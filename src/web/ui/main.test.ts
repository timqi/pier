// Exercise the real orchestrator with deferred HTTP and EventSource delivery;
// surface renderers are spies, so no browser, Pi session or network is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../core/types.js";

const h = vi.hoisted(() => ({
  sidebar: null as unknown as Parameters<typeof import("./sidebar.js").initSidebar>[0],
  composer: null as unknown as Parameters<typeof import("./composer.js").initComposer>[0],
  history: vi.fn<(url: string) => Promise<Response>>(),
  create: vi.fn<() => Promise<Response>>(),
  renderSnapshot: vi.fn(),
  appendTurn: vi.fn(),
  streamDied: vi.fn(),
  renderRecovery: vi.fn(),
  content: [] as string[],
}));
vi.mock("./auth.js", () => ({ guardFetch: vi.fn(), streamDied: h.streamDied }));
vi.mock("./chat.js", () => ({
  appendDelta: vi.fn(), appendSystemInput: vi.fn(), appendTurn: h.appendTurn,
  chatLoading: vi.fn(), completeTurn: vi.fn(), finalizeStreaming: vi.fn(),
  initChat: vi.fn(), interruptTurn: vi.fn(), renderSnapshot: h.renderSnapshot,
  resetChat: () => { h.content = []; }, scrollBottom: vi.fn(),
}));
vi.mock("./composer.js", () => ({
  clearOptimistic: vi.fn(), focusInput: vi.fn(),
  initComposer: (deps: typeof h.composer) => { h.composer = deps; },
  markOptimisticUser: vi.fn(), reconcileOptimisticUser: vi.fn(() => false),
  renderQueue: vi.fn(), renderRecovery: h.renderRecovery, restoreDraft: vi.fn(), saveDraft: vi.fn(), send: vi.fn(), updateComposer: vi.fn(),
}));
vi.mock("./notifications.js", () => ({ initPush: vi.fn() }));
vi.mock("./report.js", () => ({ initReport: vi.fn() }));
vi.mock("./session-header.js", () => ({
  initHeader: vi.fn(), noteTurnMeta: vi.fn(), renderHeader: vi.fn(), resetHeaderState: vi.fn(),
  sessionInfo: vi.fn(), sessionMenu: vi.fn(), setHeaderPending: vi.fn(), setHeaderState: vi.fn(),
}));
vi.mock("./shell.js", () => ({ closeDrawer: vi.fn(), initShell: vi.fn() }));
vi.mock("./theme.js", () => ({ initTheme: vi.fn() }));
vi.mock("./version.js", () => ({ initVersion: vi.fn() }));
vi.mock("./sidebar.js", () => ({
  initSidebar: (deps: typeof h.sidebar) => { h.sidebar = deps; }, renderSessions: vi.fn(),
}));
vi.mock("./turn-activity.js", () => ({
  activityThinking: vi.fn(), activityToolEnd: vi.fn(), activityToolStart: vi.fn(),
  noteTurnError: vi.fn(), renderBackgroundRun: vi.fn(),
}));
vi.mock("./views.js", () => ({
  applyRoute: vi.fn(), initViews: vi.fn(), isChatVisible: vi.fn(() => true),
  refreshActivity: vi.fn(), refreshTasks: vi.fn(), refreshRuns: vi.fn(), setSessionHash: vi.fn(), showChat: vi.fn(),
  showConsole: vi.fn(), showFiles: vi.fn(), showRun: vi.fn(),
  syncBar: vi.fn(), toggleFiles: vi.fn(),
}));

class Stream extends EventTarget {
  static all: Stream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
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
  context: null, thinkingLevel: "medium", queue: { steering: [], followUp: [] }, queueRecovery: [], queueUncertain: false, backgroundRuns: [],
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
  vi.stubGlobal("document", { hidden: true, addEventListener: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  const rows = ["a", "b"].map((id) => ({ id, cwd: "/test", createdAt: 1, state: "idle", pinned: false }));
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/history")) return h.history(url);
    if (url === "/api/sessions" && init?.method === "POST") return h.create();
    return Promise.resolve(Response.json(rows));
  }));
  await import("./main.js");
  await settled();
});
afterEach(() => vi.unstubAllGlobals());

describe("session loads", () => {
  it("restores queue recovery from the snapshot and reconciles it from the same event stream", async () => {
    const batch = { id: "batch", steering: ["[Ada<U1>]\nfirst", "second"], followUp: [], status: "uncertain" };
    const response = await snapshot("loaded").json();
    h.history.mockResolvedValueOnce(Response.json({ ...response, queueRecovery: [batch], queueUncertain: true }));
    h.sidebar.select("a");
    await settled();
    expect(h.renderRecovery).toHaveBeenLastCalledWith([batch], true);
    latest().onmessage?.({ data: JSON.stringify({ sessionId: "a", seq: 1, ts: 1, type: "queue-recovery", batches: [], uncertain: true }) });
    expect(h.renderRecovery).toHaveBeenLastCalledWith([], true);
    latest().onmessage?.({ data: JSON.stringify({ sessionId: "a", seq: 2, ts: 1, type: "queue-recovery", batches: [], uncertain: false }) });
    expect(h.renderRecovery).toHaveBeenLastCalledWith([], false);
  });

  it("reselecting during a load or on a healthy stream keeps the current generation", async () => {
    const history = deferred();
    h.history.mockReturnValueOnce(history.promise);
    h.sidebar.select("a");
    h.sidebar.select("a");
    expect(h.history).toHaveBeenCalledTimes(1);
    history.resolve(snapshot("loaded"));
    await settled();
    const stream = latest();
    h.sidebar.select("a");
    stream.message(1, "live");
    expect(h.history).toHaveBeenCalledTimes(1);
    expect(h.content).toEqual(["loaded", "live"]);
    expect(stream.closed).toBe(false);
  });

  it.each(["success", "error"])("ignores stale A -> B -> A history %s after the newer stream starts", async (outcome) => {
    const first = deferred(), second = deferred(), third = deferred();
    h.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    h.sidebar.select("a");
    h.sidebar.select("b");
    h.sidebar.select("a");
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
    h.sidebar.select("a");
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
    h.sidebar.select("a");
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
    h.sidebar.select("a");
    await settled();
    const recovery = deferred();
    h.history.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce(snapshot("b"));
    const old = latest();
    old.reset();
    h.sidebar.select("b");
    await settled();
    recovery.resolve(Response.json({ error: "obsolete recovery" }, { status: 503 }));
    await settled();
    old.reset();
    expect(h.sidebar.currentId()).toBe("b");
    expect(h.content).toEqual(["b"]);
    expect(h.history).toHaveBeenCalledTimes(3);
  });

  it("shows a recovery failure and allows reselecting the session to retry", async () => {
    h.history.mockResolvedValueOnce(snapshot("initial"));
    h.sidebar.select("a");
    await settled();
    h.history.mockResolvedValueOnce(Response.json({ error: "busy snapshot" }, { status: 503 }));
    const old = latest();
    old.reset();
    await settled();
    old.message(1, "stale");
    expect(h.content).toEqual(["busy snapshot"]);
    expect(old.closed).toBe(true);
    h.history.mockResolvedValueOnce(snapshot("retried", 3));
    h.sidebar.select("a");
    await settled();
    latest().message(4, "live");
    expect(h.content).toEqual(["retried", "live"]);
    expect(latest()).not.toBe(old);
    expect(latest().closed).toBe(false);
  });

  it.each(["success", "error"])("does not let a creation %s override navigation", async (outcome) => {
    const creation = deferred();
    h.create.mockReturnValueOnce(creation.promise);
    const creating = h.sidebar.createSession("/new");
    h.history.mockResolvedValueOnce(snapshot("selected"));
    h.sidebar.select("b");
    await settled();
    creation.resolve(outcome === "success" ? Response.json({ id: "created" }) : Response.json({}, { status: 500 }));
    await creating;
    expect(h.sidebar.currentId()).toBe("b");
    expect(h.composer.starting()).toBe(false);
    expect(h.content).toEqual(["selected"]);
  });

  it("creation invalidates an in-flight history read and loads its own session", async () => {
    const history = deferred();
    h.history.mockReturnValueOnce(history.promise).mockResolvedValueOnce(snapshot("created"));
    h.sidebar.select("a");
    h.create.mockResolvedValueOnce(Response.json({ id: "created" }));
    await h.sidebar.createSession("/new");
    history.resolve(snapshot("obsolete"));
    await settled();
    expect(h.sidebar.currentId()).toBe("created");
    expect(h.content).toEqual(["created"]);
    expect(latest().url).toContain("/created/events");
  });

  it("checks navigation again after the creation response body arrives", async () => {
    const body = deferred<{ id: string }>();
    const response = Response.json({});
    vi.spyOn(response, "json").mockReturnValue(body.promise);
    h.create.mockResolvedValueOnce(response);
    const creating = h.sidebar.createSession("/new");
    await settled();
    h.history.mockResolvedValueOnce(snapshot("selected"));
    h.sidebar.select("b");
    await settled();
    body.resolve({ id: "created" });
    await creating;
    expect(h.sidebar.currentId()).toBe("b");
    expect(h.content).toEqual(["selected"]);
    expect(h.sidebar.sessions().some((s) => s.id === "created")).toBe(false);
  });
});
