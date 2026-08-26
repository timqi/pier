import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const all = s.latest("proj/auth", SCOPES).winners;
    expect(all.map((e) => [e.key, e.payload])).toEqual([["owner", '"bob"'], ["status", '"open"']]);
    expect(s.latest("proj/auth", SCOPES, "owner").winners[0]?.payload).toBe('"bob"');
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
    expect(s.latest("proj/auth", SCOPES, "owner").winners).toEqual([]);
    const kinds = s.log("proj/auth", SCOPES).events.map((e) => e.kind);
    expect(kinds).toEqual(["fact", "tombstone"]);
  });

  it("an expired fact has no value, and an older write does not resurface", () => {
    const s = store();
    publish(s, { key: "k", kind: "fact", payload: '"old"' }, 0);
    publish(s, { key: "k", kind: "fact", payload: '"new"', ttlSeconds: 10 }, 1000);
    expect(s.latest("proj/auth", SCOPES, "k", 5000).winners[0]?.payload).toBe('"new"');
    expect(s.latest("proj/auth", SCOPES, "k", 12_000).winners).toEqual([]);
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
    expect(s.latest("proj/auth", scopes, "k").winners[0]?.payload).toBe('"override"');
    // … and a tombstone ends only its own scope's claim.
    s.forget("proj/auth", "k", "project:/p", "a", undefined, 4000);
    expect(s.latest("proj/auth", scopes, "k").winners[0]?.payload).toBe('"new-default"');
  });

  it("latest refuses two sibling run scopes each holding a live value under one key", () => {
    const s = store();
    const scopes = ["run:r1", "run:r2", "project:/p", "instance"];
    publish(s, { key: "k", kind: "fact", payload: '"one"', scope: "run:r1" }, 1000);
    publish(s, { key: "k", kind: "fact", payload: '"two"', scope: "run:r2" }, 2000);
    // Sibling run trees have no narrow-to-wide order; picking by the scope
    // set's insertion order would silently drop the other sibling's value.
    expect(() => s.latest("proj/auth", scopes, "k")).toThrow(/ambiguous/);
    // The refusal names the escape it expects the caller to use.
    expect(() => s.latest("proj/auth", scopes, "k")).toThrow(/run:r1 or run:r2/);
    // Keyless, the contest is a result: a throw would let one contested key
    // hide every uncontested one on the topic.
    publish(s, { key: "other", kind: "fact", payload: '"plain"', scope: "run:r1" }, 2500);
    const both = s.latest("proj/auth", scopes, undefined, 2600);
    expect(both.winners.map((e) => [e.key, e.payload])).toEqual([["other", '"plain"']]);
    expect(both.ambiguous).toEqual([{ key: "k", scopes: ["run:r1", "run:r2"] }]);
    // One live sibling is not an ambiguity — tombstoning the other resolves it …
    s.forget("proj/auth", "k", "run:r2", "a", undefined, 3000);
    expect(s.latest("proj/auth", scopes, "k", 4000).winners[0]?.payload).toBe('"one"');
    // … and a single-run caller never trips it.
    expect(s.latest("proj/auth", ["run:r2", "instance"], "k", 4000).winners).toEqual([]);
  });

  it("reads are fenced by scope", () => {
    const s = store();
    publish(s, { key: "k", kind: "fact", scope: "project:/p" });
    publish(s, { key: "k", kind: "fact", scope: "project:/q", payload: '"theirs"' });
    publish(s, { key: "k", kind: "fact", scope: "instance", payload: '"shared"' });

    expect(s.latest("proj/auth", ["project:/p"], "k").winners[0]?.payload).toBe('"v"');
    expect(s.log("proj/auth", ["project:/p", "instance"]).events).toHaveLength(2);
    expect(s.latest("proj/auth", [], "k").winners).toEqual([]);
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
    // A tombstone has no text worth finding, and it takes the value it
    // retracted out of the index with it (the case below has the detail).
    publish(s, { key: "k", kind: "fact", payload: JSON.stringify("findable-fact") }, 5000);
    expect(s.search("findable-fact", SCOPES)).toHaveLength(1);
    s.forget("proj/auth", "k", SCOPE, "a", undefined, 6000);
    expect(s.search("findable-fact", SCOPES)).toEqual([]);
    // FTS5 would call these syntax errors; the token-quoting retry makes
    // plain text — hyphens, stray quotes — just work as literal words.
    expect(s.search('"unbalanced', SCOPES)).toEqual([]);
    expect(s.search("nothing-here", SCOPES)).toEqual([]);
    // … and a quoted hyphenated token is a phrase: adjacent words match.
    expect(s.search("login-token", SCOPES)).toHaveLength(1);
    expect(() => s.search("  ", SCOPES)).toThrow(/query required/);
  });

  it("search answers with the current value only — superseded, forgotten and expired are gone", () => {
    const s = store();
    publish(s, { key: "owner", kind: "fact", payload: JSON.stringify("alice-the-first") }, 1000);
    publish(s, { key: "owner", kind: "fact", payload: JSON.stringify("bob-the-second") }, 2000);
    // A superseded revision is not a hit: relevance knows nothing about
    // recency, so an indexed old value would often rank above the live one.
    expect(s.search("alice-the-first", SCOPES)).toEqual([]);
    expect(s.search("bob-the-second", SCOPES)).toHaveLength(1);
    // Same key in another scope is its own fact: pruning is per (topic, key,
    // scope), so a project override must not evict the instance default.
    publish(s, { key: "owner", kind: "fact", payload: JSON.stringify("wide-default"), scope: "instance" }, 2500);
    publish(s, { key: "owner", kind: "fact", payload: JSON.stringify("narrow-override") }, 2600);
    expect(s.search("wide-default", [...SCOPES, "instance"])).toHaveLength(1);
    // Forgetting clears the key out of the index: the tombstone is never
    // indexed itself, and it prunes what it retracts.
    s.forget("proj/auth", "owner", SCOPE, "a", undefined, 3000);
    expect(s.search("narrow-override", SCOPES)).toEqual([]);
    // An unkeyed event is a moment on the stream — nothing supersedes it.
    publish(s, { payload: JSON.stringify("plain-moment") }, 3100);
    publish(s, { payload: JSON.stringify("plain-moment") }, 3200);
    expect(s.search("plain-moment", SCOPES)).toHaveLength(2);
    // TTL cannot be a trigger — nothing is written when it passes — so the
    // expired hit is dropped against the clock the caller passes.
    publish(s, { key: "tmp", kind: "fact", payload: JSON.stringify("expiring-soon"), ttlSeconds: 10 }, 4000);
    expect(s.search("expiring-soon", SCOPES, 20, 5000)).toHaveLength(1);
    expect(s.search("expiring-soon", SCOPES, 20, 20_000)).toEqual([]);
  });

  it("the migration backfills an index that already holds superseded revisions", () => {
    // The operator's database is the one this has to work on: written at
    // schema 9, where every revision was indexed. Reproduced by stepping a
    // real database back to 9 — the trigger gone, the version with it — and
    // writing the dead revisions the way that Pier would have.
    const path = join(mkdtempSync(join(tmpdir(), "pier-bus-")), "pier.db");
    const old = openDb(path);
    old.exec("DROP TRIGGER bus_events_fts_supersede; PRAGMA user_version = 9");
    const before = new BusStore(old);
    const write = (key: string, value: string, now: number) =>
      before.publish({
        topic: "proj/auth", key, kind: "fact", payload: JSON.stringify(value),
        scope: SCOPE, writerSession: "a",
      }, now);
    write("k", "stale-value", 1000);
    write("k", "fresh-value", 2000);
    write("gone", "retracted-value", 3000);
    before.forget("proj/auth", "gone", SCOPE, "a", undefined, 4000);
    // Pre-upgrade, finding the dead values *is* the bug.
    expect(before.search("stale-value", SCOPES)).toHaveLength(1);
    expect(before.search("retracted-value", SCOPES)).toHaveLength(1);
    old.close();

    const after = new BusStore(openDb(path));
    expect(after.search("stale-value", SCOPES)).toEqual([]);
    expect(after.search("retracted-value", SCOPES)).toEqual([]);
    expect(after.search("fresh-value", SCOPES)).toHaveLength(1);
  });

  it("archiveDeadRunScope moves a whole unreachable run scope, index included", () => {
    const s = store();
    const first = publish(s, { payload: JSON.stringify("run-chatter"), scope: "run:r1" }, 1000);
    publish(s, { key: "k", kind: "fact", payload: JSON.stringify("run-fact"), scope: "run:r1" }, 2000);
    const kept = publish(s, { payload: JSON.stringify("project-chatter") }, 3000);

    // No glob, no anchor: nothing in a dead scope is reachable, so there is
    // no live event a caller could name as a boundary.
    expect(s.archiveDeadRunScope("run:r1")).toBe(2);
    expect(s.log("proj/*", ["run:r1", SCOPE]).events.map((e) => e.id)).toEqual([kept.id]);
    expect(s.latest("proj/auth", ["run:r1"], "k").winners).toEqual([]);
    expect(s.search("run-chatter", ["run:r1", SCOPE])).toEqual([]); // FTS followed the DELETE
    expect(s.search("run-fact", ["run:r1", SCOPE])).toEqual([]);
    // History and identity survive, so a cursor into the swept scope still acks.
    expect(s.log("proj/*", ["run:r1"], "", 50, true).events).toHaveLength(2);
    expect(s.seenBy(first.id, "proj/*", ["run:r1"])).toBe(true);
    expect(s.byId(first.id)?.payload).toBe(JSON.stringify("run-chatter"));
    // A second sweep of the same scope is a no-op, not a duplicate row.
    expect(s.archiveDeadRunScope("run:r1")).toBe(0);
    // Only a run scope has a lifetime that can end; the others would lose
    // live facts with no restore tool.
    expect(() => s.archiveDeadRunScope(SCOPE)).toThrow(/only a run scope/);
    expect(() => s.archiveDeadRunScope("instance")).toThrow(/only a run scope/);
    expect(s.runScopes()).toEqual([]); // nothing live left under run:
    publish(s, { payload: '"x"', scope: "run:r2" }, 5000);
    expect(s.runScopes()).toEqual(["run:r2"]);
  });

  it("archive moves one scope's events out of every default read, but not out of history", () => {
    const s = store();
    const old1 = publish(s, { payload: '"old-1"' }, 1000);
    const old2 = publish(s, { key: "k", kind: "fact", payload: '"old-fact"' }, 2000);
    const fresh = publish(s, { payload: '"fresh"' }, 3000);

    expect(s.archive("proj/auth", old2.id, SCOPE)).toBe(2);
    // Default reads see only what stayed live …
    expect(s.log("proj/*", SCOPES).events.map((e) => e.id)).toEqual([fresh.id]);
    expect(s.latest("proj/auth", SCOPES, "k").winners).toEqual([]);
    expect(s.search("old-1", SCOPES)).toEqual([]);
    // … history is one flag away, in order, cursor semantics intact.
    const all = s.log("proj/*", SCOPES, "", 50, true);
    expect(all.events.map((e) => e.id)).toEqual([old1.id, old2.id, fresh.id]);
    // Identity survives the move: a held cursor still acks, a reaction to
    // archived history still counts its hops.
    expect(s.seenBy(old1.id, "proj/*", SCOPES)).toBe(true);
    expect(publish(s, { causedBy: old1.id }, 4000).hops).toBe(1);
    // The boundary must be a real event in the target scope — not a made-up
    // ceiling that would archive the scope whole, not another scope's id.
    expect(() => s.archive("proj/*", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", SCOPE)).toThrow(/live event/);
    expect(() => s.archive("proj/*", fresh.id, "project:/q")).toThrow(/live event/);
  });

  it("ids stay monotonic across a restart even when the tip was archived", () => {
    const db = openDb(":memory:");
    const first = new BusStore(db);
    const tip = first.publish({ topic: "t", payload: "1", scope: SCOPE, writerSession: "a" }, 10_000);
    first.archive("t", tip.id, SCOPE);
    const after = new BusStore(db).publish(
      { topic: "t", payload: "2", scope: SCOPE, writerSession: "a" }, 5_000);
    expect(after.id > tip.id).toBe(true);
  });

  it("topics reports counts, freshness and who was last read; peek does not count", () => {
    const s = store();
    publish(s, { topic: "proj/auth", payload: '"1"' }, 1000);
    const newest = publish(s, { topic: "proj/auth", payload: '"2"' }, 2000);
    publish(s, { topic: "proj/deploy", payload: '"3"' }, 3000);

    // Per (topic, scope): archive targets one scope, so an aggregate row
    // spanning scopes could name no usable boundary.
    publish(s, { topic: "proj/auth", payload: '"wide"', scope: "instance" }, 3500);
    expect(s.topics([...SCOPES, "instance"])).toEqual([
      {
        topic: "proj/auth", scope: "instance", events: 1,
        newestId: expect.any(String) as unknown as string,
        newestCreatedAt: new Date(3500).toISOString(), lastReadAt: null,
      },
      {
        topic: "proj/auth", scope: SCOPE, events: 2, newestId: newest.id,
        newestCreatedAt: new Date(2000).toISOString(), lastReadAt: null,
      },
      {
        topic: "proj/deploy", scope: SCOPE, events: 1,
        newestId: expect.any(String) as unknown as string,
        newestCreatedAt: new Date(3000).toISOString(), lastReadAt: null,
      },
    ]);
    // A maintenance pass must not look like a reader, or nothing ever ages out.
    s.log("proj/auth", SCOPES, "", 50, false, true);
    s.latest("proj/auth", SCOPES, undefined, 4000, true);
    expect(s.topics(SCOPES).every((t) => t.lastReadAt === null)).toBe(true);
    // A real reader stamps — including a poller whose page came back empty:
    // it is monitoring the topic, which is exactly what "still read" means.
    const tip = s.log("proj/auth", SCOPES, "", 50, false, true).cursor;
    const polled = s.log("proj/auth", SCOPES, tip);
    expect(polled.events).toEqual([]);
    const after = s.topics(SCOPES);
    expect(after[0]!.lastReadAt).not.toBeNull();
    expect(after[1]!.lastReadAt).toBeNull();
  });

  it("adminFacts settles liveness before the cap, so the page cannot be all expired", () => {
    const s = store();
    // The safety stop is 1000 rows in key order. With the TTL filter applied
    // after it, a topic holding 1000 expired facts answers with an empty page
    // and the live key behind them is simply not there.
    for (let i = 0; i < 1000; i++) {
      publish(s, {
        key: `k${String(i).padStart(4, "0")}`, kind: "fact", payload: '"gone"',
        ttlSeconds: 10, writerSession: `w${i}`,
      }, 1000);
    }
    publish(s, { key: "zzz-live", kind: "fact", payload: '"here"' }, 1000);
    const facts = s.adminFacts("proj/auth", SCOPE, 100_000);
    expect(facts.map((e) => e.key)).toEqual(["zzz-live"]);
    // Before it expires, the same page answers with everything.
    expect(s.adminFacts("proj/auth", SCOPE, 2000)).toHaveLength(1000); // capped at the stop
  });

  it("search relabels only the caller's grammar — a broken database reaches them as itself", () => {
    const db = openDb(":memory:");
    const s = new BusStore(db);
    s.publish({ topic: "proj/auth", payload: '"token"', scope: SCOPE, writerSession: "a" });
    const locked = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    (db as unknown as { prepare: () => never }).prepare = () => { throw locked; };
    // The retry exists for FTS5 query syntax. Catching everything sent
    // SQLITE_BUSY, I/O errors and corruption to whoever debugs a typo.
    expect(() => s.search("token", SCOPES)).toThrow(locked);
    expect(() => s.search("token", SCOPES)).not.toThrow(/valid search query/);
  });

  it("read stamps coalesce to the hour — the read paths are hot", () => {
    const s = store();
    publish(s, { topic: "proj/auth", payload: '"1"' }, 1000);
    s.stampRead(["proj/auth"], 10_000);
    s.stampRead(["proj/auth"], 20_000); // within the hour: kept, not rewritten
    expect(s.topics(SCOPES)[0]!.lastReadAt).toBe(10_000);
    s.stampRead(["proj/auth"], 10_000 + 3_600_001);
    expect(s.topics(SCOPES)[0]!.lastReadAt).toBe(3_610_001);
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
    // A key is a name: it rides in every get, index row and error message.
    expect(() => publish(s, { key: "k".repeat(257), kind: "fact" })).toThrow(/key exceeds 256 bytes/);
    expect(() => publish(s, { key: "\u00e9".repeat(129), kind: "fact" })).toThrow(/key exceeds 256 bytes/); // bytes, not chars
    expect(() => publish(s, { key: "k".repeat(256), kind: "fact" })).not.toThrow();
    expect(() => s.log("proj/{bad}", SCOPES)).toThrow(/topic_glob/);
  });
});
