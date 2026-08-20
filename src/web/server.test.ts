import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory, AgentSession, ChatTurn, ImageAttachment, ModelRef, SessionEventPayload, SessionState } from "../core/types.js";
import { createServer } from "./server.js";

/** Scripted in-memory AgentSession for seam tests. */
function fakeSession(id: string): AgentSession & {
  emit: (p: SessionEventPayload) => void;
  calls: string[];
  setState: (s: SessionState) => void;
} {
  let state: SessionState = "idle";
  let model: ModelRef = { provider: "anthropic", id: "claude-opus-4-5" };
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
    prompt: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`prompt:${t}${imgs ? `+${imgs.length}img` : ""}`),
    steer: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`steer:${t}${imgs ? `+${imgs.length}img` : ""}`),
    followUp: async (t: string, imgs?: ImageAttachment[]) =>
      void calls.push(`followUp:${t}${imgs ? `+${imgs.length}img` : ""}`),
    abort: async () => void calls.push("abort"),
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

function setup() {
  const session = fakeSession("s1");
  const factory: AgentFactory = {
    create: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: "s1", cwd: "/tmp", createdAt: 1 }]),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume("s1"));
  const app = createServer({ factory, router, hub });
  return { app, session, factory, hub, router };
}

describe("workbench server", () => {
  it("lists sessions with live state", async () => {
    const { app } = setup();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "s1", cwd: "/tmp", createdAt: 1, state: "idle" }]);
  });

  it("creates a session and attaches it to the router", async () => {
    const { app, factory, session, hub } = setup();
    const res = await app.request("/api/sessions", { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "s1" });
    expect(factory.create).toHaveBeenCalledOnce();
    // attached: session events now reach the hub
    const seen = vi.fn();
    hub.subscribe("s1", seen);
    session.emit({ type: "turn-start" });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("loads history and attaches the session on demand", async () => {
    const { app, hub, session } = setup();
    hub.emit("s1", { type: "turn-start" });
    const res = await app.request("/api/sessions/s1/history");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      lastSeq: 1,
      model: { provider: "anthropic", id: "claude-opus-4-5" },
    });
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
    const app = createServer({ factory, router, hub });
    const res = await app.request("/api/sessions/nope/history");
    expect(res.status).toBe(404);
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

  it("emits queued events into the hub when deferring", async () => {
    const { app, session, hub } = setup();
    session.setState("streaming");
    await app.request("/api/sessions/s1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "later" }),
    });
    expect(hub.replay("s1", 0)).toMatchObject([{ type: "queued", mode: "followUp", text: "later" }]);
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

  it("recalls the pending queue", async () => {
    const { app, session } = setup();
    const res = await app.request("/api/sessions/s1/queue/recall", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: ["s-msg", "f-msg"] });
    expect(session.calls).toContain("clearQueue");
  });

  it("aborts via the router", async () => {
    const { app, session } = setup();
    // attach first so the router knows the session
    await app.request("/api/sessions", { method: "POST", body: "{}" });
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
