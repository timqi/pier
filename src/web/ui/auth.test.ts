// A stream the browser gave up on — a proxy's 502 while Pier restarts — is
// probed every 10s and reopened once the server answers, the page reloaded
// only when the server came back as another version.

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ lines: [] as { remove: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> }[] }));
vi.mock("./report.js", () => ({
  report: vi.fn(() => {
    const line = { remove: vi.fn(), append: vi.fn() };
    h.lines.push(line);
    return line;
  }),
}));
vi.mock("./form.js", () => ({ button: () => ({ classList: { add: vi.fn() }, onclick: null }) }));

const CLOSED = 2;
const dead = { readyState: CLOSED } as EventSource;
let fetcher: ReturnType<typeof vi.fn>;
let location: { reload: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn>; pathname: string; hash: string };
const down = (): Promise<Response> => Promise.resolve(new Response("bad gateway", { status: 502 }));
const up = (current: string): Promise<Response> => Promise.resolve(Response.json({ current }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.lines = [];
  fetcher = vi.fn(down);
  location = { reload: vi.fn(), assign: vi.fn(), pathname: "/app/", hash: "#/s/a" };
  vi.stubGlobal("window", { fetch: fetcher });
  vi.stubGlobal("location", location);
  vi.stubGlobal("EventSource", { CLOSED });
  vi.stubGlobal("__PIER_VERSION__", "1.0.0");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries every 10s while the server is down, then reopens every dead stream once", async () => {
  const { streamDied } = await import("./auth.js");
  const workspace = vi.fn();
  const session = vi.fn();
  streamDied(dead, "Workspace", workspace);
  streamDied(dead, "Session", session);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1); // one probe loop for both
  expect(h.lines).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(70_000);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(h.lines).toHaveLength(1); // one line for the outage, however long
  expect(workspace).not.toHaveBeenCalled();

  fetcher.mockImplementation(() => up("1.0.0"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(workspace).toHaveBeenCalledOnce();
  expect(session).toHaveBeenCalledOnce();
  expect(location.reload).not.toHaveBeenCalled();
  expect(h.lines.every((l) => l.remove.mock.calls.length === 1)).toBe(true);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(9); // the loop ended with the recovery
  expect(fetcher.mock.calls.every(([url]) => url === "/api/version")).toBe(true);
});

// /api/version answering while the stream endpoint fails must not spin.
it("reopens a stream that dies again at once no sooner than 10s later", async () => {
  const { streamDied } = await import("./auth.js");
  fetcher.mockImplementation(() => up("1.0.0"));
  const revive = vi.fn();
  streamDied(dead, "Workspace", revive);
  await vi.advanceTimersByTimeAsync(0);
  expect(revive).toHaveBeenCalledOnce();

  streamDied(dead, "Workspace", revive);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(revive).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(revive).toHaveBeenCalledTimes(2);
});

it("reloads on an open stream's version check only when the server runs another version", async () => {
  const { matchVersion } = await import("./auth.js");
  fetcher.mockImplementation(() => up("1.0.0"));
  await matchVersion();
  expect(location.reload).not.toHaveBeenCalled();
  fetcher.mockImplementation(down);
  await matchVersion();
  expect(location.reload).not.toHaveBeenCalled();
  fetcher.mockImplementation(() => up("1.1.0"));
  await matchVersion();
  expect(location.reload).toHaveBeenCalledOnce();
});

it("reloads the page when the server came back as another version", async () => {
  const { streamDied } = await import("./auth.js");
  const revive = vi.fn();
  streamDied(dead, "Workspace", revive);
  fetcher.mockImplementation(() => up("1.1.0"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(location.reload).toHaveBeenCalledOnce();
  expect(revive).not.toHaveBeenCalled();
});

it("sends a signed-out page to the login, and leaves a stream the browser still retries alone", async () => {
  const { streamDied } = await import("./auth.js");
  streamDied({ readyState: 0 } as EventSource, "Workspace", vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).not.toHaveBeenCalled();

  fetcher.mockImplementation(() => Promise.resolve(new Response("", { status: 401 })));
  streamDied(dead, "Workspace", vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(location.assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/app/#/s/a")}`);
  expect(h.lines).toHaveLength(0);
});
