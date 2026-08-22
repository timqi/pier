// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { guarded, registerFileRoutes } from "./files.js";
import type {
  AgentFactory,
  BackgroundRun,
  ConfigStore,
  ImageAttachment,
  InboundMessage,
  ThinkingLevel,
} from "../core/types.js";
import { isThinkingLevel } from "../core/types.js";
import type { SessionStateStore } from "./session-state.js";
import type { SecretsMode } from "../secrets.js";
import { normalizePublicUrl, type SettingsStore } from "../settings.js";

/** The slice of Secrets the routes need; injectable so tests never touch disk
 *  or spawn vt. Never exposes key material — state, mode and the locked reason
 *  are all a browser may see. */
export interface SecretsControl {
  readonly state: "locked" | "unlocked";
  readonly mode: SecretsMode | undefined;
  readonly lockedReason: string;
  unlock(): Promise<void>;
  rotateKek(mode?: SecretsMode): Promise<void>;
}

export interface WebDeps {
  factory: AgentFactory;
  router: Router;
  hub: EventHub;
  /** Pinned sessions, and the ones whose last finished turn nobody viewed. */
  sessions: SessionStateStore;
  config: ConfigStore;
  settings: SettingsStore;
  secrets: SecretsControl;
  /** Ran after a successful unlock; main.ts starts the channels it held back.
   *  A callback because web/ must not import channels/. */
  onUnlocked?: () => void;
  /** Injected by main.ts; web stays blind to the task service. */
  backgroundRuns?: (sessionId: string) => BackgroundRun[];
}

const HEARTBEAT_MS = 15_000;
/** Client reports per minute, for the whole server: a browser bug can fire in
 *  a loop, and the journal is shared with everything else Pier says. */
const CLIENT_LOG_PER_MINUTE = 60;
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

export function createServer(
  { factory, router, hub, sessions: state, config, settings, secrets, onUnlocked, backgroundRuns }: WebDeps,
): Hono {
  const app = new Hono();

  // A finished turn marks its session unread until some client reports it was
  // seen (session selected + tab visible → POST read below). Server-side so
  // every client shows the same attention state. Streaming → idle is the
  // trigger — same transition the client notification uses — and it needs a
  // start we witnessed, so a session that boots idle stays untouched.
  const runningNow = new Set<string>();
  hub.subscribeWorkspace((e) => {
    if (e.type !== "session-state") return;
    if (e.state === "streaming") {
      runningNow.add(e.sessionId);
      return;
    }
    if (!runningNow.delete(e.sessionId)) return;
    state.set("unread", e.sessionId, true);
    hub.emitWorkspace({ type: "sessions-changed" });
  });

  /** Background runs this session launched that are still in flight. */
  const activeRuns = (id: string): number =>
    backgroundRuns?.(id).filter((r) => r.state === "queued" || r.state === "running").length ?? 0;

  /** The web channel's session for `id` — every session route resolves here. */
  const ensure = (id: string) => router.ensure({ channelId: "web", conversationId: id });

  // Sessions created here that Pi doesn't list yet — it persists a session
  // only once the first assistant message lands. Merged into the list below
  // so every client sees a new session immediately; dropped once Pi lists it.
  const nascent = new Map<string, { cwd: string; createdAt: number }>();

  app.get("/api/sessions", async (c) => {
    const sessions = await factory.list();
    for (const s of sessions) nascent.delete(s.id);
    return c.json(
      [...[...nascent].map(([id, n]) => ({ id, ...n })), ...sessions].map((s) => ({
        ...s,
        state: router.stateOf(s.id) ?? "idle",
        pinned: state.has("pinned", s.id),
        unread: state.has("unread", s.id),
        activeRuns: activeRuns(s.id),
      })),
    );
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // A session always starts in its project directory — never in pier's own.
    if (typeof body.cwd !== "string" || !body.cwd) return c.json({ error: "cwd required" }, 400);
    const session = await factory.create({ cwd: body.cwd });
    nascent.set(session.id, { cwd: body.cwd, createdAt: Date.now() });
    router.attach({ channelId: "web", conversationId: session.id }, session);
    // Created here = part of the workspace; pinning is what Projects lists.
    state.set("pinned", session.id, true);
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ id: session.id }, 201);
  });

  // Seen = read: a client with the session selected and the tab visible acks
  // here; the broadcast moves every other client's dot back to idle.
  app.post("/api/sessions/:id/read", (c) => {
    const id = c.req.param("id");
    if (state.has("unread", id)) {
      state.set("unread", id, false);
      hub.emitWorkspace({ type: "sessions-changed" });
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/pin", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.pinned !== "boolean") return c.json({ error: "pinned required" }, 400);
    state.set("pinned", c.req.param("id"), body.pinned);
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ pinned: body.pinned });
  });

  // Snapshot: everything a fresh client needs before it starts consuming
  // deltas from SSE — transcript, live state, pending queue, model.
  guarded(app, "GET", "/api/sessions/:id/history", 404, async (c) => {
    const id = c.req.param("id");
    const session = await ensure(id);
    return c.json({
      turns: await session.history(),
      lastSeq: hub.lastSeq(id),
      model: session.model ?? null,
      state: session.state,
      context: session.contextUsage ?? null,
      thinkingLevel: session.thinkingLevel,
      queue: await session.pendingQueue(),
      backgroundRuns: backgroundRuns?.(id) ?? [],
    });
  });

  // Transcript images by their history ordinal: the snapshot ships refs, the
  // browser pulls (and caches) the bytes only for what it renders.
  guarded(app, "GET", "/api/sessions/:id/images/:ordinal", 404, async (c) => {
    const ordinal = Number(c.req.param("ordinal"));
    if (!Number.isInteger(ordinal) || ordinal < 0) return c.json({ error: "bad ordinal" }, 400);
    const session = await ensure(c.req.param("id"));
    const image = await session.image(ordinal);
    if (!image) return c.json({ error: "no such image" }, 404);
    return c.body(Buffer.from(image.data, "base64"), 200, {
      "content-type": image.mimeType,
      "cache-control": "private, max-age=3600",
    });
  });

  // Backend model catalog, no session needed: surfaces that configure what a
  // *future* session launches with (IM chats) have none to ask.
  app.get("/api/models", async (c) => {
    try {
      return c.json(await factory.availableModels());
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  guarded(app, "GET", "/api/sessions/:id/models", 404, async (c) => {
    const session = await ensure(c.req.param("id"));
    return c.json(await session.availableModels());
  });

  guarded(app, "GET", "/api/sessions/:id/thinking", 404, async (c) => {
    const session = await ensure(c.req.param("id"));
    return c.json({
      level: session.thinkingLevel,
      levels: session.availableThinkingLevels(),
    });
  });

  guarded(app, "POST", "/api/sessions/:id/model", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.provider !== "string" || typeof body.id !== "string") {
      return c.json({ error: "provider and id required" }, 400);
    }
    const session = await ensure(c.req.param("id"));
    await session.setModel({ provider: body.provider, id: body.id });
    return c.json({ model: session.model });
  });

  guarded(app, "POST", "/api/sessions/:id/thinking", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !isThinkingLevel(body.level)) {
      return c.json({ error: "valid thinking level required" }, 400);
    }
    const session = await ensure(c.req.param("id"));
    session.setThinkingLevel(body.level as ThinkingLevel);
    return c.json({ level: session.thinkingLevel });
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

  // Edit a user turn: rewind the transcript to just before it, then re-send
  // the edited text as a fresh dispatch. Pi keeps the old branch in the
  // session file but out of context — the "deleted" message stops polluting.
  guarded(app, "POST", "/api/sessions/:id/turns/:index/edit", 400, async (c) => {
    const id = c.req.param("id");
    const index = Number(c.req.param("index"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(index) || index < 0 || typeof body?.text !== "string" || !body.text.trim()) {
      return c.json({ error: "index and text required" }, 400);
    }
    const session = await ensure(id);
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    await session.rewindToUserTurn(index);
    await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      text: body.text,
      mode: "auto",
    });
    return c.json({ ok: true }, 202);
  });

  // Promote queued messages: "steer" delivers them into the running turn,
  // "restart" aborts the turn and sends them as a fresh prompt. Pi has no
  // promote primitive, so this is clear-queue + re-dispatch through core.
  guarded(app, "POST", "/api/sessions/:id/queue/deliver", 404, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const mode: unknown = body?.mode;
    if (mode !== "steer" && mode !== "restart") {
      return c.json({ error: "mode must be steer or restart" }, 400);
    }
    const session = await ensure(id);
    const { steering, followUp } = await session.clearQueue();
    const text = [...steering, ...followUp].join("\n").trim();
    if (!text) return c.json({ error: "queue is empty" }, 409);
    if (mode === "restart") await router.abort(id); // resolves once idle
    await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      text,
      mode: mode === "steer" ? "steer" : "auto",
    });
    return c.json({ delivered: text }, 202);
  });

  // Recall: drop all pending queued messages and hand them back (composer restore).
  guarded(app, "POST", "/api/sessions/:id/queue/recall", 404, async (c) => {
    const session = await ensure(c.req.param("id"));
    const { steering, followUp } = await session.clearQueue();
    return c.json({ messages: [...steering, ...followUp] });
  });

  // The browser's half of the log. A workbench that threw after the response
  // left the server is otherwise invisible here (ui/report.ts) — this is the
  // one route whose entire purpose is to make it visible.
  const clientLog = logger("client");
  let reports: number[] = [];
  app.post("/api/client-log", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      message?: unknown;
      stack?: unknown;
      view?: unknown;
    } | null;
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return c.json({ error: "message required" }, 400);
    }
    const now = Date.now();
    reports = reports.filter((at) => now - at < 60_000);
    if (reports.length >= CLIENT_LOG_PER_MINUTE) return c.body(null, 429);
    reports.push(now);
    const cap = (value: unknown, max: number): string =>
      typeof value === "string" ? value.slice(0, max) : "";
    const where = cap(body.view, 120);
    const stack = cap(body.stack, 2000);
    // One line, ua included: "only on iOS" is the answer half these questions
    // have, and the report is the only place it exists.
    clientLog.warn(
      `${cap(body.message, 500)} [${where || "/"}] ${cap(c.req.header("user-agent"), 160)}` +
        (stack ? `\n${stack}` : ""),
    );
    return c.body(null, 204);
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    await router.abort(id);
    return c.json({ ok: true }, 202);
  });

  // Workspace stream: one per client, keeps every session list in sync
  // (created/pinned → re-list, run state → patch) without polling.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = hub.subscribeWorkspace(
        (e) => void stream.writeSSE({ data: JSON.stringify(e) }),
      );
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        await stream.write(": ping\n\n");
      }
    }),
  );

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

  // Instance settings. The password lives behind its own route (web/auth.ts):
  // it is a credential, and changing it takes the old one.
  app.get("/api/settings", (c) => c.json(settings.get()));

  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.publicUrl !== "string") return c.json({ error: "publicUrl required" }, 400);
    const publicUrl = normalizePublicUrl(body.publicUrl);
    if (publicUrl === null) {
      return c.json({ error: "not a URL: expected http(s)://host, no query or fragment" }, 400);
    }
    return c.json(settings.setPublicUrl(publicUrl));
  });

  // Layer-1 key status and control (Console → Settings → Security). The GET
  // is what a locked instance shows; unlock is how it recovers without a
  // restart, and rotate is the only way to change how the KEK is protected.
  const secretsStatus = () => ({
    state: secrets.state,
    mode: secrets.mode ?? null,
    ...(secrets.state === "locked" ? { reason: secrets.lockedReason } : {}),
  });

  app.get("/api/secrets", (c) => c.json(secretsStatus()));

  app.post("/api/secrets/unlock", async (c) => {
    try {
      await secrets.unlock();
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    onUnlocked?.();
    return c.json(secretsStatus());
  });

  app.post("/api/secrets/rotate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    if (body.mode !== undefined && body.mode !== "vt" && body.mode !== "file") {
      return c.json({ error: "mode must be vt or file" }, 400);
    }
    try {
      await secrets.rotateKek(body.mode);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
    return c.json(secretsStatus());
  });

  registerFileRoutes(app, { factory, config, nascentCwd: (id) => nascent.get(id)?.cwd });

  app.use("/*", serveStatic({ root: "./src/web/public" }));
  return app;
}
