// What the workbench keeps per session: a finished turn nobody looked at, and
// the browser that last spoke into it.
import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { SessionStateStore } from "./session-state.js";

const store = (): SessionStateStore => new SessionStateStore(openDb(":memory:"));

it("marks a session unread, lists only the marked ones, and clears the mark", () => {
  const state = store();
  expect(state.unread("a")).toBe(false);
  state.setUnread("a", true);
  state.setUnread("b", false);
  expect(state.unread("a")).toBe(true);
  expect([...state.flags()]).toEqual([["a", { unread: true }]]);
  state.setUnread("a", false);
  expect(state.unread("a")).toBe(false);
  expect(state.flags().size).toBe(0);
});

it("remembers the browser that last spoke into a session", () => {
  const state = store();
  expect(state.browserOf("a")).toBeUndefined();
  state.spokeFrom("a", "laptop");
  state.spokeFrom("a", "phone");
  expect(state.browserOf("a")).toBe("phone");
  expect(state.browserOf("b")).toBeUndefined();
});
