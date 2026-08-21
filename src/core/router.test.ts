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
  const notes: [string, { text: string; origin: SystemInputOrigin }][] = [];
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
    ]);
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
