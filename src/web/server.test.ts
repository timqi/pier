import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type {
  AgentFactory,
  AgentSession,
  ChatTurn,
  ConfigScope,
  ConfigStore,
  ModelRef,
  ProviderManager,
  SessionEventPayload,
  SessionState,
  ThinkingLevel,
} from "../core/types.js";
import { CUSTOM_TOOL_RULES, normalizeCustomTools } from "../tools.js";
import { registerTaskRoutes } from "../tasks/routes.js";
import { TaskService } from "../tasks/service.js";
import { TaskStore } from "../tasks/store.js";
import { SettingsStore } from "../settings.js";
import { UpdateCheck } from "../update.js";
import { openDb } from "../db.js";
import { ProviderFlows } from "./provider-flows.js";
import { SessionStateStore } from "./session-state.js";
import { createServer, tabPrefix, withTabPrefix } from "./server.js";
import type { SecretsControl } from "./instance.js";
import type { ToolsSyncNote } from "./types.js";

/** Scripted in-memory AgentSession for seam tests. */
function fakeSession(id: string): AgentSession & {
  emit: (p: SessionEventPayload) => void;
  calls: string[];
  setState: (s: SessionState) => void;
} {
  let state: SessionState = "idle";
  let model: ModelRef = { provider: "anthropic", id: "claude-opus-4-5" };
  let thinkingLevel: ThinkingLevel = "medium";
  const listeners = new Set<(e: SessionEventPayload) => void>();
  const calls: string[] = [];
  return {
    id,
    get model() {
      return model;
    },
    setModel: async (m: ModelRef) => {
      if (m.id === "nope") throw new Error("unknown model");
      model = m;
      calls.push(`setModel:${m.provider}/${m.id}`);
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    availableThinkingLevels: () => ["off", "low", "medium", "high"],
    setThinkingLevel: (level: ThinkingLevel) => {
      thinkingLevel = level;
      calls.push(`setThinkingLevel:${level}`);
    },
    setCacheRetention: () => {},
    contextUsage: { tokens: 1200, contextWindow: 200_000 },
    availableModels: async (): Promise<ModelRef[]> => [
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "openai", id: "gpt-5.2" },
    ],
    get state() {
      return state;
    },
    setState: (s: SessionState) => {
      state = s;
    },
    emit: (p: SessionEventPayload) => listeners.forEach((fn) => fn(p)),
    calls,
    history: async (): Promise<ChatTurn[]> => [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
    prompt: async (t: string) => void calls.push(`prompt:${t}`),
    steer: async (t: string) => void calls.push(`steer:${t}`),
    followUp: async (t: string) => void calls.push(`followUp:${t}`),
    systemInput: async (text, origin, mode) => {
      calls.push(`systemInput:${origin.kind}:${mode}:${text}`);
    },
    // Pi's abort resolves only once the agent is idle again.
    abort: async () => {
      calls.push("abort");
      state = "idle";
    },
    rewindToUserTurn: async (i: number) => void calls.push(`rewind:${i}`),
    compact: async () => void calls.push("compact"),
    rename: async (name: string) => void calls.push(`rename:${name}`),
    pendingQueue: async () => ({ steering: ["s-msg"], followUp: ["f-msg"] }),
    clearQueue: async () => {
      calls.push("clearQueue");
      return { steering: ["s-msg"], followUp: ["f-msg"] };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose: async () => {},
  };
}

/** The bundled extensions this test pretends Pier ships with. */
const CATALOG = [{
  source: "bundled" as const,
  kind: "extension" as const,
  name: "web",
  summary: "the provider's own web tools",
  adds: [{ name: "web_search", needs: "an authenticated model" }],
}];
/** The managed CLI tools this test pretends Pier can install — one list with
 *  the extensions, exactly as main.ts assembles it. */
const TOOLS = [{
  source: "binary" as const,
  kind: "tool" as const,
  name: "rg",
  summary: "searches a tree by content",
  binary: { spec: "github:BurntSushi/ripgrep", installed: false, version: null, path: null, error: null },
}, {
  source: "binary" as const,
  kind: "tool" as const,
  name: "fd",
  summary: "finds files by name",
  binary: { spec: "github:sharkdp/fd", installed: false, version: null, path: null, error: null },
}];
/** GET /api/settings on a fresh instance. */
const SETTINGS_JSON = {
  publicUrl: "",
  modelMenu: [],
  autoUpdate: false,
  terminalInitCommand: "",
  extensions: [],
  tools: [],
  customTools: [],
  catalog: [...CATALOG, ...TOOLS].map((entry) => ({ ...entry, enabled: false })),
  toolsTaskId: null,
};

/** Scripted ConfigStore — records calls, echoes canned content. */
function fakeConfig(): ConfigStore & { calls: string[] } {
  const calls: string[] = [];
  const at = (s: ConfigScope) => (s.kind === "global" ? "global" : s.cwd);
  return {
    calls,
    globalDir: "/home/t/.pier/pi",
    listFiles: async (s) => {
      calls.push(`listFiles:${at(s)}`);
      return [{ name: "SYSTEM.md", exists: true }];
    },
    readFile: async (s, name) => {
      calls.push(`read:${at(s)}/${name}`);
      if (name === "nope.md") throw new Error("not an editable config file");
      return "content";
    },
    writeFile: async (s, name, content) => {
      calls.push(`write:${at(s)}/${name}=${content}`);
    },
    listResources: async (s) => {
      calls.push(`listResources:${at(s)}`);
      return { extensions: [{ name: "quiet.ts", link: false }], skills: [] };
    },
    readResource: async (s, kind, name) => {
      calls.push(`resource:${at(s)}/${kind}/${name}`);
      return "// ext";
    },
  };
}

/** Provider-owned prompts/events without a Pi runtime or real credentials. */
function fakeProviders(): ProviderManager & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    providers: async () => [
      {
        id: "anthropic",
        name: "Anthropic",
        builtin: true,
        methods: [
          { type: "api_key", name: "Anthropic API key" },
          { type: "oauth", name: "Claude Pro/Max", subscription: true },
        ],
        configured: false,
      },
    ],
    setup: async (input) => void calls.push(`setup:${input.kind}:${input.id}:${input.endpoint ?? "default"}`),
    check: async (providerId, modelId) => {
      calls.push(`check:${providerId}/${modelId}`);
      const sent = `{"model":"${modelId}","messages":[{"role":"user","content":"hi"}]}`;
      return providerId === "anthropic"
        ? { ok: true, model: modelId, ms: 42, request: sent, response: "Hi!" }
        : { ok: false, model: modelId, ms: 7, request: sent, response: "401 invalid_api_key" };
    },
    login: async (providerId, type, interaction) => {
      calls.push(`login:${providerId}:${type}`);
      if (type === "oauth") {
        interaction.notify({ type: "auth_url", url: "https://auth.example/authorize" });
      }
      const value = await interaction.prompt({
        type: type === "api_key" ? "secret" : "manual_code",
        message: type === "api_key" ? "API key" : "Authorization code",
      });
      calls.push(`response:${value}`);
      return async () => void calls.push(`rollback:${providerId}`);
    },
    logout: async (providerId) => void calls.push(`logout:${providerId}`),
  };
}

/** Scripted SecretsControl — in memory, never touches disk or vt. */
function fakeSecrets(opts: { unlockError?: string; doctorError?: string } = {}): SecretsControl & { calls: string[] } {
  const calls: string[] = [];
  let mode: "vt" | "file" | undefined;
  let lockedReason = "unlock() has not run";
  return {
    calls,
    get state() {
      return mode ? ("unlocked" as const) : ("locked" as const);
    },
    get mode() {
      return mode;
    },
    get lockedReason() {
      return lockedReason;
    },
    unlock: async () => {
      calls.push("unlock");
      if (opts.unlockError) {
        lockedReason = opts.unlockError;
        throw new Error(opts.unlockError);
      }
      mode = "file";
      lockedReason = "";
    },
    rotateKek: async (next?: "vt" | "file") => {
      calls.push(`rotate:${next ?? "keep"}`);
      if (!mode) throw new Error(`secrets locked: ${lockedReason}`);
      if (next) mode = next;
    },
    doctor: async () => {
      calls.push("doctor");
      if (opts.doctorError) throw new Error(opts.doctorError);
      return "vt doctor — vt v1\n\nAgent:\n  no agent listening";
    },
  };
}

function setup(
  cwd = "/tmp",
  secrets = fakeSecrets(),
  /** Latest published version, and how (or whether) this instance can take it. */
  update: {
    latest?: string;
    updater?: {
      apply: () => Promise<"started" | "busy" | "not-installed" | "failed">;
      problem?: () => string | null;
    } | null;
  } = {},
  prepareState: (db: DatabaseSync) => void = () => {},
) {
  const session = fakeSession("s1");
  const factory: AgentFactory = {
    availableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-opus-4-5" }]),
    create: vi.fn(async () => session),
    fork: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    // `modified` is the listing's own date for a session: the transcript's
    // mtime, which is the only record of a turn that survives a restart.
    list: vi.fn(async () => [{ id: "s1", cwd, createdAt: 1, modified: Date.now() }]),
    // Derived from the same list, like the real seam: a fake that answers the
    // two independently can agree with nothing.
    find: vi.fn(async (id: string) => (await factory.list()).find((s) => s.id === id)),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume("s1"));
  // Hermetic: every store shares one in-memory database, never the real $HOME.
  const db = openDb(":memory:");
  prepareState(db);
  const state = new SessionStateStore(db);
  const config = fakeConfig();
  const providers = fakeProviders();
  const settings = new SettingsStore(db);
  const updates = new UpdateCheck("0.0.1", () => Promise.resolve(update.latest ?? "0.0.1"));
  const updater = update.updater
    ? { apply: update.updater.apply, problem: update.updater.problem ?? (() => null) }
    : null;
  const tasks = new TaskService(new TaskStore(db), factory, router, hub);
  // Composed exactly like main.ts: task routes and web server never import each other.
  const app = new Hono();
  registerTaskRoutes(app, tasks, { factory, router });
  const onUnlocked = vi.fn();
  // Stands in for channels/conversations.ts: session id → the IM channel that owns it.
  const imOwners = new Map<string, string>();
  // Wired like main.ts: the adapters are its business, the eviction core's.
  const reload = vi.fn(() => router.evictIdle(0, Date.now(), { includeWatched: true }));
  // Stands in for main.ts's task lifecycle: web/ stores the set and says so,
  // the instance layer is what installs anything.
  const onToolsChanged = vi.fn(() => Promise.resolve<ToolsSyncNote | null>({ state: "started" }));
  /** What ubix would say about a declared block, for the tests that need it to
   *  say something other than "not installed". */
  const catalogState = new Map<string, { installed: boolean; error: string | null }>();
  /** Set by a test to hold the *next* catalog read open. */
  let parked: Promise<void> | null = null;
  const parkNextCatalogRead = (): { release: () => void } => {
    let release = (): void => {};
    parked = new Promise<void>((resolve) => (release = resolve));
    return { release };
  };
  app.route("/", createServer({
    factory, router, hub, sessions: state, config, providers, settings, updates, updater, secrets, onUnlocked,
    // Composed like main.ts — a catalog of names, so this test never loads an
    // extension or the SDK behind one.
    // One list, assembled like main.ts does: data only, never a subprocess —
    // loading an extension or spawning ubix is the instance layer's business.
    catalog: async () => {
      const answer = {
        entries: [
          ...CATALOG.map((ext) => ({ ...ext, enabled: settings.get().extensions.includes(ext.name) })),
          ...TOOLS.map((tool) => ({ ...tool, enabled: settings.get().tools.includes(tool.name) })),
          // The blocks the operator declared are rows too, exactly as
          // ManagedTools.status lists them — a fake that leaves them out cannot
          // show what a request replacing them does.
          ...settings.get().customTools.map((tool) => ({
            source: "binary" as const,
            kind: "tool" as const,
            name: tool.name,
            summary: "",
            enabled: settings.get().tools.includes(tool.name),
            binary: {
              spec: tool.toml,
              installed: catalogState.get(tool.name)?.installed ?? false,
              version: null,
              path: null,
              error: catalogState.get(tool.name)?.error ?? null,
            },
            custom: true,
          })),
        ],
        toolsTaskId: null,
      };
      // The snapshot is taken here, as the real one is: a test that parks a
      // request inside this read is holding a request between what it saw and
      // what it writes — the only window a check made before the transaction
      // has to be wrong in.
      const park = parked;
      parked = null;
      if (park) await park;
      return answer;
    },
    // Composed like main.ts: names are code, and a switch is validated against
    // them rather than against a catalog the same request may be rewriting.
    names: { extensions: CATALOG.map((ext) => ext.name), tools: TOOLS.map((tool) => tool.name) },
    onToolsChanged,
    // main.ts owns the rule (tools.ts) and the bundled names; the route only
    // gets an answer.
    validateCustomTools: (raw: unknown) => {
      const tools = normalizeCustomTools(raw, CATALOG.map((ext) => ext.name));
      return tools ? { tools } : { error: CUSTOM_TOOL_RULES };
    },
    reload,
    backgroundRuns: (id) => tasks.backgroundRuns(id),
    channelOf: (id) => imOwners.get(id),
  }));
  return {
    app,
    db,
    imOwners,
    session,
    factory,
    hub,
    router,
    state,
    config,
    providers,
    settings,
    tasks,
    secrets,
    onUnlocked,
    onToolsChanged,
    catalogState,
    parkNextCatalogRead,
    reload,
  };
}

/** The rail, as a surface reads it. `state.projects()` is gone: membership is
 *  the listing joined with what the store owns, and the route is where that
 *  happens. */
const rail = async (app: Hono): Promise<{ id: string; title?: string }[]> =>
  (await (await app.request("/api/projects")).json()) as { id: string; title?: string }[];

describe("workbench server", () => {
  it("lists sessions with live state", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "s1", cwd: "/tmp", createdAt: 1, state: "idle", listed: false, unread: false, activeRuns: 0, channel: "web" },
    ]);
  });

  // The badge counts "web" rows only (ui/sidebar.ts): an IM turn is delivered
  // to its own chat, and no Console visit is owed for it.
  it("names the IM channel that owns a session", async () => {
    const { app, imOwners } = setup();
    imOwners.set("s1", "slack");
    const rows = (await (await app.request("/api/sessions")).json()) as { channel: string }[];
    expect(rows[0]?.channel).toBe("slack");
  });

  // One source for both lists: the rail is the full listing minus what
  // Projects is not showing, and the title comes off the transcript like
  // everywhere else.
  it("renders Projects from the listing, joined with what it owns", async () => {
    const { app, factory, state } = setup();
    vi.mocked(factory.list).mockResolvedValue([
      { id: "s1", cwd: "/tmp", createdAt: 1, title: "Pinned", modified: Date.now() },
      { id: "s2", cwd: "/other", createdAt: 2, modified: Date.now() },
    ]);
    state.pin("s1", "/tmp", true);
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "s1", cwd: "/tmp", createdAt: 1, title: "Pinned", state: "idle", listed: true, unread: false, activeRuns: 0, channel: "web" },
    ]);
  });

  it("coalesces concurrent full session listings", async () => {
    const { app, factory } = setup();
    let resolve!: (rows: { id: string; cwd: string; createdAt: number }[]) => void;
    vi.mocked(factory.list).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const requests = [app.request("/api/sessions"), app.request("/api/sessions")];
    expect(factory.list).toHaveBeenCalledOnce();
    resolve([{ id: "s1", cwd: "/tmp", createdAt: 1 }]);
    expect((await Promise.all(requests)).map((res) => res.status)).toEqual([200, 200]);
  });

  it("marks a session unread when a witnessed run settles, until a client acks", async () => {
    const { app, session, hub, router, state } = setup();
    router.attach({ channelId: "web", conversationId: "s1" }, session);

    // Idle without a witnessed start (e.g. boot) never marks unread.
    session.emit({ type: "state", state: "idle" });
    expect(state.unread("s1")).toBe(false);

    const changed = vi.fn();
    hub.subscribeWorkspace(changed);
    session.emit({ type: "state", state: "streaming" });
    session.emit({ type: "state", state: "idle" });
    expect(state.unread("s1")).toBe(true);
    expect(changed).toHaveBeenCalledWith({ type: "sessions-changed" });
    const rows = (await (await app.request("/api/sessions")).json()) as { unread: boolean }[];
    expect(rows[0]!.unread).toBe(true);

    // Seen = read: the ack clears the mark and broadcasts the change.
    changed.mockClear();
    expect((await app.request("/api/sessions/s1/read", { method: "POST" })).status).toBe(200);
    expect(state.unread("s1")).toBe(false);
    expect(changed).toHaveBeenCalledWith({ type: "sessions-changed" });

    // Acking a session that isn't unread is a no-op, not a broadcast.
    changed.mockClear();
    await app.request("/api/sessions/s1/read", { method: "POST" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("reloads channels, recycles idle sessions and counts the ones mid-turn", async () => {
    const { app, session, router, reload } = setup();
    router.attach({ channelId: "web", conversationId: "s1" }, session);
    const busy = fakeSession("s2");
    busy.setState("streaming");
    router.attach({ channelId: "web", conversationId: "s2" }, busy);

    const res = await app.request("/api/reload", { method: "POST" });
    expect(res.status).toBe(200);
    // The idle one goes so its next message re-reads the agent files; the
    // streaming one is never interrupted, and saying so is the point.
    expect(await res.json()).toEqual({ recycled: 1, busy: 1 });
    expect(reload).toHaveBeenCalledOnce();
    expect(router.stateOf("s1")).toBeUndefined();
    expect(router.stateOf("s2")).toBe("streaming");
  });

  it("reports a reload that could not re-read channel configuration", async () => {
    const { app, reload } = setup();
    reload.mockRejectedValueOnce(new Error("slack: invalid_auth"));
    const res = await app.request("/api/reload", { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("invalid_auth");
  });

  it("lists a created session before Pi persists it, without duplicating later", async () => {
    const session = fakeSession("s2");
    const listed: { id: string; cwd: string; createdAt: number; modified?: number }[] = [];
    const factory: AgentFactory = {
      availableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-opus-4-5" }]),
    create: vi.fn(async () => session),
      fork: vi.fn(async () => session),
      resume: vi.fn(async () => session),
      list: vi.fn(async () => listed),
      find: vi.fn(async (id: string) => listed.find((s) => s.id === id)),
    };
    const hub = new EventHub();
    const app = createServer({
      factory,
      router: new Router(hub, () => factory.resume("s2")),
      hub,
      sessions: new SessionStateStore(openDb(":memory:")),
      config: fakeConfig(),
      providers: fakeProviders(),
      settings: new SettingsStore(openDb(":memory:")),
      updates: new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1")),
      secrets: fakeSecrets(),
    });
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });

    // Not on disk yet — the nascent entry fills the gap.
    let rows = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(rows).toEqual([
      { id: "s2", cwd: "/tmp", createdAt: expect.any(Number), state: "idle", listed: true, unread: false, activeRuns: 0, channel: "web" },
    ]);

    // Pi persisted it — the real row wins, no duplicate.
    listed.push({ id: "s2", cwd: "/tmp", createdAt: 1, modified: Date.now() });
    rows = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(rows).toEqual([
      { id: "s2", cwd: "/tmp", createdAt: 1, state: "idle", listed: true, unread: false, activeRuns: 0, channel: "web" },
    ]);
  });

  it("pins sessions created here, and toggles pins on demand", async () => {
    const { app } = setup();
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });
    expect((await rail(app)).map((r) => r.id)).toEqual(["s1"]);

    const off = await app.request("/api/sessions/s1/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: false }),
    });
    expect(off.status).toBe(200);
    expect(await rail(app)).toEqual([]);

    const bad = await app.request("/api/sessions/s1/pin", { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  // The directory is the server's own fact now. A session it cannot place has
  // no row to pin, and saying so beats writing a row keyed on nothing.
  it("refuses to pin a session no listing knows a directory for", async () => {
    const { app, factory } = setup();
    vi.mocked(factory.list).mockResolvedValue([]);
    vi.mocked(factory.find).mockResolvedValue(undefined);
    const res = await app.request("/api/sessions/nowhere/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("no directory");
  });

  // The name goes into the transcript and nowhere else; the rail re-reads it
  // like every other title, so there is no second copy to keep in step.
  it("names a session in its transcript, and tells the surfaces to re-read", async () => {
    const { app, session, router, hub } = setup();
    router.attach({ channelId: "web", conversationId: "s1" }, session);
    const changed = vi.fn();
    hub.subscribeWorkspace(changed);

    const res = await app.request("/api/sessions/s1/rename", {
      method: "POST",
      body: JSON.stringify({ name: "  parser work  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(session.calls).toContain("rename:parser work");
    expect(changed).toHaveBeenCalledWith({ type: "sessions-changed" });

    expect((await app.request("/api/sessions/s1/rename", { method: "POST", body: "{}" })).status)
      .toBe(400);
  });

  // The rail groups a repository's worktrees together, so the route has to
  // carry the identity git reports for the directory. Against a real repository,
  // because a fake would only prove the spread operator works — its own, and not
  // this checkout, which CI clones at a tag and hands over with a detached head.
  it("says which repository a project directory belongs to", async () => {
    const { app, state, factory } = setup();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pier-project-")));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "first");
    vi.mocked(factory.list).mockResolvedValue([
      { id: "s1", cwd, createdAt: 1, modified: Date.now() },
    ]);
    state.pin("s1", cwd, true);
    await vi.waitFor(async () => {
      const rows = (await (await app.request("/api/projects")).json()) as
        { repo?: string; branch?: string }[];
      // A worktree reports the *main* .git dir, which is the grouping key; what
      // it maps to is repos.test.ts's business.
      expect(rows[0]?.repo).toBe(join(cwd, ".git"));
      expect(rows[0]?.branch).toBe("main");
    });
  });

  // Membership is what a hand said, and nothing dates it: a session quiet for a
  // month is on the rail until the ✓ takes it off. A lease used to hide those
  // rows and `kept` used to opt out of it — two states answering one question,
  // for an expiry that never destroyed anything.
  it("keeps a session in the rail however quiet it goes, until a hand unpins it", async () => {
    const { app, state, factory } = setup();
    const month = Date.now() - 30 * 86_400_000;
    vi.mocked(factory.list).mockResolvedValue([
      { id: "s1", cwd: "/tmp", createdAt: 1, modified: month },
      { id: "s2", cwd: "/tmp", createdAt: 2, modified: month },
    ]);
    state.pin("s1", "/tmp", true);
    state.pin("s2", "/tmp", true);
    expect((await rail(app)).map((r) => r.id).sort()).toEqual(["s1", "s2"]);

    expect((await app.request("/api/sessions/s1/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: false }),
    })).status).toBe(200);
    expect((await rail(app)).map((r) => r.id)).toEqual(["s2"]);

    // And back, on the same act: pinning a month-old session is the only thing
    // that decides, so the re-read cannot disagree with the click.
    expect((await app.request("/api/sessions/s1/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: true }),
    })).status).toBe(200);
    expect((await rail(app)).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });

  // A row that predates all of this holds a pin and a directory and nothing
  // else. Everything the rail draws comes off the listing, so there is no
  // backfill to run and no stale summary to repair.
  it("renders a pin that carries no summary at all", async () => {
    const month = Date.now() - 30 * 86_400_000;
    const { app, factory } = setup(
      "/tmp",
      fakeSecrets(),
      {},
      (db) =>
        db.prepare("INSERT INTO session_state(session_id, pinned, cwd) VALUES ('s1', 1, '/tmp')")
          .run(),
    );
    vi.mocked(factory.list).mockResolvedValue([
      { id: "s1", cwd: "/tmp", createdAt: month, title: "from the transcript", modified: Date.now() },
    ]);
    expect(await rail(app)).toEqual([
      expect.objectContaining({ id: "s1", title: "from the transcript" }),
    ]);
  });

  it("keeps the manual order, and a new session never moves its project", async () => {
    const { app, state, factory } = setup();
    const listed = [
      { id: "a1", cwd: "/a", createdAt: 1, modified: Date.now() },
      { id: "b1", cwd: "/b", createdAt: 2, modified: Date.now() },
    ];
    vi.mocked(factory.list).mockImplementation(async () => listed);
    state.pin("a1", "/a", true);
    state.pin("b1", "/b", true);
    const order = (body: unknown) =>
      app.request("/api/projects/order", { method: "POST", body: JSON.stringify(body) });

    expect((await order({ projects: ["/b", "/a"], sessions: ["b1", "a1"] })).status).toBe(200);
    const placed = (await (await app.request("/api/projects")).json()) as
      { id: string; sort?: number; projectSort?: number }[];
    expect(placed.map((r) => [r.id, r.sort, r.projectSort]).sort()).toEqual([
      ["a1", 1, 1],
      ["b1", 0, 0],
    ]);

    // The jump this exists to stop: a second session in /a inherits /a's place.
    listed.push({ id: "a2", cwd: "/a", createdAt: 3, modified: Date.now() });
    state.pin("a2", "/a", true);
    const rows = (await (await app.request("/api/projects")).json()) as
      { id: string; sort?: number; projectSort?: number }[];
    expect(rows.find((r) => r.id === "a2")).toMatchObject({ projectSort: 1 });
    // Never dragged: no place of its own, which is what puts it on top of /a.
    expect(rows.find((r) => r.id === "a2")).not.toHaveProperty("sort");
  });

  it("refuses an order that is not a list of ids", async () => {
    const { app } = setup();
    const order = (body: string) => app.request("/api/projects/order", { method: "POST", body });
    expect((await order("{}")).status).toBe(400);
    expect((await order(JSON.stringify({ projects: ["/a", 7] }))).status).toBe(400);
    expect((await order(JSON.stringify({ sessions: "s1" }))).status).toBe(400);
  });

  it("creates a session in the given project directory, never pier's own", async () => {
    const { app, factory, session, hub } = setup();
    expect((await app.request("/api/sessions", { method: "POST", body: "{}" })).status).toBe(400);
    const res = await app.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "s1" });
    expect(factory.create).toHaveBeenCalledExactlyOnceWith({ cwd: "/tmp" });
    // attached: session events now reach the hub
    const seen = vi.fn();
    hub.subscribe("s1", seen);
    session.emit({ type: "turn-start" });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("accepts an inbox upload and refuses a malformed one", async () => {
    const { app } = setup();
    const res = await app.request("/api/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shot.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") }),
    });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith(join(process.env.PIER_HOME!, "inbox", "web"))).toBe(true);
    expect(path.endsWith("-shot.png")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("png-bytes");

    const bad = await app.request("/api/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png" }), // no data
    });
    expect(bad.status).toBe(400);

    // Buffer.from would "decode" this garbage to bytes; the seam must not.
    const garbage = await app.request("/api/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", data: "!!!!" }),
    });
    expect(garbage.status).toBe(400);
  });

  it("serves agent attachments from the session cwd, and nothing outside it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pier-files-")));
    writeFileSync(join(root, "report.md"), "# hi");
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "pier-outside-"))), "secret.txt");
    writeFileSync(outside, "nope");
    symlinkSync(outside, join(root, "escape.txt"));
    const { app } = setup(root);
    const url = (p: string) => `/api/sessions/s1/files?path=${encodeURIComponent(p)}`;

    const ok = await app.request(url(join(root, "report.md")));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await ok.text()).toBe("# hi");
    expect((await app.request(`${url(join(root, "report.md"))}&download=1`)).headers.get("content-disposition"))
      .toBe("attachment; filename*=UTF-8''report.md");

    // A file in Pier's inbox (an inbound user attachment) is also served.
    const inbox = join(process.env.PIER_HOME!, "inbox", "web");
    mkdirSync(inbox, { recursive: true });
    const sent = join(inbox, "1-ab-sent.txt");
    writeFileSync(sent, "from user");
    const fromInbox = await app.request(url(sent));
    expect(fromInbox.status).toBe(200);
    expect(await fromInbox.text()).toBe("from user");

    // Traversal, symlink escape, relative paths, missing file: all refused.
    expect((await app.request(url(outside))).status).toBe(404);
    expect((await app.request(url(join(root, "..", "..", "etc", "passwd")))).status).toBe(404);
    expect((await app.request(url(join(root, "escape.txt")))).status).toBe(404);
    expect((await app.request(url("report.md"))).status).toBe(404);
    expect((await app.request(url(root))).status).toBe(404); // a directory is not a file
    expect((await app.request("/api/sessions/s1/files")).status).toBe(400);
  });

  it("snapshots history, live state and pending queue on demand", async () => {
    const { app, hub, session } = setup();
    hub.emit("s1", { type: "turn-start" });
    session.setState("streaming");
    const res = await app.request("/api/sessions/s1/history");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      lastSeq: 1,
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      state: "streaming",
      context: { tokens: 1200, contextWindow: 200_000 },
      thinkingLevel: "medium",
      queue: { steering: ["s-msg"], followUp: ["f-msg"] },
      backgroundRuns: [],
    });
    session.setState("idle");
    // ensure() attached the session: its events now reach the hub
    const seen = vi.fn();
    hub.subscribe("s1", seen);
    session.emit({ type: "turn-start" });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("leaves a step's args and output off the snapshot, and serves them per turn", async () => {
    const { app, session } = setup();
    const steps = [
      { kind: "thinking" as const, text: "hmm" },
      { kind: "tool" as const, id: "t1", toolName: "read", args: { path: "a.ts" }, output: "file", isError: false, done: true },
    ];
    session.history = async () => [
      { role: "user" as const, text: "hi" },
      { role: "assistant" as const, text: "hello", steps },
    ];
    const snapshot = (await (await app.request("/api/sessions/s1/history")).json()) as {
      turns: { steps?: unknown[] }[];
    };
    // The headline needs the thinking text and the step's identity; the bulk
    // — args and output — waits until a group is opened.
    expect(snapshot.turns[1]?.steps).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "tool", id: "t1", toolName: "read", isError: false, done: true },
    ]);

    const detail = await app.request("/api/sessions/s1/turns/1/steps");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ steps });
    // A turn with no activity answers with an empty list, not a 404 — and an
    // index past the transcript is the 404.
    expect(await (await app.request("/api/sessions/s1/turns/0/steps")).json()).toEqual({ steps: [] });
    expect((await app.request("/api/sessions/s1/turns/9/steps")).status).toBe(404);
    expect((await app.request("/api/sessions/s1/turns/x/steps")).status).toBe(400);
  });

  it("gzips a long transcript, and only the transcript", async () => {
    const { app, session } = setup();
    const filler = "x".repeat(2000);
    session.history = async () =>
      Array.from({ length: 20 }, () => ({ role: "assistant" as const, text: filler }));
    const res = await app.request("/api/sessions/s1/history", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect((JSON.parse(body) as { turns: unknown[] }).turns).toHaveLength(20);
    // The SSE streams must stay uncompressed: an encoder would sit on events
    // until its buffer filled, which is the opposite of a live stream.
    const stream = await app.request("/api/sessions/s1/events", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(stream.headers.get("content-encoding")).toBeNull();
  });

  it("answers the version badge with a real first check, not 'no idea yet'", async () => {
    const apply = vi.fn(() => Promise.resolve("started" as const));
    const { app } = setup("/tmp", fakeSecrets(), { latest: "0.9.0", updater: { apply } });
    // The whole point of statusNow: a browser loading right after a restart is
    // told the truth instead of latest: null.
    expect(await (await app.request("/api/update")).json()).toEqual({
      current: "0.0.1", latest: "0.9.0", available: true, canApply: true, autoUpdate: false, problem: null,
    });

    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, latest: "0.9.0" });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("refuses to apply an update it cannot apply, and says which reason it is", async () => {
    // Nothing supervises the process: the button is not offered, and the route
    // behind it says what to type instead.
    const bare = setup("/tmp", fakeSecrets(), { latest: "0.9.0" });
    expect((await (await bare.app.request("/api/update")).json() as { canApply: boolean }).canApply).toBe(false);
    const noService = await bare.app.request("/api/update", { method: "POST" });
    expect(noService.status).toBe(409);
    expect(await noService.json()).toEqual({ error: expect.stringContaining("pier update") });

    // Already current: nothing to install, and the updater is never started.
    const apply = vi.fn(() => Promise.resolve("started" as const));
    const current = setup("/tmp", fakeSecrets(), { updater: { apply } });
    expect((await current.app.request("/api/update", { method: "POST" })).status).toBe(409);
    expect(apply).not.toHaveBeenCalled();

    // The unit is gone under a running Pier: a failure, reported as one.
    const broken = setup("/tmp", fakeSecrets(), {
      latest: "0.9.0",
      updater: { apply: () => Promise.resolve("not-installed" as const) },
    });
    const failed = await broken.app.request("/api/update", { method: "POST" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: expect.stringContaining("pier service install") });
  });

  it("answers busy as 409 when another handover or restart owns the gate", async () => {
    const { app } = setup("/tmp", fakeSecrets(), {
      latest: "0.9.0",
      updater: { apply: () => Promise.resolve("busy" as const) },
    });
    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringContaining("already in progress") });
  });

  it("answers 202 rather than holding the response through a long drain", async () => {
    // The handover drains first, which can take minutes on a busy Pier; a
    // response held open that long dies at every proxy on the way.
    vi.useFakeTimers();
    try {
      const apply = vi.fn(() => new Promise<never>(() => {}));
      const { app } = setup("/tmp", fakeSecrets(), { latest: "0.9.0", updater: { apply } });
      const pending = app.request("/api/update", { method: "POST" });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ started: true, draining: true, latest: "0.9.0" });
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a stale updater instead of draining for a handover that cannot happen", async () => {
    // The fnm case: the recorded Node is gone, so the unit would fail to run.
    // Reported whether or not an update is pending, and never attempted.
    const apply = vi.fn(() => Promise.resolve("started" as const));
    const { app } = setup("/tmp", fakeSecrets(), {
      latest: "0.9.0",
      updater: { apply, problem: () => "the node the updater would use is gone" },
    });
    expect(await (await app.request("/api/update")).json()).toMatchObject({
      canApply: true,
      problem: "the node the updater would use is gone",
    });
    const res = await app.request("/api/update", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "the node the updater would use is gone" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("stores the auto-update switch and rejects a non-boolean", async () => {
    const { app, settings } = setup();
    const put = (autoUpdate: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoUpdate }),
      });
    expect((await put(true)).status).toBe(200);
    expect(settings.get().autoUpdate).toBe(true);
    expect((await put("yes")).status).toBe(400);
    expect(settings.get().autoUpdate).toBe(true);
    expect((await put(false)).status).toBe(200);
    expect(settings.get().autoUpdate).toBe(false);
  });

  it("switches a bundled extension on, refuses a mis-shaped delta, and recycles", async () => {
    const { app, settings } = setup();
    const put = (extension: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extension }),
      });
    const ok = await put({ name: "web", on: true });
    expect(ok.status).toBe(200);
    expect(settings.get().extensions).toEqual(["web"]);
    // The answer carries the switches back, already flipped.
    expect(await ok.json()).toMatchObject({
      catalog: [{ name: "web", enabled: true }, { name: "rg" }, { name: "fd" }],
    });
    expect((await put("web")).status).toBe(400);
    expect((await put({ name: 42, on: true })).status).toBe(400);
    expect(settings.get().extensions).toEqual(["web"]);
    expect((await put({ name: "web", on: false })).status).toBe(200);
    expect(settings.get().extensions).toEqual([]);
  });

  it("switches a managed tool on, tells the instance layer, and refuses a bad delta", async () => {
    const { app, settings, onToolsChanged } = setup();
    const put = (tool: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool }),
      });
    const ok = await put({ name: "rg", on: true });
    expect(ok.status).toBe(200);
    expect(settings.get().tools).toEqual(["rg"]);
    // The answer carries the switch back already flipped, so the Console never
    // draws a state nobody stored.
    expect(await ok.json()).toMatchObject({
      catalog: [{ name: "web" }, { name: "rg", enabled: true }, { name: "fd" }],
    });
    expect(onToolsChanged).toHaveBeenCalledTimes(1);

    expect((await put("rg")).status).toBe(400);
    expect((await put({ name: "rg", on: "yes" })).status).toBe(400);
    // A refused write changes nothing and installs nothing.
    expect(settings.get().tools).toEqual(["rg"]);
    expect(onToolsChanged).toHaveBeenCalledTimes(1);

    expect((await put({ name: "rg", on: false })).status).toBe(200);
    expect(settings.get().tools).toEqual([]);
  });

  // The bug this test exists for: the set was stored, nothing installed it,
  // and the only trace was a line in the journal the person who flipped the
  // switch never sees.
  it("says on the switch when the set was stored and nothing will install it", async () => {
    const { app, settings, onToolsChanged } = setup();
    onToolsChanged.mockResolvedValueOnce({
      state: "refused",
      reason: "no CLI to run: /opt/pier/cli.js does not exist",
    });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: { name: "rg", on: true } }),
    });
    // Stored — the switch shows what was written — and the reason rides back
    // with it rather than only reaching the log.
    expect(res.status).toBe(200);
    expect(settings.get().tools).toEqual(["rg"]);
    expect(await res.json()).toMatchObject({
      toolsSync: { state: "refused", reason: "no CLI to run: /opt/pier/cli.js does not exist" },
    });
  });

  // The bug this test exists for: two quick clicks each sent the whole list as
  // the page knew it a moment earlier, so the second silently dropped the
  // first — the sync race, one layer up.
  it("applies a switch as a delta, so two overlapping flips both survive", async () => {
    const { app, settings } = setup();
    const flip = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Both are computed from the same starting state — an empty set — exactly
    // as two clicks on a page that has not been redrawn yet would be.
    const [first, second] = await Promise.all([
      flip({ tool: { name: "rg", on: true } }),
      flip({ tool: { name: "fd", on: true } }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(settings.get().tools.sort()).toEqual(["fd", "rg"]);

    // Off is the same delta, and switching one off leaves the other alone.
    expect((await flip({ tool: { name: "rg", on: false } })).status).toBe(200);
    expect(settings.get().tools).toEqual(["fd"]);
    // Extensions take the same shape, and never land in the tool set.
    expect((await flip({ extension: { name: "web", on: true } })).status).toBe(200);
    expect(settings.get().extensions).toEqual(["web"]);
    expect(settings.get().tools).toEqual(["fd"]);
    // Mis-shaped deltas are refused, not guessed at.
    expect((await flip({ tool: { name: "rg" } })).status).toBe(400);
    expect((await flip({ tool: { on: true } })).status).toBe(400);
  });

  // The switch cannot say "saved" and leave it there while its work sits
  // behind a sync already running — that is what left four switches on and two
  // tools installed.
  it("passes back that a change is waiting behind a running sync", async () => {
    const { app, onToolsChanged } = setup();
    onToolsChanged.mockResolvedValueOnce({ state: "waiting" });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: { name: "rg", on: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ toolsSync: { state: "waiting" } });
  });

  // The bug this test exists for: any name at all was accepted. `{tool:{name:
  // "web"}}` or a typo answered 200, stored a setting no surface can show, and
  // ran a sync with nothing to install.
  it("refuses a switch for a name this instance has no switch for, and names it", async () => {
    const { app, settings, onToolsChanged } = setup();
    const put = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const [body, named] of [
      [{ tool: { name: "rgg", on: true } }, "rgg"],
      // A bundled extension is not a binary, and neither is switched through
      // the other's set.
      [{ tool: { name: "web", on: true } }, "web"],
      [{ extension: { name: "rg", on: true } }, "rg"],
    ] as const) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining(named) });
    }
    expect(settings.get().tools).toEqual([]);
    expect(settings.get().extensions).toEqual([]);
    expect(onToolsChanged).not.toHaveBeenCalled();

    // A name the catalog no longer has can still be taken *out* of the set it
    // is stored in: that is the repair, not the mistake.
    settings.setTools(["gone"]);
    expect((await put({ tool: { name: "gone", on: false } })).status).toBe(200);
    expect(settings.get().tools).toEqual([]);
  });

  // The bug this test exists for: the catalog is what is declared *now*, so a
  // request that deletes a block and switches its tool on in the same write
  // was checked against the row it was about to remove — and stored an enabled
  // tool nothing declares.
  it("checks a switch against the blocks the same request declares, not the ones it deletes", async () => {
    const { app, settings } = setup();
    const put = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const eza = { name: "eza", toml: `spec = "github:eza-community/eza"` };
    expect((await put({ customTools: [eza], tool: { name: "eza", on: true } })).status).toBe(200);
    expect((await put({ tool: { name: "eza", on: false } })).status).toBe(200);

    const gone = await put({ customTools: [], tool: { name: "eza", on: true } });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toMatchObject({ error: expect.stringContaining("eza") });
    // Neither half was stored: the block is still declared and nothing is on.
    expect(settings.get().customTools).toEqual([eza]);
    expect(settings.get().tools).toEqual([]);

    // Replacing the blocks with a *different* one, and switching that one on,
    // is the Add flow and still works.
    const uv = { name: "uv", toml: `spec = "github:astral-sh/uv"` };
    expect((await put({ customTools: [uv], tool: { name: "uv", on: true } })).status).toBe(200);
    expect(settings.get().customTools).toEqual([uv]);
    expect(settings.get().tools).toEqual(["uv"]);
    // Dropping uv's block while uv is on is refused whatever else the request
    // carries — the block is the only thing that can uninstall the binary.
    const early = await put({ customTools: [], tool: { name: "rg", on: true } });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: expect.stringContaining("still switched on") });
    expect(settings.get().customTools).toEqual([uv]);
    expect(settings.get().tools).toEqual(["uv"]);

    // Off first, and then both halves go through: a built-in row is not a
    // custom one, so replacing the blocks leaves it switchable.
    expect((await put({ tool: { name: "uv", on: false } })).status).toBe(200);
    expect((await put({ customTools: [], tool: { name: "rg", on: true } })).status).toBe(200);
    expect(settings.get().customTools).toEqual([]);
    expect(settings.get().tools).toEqual(["rg"]);
  });

  // The bug this test exists for: the rule that a declaration outlives its
  // binary lived only in the Console's helper, so `PUT {customTools: []}`
  // answered 200 and left the tool enabled with nothing left to uninstall it.
  it("refuses to drop a block while the binary it declares is still there", async () => {
    const { app, settings, catalogState } = setup();
    const put = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const eza = { name: "eza", toml: `spec = "github:eza-community/eza"` };
    expect((await put({ customTools: [eza], tool: { name: "eza", on: true } })).status).toBe(200);

    const on = await put({ customTools: [] });
    expect(on.status).toBe(409);
    expect(await on.json()).toMatchObject({ error: expect.stringContaining("still switched on") });

    // Switched off, but the binary is still installed: the block is what the
    // next sync uninstalls it with.
    expect((await put({ tool: { name: "eza", on: false } })).status).toBe(200);
    catalogState.set("eza", { installed: true, error: null });
    const installed = await put({ customTools: [] });
    expect(installed.status).toBe(409);
    expect(await installed.json()).toMatchObject({ error: expect.stringContaining("still installed") });

    // Broken, or unreadable: neither is "gone".
    catalogState.set("eza", { installed: false, error: "state.toml is locked" });
    expect((await put({ customTools: [] })).status).toBe(409);
    expect(settings.get().customTools).toEqual([eza]);

    // Gone, as ubix reports it: now the block may go.
    catalogState.set("eza", { installed: false, error: null });
    expect((await put({ customTools: [] })).status).toBe(200);
    expect(settings.get().customTools).toEqual([]);
  });

  // The bug this test exists for: validation ran before the transaction, so a
  // request dropping a declaration and one switching that tool on both passed
  // their checks and left an enabled tool nothing declares.
  it("settles two racing writes inside the transaction, not before it", async () => {
    const { app, settings, parkNextCatalogRead } = setup();
    const put = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const eza = { name: "eza", toml: `spec = "github:eza-community/eza"` };
    expect((await put({ customTools: [eza] })).status).toBe(200);

    // A request that reads the world, is held there, and writes afterwards:
    // the drop below saw eza switched off and not installed, which is exactly
    // what a check made before the write would still be believing.
    const held = parkNextCatalogRead();
    const dropping = put({ customTools: [] });
    await new Promise((resolve) => setImmediate(resolve));
    // Meanwhile the tool is switched on — legitimately: it is still declared.
    expect((await put({ tool: { name: "eza", on: true } })).status).toBe(200);
    held.release();

    // The held request is judged on the state as it is when it writes, not on
    // what it read: the block stays, because something is using it now.
    const dropped = await dropping;
    expect(dropped.status).toBe(409);
    expect(await dropped.json()).toMatchObject({ error: expect.stringContaining("still switched on") });
    expect(settings.get()).toMatchObject({ tools: ["eza"], customTools: [eza] });
  });

  it("declares a custom tool and its switch in one write, or neither", async () => {
    const { app, settings } = setup();
    const put = (body: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const eza = { name: "eza", toml: `spec = "github:eza-community/eza"` };
    const ok = await put({ customTools: [eza], tool: { name: "eza", on: true } });
    expect(ok.status).toBe(200);
    expect(settings.get().customTools).toEqual([eza]);
    expect(settings.get().tools).toEqual(["eza"]);

    // A block that opens a section beside a good switch: neither half is
    // stored, so the Console never shows a tool that is on and undeclared —
    // and install_dir is never something a text field can move.
    const bad = await put({
      customTools: [eza, { name: "nope", toml: `spec = "github:x/y"\n[settings]\ninstall_dir = "/usr/bin"` }],
      tool: { name: "nope", on: true },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining("spec line") });
    expect(settings.get().customTools).toEqual([eza]);
    expect(settings.get().tools).toEqual(["eza"]);
  });

  it("reads and writes the public URL, normalizing it and refusing a non-URL", async () => {
    const { app, settings } = setup();
    expect(await (await app.request("/api/settings")).json()).toEqual(SETTINGS_JSON);

    const put = (publicUrl: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicUrl }),
      });
    const ok = await put("pier.example.com/");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ...SETTINGS_JSON, publicUrl: "https://pier.example.com" });
    expect(settings.get().publicUrl).toBe("https://pier.example.com");

    expect((await put("not a url")).status).toBe(400);
    expect((await put(42)).status).toBe(400);
    // A rejected write leaves the stored value alone.
    expect(settings.get().publicUrl).toBe("https://pier.example.com");
  });

  it("writes the terminal startup command and rejects one a tty would split", async () => {
    const { app, settings } = setup();
    const put = (terminalInitCommand: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terminalInitCommand }),
      });
    const ok = await put("  tmux new -As run  ");
    expect(ok.status).toBe(200);
    expect(settings.get().terminalInitCommand).toBe("tmux new -As run");

    expect((await put("tmux new\nrm -rf /")).status).toBe(400);
    expect((await put(42)).status).toBe(400);
    expect(settings.get().terminalInitCommand).toBe("tmux new -As run");

    expect((await put("")).status).toBe(200);
    expect(settings.get().terminalInitCommand).toBe("");
  });

  it("writes the model menu without disturbing the URL, and rejects a bad one", async () => {
    const { app, settings } = setup();
    settings.setPublicUrl("https://pier.example.com");
    const put = (modelMenu: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelMenu }),
      });
    const menu = [{ provider: "anthropic", id: "claude-opus-4-5", note: "hard problems" }];
    const ok = await put(menu);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ...SETTINGS_JSON,
      publicUrl: "https://pier.example.com",
      modelMenu: menu,
    });

    expect((await put("nope")).status).toBe(400);
    expect((await put([{ provider: "a" }])).status).toBe(400);
    expect(settings.get().modelMenu).toEqual(menu);

    // Neither field is also "no request".
    const empty = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it("returns 404 for unknown sessions", async () => {
    const { factory } = setup();
    const hub = new EventHub();
    const router = new Router(hub, async () => {
      throw new Error("unknown session: nope");
    });
    const app = createServer({
      factory,
      router,
      hub,
      sessions: new SessionStateStore(openDb(":memory:")),
      config: fakeConfig(),
      providers: fakeProviders(),
      settings: new SettingsStore(openDb(":memory:")),
      updates: new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1")),
      secrets: fakeSecrets(),
    });
    const res = await app.request("/api/sessions/nope/history");
    expect(res.status).toBe(404);
  });

  it("drops a ghost session's rail entry when loading it proves Pi never persisted it", async () => {
    const { factory } = setup();
    const hub = new EventHub();
    const router = new Router(hub, async () => {
      throw new Error("unknown session: ghost");
    });
    const state = new SessionStateStore(openDb(":memory:"));
    // The create-time write: pinned with a cwd, exactly what POST /api/desk
    // and POST /api/sessions persist before Pi has anything on disk.
    state.pin("ghost", "/tmp/desk", true);
    const events: string[] = [];
    hub.subscribeWorkspace((e) => events.push(e.type));
    const app = createServer({
      factory,
      router,
      hub,
      sessions: state,
      config: fakeConfig(),
      providers: fakeProviders(),
      settings: new SettingsStore(openDb(":memory:")),
      updates: new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1")),
      secrets: fakeSecrets(),
    });
    const res = await app.request("/api/sessions/ghost/history");
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("never got a first reply");
    // The row is gone and every rail was told, so the Desk row (or a project
    // group) stops pointing at a session nothing can resume.
    expect(state.flags().get("ghost")).toBeUndefined();
    expect(events).toContain("sessions-changed");
  });

  it("relays API-key and OAuth login flows without returning submitted secrets", async () => {
    const { app, providers } = setup();
    const start = async (type: "api_key" | "oauth") => {
      const res = await app.request("/api/providers/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          setup: { kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1" },
          authType: type,
        }),
      });
      expect(res.status).toBe(202);
      return (await res.json()) as {
        id: string;
        state: string;
        prompt?: { id: string; type: string };
        events: { type: string; url?: string }[];
      };
    };

    const apiKey = await start("api_key");
    expect(apiKey.prompt?.type).toBe("secret");
    const answered = await app.request(`/api/providers/flows/${apiKey.id}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptId: apiKey.prompt!.id, value: "sk-live-secret" }),
    });
    expect(answered.status).toBe(204);
    expect(await answered.text()).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const flowStatus = await app.request(`/api/providers/flows/${apiKey.id}`);
    expect(flowStatus.headers.get("cache-control")).toBe("no-store");
    expect(await flowStatus.json()).toMatchObject({ state: "succeeded" });

    const oauth = await start("oauth");
    expect(oauth.events).toContainEqual({ type: "auth_url", url: "https://auth.example/authorize" });
    expect(oauth.prompt?.type).toBe("manual_code");
    await app.request(`/api/providers/flows/${oauth.id}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptId: oauth.prompt!.id, value: "oauth-code" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const providerList = await app.request("/api/providers");
    expect(providerList.status).toBe(200);
    expect(providerList.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/api/providers/anthropic/logout", { method: "POST" })).status).toBe(200);
    expect(providers.calls).toEqual([
      "login:anthropic:api_key",
      "response:sk-live-secret",
      "setup:builtin:anthropic:https://proxy.example/v1",
      "login:anthropic:oauth",
      "response:oauth-code",
      "setup:builtin:anthropic:https://proxy.example/v1",
      "logout:anthropic",
    ]);
  });

  it("answers a provider probe, and a refusal is an answer rather than a 500", async () => {
    const { app, providers } = setup();
    const probe = (id: string, body: unknown) =>
      app.request(`/api/providers/${id}/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const worked = await probe("anthropic", { model: " claude-haiku-4-5 " });
    expect(worked.status).toBe(200);
    expect(await worked.json()).toMatchObject({
      ok: true,
      model: "claude-haiku-4-5",
      response: "Hi!",
      request: expect.stringContaining("claude-haiku-4-5"),
    });

    // "The key is revoked" is the answer to "does this work", not an error of
    // the request that asked — and the provider's own words are kept.
    const refused = await probe("someone-else", { model: "m" });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ ok: false, response: "401 invalid_api_key" });

    // Nothing picks a model here: without one there is nothing to answer.
    expect((await probe("anthropic", {})).status).toBe(400);
    expect((await probe("anthropic", { model: "  " })).status).toBe(400);
    expect(providers.calls).toEqual(["check:anthropic/claude-haiku-4-5", "check:someone-else/m"]);
  });

  it("sanitizes provider-owned flow data and redacts submitted values from failures", async () => {
    const providers = fakeProviders();
    providers.login = async (_providerId, _type, interaction) => {
      interaction.notify({
        type: "info",
        message: "Provider message",
        links: [{ url: "https://auth.example", label: "Open" }],
        internal: "event-secret",
      } as Parameters<typeof interaction.notify>[0]);
      const value = await interaction.prompt({
        type: "secret",
        message: "API key",
        internal: "prompt-secret",
      } as Parameters<typeof interaction.prompt>[0]);
      interaction.notify({ type: "progress", message: `checking ${value}` });
      const confirmation = await interaction.prompt({ type: "text", message: "Continue" });
      throw new Error(`provider rejected ${value} ${confirmation}`);
    };
    const flows = new ProviderFlows(providers);
    const flow = await flows.start("anthropic", "api_key");
    expect(JSON.stringify(flow)).not.toContain("event-secret");
    expect(JSON.stringify(flow)).not.toContain("prompt-secret");
    flows.respond(flow.id, flow.prompt!.id, "submitted-secret");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const running = flows.get(flow.id)!;
    expect(running.events).toContainEqual({ type: "progress", message: "checking [redacted]" });
    expect(JSON.stringify(running)).not.toContain("submitted-secret");
    flows.respond(flow.id, running.prompt!.id, "x");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = flows.get(flow.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.events).toEqual([]);
    expect(failed.error).toContain("[redacted]");
    expect(failed.error).not.toContain("submitted-secret");
    expect(failed.error).not.toContain("x");
  });

  it("restores a committed credential when provider setup fails", async () => {
    const providers = fakeProviders();
    let restored = false;
    providers.login = async (_providerId, _type, interaction) => {
      await interaction.prompt({ type: "secret", message: "API key" });
      return async () => { restored = true; };
    };
    const flows = new ProviderFlows(providers);
    const flow = await flows.start(
      "anthropic",
      "api_key",
      undefined,
      async () => { throw new Error("models.json changed"); },
    );
    flows.respond(flow.id, flow.prompt!.id, "new-secret");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restored).toBe(true);
    expect(flows.get(flow.id)).toMatchObject({ state: "failed" });
  });

  it("expires a stalled authentication flow at its absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const providers = fakeProviders();
      let aborted = false;
      providers.login = async (_providerId, _type, interaction) => new Promise<() => Promise<void>>((_resolve, reject) => {
        interaction.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
      const flows = new ProviderFlows(providers);
      const flow = await flows.start("anthropic", "oauth");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(aborted).toBe(true);
      expect(flows.get(flow.id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an authentication flow and validates unsupported methods", async () => {
    const { app, providers } = setup();
    const bad = await app.request("/api/providers/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup: { kind: "builtin", id: "anthropic" }, authType: "password" }),
    });
    expect(bad.status).toBe(400);
    const unsafeEndpoint = await app.request("/api/providers/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setup: { kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1?key=secret" },
        authType: "api_key",
      }),
    });
    expect(unsafeEndpoint.status).toBe(400);
    expect(providers.calls).toEqual([]);

    const started = await app.request("/api/providers/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup: { kind: "builtin", id: "anthropic" }, authType: "oauth" }),
    });
    const flow = (await started.json()) as { id: string };
    const duplicate = await app.request("/api/providers/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setup: { kind: "builtin", id: "anthropic", endpoint: "https://other.example/v1" },
        authType: "oauth",
      }),
    });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("authentication already running"),
    });
    expect(providers.calls.filter((call) => call.startsWith("setup:"))).toHaveLength(0);
    const cancelled = await app.request(`/api/providers/flows/${flow.id}/cancel`, { method: "POST" });
    expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
    // Existing provider structure is committed only after authentication succeeds.
    expect(providers.calls.filter((call) => call.startsWith("setup:"))).toHaveLength(0);
  });

  it("reports secrets status — state, mode and the locked reason, never key material", async () => {
    const { app } = setup();
    const res = await app.request("/api/secrets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "locked", mode: null, reason: "unlock() has not run" });
  });

  it("unlocks secrets and starts the held-back channels", async () => {
    const { app, onUnlocked, secrets } = setup();
    const res = await app.request("/api/secrets/unlock", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "unlocked", mode: "file" });
    expect(onUnlocked).toHaveBeenCalledOnce();
    expect(secrets.calls).toEqual(["unlock"]);
  });

  it("surfaces a failed unlock as text and does not start channels", async () => {
    const { app, onUnlocked } = setup("/tmp", fakeSecrets({ unlockError: "vt read denied" }));
    const res = await app.request("/api/secrets/unlock", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: vt read denied" });
    expect(onUnlocked).not.toHaveBeenCalled();
    // The reason the unlock failed is what the next GET shows.
    expect(await (await app.request("/api/secrets")).json()).toEqual({
      state: "locked",
      mode: null,
      reason: "vt read denied",
    });
  });

  it("reports vt's own diagnosis while locked, failures included", async () => {
    const { app, secrets } = setup();
    const res = await app.request("/api/secrets/doctor");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: string }).report).toContain("no agent listening");
    expect(secrets.calls).toEqual(["doctor"]);

    // An absent binary is a diagnosis too, and must reach the page (§5b).
    const broken = setup("/tmp", fakeSecrets({ doctorError: "spawn vt ENOENT" }));
    const failed = await broken.app.request("/api/secrets/doctor");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Error: spawn vt ENOENT" });
  });

  it("rotates the KEK, switching mode on request and rejecting bad modes", async () => {
    const { app, secrets } = setup();
    const post = (body?: unknown) =>
      app.request("/api/secrets/rotate", {
        method: "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });

    // Locked: the error is surfaced, never swallowed.
    const locked = await post({});
    expect(locked.status).toBe(500);
    expect(((await locked.json()) as { error: string }).error).toContain("secrets locked");

    await app.request("/api/secrets/unlock", { method: "POST" });
    const keep = await post({});
    expect(keep.status).toBe(200);
    expect(await keep.json()).toEqual({ state: "unlocked", mode: "file" });

    const toVt = await post({ mode: "vt" });
    expect(await toVt.json()).toEqual({ state: "unlocked", mode: "vt" });

    expect((await post({ mode: "paper" })).status).toBe(400);
    expect(secrets.calls).toEqual(["rotate:keep", "unlock", "rotate:keep", "rotate:vt"]);
  });

  it("serves config for the global scope and known project cwds only", async () => {
    const { app, config } = setup();
    const globalRes = await app.request("/api/config");
    expect(globalRes.status).toBe(200);
    expect(globalRes.headers.get("cache-control")).toBe("no-store");
    expect(await globalRes.json()).toEqual({
      dir: "/home/t/.pier/pi",
      files: [{ name: "SYSTEM.md", exists: true }],
      resources: { extensions: [{ name: "quiet.ts", link: false }], skills: [] },
    });
    // /tmp is a session cwd (factory.list); anything else is rejected — and a
    // project scope's dir is its own cwd.
    const projectRes = await app.request("/api/config?scope=/tmp");
    expect(projectRes.status).toBe(200);
    expect(((await projectRes.json()) as { dir: string }).dir).toBe("/tmp");
    expect((await app.request("/api/config?scope=/etc")).status).toBe(400);
    expect(config.calls).toContain("listFiles:/tmp");
  });

  it("reads and writes config files, surfacing store errors as 400", async () => {
    const { app, config } = setup();
    const read = await app.request("/api/config/files/SYSTEM.md?scope=/tmp");
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ content: "content" });
    await app.request("/api/config/files/SYSTEM.md?scope=/tmp");
    expect(config.calls.filter((call) => call === "read:/tmp/SYSTEM.md")).toHaveLength(2);
    const write = await app.request("/api/config/files/SYSTEM.md", {
      method: "PUT",
      body: JSON.stringify({ content: "new", expected: "content" }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ ok: true, content: "content" });
    expect(config.calls).toContain("write:global/SYSTEM.md=new");
    expect((await app.request("/api/config/files/nope.md")).status).toBe(400);
    const noBody = await app.request("/api/config/files/SYSTEM.md", {
      method: "PUT",
      body: "{}",
    });
    expect(noBody.status).toBe(400);
  });

  it("serves read-only resources and validates kind", async () => {
    const { app, config } = setup();
    const ok = await app.request("/api/config/resource?kind=extensions&name=quiet.ts");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ content: "// ext" });
    expect(config.calls).toContain("resource:global/extensions/quiet.ts");
    expect((await app.request("/api/config/resource?kind=themes&name=x")).status).toBe(400);
    expect((await app.request("/api/config/resource?kind=skills")).status).toBe(400);
  });

  it("SSE honors the after query param", async () => {
    const { app, hub } = setup();
    hub.emit("s1", { type: "turn-start" });
    hub.emit("s1", { type: "state", state: "idle" });
    const res = await app.request("/api/sessions/s1/events?after=1");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    await reader.cancel();
    expect(chunk).toContain('"seq":2');
    expect(chunk).not.toContain('"seq":1,');
  });

  it("reports recent session dependencies from task provenance", async () => {
    const { app, tasks } = setup();
    const task = await tasks.create({
      name: "delegate",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: "s1" }, prompt: "work" },
    });
    const run = tasks.run(task.id, null, "agent", null, {
      invokedBySessionId: "source-session",
      background: true,
      callbackSessionId: null,
    });
    await tasks.waitForRun(run.id);
    const res = await app.request("/api/activity?scope=recent");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: "s1" }),
        expect.objectContaining({ id: "source-session" }),
      ]),
      runs: [expect.objectContaining({
        id: run.id,
        invokedBySessionId: "source-session",
        targetSessionId: "s1",
      })],
    });
  });

  it("lists available models for a session", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions/s1/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "openai", id: "gpt-5.2" },
    ]);
  });

  it("switches the model and rejects bad input", async () => {
    const { app, session } = setup();
    const post = (body: unknown) =>
      app.request("/api/sessions/s1/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post({ provider: "openai", id: "gpt-5.2" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ model: { provider: "openai", id: "gpt-5.2" } });
    expect(session.calls).toContain("setModel:openai/gpt-5.2");
    expect((await post({ provider: "x" })).status).toBe(400);
    expect((await post({ provider: "x", id: "nope" })).status).toBe(400);
  });

  it("reports and changes the reasoning level, rejecting invalid levels", async () => {
    const { app, session } = setup();
    const get = await app.request("/api/sessions/s1/thinking");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      level: "medium",
      levels: ["off", "low", "medium", "high"],
    });

    const post = (body: unknown) =>
      app.request("/api/sessions/s1/thinking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post({ level: "low" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ level: "low" });
    expect(session.calls).toContain("setThinkingLevel:low");
    expect((await post({ level: "extreme" })).status).toBe(400);
  });

  it("routes messages through the queue policy", async () => {
    const { app, session } = setup();
    const post = (body: unknown) =>
      app.request("/api/sessions/s1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let res = await post({ text: "hello" });
    expect(res.status).toBe(202);
    // The first web message carries the operator header (core/identity.ts);
    // the follow-ups below are the same speaker in the same minute, so none.
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]).toMatch(
      /^prompt:\[operator<web> \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}\]\nhello$/,
    );

    session.setState("streaming");
    await post({ text: "wait for it" });
    await post({ text: "!change course" });
    await post({ text: "explicit", mode: "steer" });
    expect(session.calls.slice(1)).toEqual([
      "followUp:wait for it",
      "steer:change course",
      "steer:explicit",
    ]);
  });

  it("rejects messages without text", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions/s1/messages", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });


  it("edits a user turn: rewind, then re-dispatch the new text", async () => {
    const { app, session } = setup();
    const res = await app.request("/api/sessions/s1/turns/0/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fixed" }),
    });
    expect(res.status).toBe(202);
    expect(session.calls).toHaveLength(2);
    expect(session.calls[0]).toBe("rewind:0");
    // The rewind forgot the sender, so the re-dispatch is headed again.
    expect(session.calls[1]).toMatch(
      /^prompt:\[operator<web> \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}\]\nfixed$/,
    );
  });

  it("rejects edits while streaming or with bad input", async () => {
    const { app, session } = setup();
    session.setState("streaming");
    const busy = await app.request("/api/sessions/s1/turns/0/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fixed" }),
    });
    expect(busy.status).toBe(409);
    session.setState("idle");
    const bad = await app.request("/api/sessions/s1/turns/x/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fixed" }),
    });
    expect(bad.status).toBe(400);
    expect(session.calls).toEqual([]);
  });

  it("recalls the pending queue", async () => {
    const { app, session } = setup();
    const res = await app.request("/api/sessions/s1/queue/recall", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: ["s-msg", "f-msg"] });
    expect(session.calls).toContain("clearQueue");
  });

  it("delivers the queue as steering", async () => {
    const { app, session } = setup();
    session.setState("streaming");
    const res = await app.request("/api/sessions/s1/queue/deliver", {
      method: "POST",
      body: JSON.stringify({ mode: "steer" }),
    });
    expect(res.status).toBe(202);
    expect(session.calls).toEqual(["clearQueue", "steer:s-msg\nf-msg"]);
    session.setState("idle");
  });

  it("restart aborts the run before re-prompting, and rejects bad modes", async () => {
    const { app, session } = setup();
    session.setState("streaming");
    const res = await app.request("/api/sessions/s1/queue/deliver", {
      method: "POST",
      body: JSON.stringify({ mode: "restart" }),
    });
    expect(res.status).toBe(202);
    // abort runs first; state is idle by then, so the queue lands as a prompt
    expect(session.calls).toEqual(["clearQueue", "abort", "prompt:s-msg\nf-msg"]);

    const bad = await app.request("/api/sessions/s1/queue/deliver", {
      method: "POST",
      body: JSON.stringify({ mode: "nope" }),
    });
    expect(bad.status).toBe(400);
  });

  it("logs a client report, rejects an empty one, and caps the rate", async () => {
    // What the line looks like is log.ts's test; what this route owes is
    // validation, a cap, and never an error the browser has to handle.
    const { app } = setup();
    const post = (body: unknown) =>
      app.request("/api/client-log", {
        method: "POST",
        headers: { "user-agent": "TestBrowser/1.0" },
        body: JSON.stringify(body),
      });

    expect((await post({ message: "boom", view: "#/session/s1", stack: "at x" })).status).toBe(204);
    expect((await post({ message: "   " })).status).toBe(400);

    // The cap is the whole point: a looping browser must not own the journal.
    let capped = 0;
    for (let i = 0; i < 70; i++) {
      if ((await post({ message: `distinct ${String(i)}` })).status === 429) capped += 1;
    }
    expect(capped).toBeGreaterThan(0);
  });

  it("compacts a session's context through the seam, once", async () => {
    const { app, session } = setup();
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(202);
    expect(session.calls.filter((c) => c === "compact")).toEqual(["compact"]);
  });

  it("refuses to compact a running turn instead of aborting it", async () => {
    const { app, session } = setup();
    session.setState("streaming");
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(409);
    expect(session.calls).not.toContain("compact");
  });

  it("answers a seam refusal with 409, not the 404 of an unknown session", async () => {
    const { app, session } = setup();
    // The idle check is one tick old by the time the route dispatches, so the
    // exclusivity gate is the seam's (agent/pi.ts); this is how it reads here.
    session.compact = () => Promise.reject(new Error("session s1 is already compacting"));
    const res = await app.request("/api/sessions/s1/compact", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain("already compacting");
  });

  it("404s a compact for a session that does not exist", async () => {
    const { factory } = setup();
    const hub = new EventHub();
    const router = new Router(hub, async () => {
      throw new Error("unknown session: nope");
    });
    const app = createServer({
      factory,
      router,
      hub,
      sessions: new SessionStateStore(openDb(":memory:")),
      config: fakeConfig(),
      providers: fakeProviders(),
      settings: new SettingsStore(openDb(":memory:")),
      updates: new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1")),
      secrets: fakeSecrets(),
    });
    expect((await app.request("/api/sessions/nope/compact", { method: "POST" })).status).toBe(404);
  });

  it("aborts via the router", async () => {
    const { app, session } = setup();
    // attach first so the router knows the session
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });
    const res = await app.request("/api/sessions/s1/abort", { method: "POST" });
    expect(res.status).toBe(202);
    expect(session.calls).toContain("abort");
  });

  it("SSE replays buffered events after Last-Event-ID", async () => {
    const { app, hub } = setup();
    hub.emit("s1", { type: "turn-start" });
    hub.emit("s1", { type: "text-delta", text: "a" });
    hub.emit("s1", { type: "state", state: "idle" });

    const res = await app.request("/api/sessions/s1/events", {
      headers: { "Last-Event-ID": "1" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    await reader.cancel();
    expect(chunk).toContain('"seq":2');
    expect(chunk).toContain('"text-delta"');
    expect(chunk).not.toContain('"seq":1,');
  });
});

describe("configuration reaching live sessions", () => {
  /** Attached, idle, watched by nobody — the state the recycle is about. */
  const attached = (router: Router, session: AgentSession) => {
    router.attach({ channelId: "web", conversationId: "s1" }, session);
    expect(router.stateOf("s1")).toBe("idle");
  };
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("lets go of idle sessions when providers, agent files or the URL change", async () => {
    const { app, router, session } = setup();
    // A session opened before the change keeps the providers, files and prompt
    // it opened with; recycling is what makes the save take effect.
    const recycled = async (what: string, res: Response) => {
      expect(res.status, what).toBe(200);
      await vi.waitFor(() => expect(router.stateOf("s1"), what).toBeUndefined());
    };

    attached(router, session);
    await recycled(
      "provider setup",
      await app.request("/api/providers/setup", json({
        setup: { kind: "builtin", id: "anthropic" },
        authType: null,
      })),
    );

    attached(router, session);
    await recycled(
      "logout",
      await app.request("/api/providers/anthropic/logout", { method: "POST" }),
    );

    attached(router, session);
    await recycled(
      "agent file",
      await app.request("/api/config/files/SYSTEM.md?scope=global", {
        ...json({ content: "new", expected: "content" }),
        method: "PUT",
      }),
    );

    attached(router, session);
    await recycled(
      "public URL",
      await app.request("/api/settings", { ...json({ publicUrl: "pier.example.com" }), method: "PUT" }),
    );

    // A bundled extension is read at session open like the rest: a session
    // that kept running would keep the tool set it was created with.
    attached(router, session);
    await recycled(
      "bundled extension",
      await app.request("/api/settings", { ...json({ extension: { name: "web", on: true } }), method: "PUT" }),
    );
  });

  it("recycles the session the operator is looking at, but never a live turn", async () => {
    const { app, hub, router, session } = setup();
    attached(router, session);
    // The tab that saved the change has this session's SSE stream open; it is
    // the likeliest one to need the new configuration.
    hub.subscribe("s1", () => {});
    session.setState("streaming");
    await app.request("/api/providers/anthropic/logout", { method: "POST" });
    expect(router.stateOf("s1")).toBe("streaming");

    session.setState("idle");
    await app.request("/api/providers/anthropic/logout", { method: "POST" });
    await vi.waitFor(() => expect(router.stateOf("s1")).toBeUndefined());
  });

  it("leaves a session alone for a setting it reads per call", async () => {
    const { app, router, session } = setup();
    attached(router, session);
    // The model menu is read by every picker call, not baked into a session.
    const res = await app.request("/api/settings", {
      ...json({ modelMenu: [{ provider: "anthropic", id: "claude-opus-4-5" }] }),
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(router.stateOf("s1")).toBe("idle");
  });
});

describe("the app shell", () => {
  it("loads protected install metadata without browser deprecation warnings", () => {
    const html = readFileSync(new URL("./ui/index.html", import.meta.url), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
  });

  it("names the instance in the tab title", () => {
    const html = "<head><title>Pier</title></head>";
    expect(withTabPrefix(html, tabPrefix(undefined, "g1"))).toContain("<title>g1 - Pier</title>");
    // $PIER_TITLE leads: a narrow tab must still say which environment it is.
    expect(tabPrefix("staging", "g1")).toBe("staging - g1");
    expect(tabPrefix("  ", "g1")).toBe("g1");
    expect(tabPrefix("staging", "")).toBe("staging");
    expect(tabPrefix("x".repeat(80), "g1").length).toBe(60);
    // Neither value is typed here, and neither may open a tag.
    expect(withTabPrefix(html, "a<b&c")).toContain("<title>a&lt;b&amp;c - Pier</title>");
    // Nothing to say, and any shell that does not say Pier: served as built.
    expect(withTabPrefix(html, "")).toBe(html);
    expect(withTabPrefix("<title>Other</title>", "g1")).toBe("<title>Other</title>");
  });
});
