import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { BusStore } from "./store.js";
import { BusSweep } from "./sweep.js";

const SCOPE = "project:/p";

function setup(dead: Set<string>, on = true) {
  const store = new BusStore(openDb(":memory:"));
  const announced: number[] = [];
  // The predicate main.ts wires from the task store; here the test decides
  // which trees have ended.
  const sweep = new BusSweep(
    store,
    (rootRunId) => dead.has(rootRunId),
    () => announced.push(Date.now()),
    () => on,
  );
  const publish = (scope: string, payload: string, topic = "proj/auth") =>
    store.publish({ topic, payload: JSON.stringify(payload), scope, writerSession: "w" });
  return { store, sweep, publish, announced };
}

describe("BusSweep", () => {
  it("archives a dead run tree's scope whole and leaves an active one alone", () => {
    const { store, sweep, publish, announced } = setup(new Set(["r1"]));
    const dead = publish("run:r1", "over");
    publish("run:r1", "also-over");
    const alive = publish("run:r2", "still-going");
    const project = publish(SCOPE, "not-a-run");

    expect(sweep.sweep()).toBe(1);
    // The dead scope's events are out of the live table and out of the index …
    expect(store.runScopes()).toEqual(["run:r2"]);
    expect(store.search("over", ["run:r1"])).toEqual([]);
    expect(store.log("proj/*", ["run:r1"]).events).toEqual([]);
    // … while the live tree and the project scope are untouched.
    expect(store.log("proj/*", ["run:r2", SCOPE]).events.map((e) => e.id))
      .toEqual([alive.id, project.id]);
    // A change nobody made a tool call for still reaches the Console (5b).
    expect(announced).toHaveLength(1);
    // History and identity survive the sweep, so a cursor pointing into the
    // swept scope still acks: seenBy and byId read the union.
    expect(store.seenBy(dead.id, "proj/*", ["run:r1"])).toBe(true);
    expect(store.byId(dead.id)?.scope).toBe("run:r1");
    // A second pass has nothing to do, and says nothing.
    expect(sweep.sweep()).toBe(0);
    expect(announced).toHaveLength(1);
  });

  it("treats a run tree the predicate does not know as alive", () => {
    // main.ts answers `false` for an unknown root run id: task_runs rows are
    // never pruned, so an unknown root is a run being created, not a dead one
    // — and sweeping mid-creation would archive a live tree's blackboard.
    const { store, sweep, publish, announced } = setup(new Set());
    publish("run:unknown", "mid-creation");
    expect(sweep.sweep()).toBe(0);
    expect(store.runScopes()).toEqual(["run:unknown"]);
    expect(announced).toEqual([]);
  });

  it("the capability switch freezes the sweep", () => {
    const { store, sweep, publish } = setup(new Set(["r1"]), false);
    publish("run:r1", "over");
    expect(sweep.sweep()).toBe(0);
    expect(store.runScopes()).toEqual(["run:r1"]); // the tables stay as the operator left them
  });
});
