import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  SessionEventPayload,
  SessionState,
  ThinkingLevel,
} from "../core/types.js";
import { registerTaskRoutes } from "../tasks/routes.js";
import { TaskService } from "../tasks/service.js";
import { TaskStore } from "../tasks/store.js";
import { PinStore } from "./pins.js";
import { createServer } from "./server.js";

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
      return { extensions: ["quiet.ts"], skills: [] };
    },
    readResource: async (s, kind, name) => {
      calls.push(`resource:${at(s)}/${kind}/${name}`);
      return "// ext";
    },
  };
}

function setup() {
  const session = fakeSession("s1");
  const factory: AgentFactory = {
    create: vi.fn(async () => session),
    fork: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: "s1", cwd: "/tmp", createdAt: 1 }]),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume("s1"));
  // Hermetic: pins land in a throwaway dir, never the real $HOME.
  const pins = new PinStore(join(mkdtempSync(join(tmpdir(), "pier-pins-")), "pins.json"));
  const config = fakeConfig();
  const tasks = new TaskService(new TaskStore(":memory:"), factory, router, hub);
  // Composed exactly like main.ts: task routes and web server never import each other.
  const app = new Hono();
  registerTaskRoutes(app, tasks, { factory, router });
  app.route("/", createServer({
    factory, router, hub, pins, config,
    backgroundRuns: (id) => tasks.backgroundRuns(id),
  }));
  return { app, session, factory, hub, router, pins, config, tasks };
}

describe("workbench server", () => {
  it("lists sessions with live state", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "s1", cwd: "/tmp", createdAt: 1, state: "idle", pinned: false },
    ]);
  });

  it("lists a created session before Pi persists it, without duplicating later", async () => {
    const session = fakeSession("s2");
    const listed: { id: string; cwd: string; createdAt: number }[] = [];
    const factory: AgentFactory = {
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
      pins: new PinStore(join(mkdtempSync(join(tmpdir(), "pier-pins-")), "pins.json")),
      config: fakeConfig(),
    });
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });

    // Not on disk yet — the nascent entry fills the gap.
    let rows = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(rows).toEqual([
      { id: "s2", cwd: "/tmp", createdAt: expect.any(Number), state: "idle", pinned: true },
    ]);

    // Pi persisted it — the real row wins, no duplicate.
    listed.push({ id: "s2", cwd: "/tmp", createdAt: 1 });
    rows = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(rows).toEqual([{ id: "s2", cwd: "/tmp", createdAt: 1, state: "idle", pinned: true }]);
  });

  it("pins sessions created here, and toggles pins on demand", async () => {
    const { app, pins } = setup();
    await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: "/tmp" }) });
    expect(pins.has("s1")).toBe(true);

    const off = await app.request("/api/sessions/s1/pin", {
      method: "POST",
      body: JSON.stringify({ pinned: false }),
    });
    expect(off.status).toBe(200);
    expect(pins.has("s1")).toBe(false);

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
      pins: new PinStore(join(mkdtempSync(join(tmpdir(), "pier-pins-")), "pins.json")),
      config: fakeConfig(),
    });
    const res = await app.request("/api/sessions/nope/history");
    expect(res.status).toBe(404);
  });

  it("serves config for the global scope and known project cwds only", async () => {
    const { app, config } = setup();
    const globalRes = await app.request("/api/config");
    expect(globalRes.status).toBe(200);
    expect(await globalRes.json()).toEqual({
      files: [{ name: "SYSTEM.md", exists: true }],
      resources: { extensions: ["quiet.ts"], skills: [] },
    });
    // /tmp is a session cwd (factory.list); anything else is rejected.
    expect((await app.request("/api/config?scope=/tmp")).status).toBe(200);
    expect((await app.request("/api/config?scope=/etc")).status).toBe(400);
    expect(config.calls).toContain("listFiles:/tmp");
  });

  it("reads and writes config files, surfacing store errors as 400", async () => {
    const { app, config } = setup();
    const read = await app.request("/api/config/files/SYSTEM.md?scope=/tmp");
    expect(await read.json()).toEqual({ content: "content" });
    const write = await app.request("/api/config/files/SYSTEM.md", {
      method: "PUT",
      body: JSON.stringify({ content: "new" }),
    });
    expect(write.status).toBe(200);
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
