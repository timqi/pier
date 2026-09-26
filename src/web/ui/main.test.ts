// Exercise the real orchestrator with deferred HTTP and EventSource delivery;
// surface renderers are spies while the palette, icons and error
// reporting run on index.html's body, so no browser, Pi session or network is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../core/types.js";
import { installPage } from "./dom.testkit.js";

const h = vi.hoisted(() => ({
  drawer: null as unknown as Parameters<typeof import("./drawer.js").initDrawer>[0],
  header: null as unknown as Parameters<typeof import("./session-header.js").initHeader>[0],
  composer: null as unknown as Parameters<typeof import("./composer.js").initComposer>[0],
  views: null as unknown as Parameters<typeof import("./views.js").initViews>[0],
  history: vi.fn<(url: string) => Promise<Response>>(),
  renderSnapshot: vi.fn(),
  appendTurn: vi.fn(),
  streamDied: vi.fn(),
  renderRecovery: vi.fn(),
  setSkills: vi.fn(),
  appendDivider: vi.fn(),
  appendPager: vi.fn(),
  content: [] as string[],
}));
vi.mock("./auth.js", () => ({ guardFetch: vi.fn(), streamDied: h.streamDied }));
vi.mock("./chat.js", () => ({
  appendDivider: h.appendDivider, appendPager: h.appendPager,
  turnsPane: { scrollHeight: 0, scrollTop: 0, addEventListener: vi.fn() },
  appendDelta: vi.fn(), appendSystemInput: vi.fn(), appendTurn: h.appendTurn,
  chatLoading: vi.fn(), completeTurn: vi.fn(), finalizeStreaming: vi.fn(),
  initChat: vi.fn(), interruptTurn: vi.fn(), renderSnapshot: h.renderSnapshot,
  resetChat: () => { h.content = []; }, scrollBottom: vi.fn(),
}));
vi.mock("./composer.js", () => ({
  clearOptimistic: vi.fn(), dropParked: vi.fn(), focusInput: vi.fn(),
  initComposer: (deps: typeof h.composer) => { h.composer = deps; },
  markOptimisticUser: vi.fn(), reconcileOptimisticUser: vi.fn(() => false),
  renderQueue: vi.fn(), renderRecovery: h.renderRecovery, restoreDraft: vi.fn(), saveDraft: vi.fn(), send: vi.fn(), setSkills: h.setSkills, updateComposer: vi.fn(),
}));
vi.mock("./notifications.js", () => ({ initPush: vi.fn() }));
vi.mock("./session-header.js", () => ({
  initHeader: (deps: typeof h.header) => { h.header = deps; }, noteTurnMeta: vi.fn(), renderHeader: vi.fn(), resetHeaderState: vi.fn(),
  setHeaderState: vi.fn(),
}));
vi.mock("./theme.js", () => ({ initTheme: vi.fn() }));
vi.mock("./version.js", () => ({ initVersion: vi.fn() }));
vi.mock("./drawer.js", () => ({
  initDrawer: (deps: typeof h.drawer) => { h.drawer = deps; }, renderDrawer: vi.fn(),
}));
vi.mock("./turn-activity.js", () => ({
  activityThinking: vi.fn(), activityToolEnd: vi.fn(), activityToolStart: vi.fn(),
  noteTurnError: vi.fn(), renderBackgroundRun: vi.fn(),
}));
vi.mock("./views.js", () => ({
  // The router's one call main.ts relies on here: a bare address opens the conversation (views.test.ts covers the rest).
  applyRoute: vi.fn(() => { if (typeof location !== "undefined" && !location.hash) h.views.openContinuous(); }),
  initViews: (deps: typeof h.views) => { h.views = deps; }, isChatVisible: vi.fn(() => true),
  setConversationHash: vi.fn(), setSessionHash: vi.fn(), showChat: vi.fn(),
  showConsole: vi.fn(), showFiles: vi.fn(),
  toggleFiles: vi.fn(),
}));

class Stream extends EventTarget {
  static all: Stream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { super(); Stream.all.push(this); }
  close(): void { this.closed = true; }
  reset(): void { this.dispatchEvent(new Event("reset")); }
  message(seq: number, text: string, id = "a"): void {
    this.onmessage?.({ data: JSON.stringify({ sessionId: id, seq, ts: 1, type: "user-message", text }) });
  }
}

function deferred<T = Response>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const snapshot = (text: string, lastSeq = 0, epoch = "new") => Response.json({
  turns: [{ role: "user", text }], lastSeq, epoch, model: null, state: "idle",
  context: null, thinkingLevel: "medium", queue: { steering: [], followUp: [], parked: [] }, queueRecovery: [], queueUncertain: false, backgroundRuns: [], skills: [],
});
const latest = () => Stream.all.at(-1)!;
const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  Stream.all = [];
  h.content = [];
  h.renderSnapshot.mockImplementation((turns: ChatTurn[]) => { h.content.push(...turns.map((t) => t.text)); });
  h.appendTurn.mockImplementation((_role: string, text: string) => { h.content.push(text); });
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("__PIER_VERSION__", "test");
  Object.assign(installPage(), { hidden: true });
  // Listed oldest first, with `modified` the other way round: the client orders by birth.
  const rows = ["a", "b"].map((id, i) => ({ id, cwd: "/test", createdAt: 1 + i, modified: 9 - i, state: "idle" }));
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/history")) return h.history(url);
    if (url === "/api/continuous") return Promise.resolve(Response.json({ chain: [], rotateAt: 60_000 }));
    if (url === "/api/continuous/open") return Promise.resolve(Response.json({ items: [], unlisted: [], designs: [] }));
    const one = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (one && !init?.method) {
      const id = one[1] as string;
      return Promise.resolve(id === "gone"
        ? Response.json({ error: "no session" }, { status: 404 })
        : Response.json({ id, cwd: "/run", createdAt: 2, state: "idle" }));
    }
    return Promise.resolve(Response.json(rows));
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { addEventListener: vi.fn(), fetch: fetcher, matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  await import("./main.js");
  await settled();
});
afterEach(() => vi.unstubAllGlobals());

// `modified` is deliberately ignored: ordering by it makes rows jump under the pointer.
it("orders the sessions by birth, newest first, once for every surface", () => {
  expect(h.drawer.sessions().map((s) => s.id)).toEqual(["b", "a"]);
});

describe("session loads", () => {
  it("restores queue recovery from the snapshot and reconciles it from the same event stream", async () => {
    const batch = { id: "batch", steering: ["[Ada<U1>]\nfirst", "second"], followUp: [], status: "uncertain" };
    const response = await snapshot("loaded").json();
    h.history.mockResolvedValueOnce(Response.json({ ...response, queueRecovery: [batch], queueUncertain: true }));
    h.drawer.select("a");
    await settled();
    expect(h.renderRecovery).toHaveBeenLastCalledWith([batch], true);
    latest().onmessage?.({ data: JSON.stringify({ sessionId: "a", seq: 1, ts: 1, type: "queue-recovery", batches: [], uncertain: true }) });
    expect(h.renderRecovery).toHaveBeenLastCalledWith([], true);
    latest().onmessage?.({ data: JSON.stringify({ sessionId: "a", seq: 2, ts: 1, type: "queue-recovery", batches: [], uncertain: false }) });
    expect(h.renderRecovery).toHaveBeenLastCalledWith([], false);
  });

  it("hands the snapshot's skills to the composer, and clears them with the pane", async () => {
    const skills = [{ name: "pier-tasks", description: "Delegate." }];
    h.history.mockResolvedValueOnce(Response.json({ ...await snapshot("loaded").json(), skills }));
    h.drawer.select("a");
    expect(h.setSkills).toHaveBeenLastCalledWith([]);
    await settled();
    expect(h.setSkills).toHaveBeenLastCalledWith(skills);
  });

  // Opened from a run card's session chip: a task run's own session is never a row, and
  // the header would otherwise have nothing to name or to open its info panel on.
  it("fetches the summary of a selected session the listing does not carry", async () => {
    h.history.mockImplementation(() => Promise.resolve(snapshot("loaded")));
    h.drawer.select("run-1");
    await settled();
    expect(h.header.currentSession()).toMatchObject({ id: "run-1", cwd: "/run" });
    h.drawer.select("a");
    await settled();
    expect(h.header.currentSession()).toMatchObject({ id: "a", cwd: "/test" });
    h.drawer.select("gone");
    await settled();
    expect(h.header.currentSession()).toBeUndefined();
  });

  it("reselecting during a load or on a healthy stream keeps the current generation", async () => {
    const history = deferred();
    h.history.mockReturnValueOnce(history.promise);
    h.drawer.select("a");
    h.drawer.select("a");
    expect(h.history).toHaveBeenCalledTimes(1);
    history.resolve(snapshot("loaded"));
    await settled();
    const stream = latest();
    h.drawer.select("a");
    stream.message(1, "live");
    expect(h.history).toHaveBeenCalledTimes(1);
    expect(h.content).toEqual(["loaded", "live"]);
    expect(stream.closed).toBe(false);
  });

  it.each(["success", "error"])("ignores stale A -> B -> A history %s after the newer stream starts", async (outcome) => {
    const first = deferred(), second = deferred(), third = deferred();
    h.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    h.drawer.select("a");
    h.drawer.select("b");
    h.drawer.select("a");
    third.resolve(snapshot("latest", 10));
    await settled();
    const stream = latest();
    stream.message(11, "live");
    first.resolve(outcome === "success" ? snapshot("stale") : Response.json({ error: "obsolete failure" }, { status: 503 }));
    second.resolve(snapshot("other session"));
    await settled();
    expect(h.content).toEqual(["latest", "live"]);
    expect(h.renderSnapshot).toHaveBeenCalledTimes(1);
    expect(latest()).toBe(stream);
    expect(stream.closed).toBe(false);
  });

  it.each(["success", "error"])("ignores an older same-session reload %s", async (outcome) => {
    h.history.mockResolvedValueOnce(snapshot("initial"));
    h.drawer.select("a");
    await settled();
    const older = deferred(), newer = deferred();
    h.history.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const p1 = h.composer.reload("a");
    const p2 = h.composer.reload("a");
    newer.resolve(snapshot("newer", 5));
    await p2;
    const stream = latest();
    stream.message(6, "live");
    older.resolve(outcome === "success" ? snapshot("older") : Response.json({ error: "obsolete" }, { status: 500 }));
    await p1;
    expect(h.content).toEqual(["newer", "live"]);
    expect(latest()).toBe(stream);
    expect(stream.closed).toBe(false);
  });

  it("repeated resets replace snapshots once and ignore obsolete stream callbacks", async () => {
    h.history.mockResolvedValueOnce(snapshot("old", 20, "old"));
    h.drawer.select("a");
    await settled();
    for (const epoch of ["new", "newer"]) {
      const previous = latest();
      const recovery = deferred();
      h.history.mockReturnValueOnce(recovery.promise);
      const calls = h.history.mock.calls.length;
      previous.reset();
      previous.reset();
      previous.message(99, "obsolete");
      previous.onerror?.();
      expect(previous.closed).toBe(true);
      expect(h.history).toHaveBeenCalledTimes(calls + 1);
      recovery.resolve(snapshot("recovered", 0, epoch));
      await settled();
      expect(latest().url).toContain(`after=${epoch}:0`);
      latest().message(1, "live");
      latest().message(1, "duplicate");
      previous.reset();
      expect(h.content).toEqual(["recovered", "live"]);
      expect(h.streamDied).not.toHaveBeenCalled();
    }
  });

  it("recovery cannot select its old session or display its failure after navigation", async () => {
    h.history.mockResolvedValueOnce(snapshot("initial"));
    h.drawer.select("a");
    await settled();
    const recovery = deferred();
    h.history.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce(snapshot("b"));
    const old = latest();
    old.reset();
    h.drawer.select("b");
    await settled();
    recovery.resolve(Response.json({ error: "obsolete recovery" }, { status: 503 }));
    await settled();
    old.reset();
    expect(h.drawer.currentId()).toBe("b");
    expect(h.content).toEqual(["b"]);
    expect(h.history).toHaveBeenCalledTimes(3);
  });

  it("shows a recovery failure and allows reselecting the session to retry", async () => {
    h.history.mockResolvedValueOnce(snapshot("initial"));
    h.drawer.select("a");
    await settled();
    h.history.mockResolvedValueOnce(Response.json({ error: "busy snapshot" }, { status: 503 }));
    const old = latest();
    old.reset();
    await settled();
    old.message(1, "stale");
    expect(h.content).toEqual(["busy snapshot"]);
    expect(old.closed).toBe(true);
    h.history.mockResolvedValueOnce(snapshot("retried", 3));
    h.drawer.select("a");
    await settled();
    latest().message(4, "live");
    expect(h.content).toEqual(["retried", "live"]);
    expect(latest()).not.toBe(old);
    expect(latest().closed).toBe(false);
  });

  // Pi can refuse a prompt before its turn starts (no model, no auth): the
  // error is the only event, and the optimistic streaming must not outlive it.
  it("clears the optimistic streaming state on an error with no turn open", async () => {
    h.history.mockResolvedValueOnce(snapshot("loaded"));
    h.drawer.select("a");
    await settled();
    h.composer.setState("streaming");
    const event = (seq: number, body: object) => latest().onmessage?.({ data: JSON.stringify({ sessionId: "a", seq, ts: 1, ...body }) });
    event(1, { type: "error", message: "no model" });
    expect(h.composer.sessionState()).toBe("idle");

    // Inside a turn the error is part of it; the turn's own state events settle it.
    h.composer.setState("streaming");
    event(2, { type: "state", state: "streaming" });
    event(3, { type: "turn-start" });
    event(4, { type: "error", message: "tool failed" });
    expect(h.composer.sessionState()).toBe("streaming");

    // Between two turns of one run (a drained follow-up) no turn is open, but
    // the server said streaming: an error there takes nothing back.
    event(5, { type: "turn-end", text: "done" });
    event(6, { type: "error", message: "session title: no auth" });
    expect(h.composer.sessionState()).toBe("streaming");
  });
});

// A reconnect follows a gap whose events are gone: the session list re-lists.
it("re-lists the sessions when the workspace stream reconnects", async () => {
  const workspace = Stream.all.find((s) => s.url === "/api/events");
  vi.clearAllMocks();
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

  workspace?.onopen?.();
  await settled();

  expect(globalThis.fetch).toHaveBeenCalledWith("/api/sessions", undefined);
});

// The drawer's run rows re-read on a marker written, without re-listing every session.
it("re-reads the open items when a turn end wrote a marker", async () => {
  const drawer = await import("./drawer.js");
  const workspace = Stream.all.find((s) => s.url === "/api/events")!;
  const fetcher = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const open = { items: [{ problem: "p", stage: "s", runs: [] }], unlisted: [], designs: [] };
  fetcher.mockClear();
  fetcher.mockImplementationOnce(() => Promise.resolve(Response.json(open)));
  vi.mocked(drawer.renderDrawer).mockClear();

  workspace.onmessage?.({ data: JSON.stringify({ type: "open-items-changed" }) });
  await settled();

  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/continuous/open"]);
  expect(h.drawer.open()).toEqual(open);
  expect(vi.mocked(drawer.renderDrawer)).toHaveBeenCalled();
});

// A lead's session is saved after its run-changed refetch, so its first state names an unlisted id.
it("re-lists sessions on a state change for an unknown session, and updates a known one in place", async () => {
  const drawer = await import("./drawer.js");
  const workspace = Stream.all.find((s) => s.url === "/api/events")!;
  const fetcher = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const sessionsFetches = () => fetcher.mock.calls.filter(([url]) => url === "/api/sessions").length;
  const state = (sessionId: string) => workspace.onmessage?.({ data: JSON.stringify({ type: "session-state", sessionId, state: "running" }) });
  fetcher.mockClear();
  vi.mocked(drawer.renderDrawer).mockClear();

  state("b");
  await settled();
  expect(sessionsFetches()).toBe(0);
  expect(h.drawer.sessions().find((s) => s.id === "b")?.state).toBe("running");
  expect(vi.mocked(drawer.renderDrawer)).toHaveBeenCalled();

  state("lead");
  await settled();
  expect(sessionsFetches()).toBe(1);
});

describe("the continuous conversation", () => {
  const member = (sessionId: string, reason = "idle", startedAt = 1) => ({ sessionId, startedAt, reason });
  let chain: ReturnType<typeof member>[] = [];
  const earlier = (id: string) => Response.json({ turns: [{ role: "user", text: `said in ${id}` }], backgroundRuns: [], readonly: true });

  async function boot(members: ReturnType<typeof member>[]) {
    chain = members;
    vi.resetModules();
    Stream.all = [];
    Object.assign(installPage(), { hidden: true });
    const rows = ["h2", "h1", "h0", "other"].map((id) => ({ id, cwd: "/home", createdAt: 1, state: "idle" }));
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/continuous") return Promise.resolve(Response.json({ chain, rotateAt: 60_000 }));
      if (url.endsWith("/history")) return h.history(url);
      return Promise.resolve(Response.json(rows));
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("location", { hash: "" });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    h.history.mockReset();
    h.history.mockImplementation((url: string) =>
      Promise.resolve(url.includes("/h2/") || (chain[0]?.sessionId === "h1" && url.includes("/h1/")) ? snapshot("head") : earlier(url.split("/")[3]!)));
    await import("./main.js");
    await settled();
  }
  const historyCalls = () => h.history.mock.calls.map(([url]) => url);

  it("opens at the head on a bare address, and any of its sessions opens the head", async () => {
    await boot([member("h1"), member("h0", "first")]);
    expect(historyCalls()).toEqual(["/api/sessions/h1/history"]);
    expect(h.header.continuousOpen()).toBe(true);
    expect(h.composer.continuous()).toBe(true);
    h.drawer.select("h0");
    await settled();
    expect(historyCalls()).toEqual(["/api/sessions/h1/history"]);
  });

  // A child session (a lead's, a task run's) is a route of its own; ‹ goes back.
  it("opens a child session outside the conversation and returns to the head", async () => {
    await boot([member("h1"), member("h0", "first")]);
    h.history.mockImplementation(() => Promise.resolve(snapshot("child")));
    h.drawer.select("other");
    await settled();
    expect(h.header.continuousOpen()).toBe(false);
    expect(h.composer.continuous()).toBe(false);
    expect(historyCalls().at(-1)).toBe("/api/sessions/other/history");
    h.header.openContinuous();
    await settled();
    expect(h.header.continuousOpen()).toBe(true);
    expect(historyCalls().at(-1)).toBe("/api/sessions/h1/history");
  });

  it("pages an earlier session in read-only above the head, closed by the rotation's divider", async () => {
    await boot([member("h1", "idle", 5), member("h0", "first")]);
    const pager = h.appendPager.mock.calls.at(-1)![0] as () => void;
    pager();
    await settled();
    expect(historyCalls()).toEqual(["/api/sessions/h1/history", "/api/sessions/h0/history", "/api/sessions/h1/history"]);
    expect(h.renderSnapshot).toHaveBeenCalledWith([{ role: "user", text: "said in h0" }], "idle", [], true);
    expect(h.appendDivider).toHaveBeenCalledWith("new session — idle 1h", 5);
    // Everything is paged in: no pager is drawn over the first session.
    expect(h.appendPager).toHaveBeenCalledTimes(1);
  });

  it("keeps the pane as it is while a page's head snapshot is on its way", async () => {
    await boot([member("h1", "idle", 5), member("h0", "first")]);
    const head = deferred();
    h.history.mockImplementation((url: string) => Promise.resolve(url.includes("/h0/") ? earlier("h0") : head.promise));
    (h.appendPager.mock.calls.at(-1)![0] as () => void)();
    await settled();
    expect(h.content).toEqual(["head"]);
    head.resolve(snapshot("head"));
    await settled();
    expect(h.content).toEqual(["said in h0", "head"]);
  });

  it("follows a send that landed on a new head, keeping the session just left in view", async () => {
    await boot([member("h1"), member("h0", "first")]);
    chain = [member("h2"), member("h1"), member("h0", "first")];
    h.composer.headMoved?.();
    await settled();
    await settled();
    expect(historyCalls().slice(1)).toEqual(["/api/sessions/h2/history", "/api/sessions/h1/history", "/api/sessions/h2/history"]);
    expect(h.renderSnapshot).toHaveBeenCalledWith([{ role: "user", text: "said in h1" }], "idle", [], true);
  });

  it("opens before its first session exists, and follows the head its first message made", async () => {
    await boot([]);
    expect(h.composer.sessionId()).toBeNull();
    expect(h.composer.continuous()).toBe(true);
    expect(h.content).toContain("The continuous conversation — your first message starts it.");
    chain = [member("h1", "first")];
    h.composer.headMoved?.();
    await settled();
    await settled();
    expect(h.composer.sessionId()).toBe("h1");
    expect(historyCalls()).toEqual(["/api/sessions/h1/history"]);
  });
});
