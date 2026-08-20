import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory, AgentSession, SessionEventPayload, SessionState } from "../core/types.js";
import { createServer } from "./server.js";

/** Scripted in-memory AgentSession for seam tests. */
function fakeSession(id: string): AgentSession & {
  emit: (p: SessionEventPayload) => void;
  calls: string[];
  setState: (s: SessionState) => void;
} {
  let state: SessionState = "idle";
  const listeners = new Set<(e: SessionEventPayload) => void>();
  const calls: string[] = [];
  return {
    id,
    get state() {
      return state;
    },
    setState: (s: SessionState) => {
      state = s;
    },
    emit: (p: SessionEventPayload) => listeners.forEach((fn) => fn(p)),
    calls,
    prompt: async (t: string) => void calls.push(`prompt:${t}`),
    steer: async (t: string) => void calls.push(`steer:${t}`),
    followUp: async (t: string) => void calls.push(`followUp:${t}`),
    abort: async () => void calls.push("abort"),
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
