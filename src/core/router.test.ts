// The router's channel fan-out: which session events reach an IM adapter, and
// in what shape. Everything an IM user sees that is not a delta comes through
// here, so the mapping is a contract, not an implementation detail.

import { beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "./hub.js";
import { Router } from "./router.js";
import type {
  AgentReply,
  AgentSession,
  Channel,
  SessionEventPayload,
  NoteOrigin,
  SystemInputOrigin,
} from "./types.js";

/** Only the surface the router touches; the rest of AgentSession is unused. */
function fakeSession(id: string) {
  const listeners = new Set<(e: SessionEventPayload) => void>();
  const calls: string[] = [];
  /** Every text that reached the session, prefix and all. */
  const prompts: string[] = [];
  let promptError: Error | undefined;
  let queued: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  const session = {
    id,
    state: "idle" as const,
    subscribe(fn: (e: SessionEventPayload) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    abort: () => {
      calls.push("abort");
      return Promise.resolve();
    },
    prompt: (text: string) => {
      calls.push("prompt");
      prompts.push(text);
      return promptError ? Promise.reject(promptError) : Promise.resolve();
    },
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    clearQueue: () => {
      calls.push("clearQueue");
      const drained = queued;
      queued = { steering: [], followUp: [] };
      for (const fn of listeners) fn({ type: "queue-state", ...queued });
      return Promise.resolve(drained);
    },
    pendingQueue: () => Promise.resolve(structuredClone(queued)),
    dispose: () => {
      calls.push("dispose");
      return Promise.resolve();
    },
  };
  return {
    // The router reads a handful of members; a full double would be noise.
    session: session as unknown as AgentSession,
    calls,
    prompts,
    /** Park messages in Pi's queue, as a steer delivered too late does. */
    setQueue: (q: { steering?: string[]; followUp?: string[] }) => {
      queued = { steering: q.steering ?? [], followUp: q.followUp ?? [] };
    },
    failPrompts: (err: Error | undefined) => {
      promptError = err;
    },
    emit: (e: SessionEventPayload) => {
      for (const fn of listeners) fn(e);
    },
  };
}

function fakeChannel(id: string) {
  const sent: [string, AgentReply][] = [];
  const notes: [string, { text: string; origin: NoteOrigin }][] = [];
  const channel: Channel = {
    id,
    start: () => Promise.resolve(),
    send: (conversationId, reply) => {
      sent.push([conversationId, reply]);
      return Promise.resolve();
    },
    notify: (conversationId, note) => {
      notes.push([conversationId, note]);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
  return { channel, sent, notes };
}

const KEY = { channelId: "telegram", conversationId: "-100/7" };
const ORIGIN: SystemInputOrigin = {
  kind: "task-callback",
  taskId: "t1",
  runId: "r1",
  sourceSessionId: "s2",
};

let hub: EventHub;
let router: Router;
let fake: ReturnType<typeof fakeSession>;
let tg: ReturnType<typeof fakeChannel>;

beforeEach(() => {
  hub = new EventHub();
  fake = fakeSession("s1");
  router = new Router(hub, () => Promise.resolve(fake.session));
  tg = fakeChannel("telegram");
  router.registerChannel(tg.channel);
});

describe("channel fan-out", () => {
  it("sends a finished turn, with its completion meta attached", async () => {
    await router.ensure(KEY);
    const meta = { completedAt: 5, durationMs: 1200, tokens: 999 };
    fake.emit({ type: "turn-end", text: "done\n\n---\n[Run it]", meta });
    expect(tg.sent).toEqual([["-100/7", { text: "done", suggestions: ["Run it"], meta }]]);
  });

  it("sends an empty turn-end too — that is the turn-settled signal", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "" });
    expect(tg.sent).toEqual([["-100/7", { text: "", suggestions: [], meta: undefined }]]);
  });

  it("forwards a system input as a note, before the turn it triggers", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "system-input", text: "task finished", origin: ORIGIN });
    fake.emit({ type: "turn-end", text: "acknowledged" });
    expect(tg.notes).toEqual([["-100/7", { text: "task finished", origin: ORIGIN }]]);
    expect(tg.sent).toHaveLength(1);
  });

  it("gives the chat a digest of a long system input, and the hub all of it", async () => {
    const seen: string[] = [];
    hub.subscribe("s1", (e) => { if (e.type === "system-input") seen.push(e.text); });
    await router.ensure(KEY);
    // What a task callback looks like: a header the reader wants and 8000
    // characters of result text they do not (tasks/callbacks.ts).
    const long = `Task "review" finished with state: succeeded\n${"result line\n".repeat(200)}`;
    fake.emit({ type: "system-input", text: long, origin: ORIGIN });
    expect(tg.notes[0]![1].text).toBe(
      `Task "review" finished with state: succeeded\nresult line\nresult line\nresult line\n\u2026 +197 more lines`,
    );
    // One paragraph, no line to cut on: the head stops on a word instead.
    fake.emit({ type: "system-input", text: "word ".repeat(200), origin: ORIGIN });
    const oneLine = tg.notes[1]![1].text;
    expect(oneLine).toBe(`${"word ".repeat(39)}word\n\u2026 +1 more line`);
    // The event stream is unclamped — the web timeline and the transcript are
    // where the whole thing still is.
    expect(seen).toEqual([long, "word ".repeat(200)]);
  });

  it("leaves a system input that already fits exactly as it is", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "system-input", text: "line one\nline two", origin: ORIGIN });
    expect(tg.notes).toEqual([["-100/7", { text: "line one\nline two", origin: ORIGIN }]]);
  });

  it("delivers one reply at a time per conversation", async () => {
    // One run can end two turns — Pi drains a message queued mid-turn — and an
    // adapter's send is several platform calls (chunks, then attachments).
    // Overlapping them interleaves two answers in the chat.
    const started: string[] = [];
    const finished: string[] = [];
    const gates: (() => void)[] = [];
    router.registerChannel({
      id: "telegram",
      start: () => Promise.resolve(),
      send: async (_conversationId, reply) => {
        started.push(reply.text);
        await new Promise<void>((r) => gates.push(r));
        finished.push(reply.text);
      },
      notify: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "first" });
    fake.emit({ type: "turn-end", text: "second" });
    expect(started).toEqual(["first"]);
    gates[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["first", "second"]);
    expect(finished).toEqual(["first"]);
    gates[1]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(finished).toEqual(["first", "second"]);
  });

  it("reports a failed reply without failing the next one", async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    hub.subscribe("s1", (e) => { if (e.type === "error") errors.push(e.message); });
    router.registerChannel({
      id: "telegram",
      start: () => Promise.resolve(),
      send: (_conversationId, reply) => {
        sent.push(reply.text);
        return reply.text === "first" ? Promise.reject(new Error("429")) : Promise.resolve();
      },
      notify: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "first" });
    fake.emit({ type: "turn-end", text: "second" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["first", "second"]);
    expect(errors).toEqual(["outbound to telegram failed: Error: 429"]);
  });

  it("keeps deltas and thinking off IM entirely", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "text-delta", text: "par" });
    fake.emit({ type: "thinking-delta", text: "hmm" });
    fake.emit({ type: "tool-start", toolCallId: "c1", toolName: "bash", args: {} });
    expect(tg.sent).toEqual([]);
    expect(tg.notes).toEqual([]);
  });

  it("sends nothing for a conversation on a channel it does not own", async () => {
    await router.ensure({ channelId: "web", conversationId: "s1" });
    fake.emit({ type: "turn-end", text: "done" });
    expect(tg.sent).toEqual([]);
  });

  it("reports a failed delivery as an error event, never as a throw", async () => {
    const errors: string[] = [];
    hub.subscribe("s1", (e) => {
      if (e.type === "error") errors.push(e.message);
    });
    const broken = fakeChannel("telegram");
    broken.channel.send = () => Promise.reject(new Error("429"));
    broken.channel.notify = () => Promise.reject(new Error("network"));
    router.registerChannel(broken.channel);
    await router.ensure(KEY);
    fake.emit({ type: "system-input", text: "x", origin: ORIGIN });
    fake.emit({ type: "turn-end", text: "y" });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([
      "notify telegram failed: Error: network",
      "outbound to telegram failed: Error: 429",
      // The failure is also pushed at the chat, and that attempt failing is
      // itself reported — but only once, never recursively.
      "could not report the failure to telegram: Error: network",
    ]);
  });

  it("re-lists every surface when the session names itself", async () => {
    await router.ensure(KEY);
    const workspace: string[] = [];
    hub.subscribeWorkspace((e) => workspace.push(e.type));
    fake.emit({ type: "renamed", title: "Parser fix" });
    expect(workspace).toEqual(["sessions-changed"]);
  });

  it("tells the conversation when the session itself reports an error", async () => {
    const { channel, notes, sent } = fakeChannel("telegram");
    router.registerChannel(channel);
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "", error: "tool exploded" });
    fake.emit({ type: "error", message: "tool exploded" });
    await new Promise((r) => setTimeout(r, 0));
    // The turn settles without leaking its error into the reply body; the
    // paired error event is the conversation's one failure notification.
    expect(sent).toEqual([[
      KEY.conversationId,
      { text: "", suggestions: [], meta: undefined },
    ]]);
    expect(notes).toEqual([[KEY.conversationId, {
      text: "tool exploded",
      origin: { kind: "error" },
    }]]);
  });

  it("tells the conversation when the prompt itself fails", async () => {
    const { channel, notes } = fakeChannel("telegram");
    router.registerChannel(channel);
    // The double is cast to AgentSession; reach the real object to break it.
    Object.assign(fake.session, { prompt: () => Promise.reject(new Error("session gone")) });
    await router.dispatch({
      key: KEY,
      senderId: "u",
      text: "hi",
      mode: "auto",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(notes[0]?.[1]).toMatchObject({ origin: { kind: "error" } });
    expect(notes[0]?.[1].text).toContain("session gone");
  });

  it("trims a long error to something a chat window can hold", async () => {
    const { channel, notes } = fakeChannel("telegram");
    router.registerChannel(channel);
    await router.ensure(KEY);
    fake.emit({ type: "error", message: "x".repeat(2000) });
    await new Promise((r) => setTimeout(r, 0));
    expect(notes[0]![1].text).toHaveLength(601);
    expect(notes[0]![1].text.endsWith("\u2026")).toBe(true);
  });
});

describe("reporting to a session", () => {
  it("tells the conversation waiting on it", async () => {
    await router.ensure(KEY);
    router.reportTo("s1", "the result could not be delivered");
    expect(tg.notes.at(-1)?.[1]).toMatchObject({
      text: "the result could not be delivered",
      origin: { kind: "error" },
    });
  });

  it("falls back to the event stream when no conversation is attached", () => {
    const seen: string[] = [];
    hub.subscribe("s9", (e) => { if (e.type === "error") seen.push(e.message); });
    router.reportTo("s9", "nobody to tell but the timeline");
    expect(seen).toEqual(["nobody to tell but the timeline"]);
    expect(tg.notes).toEqual([]);
  });
});

describe("idle eviction", () => {
  it("lets an idle session go, and resumes it on the next message", async () => {
    const opened: string[] = [];
    router = new Router(hub, (key) => {
      opened.push(key.conversationId);
      return Promise.resolve(fake.session);
    });
    await router.ensure(KEY);
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(1);
    expect(fake.calls).toEqual(["dispose"]);
    // Gone from both directions, so nothing hands out a disposed session.
    expect(router.sessionOf(KEY)).toBeUndefined();
    expect(router.conversationOf("s1")).toBeUndefined();
    await router.ensure(KEY);
    expect(opened).toEqual([KEY.conversationId, KEY.conversationId]);
  });

  it("stops listening to what it evicted", async () => {
    await router.ensure(KEY);
    await router.evictIdle(60_000, Date.now() + 61_000);
    fake.emit({ type: "turn-end", text: "late" });
    expect(tg.sent).toEqual([]);
  });

  it("drops the aliases too, so a task callback never reaches a disposed session", async () => {
    // web:<id> and task:<id> name one session; a callback arrives under task:.
    const web = { channelId: "web", conversationId: "s1" };
    const task = { channelId: "task", conversationId: "s1" };
    const fresh = fakeSession("s1");
    let opened = 0;
    router = new Router(hub, () => Promise.resolve(++opened === 1 ? fake.session : fresh.session));
    await router.ensure(web);
    await router.ensure(task);
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(1);
    expect(router.sessionOf(task)).toBeUndefined();
    expect(await router.ensure(task)).toBe(fresh.session);
  });

  it("keeps a session someone is still watching, or still streaming", async () => {
    await router.ensure(KEY);
    const stop = hub.subscribe("s1", () => {});
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(0);
    stop();
    Object.assign(fake.session, { state: "streaming" });
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("keeps a session whose queue still holds messages — Pi's queue dies with the runtime", async () => {
    await router.ensure(KEY);
    // What /stop leaves behind: an idle session, its steer still parked.
    fake.setQueue({ steering: ["and one more thing"] });
    // The config reload's recycle sweep is the same loop, so it holds too.
    expect(await router.evictIdle(0, Date.now() + 1, { includeWatched: true })).toBe(0);
    expect(fake.calls).toEqual([]);
    await router.recallQueue("s1");
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(1);
  });

  it("keeps a session that accepted a message while the sweep was reading its queue", async () => {
    await router.ensure(KEY);
    // The dispatch lands inside the sweep's await, in the same millisecond as
    // the TTL check; the reload's recycle sweep is this loop too.
    const sweep = router.evictIdle(0, Date.now(), { includeWatched: true });
    const dispatch = router.dispatch({ key: KEY, senderId: "u1", text: "accepted during sweep", mode: "auto" });
    expect(await sweep).toBe(0);
    await dispatch;
    expect(fake.calls).toEqual(["prompt"]);
    expect(router.sessionOf(KEY)).toBe(fake.session);
    expect(router.stateOf("s1")).toBe("idle");
  });

  it("takes a watched session when the caller says the configuration changed", async () => {
    await router.ensure(KEY);
    hub.subscribe("s1", () => {});
    const opts = { includeWatched: true };
    // Watching is no longer the exemption; a turn in flight still is.
    Object.assign(fake.session, { state: "streaming" });
    expect(await router.evictIdle(0, Date.now(), opts)).toBe(0);
    Object.assign(fake.session, { state: "idle" });
    expect(await router.evictIdle(0, Date.now(), opts)).toBe(1);
    expect(fake.calls).toEqual(["dispose"]);
  });

  it("keeps a session that was used inside the window", async () => {
    await router.ensure(KEY);
    expect(await router.evictIdle(60_000, Date.now() + 30_000)).toBe(0);
  });

  it("keeps numbering events where it left off, so a reconnect sees new ones", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "one" });
    const before = hub.lastSeq("s1");
    await router.evictIdle(60_000, Date.now() + 61_000);
    expect(hub.replay("s1", 0)).toEqual([]); // the ring is what costs memory
    hub.emit("s1", { type: "turn-end", text: "two" });
    expect(hub.lastSeq("s1")).toBe(before + 1);
  });
});

describe("opening a session", () => {
  it("opens it once for concurrent callers, aliases included", async () => {
    let opened = 0;
    router = new Router(hub, () => {
      opened += 1;
      // Resolve on a later tick: the whole point is the window in between.
      return new Promise((res) => setTimeout(() => res(fakeSession("s1").session), 5));
    });
    const [a, b, c] = await Promise.all([
      router.ensure({ channelId: "web", conversationId: "s1" }),
      router.ensure({ channelId: "web", conversationId: "s1" }),
      router.ensure({ channelId: "task", conversationId: "s1" }),
    ]);
    expect(opened).toBe(1);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it.each([
    ["chat", "workbench", "while it opens"],
    ["workbench", "chat", "while it opens"],
    ["chat", "workbench", "mid-turn"],
    ["workbench", "chat", "mid-turn"],
  ])("shares one object between a chat and the workbench: %s first, %s %s", async (first, second, when) => {
    // A chat mapped to s1 and the web tab on s1 name one transcript; two live
    // runtimes on it would both write it and both answer.
    const web = { channelId: "web", conversationId: "s1" };
    const keyOf = (name: string) => (name === "chat" ? KEY : web);
    let opened = 0;
    router = new Router(
      hub,
      () => {
        opened += 1;
        return new Promise((res) => setTimeout(() => res(fake.session), 5));
      },
      (key) => (key.channelId === KEY.channelId ? "s1" : undefined),
    );
    router.registerChannel(tg.channel);
    let a: AgentSession, b: AgentSession;
    if (when === "mid-turn") {
      a = await router.ensure(keyOf(first));
      Object.assign(fake.session, { state: "streaming" });
      b = await router.ensure(keyOf(second));
    } else {
      [a, b] = await Promise.all([router.ensure(keyOf(first)), router.ensure(keyOf(second))]);
    }
    expect(opened).toBe(1);
    expect(a).toBe(b);
    expect(fake.calls).toEqual([]); // nothing opened only to be disposed
    // Whichever order, the chat is where the turn is answered.
    expect(router.conversationOf("s1")).toEqual(KEY);
    fake.emit({ type: "turn-end", text: "done" });
    expect(tg.sent).toEqual([["-100/7", { text: "done", suggestions: [], meta: undefined }]]);
  });

  it("answers the alias that reached it last, never a chat it belongs to", async () => {
    // A task callback opens a workbench session under task:<id> whenever
    // nothing had it attached; the workbench asking for it again makes it a web
    // session, or the notification for its next turn is never sent (web/push.ts).
    router = new Router(hub, () => Promise.resolve(fakeSession("s1").session));
    await router.ensure({ channelId: "task", conversationId: "s1" });
    expect(router.conversationOf("s1")?.channelId).toBe("task");
    await router.ensure({ channelId: "web", conversationId: "s1" });
    expect(router.conversationOf("s1")?.channelId).toBe("web");
    // The chat key is where turn-ends go: a task callback into an IM session
    // must not make the router think it is answering the workbench.
    router = new Router(hub, () => Promise.resolve(fake.session));
    await router.ensure(KEY);
    await router.ensure({ channelId: "task", conversationId: "s1" });
    expect(router.conversationOf("s1")).toEqual(KEY);
  });

  it("tells the chat when the session cannot be opened", async () => {
    router = new Router(hub, () => Promise.reject(new Error("unknown session")));
    router.registerChannel(tg.channel);
    await expect(router.ensure(KEY)).rejects.toThrow("unknown session");
    expect(tg.notes[0]?.[1].text).toContain("could not open a session");
    expect(tg.notes[0]?.[1].origin).toEqual({ kind: "error" });
  });
});

describe("drain", () => {
  it("refuses a dispatch, telling both the chat and the caller (§5)", async () => {
    router.beginDrain();
    await expect(
      router.dispatch({ key: KEY, senderId: "u1", text: "hi", mode: "auto" }),
    ).rejects.toThrow(/restarting/);
    expect(tg.notes[0]?.[1].text).toContain("restarting");
    expect(tg.notes[0]?.[1].origin).toEqual({ kind: "error" });
    // Gated before ensure: a drain must not be what opens a session.
    expect(router.sessionOf(KEY)).toBeUndefined();
  });

  it("refuses a dispatch that was inside a slow ensure when the gate closed", async () => {
    let release = (): void => {};
    router = new Router(hub, () => new Promise((resolve) => {
      release = () => resolve(fake.session);
    }));
    router.registerChannel(tg.channel);
    const dispatched = router.dispatch({ key: KEY, senderId: "u1", text: "hi", mode: "auto" });
    dispatched.catch(() => {}); // asserted below; unhandled until then
    router.beginDrain();
    release();
    await expect(dispatched).rejects.toThrow(/restarting/);
    expect(tg.notes[0]?.[1].text).toContain("restarting");
  });

  it("busy() lists only mid-turn sessions", async () => {
    await router.ensure(KEY);
    expect(router.busy()).toEqual([]);
    fake.emit({ type: "state", state: "streaming" });
    // The fake's state field is static; busy() reads the live session state.
    Object.assign(fake.session, { state: "streaming" });
    expect(router.busy()).toEqual([{ session: fake.session, key: KEY }]);
  });

  it("busy() counts an answer the adapter has not finished sending", async () => {
    let release = (): void => {};
    tg.channel.send = () => new Promise((resolve) => { release = resolve; });
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "done" });
    // The turn is over and the session idle, but the chat has nothing yet.
    expect(router.busy()).toEqual([{ session: fake.session, key: KEY, sending: true }]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(router.busy()).toEqual([]);
  });
});

/** One macrotask: long enough for the promotion's clear-then-prompt to land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a queue with no turn left to drain it", () => {
  it("keeps task ownership during automatic promotion for callback and push routing", async () => {
    const owner = { channelId: "task", conversationId: "s1" };
    await router.ensure(owner);
    expect(router.conversationOf("s1")).toEqual(owner);
    fake.setQueue({ followUp: ["task follow-up"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["task follow-up"] });
    await settle();
    expect(fake.prompts).toEqual(["task follow-up"]);
    expect(router.conversationOf("s1")).toEqual(owner);
    // A later explicit web control retains the existing alias-switch policy.
    fake.setQueue({ followUp: ["operator promotion"] });
    await router.deliverQueue("s1", "steer");
    expect(router.conversationOf("s1")).toEqual({ channelId: "web", conversationId: "s1" });
  });
  // `decide` reads the session state once. A steer chosen against a turn that
  // ends before the call lands stays in Pi's queue, and the next turn — which
  // may never come — is the first thing that would read it. On IM that is
  // indistinguishable from the message never having arrived (§5).
  it("promotes it into a turn of its own", async () => {
    await router.ensure(KEY);
    fake.setQueue({ steering: ["one"], followUp: ["two"] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: ["two"] });
    await settle();
    expect(fake.prompts).toEqual(["one\ntwo"]);
  });

  it("sends the text as it stands — the header was spent on the first dispatch", async () => {
    await router.ensure(KEY);
    fake.setQueue({ steering: ["[Ada<U1> 09:00]\nand another thing"] });
    fake.emit({ type: "queue-state", steering: ["[Ada<U1> 09:00]\nand another thing"], followUp: [] });
    await settle();
    // Back through dispatch() it would be headed twice, by two clocks.
    expect(fake.prompts).toEqual(["[Ada<U1> 09:00]\nand another thing"]);
  });

  it("leaves a queue alone while a turn is running — that turn drains it", async () => {
    await router.ensure(KEY);
    Object.assign(fake.session, { state: "streaming" });
    fake.setQueue({ steering: ["one"] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: [] });
    await settle();
    expect(fake.prompts).toEqual([]);
    expect(fake.calls).not.toContain("clearQueue");
  });

  it("ignores the empty queue-state a clear emits", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "queue-state", steering: [], followUp: [] });
    await settle();
    expect(fake.calls).toEqual([]);
  });

  it("does not re-enter on the events its own promotion emits", async () => {
    await router.ensure(KEY);
    fake.setQueue({ steering: ["one"] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: [] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: [] });
    await settle();
    expect(fake.prompts).toEqual(["one"]);
    expect(fake.calls.filter((c) => c === "clearQueue")).toHaveLength(1);
  });

  it("never turns a /stop into the turn it was asked to stop", async () => {
    await router.ensure(KEY);
    fake.setQueue({ steering: ["one"] });
    // Pi leaves the queue in place on abort, and emits no queue-state for it;
    // the web's recall route is how those messages come back to the composer.
    await router.abortConversation(KEY);
    fake.emit({ type: "state", state: "idle" });
    await settle();
    expect(fake.prompts).toEqual([]);
  });

  it("tells the conversation when a drain refuses the promotion (§5)", async () => {
    await router.ensure(KEY);
    router.beginDrain();
    fake.setQueue({ steering: ["the thing I typed"] });
    fake.emit({ type: "queue-state", steering: ["the thing I typed"], followUp: [] });
    await settle();
    expect(fake.prompts).toEqual([]);
    expect(await fake.session.pendingQueue()).toEqual({ steering: ["the thing I typed"], followUp: [] });
    expect(tg.notes.at(-1)?.[1].text).toContain("restarting");
    expect(tg.notes.at(-1)?.[1].origin).toEqual({ kind: "error" });
  });

  it("reports a promotion that failed instead of losing it quietly", async () => {
    await router.ensure(KEY);
    fake.failPrompts(new Error("session gone"));
    fake.setQueue({ steering: ["one"] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: [] });
    await settle();
    expect(tg.notes.at(-1)?.[1].text).toContain("session gone");
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("queue promotion recovery", () => {
  const originals = {
    steering: ["[Ada<U1> 09:00]\n  first\n", "second\n"],
    followUp: ["[Bob<U2> 09:01]\n" + "long text ".repeat(1000)],
  };
  beforeEach(async () => {
    await router.ensure(KEY);
    fake.setQueue(structuredClone(originals));
  });

  it.each(["steer", "restart", "auto"] as const)("retains originals when drain begins during %s clear", async (mode) => {
    const clear = fake.session.clearQueue;
    fake.session.clearQueue = async () => {
      const queue = await clear();
      router.beginDrain();
      return queue;
    };
    await expect(router.deliverQueue("s1", mode)).rejects.toThrow("restarting");
    expect(fake.prompts).toEqual([]);
    expect(router.recoveryOf("s1")).toEqual([expect.objectContaining({ ...originals, status: "not-submitted" })]);
    expect(tg.notes).toHaveLength(1);
  });

  it.each(["reject", "drain"])("retains originals after abort %s and does not touch new arrivals", async (outcome) => {
    const abort = deferred();
    fake.session.abort = () => abort.promise;
    const deliver = router.deliverQueue("s1", "restart");
    await settle();
    fake.setQueue({ followUp: ["new arrival"] });
    if (outcome === "reject") abort.reject(new Error("abort failed"));
    else { router.beginDrain(); abort.resolve(); }
    await expect(deliver).rejects.toThrow(outcome === "reject" ? "abort failed" : "restarting");
    expect(router.recoveryOf("s1")[0]).toMatchObject({ ...originals, status: "not-submitted" });
    expect(await fake.session.pendingQueue()).toEqual({ steering: [], followUp: ["new arrival"] });
    expect(fake.prompts).toEqual([]);
  });

  it.each([false, true])("retains a rejection with uncertain acceptance, observed user-message=%s", async (accepted) => {
    const prompt = deferred();
    fake.session.prompt = (text) => {
      if (accepted) fake.emit({ type: "user-message", text });
      return prompt.promise;
    };
    await router.deliverQueue("s1", "steer");
    const batch = router.recoveryOf("s1")[0]!;
    expect(() => router.acknowledgeRecovery("s1", batch.id)).toThrow("not settled");
    prompt.reject(new Error("prompt failed"));
    await settle();
    expect(router.recoveryOf("s1")[0]).toMatchObject({ ...originals, status: "uncertain" });
    expect(tg.notes).toHaveLength(1);
    // Reading/copying cannot consume or mutate the retained originals.
    batch.steering[0] = "changed by reader";
    expect(router.recoveryOf("s1")[0]?.steering).toEqual(originals.steering);
    router.acknowledgeRecovery("s1", batch.id);
    await settle();
    expect(router.recoveryOf("s1")).toEqual([]);
  });

  it.each(["success", "failure"])("releases exclusion at launch and survives late %s after another batch's ACK", async (outcome) => {
    const first = deferred(), second = deferred();
    fake.session.prompt = () => first.promise;
    await router.deliverQueue("s1", "steer");
    const firstId = router.recoveryOf("s1")[0]!.id;
    Object.assign(fake.session, { state: "streaming" });
    fake.setQueue({ followUp: ["second"] });
    fake.session.steer = () => second.promise;
    await router.deliverQueue("s1", "steer");
    const secondId = router.recoveryOf("s1")[1]!.id;
    fake.setQueue({ steering: ["third"] });
    expect(await router.recallQueue("s1")).toEqual({ steering: ["third"], followUp: [] });
    second.reject(new Error("second failed"));
    await settle();
    router.acknowledgeRecovery("s1", secondId);
    expect(router.recoveryOf("s1").map((b) => b.id)).toEqual([firstId]);
    if (outcome === "success") first.resolve();
    else first.reject(new Error("late first failure"));
    await settle();
    expect(router.recoveryOf("s1")).toEqual(outcome === "success" ? [] : [
      expect.objectContaining({ id: firstId, ...originals, status: "uncertain" }),
    ]);
  });

  it("keeps settled recovery through eviction but pins a pending preflight", async () => {
    const prompt = deferred();
    fake.session.prompt = () => prompt.promise;
    await router.deliverQueue("s1", "steer");
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(0);
    prompt.reject(new Error("preflight failed"));
    await settle();
    const batch = router.recoveryOf("s1")[0]!;
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(1);
    expect(router.recoveryOf("s1")[0]).toEqual(batch);
    router.acknowledgeRecovery("s1", batch.id);
    await settle();
    expect(router.recoveryOf("s1")).toEqual([]);
  });

  it.each(["manual", "automatic"])("shares exclusion with %s promotion and recall", async (owner) => {
    const clear = fake.session.clearQueue;
    const gate = deferred<Awaited<ReturnType<typeof clear>>>();
    fake.session.clearQueue = () => { fake.calls.push("blocked clear"); return gate.promise; };
    let deliver: Promise<string> | undefined;
    if (owner === "manual") deliver = router.deliverQueue("s1", "steer");
    else fake.emit({ type: "queue-state", ...originals });
    await settle();
    await expect(router.deliverQueue("s1", "restart")).rejects.toThrow("in progress");
    await expect(router.recallQueue("s1")).rejects.toThrow("in progress");
    fake.emit({ type: "queue-state", ...originals });
    fake.session.clearQueue = clear;
    gate.resolve(await clear());
    await deliver;
    await settle();
    expect(fake.prompts).toEqual([[...originals.steering, ...originals.followUp].join("\n")]);
  });

  it("does not clear reentrantly before the backend enqueue has completed", async () => {
    let notifying = true;
    const clear = fake.session.clearQueue;
    fake.session.clearQueue = () => {
      expect(notifying).toBe(false);
      return clear();
    };
    fake.emit({ type: "queue-state", ...originals });
    notifying = false;
    await settle();
    expect(fake.prompts).toHaveLength(1);
  });

  it.each(["preflight", "turn"])("handles fresh queue events during successful %s exactly once", async (phase) => {
    const first = deferred();
    const prompt = fake.session.prompt;
    fake.session.prompt = () => first.promise;
    await router.deliverQueue("s1", "steer");
    if (phase === "turn") {
      Object.assign(fake.session, { state: "streaming" });
      fake.emit({ type: "state", state: "streaming" });
      // The turn became idle, but its promise has not settled yet.
      Object.assign(fake.session, { state: "idle" });
      fake.emit({ type: "state", state: "idle" });
    }
    fake.setQueue({ followUp: ["new arrival"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["new arrival"] });
    await settle();
    expect(await fake.session.pendingQueue()).toEqual({ steering: [], followUp: ["new arrival"] });
    fake.session.prompt = prompt;
    first.resolve();
    await settle();
    expect(fake.prompts).toEqual(["new arrival"]);
    expect(router.recoveryOf("s1")).toEqual([]);
  });

  it("does not blindly promote an enqueue followed by rejection, even after ACK", async () => {
    let submissions = 0;
    fake.session.prompt = async (text) => {
      submissions++;
      fake.setQueue({ followUp: [text] });
      fake.emit({ type: "queue-state", steering: [], followUp: [text] });
      throw new Error("acceptance unknown");
    };
    await router.deliverQueue("s1", "steer");
    await settle();
    const batch = router.recoveryOf("s1")[0]!;
    fake.emit({ type: "queue-state", steering: [], followUp: ["later event"] });
    await settle();
    router.acknowledgeRecovery("s1", batch.id);
    await settle();
    expect(submissions).toBe(1);
    expect((await fake.session.pendingQueue()).followUp).toHaveLength(1);
    expect(router.recoveryOf("s1")).toEqual([]);
  });

  it("does not promote a deferred queue event after /stop", async () => {
    const prompt = deferred();
    fake.session.prompt = () => prompt.promise;
    await router.deliverQueue("s1", "steer");
    fake.setQueue({ followUp: ["still queued"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["still queued"] });
    await router.abortConversation(KEY);
    prompt.resolve();
    await settle();
    expect(await fake.session.pendingQueue()).toEqual({ steering: [], followUp: ["still queued"] });
    expect(fake.calls.filter((c) => c === "clearQueue")).toHaveLength(1);
  });

  it("does not resend uncertain live input on a NEW queue event after ACK", async () => {
    let submissions = 0;
    fake.session.prompt = async (text) => {
      submissions++;
      fake.setQueue({ followUp: [text] });
      fake.emit({ type: "queue-state", steering: [], followUp: [text] });
      throw new Error("acceptance unknown");
    };
    await router.deliverQueue("s1", "steer");
    await settle();
    router.acknowledgeRecovery("s1", router.recoveryOf("s1")[0]!.id);
    const queue = await fake.session.pendingQueue();
    queue.followUp.push("a genuinely new arrival");
    fake.setQueue(queue);
    fake.emit({ type: "queue-state", ...queue });
    await settle();
    expect(submissions).toBe(1);
    expect(await fake.session.pendingQueue()).toEqual(queue);
    expect(router.queueUncertain("s1")).toBe(true);
  });

  it.each(["before", "after"])("resolves the live-queue hold with manual recall %s ACK, preserving copies until ACK", async (order) => {
    fake.failPrompts(new Error("uncertain"));
    await router.deliverQueue("s1", "steer");
    await settle();
    const batch = router.recoveryOf("s1")[0]!;
    fake.failPrompts(undefined);
    if (order === "after") router.acknowledgeRecovery("s1", batch.id);
    expect(router.queueUncertain("s1")).toBe(true);
    expect(await router.recallQueue("s1")).toEqual({ steering: [], followUp: [] });
    expect(router.queueUncertain("s1")).toBe(false);
    if (order === "before") {
      expect(router.recoveryOf("s1")[0]).toEqual(batch);
      router.acknowledgeRecovery("s1", batch.id);
    }
    expect(router.queueUncertain("s1")).toBe(false);
    fake.setQueue({ followUp: ["fresh after resolution"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["fresh after resolution"] });
    await settle();
    expect(fake.prompts.at(-1)).toBe("fresh after resolution");
  });

  it.each(["steer", "restart"] as const)("resolves the hold only after an explicit %s clear succeeds", async (mode) => {
    fake.failPrompts(new Error("uncertain"));
    await router.deliverQueue("s1", "steer");
    await settle();
    router.acknowledgeRecovery("s1", router.recoveryOf("s1")[0]!.id);
    const clear = fake.session.clearQueue;
    fake.session.clearQueue = async () => { throw new Error("clear failed"); };
    await expect(router.deliverQueue("s1", mode)).rejects.toThrow("clear failed");
    await expect(router.recallQueue("s1")).rejects.toThrow("clear failed");
    expect(router.queueUncertain("s1")).toBe(true);
    fake.session.clearQueue = clear;
    fake.failPrompts(undefined);
    fake.setQueue({ followUp: ["explicitly delivered"] });
    await router.deliverQueue("s1", mode);
    await settle();
    expect(router.queueUncertain("s1")).toBe(false);
    expect(fake.prompts.at(-1)).toBe("explicitly delivered");
  });

  it("keeps an acknowledged hold through eviction and snapshot reads", async () => {
    fake.failPrompts(new Error("uncertain"));
    await router.deliverQueue("s1", "steer");
    await settle();
    router.acknowledgeRecovery("s1", router.recoveryOf("s1")[0]!.id);
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(1);
    await router.ensure(KEY);
    expect(await fake.session.pendingQueue()).toEqual({ steering: [], followUp: [] });
    expect(router.recoveryOf("s1")).toEqual([]);
    expect(router.queueUncertain("s1")).toBe(true);
    expect(hub.replay("s1", 0)).toEqual([]); // eviction dropped replay, not the hold
    await router.recallQueue("s1");
    expect(router.queueUncertain("s1")).toBe(false);
  });

  it.each(["during clear", "after clear"])("retains a later rejection %s and ignores unrelated success", async (when) => {
    const late = deferred(), success = deferred();
    fake.session.prompt = () => late.promise;
    await router.deliverQueue("s1", "steer");
    fake.setQueue({ followUp: ["another submission"] });
    fake.session.prompt = () => success.promise;
    await router.deliverQueue("s1", "steer");
    const clear = fake.session.clearQueue;
    const gate = deferred<Awaited<ReturnType<typeof clear>>>();
    const taken = await clear();
    fake.session.clearQueue = () => gate.promise;
    const recall = router.recallQueue("s1");
    await settle();
    if (when === "during clear") { late.reject(new Error("late rejection")); await settle(); }
    gate.resolve(taken);
    await recall;
    if (when === "after clear") { late.reject(new Error("late rejection")); await settle(); }
    success.resolve();
    await settle();
    expect(router.queueUncertain("s1")).toBe(true);
    expect(router.recoveryOf("s1")).toEqual([expect.objectContaining({ ...originals, status: "uncertain" })]);
  });
});

describe("the speaker a session has been told about", () => {
  const ada = { id: "U1", name: "Ada" };

  it.each(["before submission", "uncertain"])("restores attribution after promotion fails %s, without resetting again on ACK", async (failure) => {
    Object.assign(fake.session, { state: "streaming" });
    fake.session.followUp = async (text) => { fake.setQueue({ followUp: [text] }); };
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "queued", mode: "auto" });
    expect((await fake.session.pendingQueue()).followUp[0]).toContain("Ada<U1>");
    Object.assign(fake.session, { state: "idle" });
    const clear = fake.session.clearQueue;
    if (failure === "before submission") {
      fake.session.clearQueue = async () => {
        const queue = await clear();
        router.beginDrain();
        return queue;
      };
      await expect(router.deliverQueue("s1", "steer")).rejects.toThrow("restarting");
      router.endDrain();
    } else {
      fake.failPrompts(new Error("uncertain submission"));
      await router.deliverQueue("s1", "steer");
      await settle();
      fake.failPrompts(undefined);
    }
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "next", mode: "auto" });
    expect(fake.prompts.at(-1)).toContain("Ada<U1>");
    router.acknowledgeRecovery("s1", router.recoveryOf("s1")[0]!.id);
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "after acknowledgement", mode: "auto" });
    expect(fake.prompts.at(-1)).toBe("after acknowledgement");
  });

  it("is re-sent when the dispatch carrying it failed", async () => {
    fake.failPrompts(new Error("session gone"));
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "hi", mode: "auto" });
    await settle();
    expect(fake.prompts[0]).toContain("Ada<U1>");
    // The model never saw that header: counting it as delivered leaves every
    // later message from Ada attributed to whoever spoke before her.
    fake.failPrompts(undefined);
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "again", mode: "auto" });
    expect(fake.prompts[1]).toContain("Ada<U1>");
  });

  it("is not re-sent when the dispatch worked", async () => {
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "hi", mode: "auto" });
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "again", mode: "auto" });
    // Same speaker, same minute: the header would be ~15 tokens of nothing.
    expect(fake.prompts[1]).toBe("again");
  });

  it("names the chat as the adapter spelled it, and no alias", async () => {
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "hi", mode: "auto" });
    // `<channelId>:<conversationId>` verbatim: a skill script takes it apart.
    expect(fake.prompts[0]).toMatch(/^\[Ada<U1> [\d: -]+ telegram:-100\/7\]\nhi$/);
    const web = { channelId: "web", conversationId: "s1" };
    await router.dispatch({ key: web, senderId: "web", sender: { id: "web", name: "operator" }, text: "yo", mode: "auto" });
    expect(fake.prompts[1]).not.toContain("web:");
  });

  it("is dropped on demand, for a surface that took the message back", async () => {
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "hi", mode: "auto" });
    // A recalled queue or a rewound turn: the prefixed text is out of the
    // context it was counted into (web/server.ts).
    router.forgetSender("s1");
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "again", mode: "auto" });
    expect(fake.prompts[1]).toContain("Ada<U1>");
  });
});

describe("conversation abort", () => {
  it("aborts an attached conversation", async () => {
    await router.ensure(KEY);
    await router.abortConversation(KEY);
    expect(fake.calls).toEqual(["abort"]);
  });

  it("is a no-op for a conversation nobody opened — never a lazy create", async () => {
    await router.abortConversation({ channelId: "telegram", conversationId: "-999" });
    expect(fake.calls).toEqual([]);
  });
});
