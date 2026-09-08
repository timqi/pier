// The one rule the rail's order has: a session a human speaks to joins the
// working set at the front, and a session already in it does not move.
import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { SessionStateStore, WORKING_SET } from "./session-state.js";

const store = (): SessionStateStore => new SessionStateStore(openDb(":memory:"));
const order = (state: SessionStateStore): string[] =>
  [...state.flags()].filter(([, f]) => f.rank !== undefined)
    .sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0)).map(([id]) => id);

it("puts a session nobody had spoken to at the front, and answers that the order changed", () => {
  const state = store();
  expect(state.promote("a")).toBe(true);
  expect(state.promote("b")).toBe(true);
  expect(order(state)).toEqual(["b", "a"]);
});

// Switching between two open sessions is the case that made the old rail
// dance: neither of them may move, and nothing may be written either.
it("leaves a member where it is, and says nothing changed", () => {
  const state = store();
  state.promote("a");
  state.promote("b");
  expect(state.promote("a")).toBe(false);
  expect(order(state)).toEqual(["b", "a"]);
});

it("pushes the last slot out when a ninth session is spoken to", () => {
  const state = store();
  const ids = Array.from({ length: WORKING_SET }, (_, i) => `s${String(i)}`);
  for (const id of ids) state.promote(id);
  expect(order(state)).toHaveLength(WORKING_SET);
  expect(state.promote("late")).toBe(true);
  // The oldest promotion falls out; everyone else keeps their relative place.
  expect(order(state)).toEqual(["late", ...[...ids].reverse().slice(0, WORKING_SET - 1)]);
});

// Two flags on one row: promoting a session must not clear the mark that says
// its last turn was never looked at, and reading a turn must not cost a slot.
it("keeps the unread mark and the rank apart", () => {
  const state = store();
  state.setUnread("a", true);
  state.promote("a");
  expect(state.unread("a")).toBe(true);
  expect(state.flags().get("a")?.rank).toBe(0);
  state.setUnread("a", false);
  expect(state.flags().get("a")?.rank).toBe(0);
});

// A ghost's row is deleted whole (server.ts), slot included: a session Pi never
// persisted must not hold one of the eight.
it("frees the slot when a session is forgotten", () => {
  const state = store();
  state.promote("ghost");
  state.forget("ghost");
  expect(order(state)).toEqual([]);
});
