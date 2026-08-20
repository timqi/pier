// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory, InboundMessage } from "../core/types.js";

export interface WebDeps {
  factory: AgentFactory;
  router: Router;
  hub: EventHub;
}

const HEARTBEAT_MS = 15_000;

export function createServer({ factory, router, hub }: WebDeps): Hono {
  const app = new Hono();

  app.get("/api/sessions", async (c) => {
    const sessions = await factory.list();
    return c.json(
      sessions.map((s) => ({ ...s, state: router.stateOf(s.id) ?? "idle" })),
    );
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    const session = await factory.create({ cwd });
    router.attach({ channelId: "web", conversationId: session.id }, session);
    return c.json({ id: session.id }, 201);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text required" }, 400);
    }
    const mode: InboundMessage["mode"] =
      body.mode === "steer" || body.mode === "followUp" ? body.mode : "auto";
    const { sessionId } = await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      text: body.text,
      mode,
    });
    return c.json({ sessionId }, 202);
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    await router.abort(id);
    return c.json({ ok: true }, 202);
  });

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const lastId = Number(c.req.header("Last-Event-ID") ?? "0") || 0;
    return streamSSE(c, async (stream) => {
      const send = (e: { seq: number }) =>
        stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
      for (const e of hub.replay(id, lastId)) await send(e);
      const unsubscribe = hub.subscribe(id, (e) => void send(e));
      stream.onAbort(unsubscribe);
      // Heartbeat keeps proxies from closing the stream; loop ends on abort.
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        await stream.write(": ping\n\n");
      }
    });
  });

  app.use("/*", serveStatic({ root: "./src/web/public" }));
  return app;
}
