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
    // Honest proof timing: an input reaches the transcript at the step
    // boundary, not while the turn is still streaming — the window where a
    // steer sits in Pi's in-memory queue is exactly what these tests exercise.
    history: async (): Promise<ChatTurn[]> =>
      state === "streaming"
        ? []
        : inputs.map(({ text, origin }) => ({ role: "system" as const, text, origin })),
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
  const announced: number[] = [];
  const delivery = new BusDelivery(
    router,
    store,
    subs,
    (sid, what, why) => given.push(`${sid}|${what}|${why}`),
    () => true,
    () => announced.push(Date.now()),
  );
  const publish = (payload: string, topic = "proj/auth") => {
    const event = store.publish({ topic, payload: JSON.stringify(payload), scope: SCOPE, writerSession: "writer" });
    delivery.notify(event);
    return event;
  };
  return { db, store, subs, session, delivery, publish, given, announced };
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

  it("announces a note's lifecycle, so the operator's view is not the last to know", async () => {
    const { subs, session, publish, store, announced } = setup();
    subs.upsert("b", "proj/*", "queue", [SCOPE], store.tip());
    publish("one");
    // The note is attempted and then settled against transcript proof: state
    // moved twice with no tool call behind it, which is the whole reason the
    // Deliverable's changed() hook stopped being a stub.
    await vi.waitFor(() => expect(session("b").inputs).toHaveLength(1));
    await vi.waitFor(() => expect(announced.length).toBeGreaterThan(0));
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

  it("a steer handed to Pi is not re-sent while the same turn still runs", async () => {
    const { subs, session, publish, delivery, store } = setup();
    subs.upsert("b", "proj/*", "steer", [SCOPE], store.tip());
    const b = session("b");
    b.setState("streaming");
    publish("urgent");
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
    // The proof cannot land until the boundary; the retry sweep must treat
    // the steer as in-flight, not late — re-sending would queue duplicates
    // and spend the attempts of an input that already arrived.
    for (let i = 1; i <= 5; i++) delivery.recover(Date.now() + i * 600_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.inputs).toHaveLength(1);
    const note = subs.dueNotes(Number.MAX_SAFE_INTEGER)[0]!;
    expect(note.callbackState).toBe("pending");
    expect(note.callbackAttempts).toBe(1); // not spent, not abandoned

    b.setState("idle"); // the boundary: the transcript now proves it
    delivery.recover(Date.now() + 600_000);
    await vi.waitFor(() => expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]));
    expect(b.inputs).toHaveLength(1);
  });

  it("an event landing in the proof window gets its own wake instead of vanishing", async () => {
    const { subs, session, publish, delivery, store } = setup();
    subs.upsert("b", "proj/*", "queue", [SCOPE], store.tip());
    const b = session("b");
    // The delivered input starts a turn: the note is sent but its proof is
    // hidden until the boundary — the window the second event lands in.
    b.systemInput = async (text, origin, mode) => {
      b.setState("streaming");
      b.inputs.push({ text, origin, mode: mode as string });
    };
    publish("first");
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1));
    publish("second"); // absorbed into the sent note = lost forever
    const third = publish("third"); // …but the *unsent* note still coalesces
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toHaveLength(2);

    b.setState("idle");
    delivery.recover(Date.now() + 600_000);
    // The first note settles by proof; the second wakes the reader again —
    // pointing at the *newest* event, the head of the causal chain.
    await vi.waitFor(() => expect(b.inputs).toHaveLength(2));
    expect(b.inputs[1]!.text).toContain(`caused_by: '${third.id}'`);
    // Everything owed is settled once that turn ends and the transcript
    // proves the second input.
    b.setState("idle");
    delivery.recover(Date.now() + 1_200_000);
    await vi.waitFor(() => expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]));
    expect(b.inputs).toHaveLength(2);
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

  it("the switch freezes delivery without spending or deleting what is owed", async () => {
    const db = openDb(":memory:");
    const store = new BusStore(db);
    const subs = new SubStore(db);
    const b = fakeSession("b");
    const router = new Router(new EventHub(), () => Promise.resolve(b));
    let on = true;
    const delivery = new BusDelivery(router, store, subs, () => {}, () => on);
    subs.upsert("b", "proj/*", "queue", [SCOPE], "");
    b.setState("streaming"); // owed but deferred while the switch is still on
    delivery.notify(store.publish({ topic: "proj/auth", payload: "1", scope: SCOPE, writerSession: "w" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const owed = subs.dueNotes(Number.MAX_SAFE_INTEGER);
    expect(owed).toHaveLength(1);

    on = false;
    b.setState("idle");
    delivery.recover(Date.now() + 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.inputs).toEqual([]); // frozen …
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)[0]!.callbackAttempts)
      .toBe(owed[0]!.callbackAttempts); // … not spent against a session that was told the bus is off

    on = true;
    delivery.recover(Date.now() + 60_000);
    await vi.waitFor(() => expect(b.inputs).toHaveLength(1)); // resumes, nothing lost
  });

  it("an unreachable session's abandonment retires the sub, keeps the record, and announces", async () => {
    const db = openDb(":memory:");
    const store = new BusStore(db);
    const subs = new SubStore(db);
    // The session's file is gone from disk: every ensure() rejects, forever.
    const router = new Router(new EventHub(), () => Promise.reject(new Error("unknown session: dead")));
    const given: string[] = [];
    const announced: number[] = [];
    const delivery = new BusDelivery(
      router, store, subs,
      (sid, what, why) => given.push(`${sid}|${what}|${why}`),
      () => true,
      () => announced.push(Date.now()),
    );
    subs.upsert("dead", "proj/*", "queue", [SCOPE], "");
    delivery.notify(store.publish({ topic: "proj/auth", payload: '"x"', scope: SCOPE, writerSession: "w" }));
    // Burn the retry ladder: each sweep lands past the backoff and fails.
    for (let i = 1; given.length === 0 && i <= 20; i++) {
      delivery.recover(Date.now() + i * 600_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await vi.waitFor(() => expect(given).toHaveLength(1)); // reported, not silent

    // The subscription is gone — with the notes it was owed …
    expect(subs.get("dead", "proj/*")).toBeUndefined();
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]);
    // … but the abandoned note stays: the failure is visible, not erased.
    const { notes } = subs.adminNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.callbackState).toBe("abandoned");
    expect(announced.length).toBeGreaterThan(0); // the Console was told

    // A later publish on the same topic no longer matches: no fresh note,
    // no second ladder, no second abandoned row.
    delivery.notify(store.publish({ topic: "proj/auth", payload: '"y"', scope: SCOPE, writerSession: "w" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subs.dueNotes(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(subs.adminNotes().notes).toHaveLength(1);
    expect(given).toHaveLength(1);
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
