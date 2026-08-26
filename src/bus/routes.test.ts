import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { registerBusRoutes } from "./routes.js";
import { BusStore } from "./store.js";
import { SubStore } from "./subs.js";
import type { BusNote } from "./subs.js";
import type { BusOverview } from "./types.js";

const SCOPE = "project:/p";

function setup(enabled = true) {
  const db = openDb(":memory:");
  const events = new BusStore(db);
  const subs = new SubStore(db);
  const app = new Hono();
  registerBusRoutes(app, { events, subs, enabled: () => enabled });
  const get = async (): Promise<BusOverview> => {
    const res = await app.request("/api/bus");
    expect(res.status).toBe(200);
    return (await res.json()) as BusOverview;
  };
  return { events, subs, get };
}

const note = (over: Partial<BusNote> & Pick<BusNote, "subId" | "sessionId">): BusNote => ({
  id: `note-${over.subId}-${over.callbackState ?? "pending"}`,
  topicGlob: "proj/*",
  mode: "queue",
  scopes: [SCOPE],
  lastEventId: "",
  createdAt: 1000,
  callbackState: "pending",
  callbackAttempts: 0,
  callbackError: null,
  callbackNextAttemptAt: null,
  ...over,
});

describe("GET /api/bus", () => {
  it("answers the four sections from seeded events, subs and notes", async () => {
    const { events, subs, get } = setup();
    events.publish({ topic: "proj/auth", key: "owner", kind: "fact", payload: '"alice"', scope: SCOPE, writerSession: "writer-session-1" }, 1000);
    events.publish({ topic: "proj/auth", payload: '"a plain moment"', scope: SCOPE, writerSession: "writer-session-1" }, 2000);
    const tip = events.publish({ topic: "proj/auth", key: "gone", kind: "fact", payload: '"x"', scope: "instance", writerSession: "writer-session-1" }, 3000);
    events.forget("proj/auth", "gone", "instance", "writer-session-1", undefined, 4000);
    const sub = subs.upsert("reader-session-9", "proj/*", "wake", [SCOPE], "");
    subs.saveNote(note({ subId: sub.id, sessionId: sub.sessionId, lastEventId: tip.id }));

    const body = await get();
    expect(body.enabled).toBe(true);

    // Topics: one row per (topic, scope), each carrying its own live facts —
    // no shadowing, so the instance row shows its own tombstoned state. Most
    // recently written first, which is why the instance row leads.
    expect(body.topics.map((t) => [t.topic, t.scope, t.events, t.facts.map((f) => f.key)])).toEqual([
      ["proj/auth", "instance", 2, []],
      ["proj/auth", SCOPE, 2, ["owner"]],
    ]);
    // Every section's page sits beside the true total.
    expect([body.topicsTotal, body.subsTotal, body.notesTotal, body.eventsTotal]).toEqual([2, 1, 1, 4]);
    expect(body.topics[1]?.facts[0]).toMatchObject({ payload: '"alice"', writerSession: "writer-session-1" });
    // A read stamp is a fact this page shows and must never write.
    expect(body.topics.every((t) => t.lastReadAt === null)).toBe(true);

    // Subscriptions: the lag number, not the cursor, against pinned scopes.
    expect(body.subs).toEqual([{
      sessionId: "reader-session-9",
      topicGlob: "proj/*",
      mode: "wake",
      lag: 2,
      scopes: [SCOPE],
      createdAt: expect.any(String),
    }]);

    // Deliveries owed.
    expect(body.notes).toMatchObject([{ sessionId: "reader-session-9", topicGlob: "proj/*", state: "pending", attempts: 0 }]);

    // Recent events: newest first, tombstone included, writer named.
    expect(body.events.map((e) => [e.kind, e.scope, e.key])).toEqual([
      ["tombstone", "instance", "gone"],
      ["fact", "instance", "gone"],
      ["event", SCOPE, null],
      ["fact", SCOPE, "owner"],
    ]);
    expect(body.events[2]).toMatchObject({ payload: '"a plain moment"', writerSession: "writer-session-1", hops: 0 });
  });

  it("truncates a payload rather than shipping the 8KB cap 50 times over", async () => {
    const { events, get } = setup();
    events.publish({ topic: "proj/big", payload: JSON.stringify("x".repeat(4000)), scope: SCOPE, writerSession: "s1" });
    const [event] = (await get()).events;
    expect(event?.payload.length).toBeLessThan(300);
    expect(event?.payload.endsWith("…")).toBe(true);
  });

  it("lists a failed and an abandoned note, and drops the delivered one", async () => {
    const { subs, get } = setup();
    const sub = subs.upsert("reader-session-9", "proj/*", "queue", [SCOPE], "");
    subs.saveNote(note({ subId: sub.id, sessionId: sub.sessionId, callbackState: "failed", callbackAttempts: 3, callbackError: "session busy", callbackNextAttemptAt: 9_000, createdAt: 5000 }));
    // Deliberately the *oldest* row: nothing deletes an abandoned note, so a
    // plain newest-first page would eventually truncate the failures away.
    subs.saveNote(note({ subId: sub.id, sessionId: sub.sessionId, callbackState: "abandoned", callbackAttempts: 8, callbackError: "nothing can reach it", createdAt: 1000 }));
    subs.saveNote(note({ subId: sub.id, sessionId: sub.sessionId, callbackState: "delivered", createdAt: 9000 }));

    // Abandoned first, then newest — a failure is never filtered out or
    // paged out (AGENTS.md 5b).
    expect((await get()).notes.map((n) => [n.state, n.attempts, n.error, n.nextAttemptAt])).toEqual([
      ["abandoned", 8, "nothing can reach it", null],
      ["failed", 3, "session busy", 9_000],
    ]);
  });

  it("reports the switch off while still answering with the frozen state", async () => {
    const { events, subs, get } = setup(false);
    events.publish({ topic: "proj/auth", key: "owner", kind: "fact", payload: '"alice"', scope: SCOPE, writerSession: "s1" });
    const sub = subs.upsert("reader-session-9", "proj/*", "queue", [SCOPE], "");
    subs.saveNote(note({ subId: sub.id, sessionId: sub.sessionId }));

    const body = await get();
    // Off freezes delivery, it does not empty the tables: a note still owed
    // must not read as "nothing is owed" (the view draws the empty state).
    expect(body.enabled).toBe(false);
    expect(body.topics).toHaveLength(1);
    expect(body.notes).toHaveLength(1);
  });

  it("counts archived rows beside live ones for the same topic", async () => {
    const { events, get } = setup();
    const first = events.publish({ topic: "proj/log", payload: '"1"', scope: SCOPE, writerSession: "s1" }, 1000);
    events.publish({ topic: "proj/log", payload: '"2"', scope: SCOPE, writerSession: "s1" }, 2000);
    expect(events.archive("proj/log", first.id, SCOPE)).toBe(1);

    const [topic] = (await get()).topics;
    expect(topic).toMatchObject({ topic: "proj/log", events: 1, archived: 1 });
    // The tail is the live stream; the archived event is out of it.
    expect((await get()).events).toHaveLength(1);
    expect((await get()).eventsTotal).toBe(1);
  });

  it("caps a topic's facts and says there are more, instead of shipping them all", async () => {
    const { events, get } = setup();
    for (let i = 0; i < 25; i++) {
      events.publish({ topic: "proj/wide", key: `k${i}`, kind: "fact", payload: '"v"', scope: SCOPE, writerSession: "s1" });
    }
    const [topic] = (await get()).topics;
    expect(topic?.facts).toHaveLength(20);
    expect(topic?.factsMore).toBe(true);
    // The count of events is untouched by the facts page — it is the history.
    expect(topic?.events).toBe(25);
  });

  it("orders topics by what moved last, so a capped page keeps the live ones", async () => {
    const { events, get } = setup();
    events.publish({ topic: "proj/old", payload: '"1"', scope: SCOPE, writerSession: "s1" }, 1000);
    events.publish({ topic: "proj/new", payload: '"2"', scope: SCOPE, writerSession: "s1" }, 90_000);
    expect((await get()).topics.map((t) => t.topic)).toEqual(["proj/new", "proj/old"]);
  });
});
