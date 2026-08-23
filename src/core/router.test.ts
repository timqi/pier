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
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    dispose: () => {
      calls.push("dispose");
      return Promise.resolve();
    },
  };
  return {
    // The router reads a handful of members; a full double would be noise.
    session: session as unknown as AgentSession,
    calls,
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

  it("tells the conversation when the session itself reports an error", async () => {
    const { channel, notes } = fakeChannel("telegram");
    router.registerChannel(channel);
    await router.ensure(KEY);
    fake.emit({ type: "error", message: "tool exploded" });
    await new Promise((r) => setTimeout(r, 0));
    // Otherwise the eyes come off with no reply and nothing says why.
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

  it("tells the chat when the session cannot be opened", async () => {
    router = new Router(hub, () => Promise.reject(new Error("unknown session")));
    router.registerChannel(tg.channel);
    await expect(router.ensure(KEY)).rejects.toThrow("unknown session");
    expect(tg.notes[0]?.[1].text).toContain("could not open a session");
    expect(tg.notes[0]?.[1].origin).toEqual({ kind: "error" });
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
