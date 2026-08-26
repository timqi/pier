import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { BusStore } from "./store.js";
import { handleBusTool, type BusCaller } from "./tool.js";

// Sessions the resolver knows: A and B share a project, "run-child" is a
// subagent inside run tree r1, "nowhere" resolves to nothing.
const caller: BusCaller = {
  resolve: async (id) => ({
    "a": { cwd: "/p" },
    "b": { cwd: "/p" },
    "c": { cwd: "/q" },
    "run-child": { rootRunId: "r1", cwd: "/p" },
  }[id] ?? {}),
};

const tool = (store = new BusStore(openDb(":memory:"))) =>
  (params: unknown, sessionId: string) => handleBusTool(store, caller, params, sessionId);

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
    const page = await call({ operation: "log", topic_glob: "proj/auth" }, "a") as { events: { kind: string }[] };
    expect(page.events.map((e) => e.kind)).toEqual(["fact", "tombstone"]);
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
      .rejects.toThrow(/inside a task run/);
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

  it("rejects what the boundary must not half-handle", async () => {
    const call = tool();
    await expect(call(null, "a")).rejects.toThrow(/parameters required/);
    await expect(call({ operation: "publish", topic: "t" }, "a")).rejects.toThrow(/payload required/);
    await expect(call({ operation: "publish", payload: 1 }, "a")).rejects.toThrow(/topic required/);
    await expect(call({ operation: "get" }, "a")).rejects.toThrow(/topic required/);
    await expect(call({ operation: "log" }, "a")).rejects.toThrow(/topic_glob required/);
    await expect(call({ operation: "forget", topic: "t" }, "a")).rejects.toThrow(/key required/);
    await expect(call({ operation: "wat" }, "a")).rejects.toThrow(/unknown bus operation/);
  });
});
