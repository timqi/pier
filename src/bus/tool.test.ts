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
    "coordinator": { cwd: "/p", invokedRootRunIds: ["r1"] },
    "fanout": { cwd: "/p", invokedRootRunIds: ["r1", "r2"] },
  }[id] ?? {}),
};

const tool = (db = openDb(":memory:"), notified: BusEvent[] = []) => {
  const deps = {
    store: new BusStore(db),
    subs: new SubStore(db),
    caller,
    notify: (event: BusEvent) => { notified.push(event); },
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

    const ack = await call({ operation: "ack", topic_glob: "proj/*", cursor: before.id }, "b") as { cursor: string };
    expect(ack.cursor).toBe(before.id);
    // A cursor that is not a real event id would silence the subscription
    // forever — every future note would settle as "already caught up".
    await expect(call({ operation: "ack", topic_glob: "proj/*", cursor: "zzz" }, "b"))
      .rejects.toThrow(/event id/);
    // Every write reaches the notifier — who hears it is delivery's decision.
    expect(notified.map((e) => e.payload)).toEqual(["0"]);

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
      handleBusTool({ store, subs, caller, notify: () => {}, enabled: () => true }, params, sessionId);
    // A subscription whose pinned scope 'a' can no longer resolve live — the
    // shape of a run-scoped sub after its run tree ended.
    subs.upsert("a", "proj/*", "queue", ["run:gone"], "");
    store.publish({ topic: "proj/auth", payload: "1", scope: "run:gone", writerSession: "w" });
    const page = await call({ operation: "log", topic_glob: "proj/*" }, "a") as { events: unknown[] };
    // Without the pinned view this is [], and the pointer's count lies forever.
    expect(page.events).toHaveLength(1);
  });

  it("is a refusal with a reason when the operator switched it off", async () => {
    const db = openDb(":memory:");
    const off = (params: unknown, sessionId: string) =>
      handleBusTool(
        { store: new BusStore(db), subs: new SubStore(db), caller, notify: () => {}, enabled: () => false },
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
