// The router's channel fan-out: which session events reach an IM adapter, and
// in what shape. Everything an IM user sees that is not a delta comes through
// here, so the mapping is a contract, not an implementation detail.

import { beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "./hub.js";
import { Router, SkillAmbiguous } from "./router.js";
import { fakeSession as sharedFake } from "./session.testkit.js";
import type {
  AgentReply,
  AgentSession,
  Channel,
  NoteOrigin,
  SystemInputOrigin,
} from "./types.js";

/** Pi's side is scripted by each test. `failPrompts` rejects prompts after
 *  recording them, as a session that took the text and then failed does. */
function fakeSession(id: string) {
  const session = sharedFake(id, { scripted: true });
  let failure: Error | undefined;
  const record = session.prompt;
  session.prompt = async (text) => {
    await record(text);
    if (failure) throw failure;
  };
  return Object.assign(session, { failPrompts: (err: Error | undefined) => { failure = err; } });
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
    openThread: () => Promise.resolve(""),
    editRoot: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return { channel, sent, notes };
}

const KEY = { channelId: "slack", conversationId: "C100/1717.7" };
const ORIGIN: SystemInputOrigin = {
  kind: "task-callback",
  taskId: "t1",
  runId: "r1",
  sourceSessionId: "s2",
};

let hub: EventHub;
let router: Router;
let fake: ReturnType<typeof fakeSession>;
let im: ReturnType<typeof fakeChannel>;

beforeEach(() => {
  hub = new EventHub();
  fake = fakeSession("s1");
  router = new Router(hub, () => Promise.resolve(fake));
  im = fakeChannel("slack");
  router.registerChannel(im.channel);
});

describe("channel fan-out", () => {
  it("sends a finished turn, with its completion meta attached", async () => {
    await router.ensure(KEY);
    const meta = { completedAt: 5, durationMs: 1200, tokens: 999 };
    fake.emit({ type: "turn-end", text: "done\n\n---\n[Run it]", meta });
    expect(im.sent).toEqual([["C100/1717.7", { text: "done", suggestions: ["Run it"], meta }]]);
  });

  it("sends an empty turn-end too — that is the turn-settled signal", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "" });
    expect(im.sent).toEqual([["C100/1717.7", { text: "", suggestions: [], meta: undefined }]]);
  });

  it("forwards a system input as a note, before the turn it triggers", async () => {
    await router.ensure(KEY);
    // The language stamp is for the model; the chat reads the input itself.
    fake.emit({ type: "system-input", text: "[lang=zh]\ntask finished", origin: ORIGIN });
    fake.emit({ type: "turn-end", text: "acknowledged" });
    expect(im.notes).toEqual([["C100/1717.7", { text: "task finished", origin: ORIGIN }]]);
    expect(im.sent).toHaveLength(1);
  });

  it("hands the chat and the hub the whole of a long system input", async () => {
    const seen: string[] = [];
    hub.subscribe("s1", (e) => { if (e.type === "system-input") seen.push(e.text); });
    await router.ensure(KEY);
    const long = `Task "review" finished with state: succeeded\n${"result line\n".repeat(200)}`;
    fake.emit({ type: "system-input", text: long, origin: ORIGIN });
    expect(im.notes[0]![1].text).toBe(long);
    expect(seen).toEqual([long]);
  });

  it("delivers one reply at a time per conversation", async () => {
    // One run can end two turns — Pi drains a message queued mid-turn — and an
    // adapter's send is several platform calls (chunks, then attachments).
    // Overlapping them interleaves two answers in the chat.
    const started: string[] = [];
    const finished: string[] = [];
    const gates: (() => void)[] = [];
    router.registerChannel({
      id: "slack",
      start: () => Promise.resolve(),
      send: async (_conversationId, reply) => {
        started.push(reply.text);
        await new Promise<void>((r) => gates.push(r));
        finished.push(reply.text);
      },
      notify: () => Promise.resolve(),
      openThread: () => Promise.resolve(""),
      editRoot: () => Promise.resolve(),
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
      id: "slack",
      start: () => Promise.resolve(),
      send: (_conversationId, reply) => {
        sent.push(reply.text);
        return reply.text === "first" ? Promise.reject(new Error("429")) : Promise.resolve();
      },
      notify: () => Promise.resolve(),
      openThread: () => Promise.resolve(""),
      editRoot: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "first" });
    fake.emit({ type: "turn-end", text: "second" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["first", "second"]);
    expect(errors).toEqual(["outbound to slack failed: Error: 429"]);
  });

  it("keeps deltas and thinking off IM entirely", async () => {
    await router.ensure(KEY);
    fake.emit({ type: "text-delta", text: "par" });
    fake.emit({ type: "thinking-delta", text: "hmm" });
    fake.emit({ type: "tool-start", toolCallId: "c1", toolName: "bash", args: {} });
    expect(im.sent).toEqual([]);
    expect(im.notes).toEqual([]);
  });

  it("sends nothing for a conversation on a channel it does not own", async () => {
    await router.ensure({ channelId: "web", conversationId: "s1" });
    fake.emit({ type: "turn-end", text: "done" });
    expect(im.sent).toEqual([]);
  });

  it("reports a failed delivery as an error event, never as a throw", async () => {
    const errors: string[] = [];
    hub.subscribe("s1", (e) => {
      if (e.type === "error") errors.push(e.message);
    });
    const broken = fakeChannel("slack");
    broken.channel.send = () => Promise.reject(new Error("429"));
    broken.channel.notify = () => Promise.reject(new Error("network"));
    router.registerChannel(broken.channel);
    await router.ensure(KEY);
    fake.emit({ type: "system-input", text: "x", origin: ORIGIN });
    fake.emit({ type: "turn-end", text: "y" });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([
      "notify slack failed: Error: network",
      "outbound to slack failed: Error: 429",
      // The failure is also pushed at the chat, and that attempt failing is
      // itself reported — but only once, never recursively.
      "could not report the failure to slack: Error: network",
    ]);
  });

  it("reports a throwing turn-end listener and still runs the rest and sends", async () => {
    const errors: string[] = [];
    hub.subscribe("s1", (e) => {
      if (e.type === "error") errors.push(e.message);
    });
    const heard: string[] = [];
    router.onTurnEnd(() => { throw new Error("boom"); });
    router.onTurnEnd((id, text) => heard.push(`${id}:${text}`));
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "done" });
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).toEqual(["s1:done"]);
    expect(errors).toEqual(["turn-end listener failed: Error: boom"]);
    expect(im.notes).toEqual([["C100/1717.7", { text: "turn-end listener failed: Error: boom", origin: { kind: "error" } }]]);
    expect(im.sent).toHaveLength(1);
  });

  it("re-lists every surface when the session names itself", async () => {
    await router.ensure(KEY);
    const workspace: string[] = [];
    hub.subscribeWorkspace((e) => workspace.push(e.type));
    fake.emit({ type: "renamed", title: "Parser fix" });
    expect(workspace).toEqual(["sessions-changed"]);
  });

  it("tells the conversation when the session itself reports an error", async () => {
    const { channel, notes, sent } = fakeChannel("slack");
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
    const { channel, notes } = fakeChannel("slack");
    router.registerChannel(channel);
    fake.failPrompts(new Error("session gone"));
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
    const { channel, notes } = fakeChannel("slack");
    router.registerChannel(channel);
    await router.ensure(KEY);
    fake.emit({ type: "error", message: "x".repeat(2000) });
    await new Promise((r) => setTimeout(r, 0));
    expect(notes[0]![1].text).toHaveLength(600);
    expect(notes[0]![1].text.endsWith("\u2026")).toBe(true);
  });
});

describe("reporting to a session", () => {
  it("tells the conversation waiting on it", async () => {
    await router.ensure(KEY);
    router.reportTo("s1", "the result could not be delivered");
    expect(im.notes.at(-1)?.[1]).toMatchObject({
      text: "the result could not be delivered",
      origin: { kind: "error" },
    });
  });

  it("falls back to the event stream when no conversation is attached", () => {
    const seen: string[] = [];
    hub.subscribe("s9", (e) => { if (e.type === "error") seen.push(e.message); });
    router.reportTo("s9", "nobody to tell but the timeline");
    expect(seen).toEqual(["nobody to tell but the timeline"]);
    expect(im.notes).toEqual([]);
  });
});

describe("idle eviction", () => {
  it("lets an idle session go, and resumes it on the next message", async () => {
    const opened: string[] = [];
    router = new Router(hub, (key) => {
      opened.push(key.conversationId);
      return Promise.resolve(fake);
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
    expect(im.sent).toEqual([]);
  });

  it("drops the aliases too, so a task callback never reaches a disposed session", async () => {
    // web:<id> and task:<id> name one session; a callback arrives under task:.
    const web = { channelId: "web", conversationId: "s1" };
    const task = { channelId: "task", conversationId: "s1" };
    const fresh = fakeSession("s1");
    let opened = 0;
    router = new Router(hub, () => Promise.resolve(++opened === 1 ? fake : fresh));
    await router.ensure(web);
    await router.ensure(task);
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(1);
    expect(router.sessionOf(task)).toBeUndefined();
    expect(await router.ensure(task)).toBe(fresh);
  });

  it("keeps a session someone is still watching, or still streaming", async () => {
    await router.ensure(KEY);
    const stop = hub.subscribe("s1", () => {});
    expect(await router.evictIdle(60_000, Date.now() + 61_000)).toBe(0);
    stop();
    fake.setState("streaming");
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
    expect(fake.calls).toEqual([expect.stringMatching(/^prompt:/)]);
    expect(router.sessionOf(KEY)).toBe(fake);
    expect(router.stateOf("s1")).toBe("idle");
  });

  it("takes a watched session when the caller says the configuration changed", async () => {
    await router.ensure(KEY);
    hub.subscribe("s1", () => {});
    const opts = { includeWatched: true };
    // Watching is no longer the exemption; a turn in flight still is.
    fake.setState("streaming");
    expect(await router.evictIdle(0, Date.now(), opts)).toBe(0);
    fake.setState("idle");
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
      return new Promise((res) => setTimeout(() => res(fakeSession("s1")), 5));
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
        return new Promise((res) => setTimeout(() => res(fake), 5));
      },
      (key) => (key.channelId === KEY.channelId ? "s1" : undefined),
    );
    router.registerChannel(im.channel);
    let a: AgentSession, b: AgentSession;
    if (when === "mid-turn") {
      a = await router.ensure(keyOf(first));
      fake.setState("streaming");
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
    expect(im.sent).toEqual([["C100/1717.7", { text: "done", suggestions: [], meta: undefined }]]);
  });

  it("answers the alias that reached it last, never a chat it belongs to", async () => {
    // A task callback opens a workbench session under task:<id> whenever
    // nothing had it attached; the workbench asking for it again makes it a web
    // session, or the notification for its next turn is never sent (web/push.ts).
    router = new Router(hub, () => Promise.resolve(fakeSession("s1")));
    await router.ensure({ channelId: "task", conversationId: "s1" });
    expect(router.conversationOf("s1")?.channelId).toBe("task");
    await router.ensure({ channelId: "web", conversationId: "s1" });
    expect(router.conversationOf("s1")?.channelId).toBe("web");
    // The chat key is where turn-ends go: a task callback into an IM session
    // must not make the router think it is answering the workbench.
    router = new Router(hub, () => Promise.resolve(fake));
    await router.ensure(KEY);
    await router.ensure({ channelId: "task", conversationId: "s1" });
    expect(router.conversationOf("s1")).toEqual(KEY);
  });

  it("an alias open attaches the session's durable chat key and turn-end reaches that channel", async () => {
    // After a restart the web tab speaks first: the chat that owns s1 is not
    // loaded, but its row is, and the reply belongs in the thread.
    router = new Router(
      hub,
      () => Promise.resolve(fake),
      (key) => (key.channelId === KEY.channelId ? "s1" : undefined),
      (id) => (id === "s1" ? KEY : undefined),
    );
    router.registerChannel(im.channel);
    await router.ensure({ channelId: "web", conversationId: "s1" });
    expect(router.conversationOf("s1")).toEqual(KEY);
    // The chat key is live too: its next message shares the object.
    expect(router.sessionOf(KEY)).toBe(fake);
    fake.emit({ type: "turn-end", text: "done" });
    expect(im.sent).toEqual([["C100/1717.7", { text: "done", suggestions: [], meta: undefined }]]);
  });

  it("a later alias reach does not take the key back", async () => {
    router = new Router(hub, () => Promise.resolve(fake), () => undefined, () => KEY);
    router.registerChannel(im.channel);
    await router.ensure({ channelId: "web", conversationId: "s1" });
    await router.ensure({ channelId: "task", conversationId: "s1" });
    await router.ensure({ channelId: "web", conversationId: "s1" });
    expect(router.conversationOf("s1")).toEqual(KEY);
  });

  it("a stopped adapter's sessions go back to their own stream, and take the chat again when it is back", async () => {
    router = new Router(hub, () => Promise.resolve(fake), () => undefined, () => KEY);
    router.registerChannel(im.channel);
    await router.ensure({ channelId: "web", conversationId: "s1" });
    router.unregisterChannel("slack");
    expect(router.conversationOf("s1")).toEqual({ channelId: "web", conversationId: "s1" });
    expect(router.sessionOf(KEY)).toBeUndefined();
    fake.emit({ type: "turn-end", text: "web only" });
    expect(im.sent).toEqual([]);
    router.registerChannel(im.channel);
    expect(router.conversationOf("s1")).toEqual(KEY);
    fake.emit({ type: "turn-end", text: "back" });
    expect(im.sent.map(([, r]) => r.text)).toEqual(["back"]);
  });

  it("no chat key → alias behaviour unchanged", async () => {
    router = new Router(hub, () => Promise.resolve(fake), () => undefined, () => undefined);
    await router.ensure({ channelId: "web", conversationId: "s1" });
    expect(router.conversationOf("s1")).toEqual({ channelId: "web", conversationId: "s1" });
  });

  it("tells the chat when the session cannot be opened", async () => {
    router = new Router(hub, () => Promise.reject(new Error("unknown session")));
    router.registerChannel(im.channel);
    await expect(router.ensure(KEY)).rejects.toThrow("unknown session");
    expect(im.notes[0]?.[1].text).toContain("could not open a session");
    expect(im.notes[0]?.[1].origin).toEqual({ kind: "error" });
  });
});

describe("busy", () => {
  it("busy() lists only mid-turn sessions", async () => {
    await router.ensure(KEY);
    expect(router.busy()).toEqual([]);
    fake.setState("streaming");
    expect(router.busy()).toEqual([{ session: fake, key: KEY }]);
  });

  it("busy() counts an answer the adapter has not finished sending", async () => {
    let release = (): void => {};
    im.channel.send = () => new Promise((resolve) => { release = resolve; });
    await router.ensure(KEY);
    fake.emit({ type: "turn-end", text: "done" });
    // The turn is over and the session idle, but the chat has nothing yet.
    expect(router.busy()).toEqual([{ session: fake, key: KEY, sending: true }]);
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
    fake.setState("streaming");
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

  it("reports a promotion that failed instead of losing it quietly", async () => {
    await router.ensure(KEY);
    fake.failPrompts(new Error("session gone"));
    fake.setQueue({ steering: ["one"] });
    fake.emit({ type: "queue-state", steering: ["one"], followUp: [] });
    await settle();
    expect(im.notes.at(-1)?.[1].text).toContain("session gone");
    expect(im.notes.at(-1)?.[1].text).toContain("one");
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("a failed promotion", () => {
  const originals = {
    steering: ["[Ada<U1> 09:00]\n  first\n", "second\n"],
    followUp: ["[Bob<U2> 09:01]\n" + "long text ".repeat(1000)],
  };
  const text = [...originals.steering, ...originals.followUp].join("\n");
  const errors = () => hub.replay("s1", 0).flatMap((e) => (e.type === "error" ? [e.message] : []));
  /** The originals go back to the conversation: in full on the hub, cut on IM. */
  const reported = (why: string) => {
    expect(errors()).toEqual([expect.stringContaining(why)]);
    expect(errors()[0]).toContain(text);
    expect(im.notes).toHaveLength(1);
    expect(im.notes[0]![1]).toMatchObject({ origin: { kind: "error" } });
    expect(im.notes[0]![1].text).toContain(why);
    expect(im.notes[0]![1].text).toContain(originals.steering[0]);
    expect(im.notes[0]![1].text.length).toBe(600);
  };
  beforeEach(async () => {
    await router.ensure(KEY);
    fake.setQueue(structuredClone(originals));
  });

  it("reports the originals after a failed abort and does not touch new arrivals", async () => {
    const abort = deferred();
    fake.abort = () => abort.promise;
    const deliver = router.deliverQueue("s1", "restart");
    await settle();
    fake.setQueue({ followUp: ["new arrival"] });
    abort.reject(new Error("abort failed"));
    await expect(deliver).rejects.toThrow("abort failed");
    reported("abort failed");
    expect(await fake.pendingQueue()).toEqual({ steering: [], followUp: ["new arrival"] });
    expect(fake.prompts).toEqual([]);
  });

  it.each([false, true])("reports a rejection after launch, observed user-message=%s", async (accepted) => {
    const prompt = deferred();
    fake.prompt = (t) => {
      if (accepted) fake.emit({ type: "user-message", text: t });
      return prompt.promise;
    };
    expect(await router.deliverQueue("s1", "steer")).toBe(text);
    expect(errors()).toEqual([]);
    prompt.reject(new Error("prompt failed"));
    await settle();
    reported("prompt failed");
  });

  it("releases exclusion at launch, and a late rejection reports only its own originals", async () => {
    const first = deferred(), second = deferred();
    fake.prompt = () => first.promise;
    await router.deliverQueue("s1", "steer");
    fake.setState("streaming");
    fake.setQueue({ followUp: ["second"] });
    fake.steer = () => second.promise;
    expect(await router.deliverQueue("s1", "steer")).toBe("second");
    fake.setQueue({ steering: ["third"] });
    expect(await router.recallQueue("s1")).toEqual({ steering: ["third"], followUp: [] });
    second.resolve();
    first.reject(new Error("late first failure"));
    await settle();
    reported("late first failure");
    expect(errors()[0]).not.toContain("third");
  });

  it("pins a pending preflight against eviction and keeps nothing after it fails", async () => {
    const prompt = deferred();
    fake.prompt = () => prompt.promise;
    await router.deliverQueue("s1", "steer");
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(0);
    prompt.reject(new Error("preflight failed"));
    await settle();
    reported("preflight failed");
    expect(await router.evictIdle(0, Date.now() + 1)).toBe(1);
  });

  it.each(["manual", "automatic"])("shares exclusion with %s promotion and recall", async (owner) => {
    const clear = fake.clearQueue;
    const gate = deferred<Awaited<ReturnType<typeof clear>>>();
    fake.clearQueue = () => { fake.calls.push("blocked clear"); return gate.promise; };
    let deliver: Promise<string> | undefined;
    if (owner === "manual") deliver = router.deliverQueue("s1", "steer");
    else fake.emit({ type: "queue-state", ...originals });
    await settle();
    await expect(router.deliverQueue("s1", "restart")).rejects.toThrow("in progress");
    await expect(router.recallQueue("s1")).rejects.toThrow("in progress");
    fake.emit({ type: "queue-state", ...originals });
    fake.clearQueue = clear;
    gate.resolve(await clear());
    await deliver;
    await settle();
    expect(fake.prompts).toEqual([text]);
  });

  it("does not clear reentrantly before the backend enqueue has completed", async () => {
    let notifying = true;
    const clear = fake.clearQueue;
    fake.clearQueue = () => {
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
    const prompt = fake.prompt;
    fake.prompt = () => first.promise;
    await router.deliverQueue("s1", "steer");
    if (phase === "turn") {
      fake.setState("streaming");
      // The turn became idle, but its promise has not settled yet.
      fake.setState("idle");
    }
    fake.setQueue({ followUp: ["new arrival"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["new arrival"] });
    await settle();
    expect(await fake.pendingQueue()).toEqual({ steering: [], followUp: ["new arrival"] });
    fake.prompt = prompt;
    first.resolve();
    await settle();
    expect(fake.prompts).toEqual(["new arrival"]);
    expect(errors()).toEqual([]);
  });

  it("does not resend on its own failure, and does not pause the next queue event", async () => {
    let submissions = 0;
    fake.prompt = async (t) => {
      submissions++;
      fake.setQueue({ followUp: [t] });
      fake.emit({ type: "queue-state", steering: [], followUp: [t] });
      throw new Error("acceptance unknown");
    };
    await router.deliverQueue("s1", "steer");
    await settle();
    expect(submissions).toBe(1);
    reported("acceptance unknown");
    fake.prompt = async (t) => { submissions++; fake.prompts.push(t); };
    fake.setQueue({ followUp: ["later arrival"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["later arrival"] });
    await settle();
    expect(submissions).toBe(2);
    expect(fake.prompts.at(-1)).toBe("later arrival");
  });

  it("does not promote a deferred queue event after /stop", async () => {
    const prompt = deferred();
    fake.prompt = () => prompt.promise;
    await router.deliverQueue("s1", "steer");
    fake.setQueue({ followUp: ["still queued"] });
    fake.emit({ type: "queue-state", steering: [], followUp: ["still queued"] });
    await router.abortConversation(KEY);
    prompt.resolve();
    await settle();
    expect(await fake.pendingQueue()).toEqual({ steering: [], followUp: ["still queued"] });
    expect(fake.calls.filter((c) => c === "clearQueue")).toHaveLength(1);
  });
});

describe("the speaker a session has been told about", () => {
  const ada = { id: "U1", name: "Ada" };

  it.each(["before submission", "after launch"])("restores attribution after promotion fails %s", async (failure) => {
    fake.setState("streaming");
    fake.followUp = async (text) => { fake.setQueue({ followUp: [text] }); };
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "queued", mode: "auto" });
    expect((await fake.pendingQueue()).followUp[0]).toContain("Ada<U1>");
    fake.setState("idle");
    if (failure === "before submission") {
      const abort = fake.abort;
      fake.abort = () => Promise.reject(new Error("abort failed"));
      await expect(router.deliverQueue("s1", "restart")).rejects.toThrow("abort failed");
      fake.abort = abort;
    } else {
      fake.failPrompts(new Error("uncertain submission"));
      await router.deliverQueue("s1", "steer");
      await settle();
      fake.failPrompts(undefined);
    }
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "next", mode: "auto" });
    expect(fake.prompts.at(-1)).toContain("Ada<U1>");
    await router.dispatch({ key: KEY, senderId: ada.id, sender: ada, text: "after that", mode: "auto" });
    expect(fake.prompts.at(-1)).toBe("after that");
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
    expect(fake.prompts[0]).toMatch(/^\[Ada<U1> [\d: -]+ slack:C100\/1717.7\]\nhi$/);
    const web = { channelId: "web", conversationId: "s1" };
    await router.dispatch({ key: web, senderId: "web", sender: { id: "web", name: "operator" }, text: "yo", mode: "auto" });
    expect(fake.prompts[1]).not.toContain("web:");
  });

  it("drops the ids no tool of the agent's can take", async () => {
    router.registerChannel({ ...fakeChannel("lark").channel, opaqueIds: true });
    const key = { channelId: "lark", conversationId: "oc_29115f94a301/om_2" };
    const sender = { id: "ou_6823bea16e6f2da5fc4a78a2f137c870", name: "qiqi" };
    await router.dispatch({ key, senderId: sender.id, sender, text: "hi", mode: "auto" });
    expect(fake.prompts[0]).toMatch(/^\[qiqi [\d: -]+ lark\]\nhi$/);
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
    await router.abortConversation({ channelId: "slack", conversationId: "C999" });
    expect(fake.calls).toEqual([]);
  });
});

describe("skill commands by prefix", () => {
  const SKILLS = ["pier-tasks", "pier-web", "pier-slack", "review"].map((name) => ({ name, description: name }));
  const WEB = { channelId: "web", conversationId: "s1" };
  let session: ReturnType<typeof sharedFake>;
  const send = (text: string, key = WEB) => router.dispatch({ key, senderId: "web", text, mode: "auto" });

  beforeEach(() => {
    session = sharedFake("s1", { scripted: true, skills: SKILLS });
    router = new Router(hub, () => Promise.resolve(session));
    router.registerChannel(im.channel);
  });

  it("rewrites a word naming one skill, by its name or a part after a dash, `%` or `/`, `skill:` kept", async () => {
    await send("/ta ship the parser");
    await send("%Pier-W  what is new?");
    await send("/skill:pier-s");
    await send("/rev");
    expect(session.prompts).toEqual([
      "/skill:pier-tasks ship the parser", "/skill:pier-web what is new?", "/skill:pier-slack", "/skill:review",
    ]);
  });

  it("leaves a word naming no skill, a chat command and plain text as they were", async () => {
    for (const text of ["/tmp is full", "%status", "/stop", "100% done", "/s one letter"]) await send(text);
    expect(session.prompts).toEqual(["/tmp is full", "%status", "/stop", "100% done", "/s one letter"]);
  });

  it("sends nothing for a word naming several, and tells the chat which", async () => {
    await expect(send("/pier- go")).rejects.toThrow("/pier- matches pier-tasks, pier-web, pier-slack — say more");
    await expect(send("%pier go", KEY)).rejects.toThrow(SkillAmbiguous);
    expect(session.prompts).toEqual([]);
    expect(im.notes).toEqual([["C100/1717.7", { text: "/pier matches pier-tasks, pier-web, pier-slack — say more", origin: { kind: "error" } }]]);
  });

  it("puts a speaker header after the skill, where Pi still expands it", async () => {
    await router.dispatch({ key: KEY, senderId: "u1", sender: { id: "u1", name: "qiqi" }, text: "/web search this", mode: "auto" });
    expect(session.prompts[0]).toMatch(/^\/skill:pier-web \[qiqi<u1> .*slack:C100\/1717\.7\]\nsearch this$/);
  });
});
