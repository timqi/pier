// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type { AgentFactory, ImageAttachment, InboundMessage } from "../core/types.js";

export interface WebDeps {
  factory: AgentFactory;
  router: Router;
  hub: EventHub;
}

const HEARTBEAT_MS = 15_000;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // per image, base64 length ≈ bytes × 4/3

/** Validate at the seam: malformed attachments are rejected, never half-sent. */
function parseImages(raw: unknown): ImageAttachment[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return { error: "invalid images" };
  const images: ImageAttachment[] = [];
  for (const i of raw) {
    if (
      typeof i?.data !== "string" ||
      !i.data ||
      i.data.length > (MAX_IMAGE_BYTES * 4) / 3 ||
      typeof i?.mimeType !== "string" ||
      !i.mimeType.startsWith("image/")
    ) {
      return { error: "invalid images" };
    }
    images.push({ data: i.data, mimeType: i.mimeType });
  }
  return images;
}

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

  app.get("/api/sessions/:id/history", async (c) => {
    const id = c.req.param("id");
    try {
      const session = await router.ensure({ channelId: "web", conversationId: id });
      return c.json({
        turns: await session.history(),
        lastSeq: hub.lastSeq(id),
        model: session.model ?? null,
      });
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.get("/api/sessions/:id/models", async (c) => {
    const id = c.req.param("id");
    try {
      const session = await router.ensure({ channelId: "web", conversationId: id });
      return c.json(await session.availableModels());
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.post("/api/sessions/:id/model", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.provider !== "string" || typeof body.id !== "string") {
      return c.json({ error: "provider and id required" }, 400);
    }
    try {
      const session = await router.ensure({ channelId: "web", conversationId: id });
      await session.setModel({ provider: body.provider, id: body.id });
      return c.json({ model: session.model });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") {
      return c.json({ error: "text required" }, 400);
    }
    const images = parseImages(body.images);
    if ("error" in images) return c.json({ error: images.error }, 400);
    if (!body.text.trim() && images.length === 0) {
      return c.json({ error: "text or images required" }, 400);
    }
    const mode: InboundMessage["mode"] =
      body.mode === "steer" || body.mode === "followUp" ? body.mode : "auto";
    const { sessionId } = await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      text: body.text,
      images: images.length ? images : undefined,
      mode,
    });
    return c.json({ sessionId }, 202);
  });

  // Recall: drop all pending queued messages and hand them back (composer restore).
  app.post("/api/sessions/:id/queue/recall", async (c) => {
    const id = c.req.param("id");
    try {
      const session = await router.ensure({ channelId: "web", conversationId: id });
      const { steering, followUp } = await session.clearQueue();
      return c.json({ messages: [...steering, ...followUp] });
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    await router.abort(id);
    return c.json({ ok: true }, 202);
  });

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const lastId =
      Number(c.req.header("Last-Event-ID") ?? "") ||
      Number(c.req.query("after") ?? "") ||
      0;
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
