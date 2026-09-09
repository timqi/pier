// The error handler's one judgement call: what is not worth reporting.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ appendTurn: vi.fn(), fetch: vi.fn() }));
vi.mock("./chat.js", () => ({ appendTurn: state.appendTurn }));

type Handler = (e: { message: string; error?: unknown }) => void;
let handlers: Map<string, Handler>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers = new Map();
  state.fetch.mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    fetch: state.fetch,
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  });
  vi.stubGlobal("location", { hash: "" });
  const report = await import("./report.js");
  report.initReport();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("drops the browser's ResizeObserver loop notice", () => {
  handlers.get("error")!({
    message: "ResizeObserver loop completed with undelivered notifications.",
    error: null,
  });
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.appendTurn).not.toHaveBeenCalled();
});

it("still reports a real throw, and one that only mentions ResizeObserver", () => {
  handlers.get("error")!({ message: "x is not a function", error: new Error("x is not a function") });
  handlers.get("error")!({
    message: "ResizeObserver loop limit exceeded",
    error: new Error("thrown inside an observer"),
  });
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(state.appendTurn).toHaveBeenCalledTimes(2);
});
