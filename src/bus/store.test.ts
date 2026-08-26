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
    s.forget("proj/auth", "owner", SCOPE, "a", undefined, 2000);
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

  it("ids stay monotonic across a restart even when the clock steps back", () => {
    const db = openDb(":memory:");
    const before = new BusStore(db).publish(
      { topic: "t", payload: "1", scope: SCOPE, writerSession: "a" }, 10_000);
    // Second store on the same database = the process restarted; the wall
    // clock stepped back (NTP). An id below `before.id` would hide this event
    // from every cursor that already passed it.
    const after = new BusStore(db).publish(
      { topic: "t", payload: "2", scope: SCOPE, writerSession: "a" }, 5_000);
    expect(after.id > before.id).toBe(true);
    expect(new BusStore(db).log("t", SCOPES, before.id).events.map((e) => e.id)).toEqual([after.id]);
  });

  it("a narrower scope's fact shadows a wider one's; forgetting it reveals the wider", () => {
    const s = store();
    const scopes = ["project:/p", "instance"];
    publish(s, { key: "k", kind: "fact", payload: '"default"', scope: "instance" }, 1000);
    publish(s, { key: "k", kind: "fact", payload: '"override"', scope: "project:/p" }, 2000);
    publish(s, { key: "k", kind: "fact", payload: '"new-default"', scope: "instance" }, 3000);
    // The newer instance write does not poison the project's own fact …
    expect(s.latest("proj/auth", scopes, "k")[0]?.payload).toBe('"override"');
    // … and a tombstone ends only its own scope's claim.
    s.forget("proj/auth", "k", "project:/p", "a", undefined, 4000);
    expect(s.latest("proj/auth", scopes, "k")[0]?.payload).toBe('"new-default"');
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
    const first = publish(s, {});
    let parent = first;
    for (let hop = 1; hop <= MAX_HOPS; hop++) {
      parent = publish(s, { causedBy: parent.id });
      expect(parent.hops).toBe(hop);
    }
    expect(() => publish(s, { causedBy: parent.id })).toThrow(/causal chain exceeds 4 hops/);
    expect(() => publish(s, { causedBy: "nope" })).toThrow(/not found/);
    // forget is a write like any other: a reactive delete cannot evade the ceiling.
    const tombstone = s.forget("proj/auth", "k", SCOPE, "a", first.id);
    expect(tombstone.hops).toBe(1);
    expect(() => s.forget("proj/auth", "k", SCOPE, "a", parent.id)).toThrow(/feedback loop/);
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

  it("search finds payload and topic words, scope-fenced, newest first", () => {
    const s = store();
    publish(s, { topic: "proj/auth", payload: JSON.stringify("the login token expired") }, 1000);
    publish(s, { topic: "proj/deploy", payload: JSON.stringify("rolled back the release") }, 2000);
    publish(s, { topic: "proj/auth", payload: JSON.stringify("token refreshed") }, 3000);
    publish(s, { topic: "other/auth", payload: JSON.stringify("token elsewhere"), scope: "project:/q" }, 4000);

    const hits = s.search("token", SCOPES);
    expect(hits.map((e) => e.topic)).toEqual(["proj/auth", "proj/auth"]); // /q fenced out
    expect(s.search("auth", SCOPES)).toHaveLength(2); // topic words match too
    expect(s.search("rolled", SCOPES)).toHaveLength(1);
    expect(s.search("nothing-here", SCOPES)).toEqual([]);
    // A tombstone has no text worth finding.
    publish(s, { key: "k", kind: "fact", payload: JSON.stringify("findable-fact") }, 5000);
    s.forget("proj/auth", "k", SCOPE, "a", undefined, 6000);
    expect(s.search("findable-fact", SCOPES)).toHaveLength(1); // the fact, not its tombstone
    // FTS5 would call these syntax errors; the token-quoting retry makes
    // plain text — hyphens, stray quotes — just work as literal words.
    expect(s.search('"unbalanced', SCOPES)).toEqual([]);
    expect(s.search("nothing-here", SCOPES)).toEqual([]);
    // … and a quoted hyphenated token is a phrase: adjacent words match.
    expect(s.search("login-token", SCOPES)).toHaveLength(1);
    expect(() => s.search("  ", SCOPES)).toThrow(/query required/);
  });

  it("archive moves events out of every default read, but not out of history", () => {
    const s = store();
    const old1 = publish(s, { payload: '"old-1"' }, 1000);
    const old2 = publish(s, { key: "k", kind: "fact", payload: '"old-fact"' }, 2000);
    const fresh = publish(s, { payload: '"fresh"' }, 3000);

    expect(s.archive("proj/auth", old2.id, SCOPES)).toBe(2);
    // Default reads see only what stayed live …
    expect(s.log("proj/*", SCOPES).events.map((e) => e.id)).toEqual([fresh.id]);
    expect(s.latest("proj/auth", SCOPES, "k")).toEqual([]);
    expect(s.search("old-1", SCOPES)).toEqual([]);
    // … history is one flag away, in order, cursor semantics intact.
    const all = s.log("proj/*", SCOPES, "", 50, true);
    expect(all.events.map((e) => e.id)).toEqual([old1.id, old2.id, fresh.id]);
    // Scope fence holds: another project archives nothing.
    expect(s.archive("proj/*", fresh.id, ["project:/q"])).toBe(0);
  });

  it("topics reports counts, freshness and who was last read", () => {
    const s = store();
    publish(s, { topic: "proj/auth", payload: '"1"' }, 1000);
    const newest = publish(s, { topic: "proj/auth", payload: '"2"' }, 2000);
    publish(s, { topic: "proj/deploy", payload: '"3"' }, 3000);

    const before = s.topics(SCOPES);
    expect(before).toEqual([
      { topic: "proj/auth", events: 2, newestId: newest.id, lastReadAt: null },
      { topic: "proj/deploy", events: 3 - 2, newestId: expect.any(String) as unknown as string, lastReadAt: null },
    ]);
    // get and log stamp the read; the stamp is what "nobody reads this" means.
    s.log("proj/auth", SCOPES, "", 50);
    const after = s.topics(SCOPES);
    expect(after[0]!.lastReadAt).not.toBeNull();
    expect(after[1]!.lastReadAt).toBeNull();
  });

  it("rejects the writes that would sit half in each world", () => {
    const s = store();
    expect(() => publish(s, { topic: "Bad/Topic" })).toThrow(/topic/);
    expect(() => publish(s, { topic: "a".repeat(129) })).toThrow(/topic/);
    expect(() => publish(s, { payload: JSON.stringify("x".repeat(9000)) })).toThrow(/file_ptr/);
    expect(() => publish(s, { payload: "not json" })).toThrow(/JSON/);
    expect(() => publish(s, { key: "k" })).toThrow(/omit key/);
    expect(() => publish(s, { kind: "fact" })).toThrow(/needs a key/);
    expect(() => publish(s, { ttlSeconds: 60 })).toThrow(/facts/);
    expect(() => publish(s, { key: "k", kind: "fact", ttlSeconds: -1 })).toThrow(/positive integer/);
    expect(() => publish(s, { filePtr: "relative/path.md" })).toThrow(/absolute/);
    expect(() => s.log("proj/{bad}", SCOPES)).toThrow(/topic_glob/);
  });
});
