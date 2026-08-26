import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { BusStore, type BusEvent } from "./store.js";
import { SubStore } from "./subs.js";
import { handleBusTool, type BusCaller } from "./tool.js";

// Sessions the resolver knows: A and B share a project, "run-child" is a
// subagent inside run tree r1, "coordinator" delegated r1 (and "fanout" two
// trees), "nowhere" resolves to nothing.
const caller: BusCaller = {
  resolve: async (id) => ({
    "a": { cwd: "/p" },
    "b": { cwd: "/p" },
    "c": { cwd: "/q" },
    "run-child": { rootRunId: "r1", cwd: "/p" },
    "run-child-2": { rootRunId: "r2", cwd: "/p" },
    "coordinator": { cwd: "/p", invokedRootRunIds: ["r1"] },
    "fanout": { cwd: "/p", invokedRootRunIds: ["r1", "r2"] },
  }[id] ?? {}),
};

const tool = (db = openDb(":memory:"), notified: BusEvent[] = []) => {
  const deps = {
    store: new BusStore(db),
    subs: new SubStore(db),
    caller,
    notify: (event: BusEvent) => { notified.push(event); return () => {}; },
    enabled: () => true,
  };
  return (params: unknown, sessionId: string) => handleBusTool(deps, params, sessionId);
};

describe("bus tool", () => {
  it("A publishes a fact, B in the same project gets the latest", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "proj/auth", key: "owner", payload: "alice" }, "a");
    await call({ operation: "publish", topic: "proj/auth", key: "owner", payload: { name: "bob" } }, "a");

    const got = await call({ operation: "get", topic: "proj/auth", key: "owner" }, "b");
    expect(got).toMatchObject({ kind: "fact", payload: { name: "bob" }, scope: "project:/p" });
    // Same topic, different project: invisible.
    expect(await call({ operation: "get", topic: "proj/auth", key: "owner" }, "c")).toBeNull();
    // Without key: every live (key, value) on the topic.
    expect(await call({ operation: "get", topic: "proj/auth" }, "b")).toHaveLength(1);
  });

  it("B reads the stream incrementally with log and its cursor", async () => {
    const call = tool();
    const { id } = await call({ operation: "publish", topic: "proj/auth", payload: 1 }, "a") as { id: string };
    await call({ operation: "publish", topic: "proj/auth", payload: 2 }, "a");

    const page = await call({ operation: "log", topic_glob: "proj/*", after: id }, "b") as
      { events: { payload: unknown }[]; cursor: string };
    expect(page.events.map((e) => e.payload)).toEqual([2]);
    const done = await call({ operation: "log", topic_glob: "proj/*", after: page.cursor }, "b") as { events: unknown[] };
    expect(done.events).toEqual([]);
  });

  it("forget removes the fact for every reader and leaves a tombstone in log", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "proj/auth", key: "owner", payload: "alice" }, "a");
    await call({ operation: "forget", topic: "proj/auth", key: "owner" }, "b");
    expect(await call({ operation: "get", topic: "proj/auth", key: "owner" }, "a")).toBeNull();
    const page = await call({ operation: "log", topic_glob: "proj/auth" }, "a") as
      { events: { kind: string; writer_session: string }[] };
    expect(page.events.map((e) => e.kind)).toEqual(["fact", "tombstone"]);
    // The stream names its writers; a subscriber skips its own events by this.
    expect(page.events.map((e) => e.writer_session)).toEqual(["a", "b"]);
  });

  it("a subagent's forget lands where the winner lives, not in its run scope", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "proj/auth", key: "owner", payload: "alice" }, "a");
    await call({ operation: "forget", topic: "proj/auth", key: "owner" }, "run-child");
    // A run-scoped tombstone would hide it from the run only — and reveal it
    // again the moment the run ends.
    expect(await call({ operation: "get", topic: "proj/auth", key: "owner" }, "a")).toBeNull();
  });

  it("forget refuses to follow the winner into instance scope without explicit confirmation", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "shared", scope: "instance" }, "a");
    // Following the winner here would tombstone an instance-wide fact from a
    // project-scoped call — the silent widening publish's writeScope refuses.
    await expect(call({ operation: "forget", topic: "t", key: "k" }, "b"))
      .rejects.toThrow(/pass scope 'instance'/);
    await expect(call({ operation: "forget", topic: "t", key: "k" }, "run-child"))
      .rejects.toThrow(/pass scope 'instance'/);
    // Explicit confirmation deletes it for everyone, other projects included.
    await call({ operation: "forget", topic: "t", key: "k", scope: "instance" }, "b");
    expect(await call({ operation: "get", topic: "t", key: "k" }, "c")).toBeNull();
  });

  it("get refuses when two sibling run trees each hold a live fact under one key", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "one" }, "run-child");
    await call({ operation: "publish", topic: "t", key: "k", payload: "two" }, "run-child-2");
    // The fan-out coordinator stands in both trees; runRoots insertion order
    // must not silently pick which sibling's value wins.
    await expect(call({ operation: "get", topic: "t", key: "k" }, "fanout"))
      .rejects.toThrow(/ambiguous/);
    // An explicit scope reads past the siblings; one tree alone still resolves.
    expect(await call({ operation: "get", topic: "t", key: "k", scope: "project" }, "fanout")).toBeNull();
    expect(await call({ operation: "get", topic: "t", key: "k" }, "coordinator")).toMatchObject({ payload: "one" });
  });

  it("a publish and the notes it owes are one durable fact", async () => {
    const db = openDb(":memory:");
    const store = new BusStore(db);
    const call = (params: unknown) => handleBusTool({
      store,
      subs: new SubStore(db),
      caller,
      // The crash window, as an exception: the notes cannot be written.
      notify: () => { throw new Error("note store down"); },
      enabled: () => true,
    }, params, "a");
    await expect(call({ operation: "publish", topic: "t", payload: 1 })).rejects.toThrow(/note store down/);
    // The failure the caller was told about is the truth: an event kept here
    // would be undeliverable forever (the sweep's worklist is notes), and the
    // caller retrying its publish would leave two.
    expect(store.log("t", ["project:/p"]).events).toEqual([]);
    await expect(call({ operation: "forget", topic: "t", key: "k" })).rejects.toThrow(/note store down/);
    expect(store.log("t", ["project:/p"]).events).toEqual([]);
  });

  it("a contested key does not hide the rest of the topic from a keyless get", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "one" }, "run-child");
    await call({ operation: "publish", topic: "t", key: "k", payload: "two" }, "run-child-2");
    await call({ operation: "publish", topic: "t", key: "other", payload: "plain" }, "run-child");
    // The fan-out coordinator stands in both trees. Refusing the whole read
    // would make one contested key hide every uncontested one on the topic.
    expect(await call({ operation: "get", topic: "t" }, "fanout")).toEqual([
      expect.objectContaining({ key: "other", payload: "plain" }),
      { key: "k", ambiguous: true, scopes: ["run:r1", "run:r2"] },
    ]);
    // Asked for that key alone, the refusal stands — and names the escape.
    await expect(call({ operation: "get", topic: "t", key: "k" }, "fanout"))
      .rejects.toThrow(/run:r1 or run:r2/);
  });

  it("scope 'run:<rootRunId>' names one tree of several, and only the caller's own", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "one" }, "run-child");
    await call({ operation: "publish", topic: "t", key: "k", payload: "two" }, "run-child-2");
    // The escape both ambiguity refusals advertise, on every operation that
    // takes a scope: an exact fence for get, publish, forget, search, archive.
    const write = await call({ operation: "publish", topic: "t", payload: 1, scope: "run:r2" }, "fanout") as { scope: string };
    expect(write.scope).toBe("run:r2");
    expect(await call({ operation: "get", topic: "t", key: "k", scope: "run:r1" }, "fanout"))
      .toMatchObject({ payload: "one" });
    // Validated against the caller's own memberships: naming a tree it does
    // not stand in would reach a blackboard that is not its to read or write.
    await expect(call({ operation: "publish", topic: "t", payload: 1, scope: "run:r9" }, "fanout"))
      .rejects.toThrow(/not one of your run trees — yours: run:r1, run:r2/);
    await expect(call({ operation: "get", topic: "t", key: "k", scope: "run:r1" }, "a"))
      .rejects.toThrow(/you stand in none/);
    // Bare 'run' is unchanged; its refusal now says how to get past it.
    await expect(call({ operation: "publish", topic: "t", payload: 1, scope: "run" }, "fanout"))
      .rejects.toThrow(/name one as scope 'run:<rootRunId>' \(run:r1, run:r2\)/);
    await expect(call({ operation: "publish", topic: "t", payload: 1, scope: "elsewhere" }, "a"))
      .rejects.toThrow(/scope must be/);
  });

  it("scope defaults to the run tree for a subagent, else the project, else errors", async () => {
    const call = tool();
    const inRun = await call({ operation: "publish", topic: "t", payload: 1 }, "run-child") as { scope: string };
    expect(inRun.scope).toBe("run:r1");
    const inProject = await call({ operation: "publish", topic: "t", payload: 1 }, "a") as { scope: string };
    expect(inProject.scope).toBe("project:/p");
    await expect(call({ operation: "publish", topic: "t", payload: 1 }, "nowhere"))
      .rejects.toThrow(/pass scope explicitly/);
    // Explicit widening works; explicit narrowing to a run needs a run.
    const wide = await call({ operation: "publish", topic: "t", payload: 1, scope: "instance" }, "a") as { scope: string };
    expect(wide.scope).toBe("instance");
    await expect(call({ operation: "publish", topic: "t", payload: 1, scope: "run" }, "a"))
      .rejects.toThrow(/task run/);
  });

  it("a coordinator reads its children's run tree; writes to it only explicitly and unambiguously", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "from-child" }, "run-child");
    // The delegator stands in the tree it started — a null here would be
    // indistinguishable from "no fact yet".
    expect(await call({ operation: "get", topic: "t", key: "k" }, "coordinator")).toMatchObject({ payload: "from-child" });
    // Its default write scope is still its project, not the child's tree …
    const write = await call({ operation: "publish", topic: "t", payload: 1 }, "coordinator") as { scope: string };
    expect(write.scope).toBe("project:/p");
    // … explicit 'run' addresses the one tree it runs; two trees is a guess.
    const explicit = await call({ operation: "publish", topic: "t", payload: 1, scope: "run" }, "coordinator") as { scope: string };
    expect(explicit.scope).toBe("run:r1");
    await expect(call({ operation: "publish", topic: "t", payload: 1, scope: "run" }, "fanout"))
      .rejects.toThrow(/ambiguous/);
  });

  it("run-scoped writes stay invisible outside the run tree, instance reaches everyone", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "t", key: "k", payload: "private" }, "run-child");
    expect(await call({ operation: "get", topic: "t", key: "k" }, "a")).toBeNull();
    await call({ operation: "publish", topic: "t", key: "k", payload: "shared", scope: "instance" }, "c");
    expect(await call({ operation: "get", topic: "t", key: "k" }, "a")).toMatchObject({ payload: "shared" });
  });

  it("caused_by accumulates hops across sessions until the ceiling refuses", async () => {
    const call = tool();
    let last = await call({ operation: "publish", topic: "t", payload: 0 }, "a") as { id: string };
    for (const writer of ["b", "a", "b", "a"]) {
      last = await call({ operation: "publish", topic: "t", payload: 1, caused_by: last.id }, writer) as { id: string };
    }
    await expect(call({ operation: "publish", topic: "t", payload: 2, caused_by: last.id }, "b"))
      .rejects.toThrow(/feedback loop/);
  });

  it("subscribe pins scopes and starts at the tip; ack moves the cursor; unsubscribe ends it", async () => {
    const notified: BusEvent[] = [];
    const call = tool(openDb(":memory:"), notified);
    const before = await call({ operation: "publish", topic: "proj/auth", payload: 0 }, "a") as { id: string };
    const sub = await call({ operation: "subscribe", topic_glob: "proj/*" }, "b") as
      { mode: string; cursor: string; scopes: string[] };
    // Hears the future, not a replay; sees exactly what B saw when it asked.
    expect(sub).toMatchObject({ mode: "queue", cursor: before.id, scopes: ["project:/p", "instance"] });

    const next = await call({ operation: "publish", topic: "proj/auth", payload: 1 }, "a") as { id: string };
    const ack = await call({ operation: "ack", topic_glob: "proj/*", cursor: next.id }, "b") as { cursor: string };
    expect(ack.cursor).toBe(next.id);
    // A cursor at or below the current one would silently reopen the backlog
    // and re-wake the subscriber for events it already confirmed.
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: next.id }, "b"))
      .rejects.toThrow(/already at/);
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: before.id }, "b"))
      .rejects.toThrow(/already at/);
    // A cursor that is not a real event id would silence the subscription
    // forever — every future note would settle as "already caught up".
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: "zzz" }, "b"))
      .rejects.toThrow(/event/);
    // So would a real id the subscription never reads (other topic).
    const foreign = await call({ operation: "publish", topic: "elsewhere", payload: 1 }, "a") as { id: string };
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: foreign.id }, "b"))
      .rejects.toThrow(/this subscription reads/);
    // Every write reaches the notifier — who hears it is delivery's decision.
    expect(notified.map((e) => e.payload)).toEqual(["0", "1", "1"]);

    expect(await call({ operation: "unsubscribe", topic_glob: "proj/*" }, "b")).toEqual({ removed: "proj/*" });
    await expect(call({ operation: "unsubscribe", topic_glob: "proj/*" }, "b")).rejects.toThrow(/no subscription/);
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: "z" }, "b")).rejects.toThrow(/subscribe first/);
    await expect(call({ operation: "subscribe", topic_glob: "proj/*", mode: "loud" }, "b")).rejects.toThrow(/mode/);
    await expect(call({ operation: "subscribe", topic_glob: "{bad}" }, "b")).rejects.toThrow(/topic_glob/);
  });

  it("log through a subscription reads its pinned scopes, not the caller's live ones", async () => {
    const db = openDb(":memory:");
    const store = new BusStore(db);
    const subs = new SubStore(db);
    const call = (params: unknown, sessionId: string) =>
      handleBusTool({ store, subs, caller, notify: () => () => {}, enabled: () => true }, params, sessionId);
    // A subscription whose pinned scope 'a' can no longer resolve live — the
    // shape of a run-scoped sub after its run tree ended.
    subs.upsert("a", "proj/*", "queue", ["run:gone"], "");
    store.publish({ topic: "proj/auth", payload: "1", scope: "run:gone", writerSession: "w" });
    const page = await call({ operation: "log", topic_glob: "proj/*" }, "a") as
      { events: unknown[]; pinned_scopes?: string[] };
    // Without the pinned view this is [], and the pointer's count lies forever.
    expect(page.events).toHaveLength(1);
    // The re-fenced read says so — a fence the response never names would
    // silently change what the same glob means before and after subscribing.
    expect(page.pinned_scopes).toEqual(["run:gone"]);
    const plain = await call({ operation: "log", topic_glob: "other/*" }, "a") as { pinned_scopes?: string[] };
    expect(plain.pinned_scopes).toBeUndefined();
  });

  it("a cursor into a swept dead run scope still acks and still drains", async () => {
    const db = openDb(":memory:");
    const store = new BusStore(db);
    const subs = new SubStore(db);
    const call = (params: unknown, sessionId: string) =>
      handleBusTool({ store, subs, caller, notify: () => () => {}, enabled: () => true }, params, sessionId);
    subs.upsert("a", "proj/*", "queue", ["run:gone"], "");
    const event = store.publish({ topic: "proj/auth", payload: "1", scope: "run:gone", writerSession: "w" });
    // The tree ended and bus/sweep.ts moved the whole scope to the archive.
    expect(store.archiveDeadRunScope("run:gone")).toBe(1);
    // The subscriber's backlog is still readable and its cursor still valid:
    // an ack that started failing because maintenance moved a row would leave
    // the sub owed a note forever, with nothing anywhere saying why. Its own
    // glob needs no include_archived — it was woken for these events, and the
    // sweep moved them between the pointer and this read.
    const page = await call({ operation: "log", topic_glob: "proj/*" }, "a") as
      { events: { id: string }[] };
    expect(page.events.map((e) => e.id)).toEqual([event.id]);
    // Everyone else still asks: only the subscription's exact glob re-fences.
    const plain = await call({ operation: "log", topic_glob: "proj/auth" }, "a") as { events: unknown[] };
    expect(plain.events).toEqual([]);
    expect(await call({ operation: "ack", topic_glob: "proj/*", cursor: event.id }, "a"))
      .toEqual({ topic_glob: "proj/*", cursor: event.id });
  });

  it("search, topics and archive run behind the same scope fence as every read", async () => {
    const call = tool();
    await call({ operation: "publish", topic: "notes/a", payload: "the deploy broke login" }, "a");
    const { id } = await call({ operation: "publish", topic: "notes/b", payload: "login fixed" }, "a") as { id: string };

    const hits = await call({ operation: "search", query: "login" }, "b") as { topic: string }[];
    expect(hits.map((h) => h.topic).sort()).toEqual(["notes/a", "notes/b"]);
    expect(await call({ operation: "search", query: "login" }, "c")).toEqual([]); // other project

    const inventory = await call({ operation: "topics" }, "b") as { topic: string; events: number }[];
    expect(inventory.map((t) => t.topic)).toEqual(["notes/a", "notes/b"]);

    // The scope param narrows the fence — it never widens it.
    await call({ operation: "publish", topic: "notes/wide", payload: "login instance-wide", scope: "instance" }, "a");
    const narrowed = await call({ operation: "search", query: "login", scope: "instance" }, "b") as { topic: string }[];
    expect(narrowed.map((h) => h.topic)).toEqual(["notes/wide"]);

    // Archive defaults to the caller's narrowest scope: the two project
    // events move, the instance-wide one is untouched.
    const archived = await call({ operation: "archive", topic_glob: "notes/*", before: id }, "b") as { archived: number };
    expect(archived.archived).toBe(2);
    const live = await call({ operation: "log", topic_glob: "notes/*" }, "a") as { events: { topic: string }[] };
    expect(live.events.map((e) => e.topic)).toEqual(["notes/wide"]);
    const history = await call({ operation: "log", topic_glob: "notes/*", include_archived: true }, "a") as { events: unknown[] };
    expect(history.events).toHaveLength(3);

    await expect(call({ operation: "search" }, "a")).rejects.toThrow(/query required/);
    await expect(call({ operation: "archive", topic_glob: "notes/*" }, "a")).rejects.toThrow(/before required/);
  });

  it("is a refusal with a reason when the operator switched it off", async () => {
    const db = openDb(":memory:");
    const off = (params: unknown, sessionId: string) =>
      handleBusTool(
        { store: new BusStore(db), subs: new SubStore(db), caller, notify: () => () => {}, enabled: () => false },
        params, sessionId,
      );
    await expect(off({ operation: "get", topic: "t" }, "a")).rejects.toThrow(/switched off/);
  });

  it("rejects what the boundary must not half-handle", async () => {
    const call = tool();
    await expect(call(null, "a")).rejects.toThrow(/parameters required/);
    await expect(call({ operation: "publish", topic: "t" }, "a")).rejects.toThrow(/payload required/);
    await expect(call({ operation: "publish", payload: 1 }, "a")).rejects.toThrow(/topic required/);
    await expect(call({ operation: "get" }, "a")).rejects.toThrow(/topic required/);
    await expect(call({ operation: "log" }, "a")).rejects.toThrow(/topic_glob required/);
    await expect(call({ operation: "log", topic_glob: "t", limit: "abc" }, "a")).rejects.toThrow(/integer/);
    await expect(call({ operation: "forget", topic: "t" }, "a")).rejects.toThrow(/key required/);
    await expect(call({ operation: "wat" }, "a")).rejects.toThrow(/unknown bus operation/);
  });
});
