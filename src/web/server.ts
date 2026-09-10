// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { EventHub } from "../core/hub.js";
import { logger } from "../log.js";
import { QueueOperationError, Router } from "../core/router.js";
import { registerConfigRoutes } from "./config.js";
import { registerExplorerRoutes } from "./explorer.js";
import { registerPackageRoutes } from "./packages.js";
import { fileHeaders, MAX_FILE_BYTES, registerFsRoutes } from "./fs.js";
import { guarded } from "./route.js";
import type {
  AgentFactory,
  AgentSession,
  BackgroundRun,
  CatalogEntry,
  ChatTurn,
  ConfigStore,
  InboundMessage,
  PackageStore,
  ProviderManager,
  SessionEvent,
  SessionSummary,
  ThinkingLevel,
} from "../core/types.js";
import { isThinkingLevel, SESSION_TITLE_MAX } from "../core/types.js";
import { saveInbound } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { type SessionFlags, type SessionStateStore } from "./session-state.js";
import type { SettingsStore } from "../settings.js";
import type { CustomTool } from "../tools.js";
import type { UpdateCheck } from "../update.js";
import { registerInstanceRoutes, type SecretsControl, type UpdateApplier } from "./instance.js";
import type { ToolsSyncNote } from "./types.js";
import { registerProviderRoutes } from "./providers.js";

const log = logger("web");

async function queueResponse(action: () => Promise<unknown>, status: 200 | 202 = 200): Promise<Response> {
  try {
    return Response.json(await action(), { status });
  } catch (err) {
    const code = err instanceof QueueOperationError
      ? err.reason === "draining" ? 503 : err.reason === "missing" ? 404 : 409
      : 404;
    return Response.json({ error: String(err) }, { status: code });
  }
}

/** A step's `args` and `output` are ~90% of a long session's snapshot and sit
 *  in a collapsed group; the client fetches one turn's worth when opened. */
const slim = (turn: ChatTurn): ChatTurn =>
  turn.steps
    ? { ...turn, steps: turn.steps.map(({ args: _args, output: _output, ...step }) => step) }
    : turn;

/** `$PIER_TITLE`, then the machine: the label leads because a tab is narrow
 *  and "which instance" must survive truncation. */
export const tabPrefix = (title: string | undefined, host: string): string =>
  [title?.trim(), host.trim()].filter(Boolean).join(" - ").slice(0, 60);

export const withTabPrefix = (html: string, prefix: string): string =>
  prefix
    ? html.replace(
      "<title>Pier</title>",
      `<title>${prefix.replace(/&/g, "&amp;").replace(/</g, "&lt;")} - Pier</title>`,
    )
    : html;

export interface WebDeps {
  factory: AgentFactory;
  router: Router;
  hub: EventHub;
  sessions: SessionStateStore;
  config: ConfigStore;
  packages: PackageStore;
  providers: ProviderManager;
  settings: SettingsStore;
  /** Passed straight to the instance routes, which document them. */
  catalog?: () => Promise<{ entries: CatalogEntry[]; toolsTaskId: string | null }>;
  names?: readonly string[];
  onToolsChanged?: () => Promise<ToolsSyncNote | null>;
  validateCustomTools?: (raw: unknown) => { tools: CustomTool[] } | { error: string };
  updates: UpdateCheck;
  /** `null`/absent where nothing supervises this instance. */
  updater?: UpdateApplier | null;
  secrets: SecretsControl;
  /** A callback because web/ must not import channels/. */
  onUnlocked?: () => void;
  /** `pier reload`, defined by main.ts because half of it is the adapters. */
  reload?: () => Promise<number>;
  /** Injected by main.ts; web stays blind to the task service. */
  backgroundRuns?: (sessionId: string) => BackgroundRun[];
  activeBackgroundRunCounts?: () => Map<string, number>;
  /** Sessions a task run created for itself; not the operator's conversations. */
  taskSessions?: () => Set<string>;
  /** The IM channel that durably owns a session. Not push.ts's question, which
   *  is answered from the live router: a chat session prompted from the
   *  workbench answers "web" there and its owning channel here. */
  channelOf?: (sessionId: string) => string | undefined;
}

const HEARTBEAT_MS = 15_000;
/** Past this much frame text in flight a stream is dropped. */
const SSE_HIGH_WATER = 4 * 1024 * 1024;
/** Both SSE routes: Hono queues every write, so backpressure alone never stops
 *  a caller from adding more. Neither stream needs durable replay to recover —
 *  the session stream resumes from Last-Event-ID, the workspace stream re-lists
 *  — so a reader past the ceiling is dropped instead of buffered. */
function boundedWriter(stream: SSEStreamingApi, who: string): (frame: string) => void {
  let queued = 0; // frame chars written but not yet drained by the reader
  return (frame) => {
    if (stream.aborted || stream.closed) return;
    if (queued > SSE_HIGH_WATER) {
      log.warn(`dropping slow event client for ${who} — ${queued} chars queued`);
      stream.abort(); // unsubscribes; the client reconnects
      return;
    }
    queued += frame.length;
    void stream
      .write(frame)
      .catch((err: unknown) => log.warn(`event write for ${who} failed: ${String(err)}`))
      .finally(() => (queued -= frame.length));
  };
}
// Canonical base64 only: Buffer.from(.., "base64") happily "decodes" garbage.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function createServer(
  {
    factory,
    router,
    hub,
    sessions: state,
    config,
    packages,
    providers,
    settings,
    catalog,
    names,
    onToolsChanged,
    validateCustomTools,
    secrets,
    onUnlocked,
    reload,
    updates,
    updater,
    backgroundRuns,
    activeBackgroundRunCounts,
    taskSessions,
    channelOf,
  }: WebDeps,
): Hono {
  const app = new Hono();
  const epoch = randomUUID();
  // One frame shared by synchronous fan-out to every watching tab.
  let lastEvent: SessionEvent | null = null;
  let lastFrame = "";
  const sseFrame = (e: SessionEvent): string => {
    if (e !== lastEvent) {
      lastEvent = e;
      lastFrame = `data: ${JSON.stringify(e)}\nid: ${epoch}:${e.seq}\n\n`;
    }
    return lastFrame;
  };

  // Server-side so every client shows the same attention state; it needs a
  // start we witnessed, so a session that boots idle stays untouched. Only the
  // workbench's own sessions: an IM turn or a subagent's was delivered
  // elsewhere, and nothing could ever clear the mark (the ack needs the session
  // on screen).
  const workbenchOwn = (id: string): boolean =>
    (channelOf?.(id) ?? "web") === "web" && !(taskSessions?.().has(id) ?? false);
  const runningNow = new Set<string>();
  hub.subscribeWorkspace((e) => {
    if (e.type !== "session-state") return;
    if (e.state === "streaming") {
      runningNow.add(e.sessionId);
      return;
    }
    if (!runningNow.delete(e.sessionId)) return;
    if (!workbenchOwn(e.sessionId)) return;
    state.setUnread(e.sessionId, true);
    hub.emitWorkspace({ type: "sessions-changed" });
  });

  /** One query for a whole list, not one per row. */
  const activeRuns = (): Map<string, number> => activeBackgroundRunCounts?.() ?? new Map();

  const ensure = (id: string) => router.ensure({ channelId: "web", conversationId: id });

  // Pi persists a session only once the first assistant message lands; until
  // then the rail lists it from here.
  const nascent = new Map<string, { cwd: string; createdAt: number }>();

  /** A session created and never messaged does not survive an eviction (Pi
   *  persisted nothing) but is still in `nascent`; left alone, clicking it 404s
   *  forever. Dropped here, and the 404 says what happened (§5). */
  const ensureLoadable = async (id: string): Promise<AgentSession> => {
    try {
      return await ensure(id);
    } catch (err) {
      if (String(err).includes("unknown session")) {
        nascent.delete(id);
        state.forget(id);
        hub.emitWorkspace({ type: "sessions-changed" });
        throw new Error(`session ${id} no longer exists — it never got a first reply, so nothing was persisted; its rail entry was removed`);
      }
      throw err;
    }
  };

  // Concurrent consumers share one scan; nothing is cached past the last of them.
  let listing: Promise<SessionSummary[]> | undefined;
  const listSessions = (): Promise<SessionSummary[]> =>
    listing ??= factory.list().finally(() => {
      listing = undefined;
    });

  const allSessions = async (): Promise<SessionSummary[]> => {
    const sessions = await listSessions();
    for (const s of sessions) nascent.delete(s.id);
    // A session created but never prompted would otherwise hold a working-set
    // slot forever.
    for (const [id, n] of nascent) {
      if (Date.now() - n.createdAt > 86_400_000) {
        nascent.delete(id);
        state.forget(id);
      }
    }
    const owned = taskSessions?.() ?? new Set<string>();
    return [
      ...[...nascent].map(([id, n]) => ({ id, ...n })),
      ...sessions.filter((s) => !owned.has(s.id)),
    ];
  };

  // `rank` is the place in the rail's working set; `modified` is for the
  // row's tooltip and orders nothing.
  const present = (s: SessionSummary, own: SessionFlags | undefined, active: Map<string, number>) => ({
    ...s,
    ...(own?.rank === undefined ? {} : { rank: own.rank }),
    state: router.stateOf(s.id) ?? "idle",
    unread: own?.unread ?? false,
    channel: channelOf?.(s.id) ?? "web",
    activeRuns: active.get(s.id) ?? 0,
  });

  // The rail's top rows are maintained here and nowhere else: a session a
  // human speaks to — or creates, below — and that is not in the working set
  // already takes the front slot (web/session-state.ts). No route — there is no
  // gesture to make, and an IM message has no browser to make it from.
  router.onSpokenTo((id) => {
    if (state.promote(id)) hub.emitWorkspace({ type: "sessions-changed" });
  });

  app.get("/api/sessions", async (c) => {
    const flags = state.flags();
    const active = activeRuns();
    return c.json((await allSessions()).map((s) => present(s, flags.get(s.id), active)));
  });

  // One session by id, the listing's filters aside: a task run's own session is
  // never a row (allSessions), and the pane that opened it from Runs still has
  // a header to name and a session info panel to fill.
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const n = nascent.get(id);
    const summary = n ? { id, ...n } : (await listSessions()).find((s) => s.id === id);
    if (!summary) return c.json({ error: `no session ${id}` }, 404);
    return c.json(present(summary, state.flags().get(id), activeRuns()));
  });

  // What was said, across every session: the palette's Messages section. The
  // factory owns the index and the ranking; an empty query is an empty answer,
  // not a listing of everything.
  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    return c.json({ hits: q ? await factory.search(q) : [] });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // Never in pier's own directory.
    if (typeof body.cwd !== "string" || !body.cwd) return c.json({ error: "cwd required" }, 400);
    // Resolved like the seam does (agent/pi.ts), or the nascent row is the one
    // place a symlinked directory still looks like a project of its own.
    const cwd = await realpath(body.cwd).catch(() => body.cwd as string);
    const session = await factory.create({ cwd });
    const createdAt = Date.now();
    nascent.set(session.id, { cwd, createdAt });
    router.attach({ channelId: "web", conversationId: session.id }, session);
    // Created is as good as spoken to: a row born below the working set would
    // jump on the first message.
    state.promote(session.id);
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ id: session.id }, 201);
  });

  app.post("/api/sessions/:id/read", (c) => {
    const id = c.req.param("id");
    if (state.unread(id)) {
      state.setUnread(id, false);
      hub.emitWorkspace({ type: "sessions-changed" });
    }
    return c.json({ ok: true });
  });

  // Only these two: compressing the SSE streams would sit on events until the
  // encoder's buffer filled.
  app.use("/api/sessions/:id/history", compress());
  app.use("/api/sessions/:id/turns/:index/steps", compress());

  guarded(app, "GET", "/api/sessions/:id/history", 404, async (c) => {
    const id = c.req.param("id");
    const session = await ensureLoadable(id);
    // Async seam reads can straddle an event. Never label older content with a
    // newer cursor, and never spin indefinitely if the session stays busy.
    for (let attempt = 0; attempt < 3; attempt++) {
      const lastSeq = hub.lastSeq(id);
      const turns = (await session.history()).map(slim);
      const queue = await session.pendingQueue();
      if (hub.lastSeq(id) !== lastSeq) continue;
      return c.json({
        turns, lastSeq, epoch,
        model: session.model ?? null,
        state: session.state,
        context: session.contextUsage ?? null,
        thinkingLevel: session.thinkingLevel,
        queue,
        queueRecovery: router.recoveryOf(id),
        queueUncertain: router.queueUncertain(id),
        backgroundRuns: backgroundRuns?.(id) ?? [],
      });
    }
    log.warn(`snapshot for ${id} changed during all 3 reads`);
    return c.json({ error: "Session changed while loading history; retry loading the session" }, 503);
  });

  // One turn's activity in full, for the group the user just opened. Indexed
  // like the edit route below; the steps carry their own id and tool name so a
  // client whose snapshot has since been rewound can tell it is looking at a
  // different turn instead of showing the wrong tool's output.
  guarded(app, "GET", "/api/sessions/:id/turns/:index/steps", 404, async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: "index required" }, 400);
    const turn = (await (await ensure(c.req.param("id"))).history())[index];
    if (!turn) return c.json({ error: `no turn at index ${index}` }, 404);
    return c.json({ steps: turn.steps ?? [] });
  });

  // Any readable file: the boundary is the Console password (web/fs.ts), not
  // the session's cwd, which is chosen by whoever creates the session.
  guarded(app, "GET", "/api/sessions/:id/files", 400, async (c) => {
    const raw = c.req.query("path");
    if (!raw) return c.json({ error: "path required" }, 400);
    // Absolute only: neither the agent nor Pier writes a relative link.
    const file = isAbsolute(raw) ? await realpath(raw).catch(() => null) : null;
    const info = file ? await stat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) return c.json({ error: "no such file" }, 404);
    if (info.size > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    const bytes = await readFile(file);
    return c.body(bytes, 200, {
      ...fileHeaders(file, bytes, c.req.query("download") === "1"),
      "cache-control": "private, max-age=60",
    });
  });

  // Upload first, so the text the client sends and optimistically renders is final.
  guarded(app, "POST", "/api/inbox", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      typeof body?.data !== "string" ||
      !body.data ||
      // Cheap ceiling before decoding; the exact check is on the bytes.
      body.data.length > Math.ceil(MAX_INBOUND_BYTES / 3) * 4 + 4 ||
      !BASE64_RE.test(body.data) ||
      typeof body?.mimeType !== "string"
    ) {
      return c.json({ error: "invalid file" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : undefined;
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length > MAX_INBOUND_BYTES) return c.json({ error: "invalid file" }, 400);
    return c.json({ path: await saveInbound("web", name, body.mimeType, bytes) });
  });

  // No session needed: surfaces configuring a *future* session have none to ask.
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
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text required" }, 400);
    }
    const mode: InboundMessage["mode"] =
      body.mode === "steer" || body.mode === "followUp" ? body.mode : "auto";
    const { sessionId } = await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      // Named: in a session also reached from a group chat, an unheaded message
      // is attributed to whoever spoke last (core/identity.ts).
      sender: { id: "web", name: "operator" },
      text: body.text,
      mode,
    });
    return c.json({ sessionId }, 202);
  });

  // Edit a user turn: rewind to just before it, then re-dispatch the edited text.
  guarded(app, "POST", "/api/sessions/:id/turns/:index/edit", 400, async (c) => {
    const id = c.req.param("id");
    const index = Number(c.req.param("index"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(index) || index < 0 || typeof body?.text !== "string" || !body.text.trim()) {
      return c.json({ error: "index and text required" }, 400);
    }
    // Before touching anything: a refused dispatch must not cost a rewound transcript.
    if (router.isDraining()) return c.json({ error: "Pier is restarting — try again in a moment" }, 503);
    const session = await ensure(id);
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    const latest = (await session.history()).filter((turn) => turn.role === "user").length - 1;
    if (index !== latest) return c.json({ error: "only the latest user message can be edited — refresh and try again" }, 409);
    if (session.state !== "idle") return c.json({ error: "busy — stop the turn first" }, 409);
    await session.rewindToUserTurn(index);
    // The rewind took the speaker headers out of the context too.
    router.forgetSender(id);
    await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      sender: { id: "web", name: "operator" },
      text: body.text,
      mode: "auto",
    });
    return c.json({ ok: true }, 202);
  });

  // Core owns exclusion and retains originals through the asynchronous handoff.
  guarded(app, "POST", "/api/sessions/:id/queue/deliver", 404, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const mode: unknown = body?.mode;
    if (mode !== "steer" && mode !== "restart") {
      return c.json({ error: "mode must be steer or restart" }, 400);
    }
    return queueResponse(async () => ({ submitted: await router.deliverQueue(id, mode) }), 202);
  });

  guarded(app, "POST", "/api/sessions/:id/queue/recall", 404, async (c) => {
    const id = c.req.param("id");
    return queueResponse(async () => {
      const { steering, followUp } = await router.recallQueue(id);
      return { messages: [...steering, ...followUp] };
    });
  });

  guarded(app, "POST", "/api/sessions/:id/queue/recovery/:batchId/ack", 404, async (c) =>
    queueResponse(async () => {
      router.acknowledgeRecovery(c.req.param("id"), c.req.param("batchId"));
      return { ok: true };
    }),
  );

  // Refused while streaming: Pi's compaction aborts a running turn, and losing
  // one is not what the button offered. The result arrives on the stream as
  // `context-compacted`.
  guarded(app, "POST", "/api/sessions/:id/compact", 404, async (c) => {
    const session = await ensure(c.req.param("id"));
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    // The check above is not the lock: two clicks pass it on the same tick, and
    // the seam's refusal must keep the "not now" status, not read as "no such session".
    return await session.compact().then(
      () => c.json({ ok: true }, 202),
      (err: unknown) => c.json({ error: String(err) }, 409),
    );
  });

  // Not refused while streaming: a rename has nothing to do with the turn running.
  guarded(app, "POST", "/api/sessions/:id/rename", 404, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.name !== "string") return c.json({ error: "name required" }, 400);
    const id = c.req.param("id");
    await (await ensure(id)).rename(body.name.trim().slice(0, SESSION_TITLE_MAX));
    // The transcript is the answer; the event tells surfaces to re-read it.
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    await router.abort(id);
    return c.json({ ok: true }, 202);
  });

  // One per client; keeps every session list in sync without polling.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = boundedWriter(stream, "workspace");
      const unsubscribe = hub.subscribeWorkspace((e) => send(`data: ${JSON.stringify(e)}\n\n`));
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        await stream.write(": ping\n\n");
      }
    }),
  );

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const cursor = c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "";
    const match = /^([^:]+):(0|[1-9]\d*)$/.exec(cursor);
    const lastId = match ? Number(match[2]) : NaN;
    return streamSSE(c, async (stream) => {
      if (match?.[1] !== epoch || !hub.covers(id, lastId)) {
        await stream.writeSSE({ event: "reset", data: "snapshot required" });
        return;
      }
      const send = boundedWriter(stream, id);
      // Subscribe before the replay write can wait on its reader, or an event
      // arriving during backpressure falls between replay() and subscribe().
      const unsubscribe = hub.subscribe(id, (e) => send(sseFrame(e)));
      stream.onAbort(unsubscribe);
      // One write for the whole replay, not an await per event.
      const missed = hub.replay(id, lastId);
      if (missed.length) await stream.write(missed.map(sseFrame).join(""));
      // Heartbeat keeps proxies from closing the stream; loop ends on abort.
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        await stream.write(": ping\n\n");
      }
    });
  });

  // Credentials, agent files and the surface prompt are read when a session
  // opens, so a Console save recycles idle sessions — watched included, since
  // the tab that just saved is the likeliest to need it. A turn in flight is
  // never interrupted.
  const recycle = (what: string): void => {
    void router.evictIdle(0, Date.now(), { includeWatched: true })
      .then((n) => {
        if (n) log.info(`${what} changed — recycled ${n} idle session(s)`);
      })
      .catch((err: unknown) => log.error(`recycling sessions after ${what} failed`, err));
  };

  // `pier reload` on a button, for a file edited outside the Console. `busy`
  // is the honest answer to "why is my change not live yet".
  app.post("/api/reload", async (c) => {
    try {
      const recycled = (await reload?.()) ?? 0;
      log.info(`reload requested — recycled ${recycled} idle session(s)`);
      return c.json({ recycled, busy: router.busy().length });
    } catch (err) {
      log.error("reload failed", err);
      return c.json({ error: `Could not reload: ${String(err)}` }, 500);
    }
  });

  registerInstanceRoutes(app, {
    settings,
    updates,
    updater,
    secrets,
    catalog,
    names,
    onToolsChanged,
    validateCustomTools,
    onUnlocked,
    onSettingsChanged: () => recycle("instance settings"),
  });
  registerProviderRoutes(app, providers, () => recycle("provider configuration"));
  registerConfigRoutes(app, { factory, config, onConfigWritten: () => recycle("an agent file") });
  registerPackageRoutes(app, { factory, packages, onConfigWritten: () => recycle("the package registry") });
  registerFsRoutes(app);
  registerExplorerRoutes(app);

  // serveStatic resolves `root` against the working directory, and an installed
  // Pier is started from wherever the operator happens to be.
  const bundle = fileURLToPath(new URL("./public", import.meta.url));

  // The tab says which instance this is: mistaking staging for production is
  // the mistake worth a few lines. Behind the auth guard, so a stranger at
  // /login learns neither fact.
  const prefix = tabPrefix(process.env.PIER_TITLE, hostname().split(".")[0] ?? "");
  let shell: string | null = null;
  // Answers from the patched string, not from disk, so the precompressed
  // siblings below cannot cover it. Exact path: never the SSE streams.
  app.use("/", compress());
  app.get("/", async (c, next) => {
    // A cached index must not name bundles a release has replaced.
    c.header("cache-control", "private, no-cache");
    if (shell === null) {
      try {
        shell = withTabPrefix(await readFile(join(bundle, "index.html"), "utf8"), prefix);
      } catch (err) {
        // A workbench that will not load is not worth a nicer tab.
        log.warn(`shell unreadable, serving it unpatched: ${String(err)}`);
        return next();
      }
    }
    return c.html(shell);
  });

  // The one unhashed asset: an installed app keeps its worker until the
  // re-fetched script differs, so a cached copy is a fix that never ships.
  app.get("/sw.js", async (c, next) => {
    c.header("cache-control", "private, no-cache");
    await next();
  });
  // Hashed bundles never change under their name; without this the auth
  // layer's bare `private` costs a revalidation round trip per bundle per open.
  app.get("/assets/*", async (c, next) => {
    c.header("cache-control", "private, max-age=31536000, immutable");
    await next();
  });
  // The build writes `.br`/`.gz` siblings (vite.config.ts). serveStatic sets
  // Vary only when it selects one; identity must carry it too, or a cache can
  // reuse that response for a later Brotli request.
  app.use("/*", async (c, next) => {
    await next();
    c.header("Vary", "Accept-Encoding");
  });
  app.use("/*", serveStatic({ root: relative(process.cwd(), bundle) || ".", precompressed: true }));
  return app;
}
