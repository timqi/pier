import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type {
  AgentSession,
  ChatTurn,
  SessionEventPayload,
  SessionState,
  SystemInputOrigin,
} from "../core/types.js";
import { openDb } from "../db.js";
import { BusDelivery } from "./delivery.js";
import { BusStore } from "./store.js";
import { SubStore } from "./subs.js";

const SCOPE = "project:/p";

/** The slice of a session the outbox touches: state, systemInput, history —
 * where an input it recorded is the delivery proof. */
function fakeSession(id: string): AgentSession & {
  inputs: { text: string; origin: SystemInputOrigin; mode: string }[];
  setState(state: SessionState): void;
} {
  let state: SessionState = "idle";
  const listeners = new Set<(event: SessionEventPayload) => void>();
  const inputs: { text: string; origin: SystemInputOrigin; mode: string }[] = [];
  return {
    id,
    inputs,
    get state() { return state; },
    setState(next) { state = next; listeners.forEach((fn) => fn({ type: "state", state: next })); },
    model: undefined,
    thinkingLevel: "off",
    contextUsage: undefined,
    history: async (): Promise<ChatTurn[]> =>
      inputs.map(({ text, origin }) => ({ role: "system" as const, text, origin })),
    setModel: async () => {},
    availableModels: async () => [],
    availableThinkingLevels: () => ["off"],
    setThinkingLevel: () => {},
    pendingQueue: async () => ({ steering: [], followUp: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    rewindToUserTurn: async () => {},
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    systemInput: async (text, origin, mode) => { inputs.push({ text, origin, mode }); },
    abort: async () => {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: async () => {},
  };
}

function setup() {
  const db = openDb(":memory:");
  const store = new BusStore(db);
  const subs = new SubStore(db);
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const session = (id: string): ReturnType<typeof fakeSession> => {
    if (!sessions.has(id)) sessions.set(id, fakeSession(id));
    return sessions.get(id)!;
  };
  const router = new Router(new EventHub(), (key) => Promise.resolve(session(key.conversationId)));
  const given: string[] = [];
  const delivery = new BusDelivery(router, store, subs, (sid, what, why) => given.push(`${sid}|${what}|${why}`));
  const publish = (payload: string, topic = "proj/auth") => {
    const event = store.publish({ topic, payload: JSON.stringify(payload), scope: SCOPE, writerSession: "writer" });
    delivery.notify(event);
    return event;
  };
  return { db, store, subs, session, delivery, publish, given };
}

describe("BusDelivery", () => {
  it("wakes an idle subscriber with a pointer, never the payload", async () => {
    const { subs, session, publish, store } = setup();
    subs.upsert("b", "proj/*", "queue", [SCOPE], store.tip());
    const event = publish("secret");

    const b = session("b");
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
    const input = b.inputs[0]!;
    expect(input.mode).toBe("followUp");
    expect(input.text).toContain("1 new event on 'proj/*'");
    expect(input.text).toContain(`caused_by: '${event.id}'`); // the loop guard rides along
    expect(input.text).not.toContain("secret"); // pointer only
    expect(input.origin.kind).toBe("bus-notify");
    // Proof read back from the transcript: the note settles as delivered.
    await vi.waitFor(() => expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]));
  });

  it("coalesces while the subscriber is busy and delivers once at the boundary", async () => {
    const { subs, session, publish, delivery, store } = setup();
    subs.upsert("b", "proj/*", "queue", [SCOPE], store.tip());
    const b = session("b");
    b.setState("streaming");
    publish("1");
    publish("2");
    publish("3");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.inputs).toEqual([]); // deferred, not delivered mid-turn
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toHaveLength(1); // one open note, not three

    b.setState("idle");
    delivery.recover(Date.now() + 60_000);
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
    expect(b.inputs[0]!.text).toContain("3 new events");
  });

  it("steer mode reaches the running turn instead of waiting", async () => {
    const { subs, session, publish, store } = setup();
    subs.upsert("b", "proj/*", "steer", [SCOPE], store.tip());
    const b = session("b");
    b.setState("streaming");
    publish("urgent");
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
    expect(b.inputs[0]!.mode).toBe("steer");
  });

  it("never notifies the writer of its own write, nor outside the pinned scopes", async () => {
    const { subs, session, publish, store } = setup();
    subs.upsert("writer", "proj/*", "queue", [SCOPE], store.tip());
    subs.upsert("elsewhere", "proj/*", "queue", ["project:/q"], store.tip());
    publish("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session("writer").inputs).toEqual([]);
    expect(session("elsewhere").inputs).toEqual([]);
  });

  it("a note pending at crash is delivered by the next process's sweep", async () => {
    const { db, subs, session, publish } = setup();
    const b = session("b");
    b.setState("streaming"); // the first process defers…
    subs.upsert("b", "proj/*", "queue", [SCOPE], "");
    publish("survives");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.inputs).toEqual([]);

    // …and dies. A fresh delivery engine over the same database recovers it.
    b.setState("idle");
    const router = new Router(new EventHub(), () => Promise.resolve(b));
    const revived = new BusDelivery(router, new BusStore(db), new SubStore(db), () => {});
    revived.recover(Date.now() + 60_000);
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
  });

  it("a subscriber that caught up on its own is not woken for nothing", async () => {
    const { subs, session, publish, delivery } = setup();
    const b = session("b");
    b.setState("streaming");
    subs.upsert("b", "proj/*", "queue", [SCOPE], "");
    const event = publish("seen");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // B reads and acks mid-turn, on its own initiative.
    subs.ack("b", "proj/*", event.id);
    b.setState("idle");
    delivery.recover(Date.now() + 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.inputs).toEqual([]);
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]); // settled, not retrying
  });
});
