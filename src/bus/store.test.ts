import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { BusStore, MAX_HOPS, RATE_LIMIT } from "./store.js";

const SCOPE = "project:/p";
const SCOPES = [SCOPE];

const store = () => new BusStore(openDb(":memory:"));

const publish = (
  s: BusStore,
  over: Partial<Parameters<BusStore["publish"]>[0]> = {},
  now?: number,
) =>
  s.publish({
    topic: "proj/auth",
    payload: '"v"',
    scope: SCOPE,
    writerSession: "a",
    ...over,
  }, now);

describe("BusStore", () => {
  it("latest returns the newest value per key, across writers", () => {
    const s = store();
    publish(s, { key: "owner", kind: "fact", payload: '"alice"' }, 1000);
    publish(s, { key: "owner", kind: "fact", payload: '"bob"', writerSession: "b" }, 2000);
    publish(s, { key: "status", kind: "fact", payload: '"open"' }, 3000);

    const all = s.latest("proj/auth", SCOPES);
    expect(all.map((e) => [e.key, e.payload])).toEqual([["owner", '"bob"'], ["status", '"open"']]);
    expect(s.latest("proj/auth", SCOPES, "owner")[0]?.payload).toBe('"bob"');
  });

  it("log reads incrementally by cursor and in write order", () => {
    const s = store();
    // One millisecond on purpose: the monotonic ULID is what keeps the order.
    const first = publish(s, { payload: '"1"' }, 5000);
    publish(s, { payload: '"2"' }, 5000);
    publish(s, { topic: "proj/other", payload: '"x"' }, 5000);

    const page = s.log("proj/auth", SCOPES, first.id);
    expect(page.events.map((e) => e.payload)).toEqual(['"2"']);
    expect(s.log("proj/*", SCOPES).events).toHaveLength(3);
    // Cursor at the end: nothing new, cursor unchanged.
    const done = s.log("proj/auth", SCOPES, page.cursor);
    expect(done.events).toEqual([]);
    expect(done.cursor).toBe(page.cursor);
  });

  it("a tombstone hides the fact from latest but shows in log", () => {
    const s = store();
    publish(s, { key: "owner", kind: "fact" }, 1000);
    s.forget("proj/auth", "owner", SCOPE, "a", 2000);
    expect(s.latest("proj/auth", SCOPES, "owner")).toEqual([]);
    const kinds = s.log("proj/auth", SCOPES).events.map((e) => e.kind);
    expect(kinds).toEqual(["fact", "tombstone"]);
  });

  it("an expired fact has no value, and an older write does not resurface", () => {
    const s = store();
    publish(s, { key: "k", kind: "fact", payload: '"old"' }, 0);
    publish(s, { key: "k", kind: "fact", payload: '"new"', ttlSeconds: 10 }, 1000);
    expect(s.latest("proj/auth", SCOPES, "k", 5000)[0]?.payload).toBe('"new"');
    expect(s.latest("proj/auth", SCOPES, "k", 12_000)).toEqual([]);
  });

  it("reads are fenced by scope", () => {
    const s = store();
    publish(s, { key: "k", kind: "fact", scope: "project:/p" });
    publish(s, { key: "k", kind: "fact", scope: "project:/q", payload: '"theirs"' });
    publish(s, { key: "k", kind: "fact", scope: "instance", payload: '"shared"' });

    expect(s.latest("proj/auth", ["project:/p"], "k")[0]?.payload).toBe('"v"');
    expect(s.log("proj/auth", ["project:/p", "instance"]).events).toHaveLength(2);
    expect(s.latest("proj/auth", [], "k")).toEqual([]);
  });

  it("computes hops from caused_by and refuses a chain past the ceiling", () => {
    const s = store();
    let parent = publish(s, {});
    for (let hop = 1; hop <= MAX_HOPS; hop++) {
      parent = publish(s, { causedBy: parent.id });
      expect(parent.hops).toBe(hop);
    }
    expect(() => publish(s, { causedBy: parent.id })).toThrow(/causal chain exceeds 4 hops/);
    expect(() => publish(s, { causedBy: "nope" })).toThrow(/not found/);
  });

  it("rate-limits a writer per topic within the window", () => {
    const s = store();
    for (let i = 0; i < RATE_LIMIT; i++) publish(s, {}, 1000 + i);
    expect(() => publish(s, {}, 2000)).toThrow(/rate limit/);
    // A different topic, writer, or a later window are unaffected.
    expect(() => publish(s, { topic: "proj/other" }, 2000)).not.toThrow();
    expect(() => publish(s, { writerSession: "b" }, 2000)).not.toThrow();
    expect(() => publish(s, {}, 1000 + 61_000)).not.toThrow();
  });

  it("rejects malformed topics, oversized payloads and bad TTLs", () => {
    const s = store();
    expect(() => publish(s, { topic: "Bad/Topic" })).toThrow(/topic/);
    expect(() => publish(s, { topic: "a".repeat(129) })).toThrow(/topic/);
    expect(() => publish(s, { payload: JSON.stringify("x".repeat(9000)) })).toThrow(/file_ptr/);
    expect(() => publish(s, { ttlSeconds: -1 })).toThrow(/ttl/);
    expect(() => s.log("proj/{bad}", SCOPES)).toThrow(/topic_glob/);
  });
});
