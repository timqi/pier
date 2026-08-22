import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  ImageAttachment,
  ModelRef,
  ProviderManager,
  SessionEventPayload,
  SessionState,
  ThinkingLevel,
} from "../core/types.js";
import { registerTaskRoutes } from "../tasks/routes.js";
import { TaskService } from "../tasks/service.js";
import { TaskStore } from "../tasks/store.js";
import { SettingsStore } from "../settings.js";
import { UpdateCheck } from "../update.js";
import { openDb } from "../db.js";
import { ProviderFlows } from "./provider-flows.js";
import { SessionStateStore } from "./session-state.js";
import { createServer, type SecretsControl } from "./server.js";

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
      { role: "user", text: "hi", images: [{ mimeType: "image/png", ordinal: 0 }] },
      { role: "assistant", text: "hello" },
    ],
    image: async (ordinal: number) =>
      ordinal === 0 ? { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" } : undefined,
    prompt: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`prompt:${t}${imgs ? `+${imgs.length}img` : ""}`),
    steer: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`steer:${t}${imgs ? `+${imgs.length}img` : ""}`),
    followUp: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`followUp:${t}${imgs ? `+${imgs.length}img` : ""}`),
    systemInput: async (text, origin, mode) => {
      calls.push(`systemInput:${origin.kind}:${mode}:${text}`);
    },
    // Pi's abort resolves only once the agent is idle again.
    abort: async () => {
      calls.push("abort");
      state = "idle";
    },
    rewindToUserTurn: async (i: number) => void calls.push(`rewind:${i}`),
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
function fakeSecrets(opts: { unlockError?: string } = {}): SecretsControl & { calls: string[] } {
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
  };
}

function setup(cwd = "/tmp", secrets = fakeSecrets()) {
  const session = fakeSession("s1");
  const factory: AgentFactory = {
    availableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-opus-4-5" }]),
    create: vi.fn(async () => session),
    fork: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: "s1", cwd, createdAt: 1 }]),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume("s1"));
  // Hermetic: every store shares one in-memory database, never the real $HOME.
  const db = openDb(":memory:");
  const state = new SessionStateStore(db);
  const config = fakeConfig();
  const providers = fakeProviders();
  const settings = new SettingsStore(db);
  const updates = new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1"));
  const tasks = new TaskService(new TaskStore(db), factory, router, hub);
  // Composed exactly like main.ts: task routes and web server never import each other.
  const app = new Hono();
  registerTaskRoutes(app, tasks, { factory, router });
  const onUnlocked = vi.fn();
  app.route("/", createServer({
    factory, router, hub, sessions: state, config, providers, settings, updates, secrets, onUnlocked,
    backgroundRuns: (id) => tasks.backgroundRuns(id),
  }));
  return { app, session, factory, hub, router, state, config, providers, settings, tasks, secrets, onUnlocked };
}

describe("workbench server", () => {
  it("lists sessions with live state", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "s1", cwd: "/tmp", createdAt: 1, state: "idle", pinned: false, unread: false, activeRuns: 0 },
    ]);
  });

  it("marks a session unread when a witnessed run settles, until a client acks", async () => {
    const { app, session, hub, router, state } = setup();
    router.attach({ channelId: "web", conversationId: "s1" }, session);

    // Idle without a witnessed start (e.g. boot) never marks unread.
    session.emit({ type: "state", state: "idle" });
    expect(state.has("unread", "s1")).toBe(false);

    const changed = vi.fn();
    hub.subscribeWorkspace(changed);
    session.emit({ type: "state", state: "streaming" });
    session.emit({ type: "state", state: "idle" });
    expect(state.has("unread", "s1")).toBe(true);
    expect(changed).toHaveBeenCalledWith({ type: "sessions-changed" });
    const rows = (await (await app.request("/api/sessions")).json()) as { unread: boolean }[];
    expect(rows[0]!.unread).toBe(true);

    // Seen = read: the ack clears the mark and broadcasts the change.
    changed.mockClear();
    expect((await app.request("/api/sessions/s1/read", { method: "POST" })).status).toBe(200);
    expect(state.has("unread", "s1")).toBe(false);
    expect(changed).toHaveBeenCalledWith({ type: "sessions-changed" });

    // Acking a session that isn't unread is a no-op, not a broadcast.
    changed.mockClear();
    await app.request("/api/sessions/s1/read", { method: "POST" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("lists a created session before Pi persists it, without duplicating later", async () => {
    const session = fakeSession("s2");
    const listed: { id: string; cwd: string; createdAt: number }[] = [];
    const factory: AgentFactory = {
      availableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-opus-4-5" }]),
    create: vi.fn(async () => session),
      fork: vi.fn(async () => session),
      resume: vi.fn(async () => session),
      list: vi.fn(async () => listed),
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
      { id: "s2", cwd: "/tmp", createdAt: expect.any(Number), state: "idle", pinned: true, unread: false, activeRuns: 0 },
    ]);

    // Pi persisted it — the real row wins, no duplicate.
    listed.push({ id: "s2", cwd: "/tmp", createdAt: 1 });
    rows = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(rows).toEqual([{ id: "s2", cwd: "/tmp", createdAt: 1, state: "idle", pinned: true, unread: false, activeRuns: 0 }]);
  });

  it("pins sessions created here, and toggles pins on demand", async () => {
    const { app, state } = setup();
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });
    expect(state.has("pinned", "s1")).toBe(true);

    const off = await app.request("/api/sessions/s1/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: false }),
    });
    expect(off.status).toBe(200);
    expect(state.has("pinned", "s1")).toBe(false);

    const bad = await app.request("/api/sessions/s1/pin", { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
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

  it("serves a transcript image by ordinal, 404 past the end", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions/s1/images/0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png-bytes");
    expect((await app.request("/api/sessions/s1/images/1")).status).toBe(404);
    expect((await app.request("/api/sessions/s1/images/-1")).status).toBe(400);
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
        { role: "user", text: "hi", images: [{ mimeType: "image/png", ordinal: 0 }] },
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

  it("reads and writes the public URL, normalizing it and refusing a non-URL", async () => {
    const { app, settings } = setup();
    expect(await (await app.request("/api/settings")).json()).toEqual({ publicUrl: "", modelMenu: [] });

    const put = (publicUrl: unknown) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicUrl }),
      });
    const ok = await put("pier.example.com/");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ publicUrl: "https://pier.example.com", modelMenu: [] });
    expect(settings.get().publicUrl).toBe("https://pier.example.com");

    expect((await put("not a url")).status).toBe(400);
    expect((await put(42)).status).toBe(400);
    // A rejected write leaves the stored value alone.
    expect(settings.get().publicUrl).toBe("https://pier.example.com");
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
    expect(await ok.json()).toEqual({ publicUrl: "https://pier.example.com", modelMenu: menu });

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
      action: { type: "agent", sessionId: "s1", prompt: "work" },
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
    expect(session.calls).toEqual(["prompt:hello"]);

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

  it("passes image attachments through to the session", async () => {
    const { app, session } = setup();
    const img = { data: "aGVsbG8=", mimeType: "image/png" };
    const res = await app.request("/api/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "look", images: [img] }),
    });
    expect(res.status).toBe(202);
    expect(session.calls).toEqual(["prompt:look+1img"]);
  });

  it("accepts image-only messages and rejects malformed images", async () => {
    const { app, session } = setup();
    const ok = await app.request("/api/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", images: [{ data: "aGVsbG8=", mimeType: "image/jpeg" }] }),
    });
    expect(ok.status).toBe(202);
    expect(session.calls).toEqual(["prompt:+1img"]);
    const bad = await app.request("/api/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", images: [{ data: "a", mimeType: "text/html" }] }),
    });
    expect(bad.status).toBe(400);
  });

  it("edits a user turn: rewind, then re-dispatch the new text", async () => {
    const { app, session } = setup();
    const res = await app.request("/api/sessions/s1/turns/0/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fixed" }),
    });
    expect(res.status).toBe(202);
    expect(session.calls).toEqual(["rewind:0", "prompt:fixed"]);
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

  // Backs the working-directory picker (new session, IM chat config).
  it("browses directories by name, defaulting to $HOME", async () => {
    const { app } = setup();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pier-dirs-")));
    mkdirSync(join(root, "project"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "note.txt"), "x");

    const res = await app.request(`/api/fs/dirs?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    // Directories only, dotfiles skipped, never any file contents.
    expect(await res.json()).toEqual({ path: root, parent: dirname(root), entries: ["project"] });

    const home = await (await app.request("/api/fs/dirs")).json() as { path: string };
    expect(home.path).toBe(homedir());
    expect((await app.request("/api/fs/dirs?path=/no/such/dir")).status).toBe(404);
  });

  it("creates a folder by name, and refuses a path", async () => {
    const { app } = setup();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pier-mkdir-")));
    const create = (body: unknown) =>
      app.request("/api/fs/dirs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await create({ path: root, name: "new-project" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: join(root, "new-project") });
    expect(statSync(join(root, "new-project")).isDirectory()).toBe(true);

    // Traversal and separators are rejected, never normalized into a write.
    for (const name of ["../escape", "a/b", "..", ""]) {
      expect((await create({ path: root, name })).status).toBe(400);
    }
    expect((await create({ path: "relative", name: "x" })).status).toBe(400);
    // Existing folder, and a parent that does not exist: both 400, not 500.
    expect((await create({ path: root, name: "new-project" })).status).toBe(400);
    expect((await create({ path: join(root, "nope"), name: "x" })).status).toBe(400);
  });
});
