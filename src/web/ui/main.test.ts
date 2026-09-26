// Exercise the real orchestrator with deferred HTTP and EventSource delivery;
// surface renderers are spies while the shell, palette, icons and error
// reporting run on index.html's body, so no browser, Pi session or network is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../core/types.js";
import { installPage } from "./dom.testkit.js";

const h = vi.hoisted(() => ({
  sidebar: null as unknown as Parameters<typeof import("./sidebar.js").initSidebar>[0],
  header: null as unknown as Parameters<typeof import("./session-header.js").initHeader>[0],
  composer: null as unknown as Parameters<typeof import("./composer.js").initComposer>[0],
  history: vi.fn<(url: string) => Promise<Response>>(),
  create: vi.fn<() => Promise<Response>>(),
  renderSnapshot: vi.fn(),
  appendTurn: vi.fn(),
  streamDied: vi.fn(),
  renderRecovery: vi.fn(),
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
  renderQueue: vi.fn(), renderRecovery: h.renderRecovery, restoreDraft: vi.fn(), saveDraft: vi.fn(), send: vi.fn(), updateComposer: vi.fn(),
}));
vi.mock("./notifications.js", () => ({ initPush: vi.fn() }));
vi.mock("./session-header.js", () => ({
  initHeader: (deps: typeof h.header) => { h.header = deps; }, noteTurnMeta: vi.fn(), renderHeader: vi.fn(), resetHeaderState: vi.fn(),
  sessionInfo: vi.fn(), sessionMenu: vi.fn(), setHeaderPending: vi.fn(), setHeaderState: vi.fn(),
}));
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
  context: null, thinkingLevel: "medium", queue: { steering: [], followUp: [], parked: [] }, queueRecovery: [], queueUncertain: false, backgroundRuns: [],
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
  const rows = ["a", "b"].map((id) => ({ id, cwd: "/test", createdAt: 1, state: "idle" }));
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/history")) return h.history(url);
    if (url === "/api/sessions" && init?.method === "POST") return h.create();
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

  // Opened from Runs or Activity: a task run's own session is never a row, and
  // the header would otherwise have nothing to name or to open its info panel on.
  it("fetches the summary of a selected session the listing does not carry", async () => {
    h.history.mockImplementation(() => Promise.resolve(snapshot("loaded")));
    h.sidebar.select("run-1");
    await settled();
    expect(h.header.currentSession()).toMatchObject({ id: "run-1", cwd: "/run" });
    h.sidebar.select("a");
    await settled();
    expect(h.header.currentSession()).toMatchObject({ id: "a", cwd: "/test" });
    h.sidebar.select("gone");
    await settled();
    expect(h.header.currentSession()).toBeUndefined();
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

// A reconnect follows a gap whose events are gone. Sessions were re-listed;
// tasks, runs and activity ride the same stream and were left stale.
it("re-lists every view the workspace stream feeds when it reconnects", async () => {
  const views = await import("./views.js");
  const workspace = Stream.all.find((s) => s.url === "/api/events");
  vi.clearAllMocks();
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

  workspace?.onopen?.();
  await settled();

  expect(vi.mocked(views.refreshTasks)).toHaveBeenCalledWith();
  expect(vi.mocked(views.refreshRuns)).toHaveBeenCalledOnce();
  expect(vi.mocked(views.refreshActivity)).toHaveBeenCalledOnce();
  expect(globalThis.fetch).toHaveBeenCalledWith("/api/sessions", undefined);
});

describe("the continuous conversation", () => {
  const member = (sessionId: string, reason = "idle", startedAt = 1) => ({ sessionId, startedAt, reason });
  let chain: ReturnType<typeof member>[] = [];
  const posts: string[] = [];
  const earlier = (id: string) => Response.json({ turns: [{ role: "user", text: `said in ${id}` }], backgroundRuns: [], readonly: true });

  async function boot(members: ReturnType<typeof member>[]) {
    chain = members;
    vi.resetModules();
    Stream.all = [];
    Object.assign(installPage(), { hidden: true });
    const rows = ["h2", "h1", "h0", "other"].map((id) => ({ id, cwd: "/home", createdAt: 1, state: "idle" }));
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/continuous" && init?.method === "POST") {
        posts.push(url);
        chain = [member("h1", "first", Date.now())];
        return Promise.resolve(Response.json({ sessionId: "h1", rotated: "first" }));
      }
      if (url === "/api/continuous") return Promise.resolve(Response.json({ chain }));
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
    expect(h.sidebar.continuousOpen()).toBe(true);
    expect(h.composer.continuous?.()).toBe(true);
    h.sidebar.select("h0");
    await settled();
    expect(historyCalls()).toEqual(["/api/sessions/h1/history"]);
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

  it("opens before its first session exists, and is on the first session before its first message is sent", async () => {
    posts.length = 0;
    await boot([]);
    expect(h.composer.sessionId()).toBeNull();
    expect(h.composer.continuous?.()).toBe(true);
    expect(h.content).toContain("The continuous conversation — your first message starts it.");
    await h.composer.prepareHead?.();
    expect(posts).toEqual(["/api/continuous"]);
    expect(h.composer.sessionId()).toBe("h1");
    expect(historyCalls()).toEqual(["/api/sessions/h1/history"]);
  });

  it("sends straight through the alias when the head is not due to rotate", async () => {
    posts.length = 0;
    await boot([member("h1", "idle", Date.now())]);
    await h.composer.prepareHead?.();
    expect(posts).toEqual([]);
  });
});
