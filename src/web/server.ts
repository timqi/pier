// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type Next } from "hono";
import { compress } from "hono/compress";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { ChatCommandRefused, type MainChain } from "../core/chain.js";
import { EventHub } from "../core/hub.js";
import { logger } from "../log.js";
import { isSilentReply, splitReply } from "../core/reply.js";
import { QueueOperationError, Router, SkillAmbiguous } from "../core/router.js";
import { registerConfigRoutes } from "./config.js";
import { registerExplorerRoutes } from "./explorer.js";
import { registerPackageRoutes } from "./packages.js";
import { fileHeaders, MAX_FILE_BYTES, registerFsRoutes } from "./fs.js";
import { guarded } from "./route.js";
import type {
  AgentFactory,
  BackgroundRun,
  ChatTurn,
  InboundMessage,
  LeadPhase,
  SessionEvent,
  SessionSummary,
  ThinkingLevel,
} from "../core/types.js";
import type {
  CatalogEntry,
  ConfigStore,
  PackageStore,
  ProviderManager,
} from "../agent/types.js";
import { CHAIN_FULL_TOKENS, isThinkingLevel } from "../core/types.js";
import { saveInbound } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import type { OpenItems, ParkedMessage } from "../tasks/types.js";
import { type SessionFlags, type SessionStateStore } from "./session-state.js";
import { ACCENTS, DEFAULT_ACCENT, ICON_PLATE, type SettingsStore } from "../settings.js";
import type { CustomTool } from "../tools.js";
import type { UpdateCheck } from "../update.js";
import { registerInstanceRoutes, type SecretsControl, type UpdateApplier } from "./instance.js";
import type { PasskeyStore } from "./passkeys.js";
import type { ToolsSyncNote } from "./types.js";
import { registerProviderRoutes } from "./providers.js";

const log = logger("web");

async function queueResponse(action: () => Promise<unknown>, status: 200 | 202 = 200): Promise<Response> {
  try {
    return Response.json(await action(), { status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: err instanceof QueueOperationError ? 409 : 404 });
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

/** Safari, the iOS Home Screen, the Dock and launchers take PNG links, never
 *  the served SVG, so every `/app/icon-*.png` reference (shell and manifest)
 *  is pointed at the preset's pre-rendered copy, `icon-<size>-<accent>.png`
 *  beside the defaults in public/ (`just icons`). A preset name, already
 *  validated — never a colour. */
const accentPngs = (text: string, accent: string): string =>
  text.replace(/\/app\/icon-[\w-]+\.png/g, (src) => src.replace(/\.png$/, `-${accent}.png`));

/** The accent rides on `<html>` so the first paint is already in it; the
 *  stylesheet's `[data-accent]` ramps do the rest (style.css). */
export const withAccent = (html: string, accent: string): string =>
  accent
    ? accentPngs(html.replace('<html lang="en">', `<html lang="en" data-accent="${accent}">`), accent)
    : html;

/** Two Piers on one phone need two names and two colours: the manifest names
 *  the instance (`$PIER_TITLE`) and paints its chrome with the accent's 600
 *  step, the same one the icon's plate takes. */
export const instanceManifest = (
  template: Record<string, unknown>,
  title: string | undefined,
  accent: string,
): Record<string, unknown> => {
  const name = title?.trim() || "Pier";
  const rendered = accent ? JSON.parse(accentPngs(JSON.stringify(template), accent)) as Record<string, unknown> : template;
  return {
    ...rendered,
    name,
    short_name: name.slice(0, 12),
    theme_color: ACCENTS[accent || DEFAULT_ACCENT],
  };
};

/** The plate colour is the one thing the served SVG changes; the mark stays
 *  white. */
export const withAccentIcon = (svg: string, accent: string): string =>
  svg.replace(`fill="${ICON_PLATE}"`, `fill="${ACCENTS[accent || DEFAULT_ACCENT]}"`);

interface WebDeps {
  factory: Omit<AgentFactory, "search">;
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
  /** Passed to the instance routes: the public URL guard (passkeys.ts). */
  passkeys?: PasskeyStore;
  /** A callback because web/ must not import channels/. */
  onUnlocked?: () => void;
  /** `pier reload`, defined by main.ts because half of it is the adapters. */
  reload?: () => Promise<number>;
  /** Injected by main.ts; web stays blind to the task service. */
  backgroundRuns?: (sessionId: string) => BackgroundRun[];
  activeBackgroundRunCounts?: () => Map<string, number>;
  /** `pier task run --run <id> --after` messages waiting for the session to idle. */
  parkedMessages?: (sessionId: string) => ParkedMessage[];
  /** Sessions a task run created for itself; not the operator's conversations. */
  taskSessions?: () => Set<string>;
  /** `TaskStore.leads`: every lead session, tagged by its phase in the session list,
   *  `runLive` while a run targeting it is queued or running. */
  leads?: () => Map<string, { phase: LeadPhase; runLive: boolean }>;
  /** `TaskService.openItems`: what `GET /api/continuous/open` answers. */
  openItems?: () => OpenItems;
  /** The IM channel that durably owns a session. Not push.ts's question, which
   *  is answered from the live router: a chat session prompted from the
   *  workbench answers "web" there and its owning channel here. */
  channelOf?: (sessionId: string) => string | undefined;
  /** The continuous conversation (docs/design/10-continuous-session.md). */
  continuous: MainChain;
  /** The configuration subscription is on: what it carries is the source's,
   *  and the routes that would edit it locally refuse. */
  subscribed?: () => boolean;
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
    passkeys,
    onUnlocked,
    reload,
    updates,
    updater,
    backgroundRuns,
    activeBackgroundRunCounts,
    parkedMessages,
    subscribed,
    taskSessions,
    leads,
    openItems,
    channelOf,
    continuous,
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
  // Outside the continuous conversation only a turn the operator sent into is
  // theirs to read: a lead's dispatch or callback turn reports through main.
  const operatorSent = new Set<string>();
  const sentByOperator = (id: string): void => void operatorSent.add(id);
  const runningNow = new Set<string>();
  // Whether every turn of the run stayed silent; turn-end precedes the idle state.
  // A head's silent turn (a dispatch, a stage moved) is traced by the stage, not a mark.
  const silentLast = new Map<string, boolean>();
  router.onTurnEnd((id, text) => {
    if (text.trim()) silentLast.set(id, (silentLast.get(id) ?? true) && isSilentReply(splitReply(text)));
  });
  hub.subscribeWorkspace((e) => {
    if (e.type !== "session-state") return;
    if (e.state === "streaming") {
      runningNow.add(e.sessionId);
      silentLast.delete(e.sessionId);
      return;
    }
    const silent = silentLast.get(e.sessionId) ?? false;
    silentLast.delete(e.sessionId);
    if (!runningNow.delete(e.sessionId)) return;
    const theirs = operatorSent.delete(e.sessionId)
      || (continuous.chainOf(e.sessionId) !== undefined && !silent);
    if (!theirs || !workbenchOwn(e.sessionId)) return;
    state.setUnread(e.sessionId, true);
    hub.emitWorkspace({ type: "sessions-changed" });
  });

  /** One query for a whole list, not one per row. */
  const activeRuns = (): Map<string, number> => activeBackgroundRunCounts?.() ?? new Map();

  const ensure = (id: string) => router.ensure({ channelId: "web", conversationId: id });

  // An earlier member of the continuous conversation is read off disk and
  // never opened, so it can be neither edited nor resumed.
  const older = (id: string): boolean => (continuous.chainOf(id)?.[0] ?? id) !== id;
  const turnsOf = async (id: string): Promise<ChatTurn[]> => {
    if (!older(id)) return (await ensure(id)).history();
    const turns = await factory.readHistory(id);
    if (!turns) throw new Error(`unknown session: ${id}`);
    return turns;
  };

  // Concurrent consumers share one scan; nothing is cached past the last of them.
  let listing: Promise<SessionSummary[]> | undefined;
  const listSessions = (): Promise<SessionSummary[]> =>
    listing ??= factory.list().finally(() => {
      listing = undefined;
    });

  const allSessions = async (): Promise<SessionSummary[]> => {
    const sessions = await listSessions();
    const owned = taskSessions?.() ?? new Set<string>();
    return sessions.filter((s) => !owned.has(s.id));
  };

  // `modified` is for the row's tooltip and orders nothing.
  const leadOf = (lead: { phase: LeadPhase; runLive: boolean } | undefined) =>
    (lead ? { phase: lead.phase, ...(lead.runLive ? { runLive: true } : {}) } : {});
  const present = (s: SessionSummary, own: SessionFlags | undefined, active: Map<string, number>, lead: ReturnType<NonNullable<WebDeps["leads"]>>) => ({
    ...s,
    state: router.stateOf(s.id) ?? "idle",
    unread: own?.unread ?? false,
    channel: channelOf?.(s.id) ?? "web",
    activeRuns: active.get(s.id) ?? 0,
    ...leadOf(lead.get(s.id)),
  });

  app.get("/api/sessions", async (c) => {
    const flags = state.flags();
    const active = activeRuns();
    const lead = leads?.() ?? new Map();
    return c.json((await allSessions()).map((s) => present(s, flags.get(s.id), active, lead)));
  });

  // One session by id, the listing's filters aside: a task run's own session is
  // never a row (allSessions), and the pane that opened it from a run card still has
  // a header to name and a session info panel to fill.
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const summary = (await listSessions()).find((s) => s.id === id);
    if (!summary) return c.json({ error: `no session ${id}` }, 404);
    return c.json(present(summary, state.flags().get(id), activeRuns(), leads?.() ?? new Map()));
  });

  app.post("/api/sessions/:id/read", (c) => {
    const id = c.req.param("id");
    if (state.unread(id)) {
      state.setUnread(id, false);
      hub.emitWorkspace({ type: "sessions-changed" });
    }
    return c.json({ ok: true });
  });

  // Only these reads: compressing the SSE streams would sit on events until the
  // encoder's buffer filled.
  app.use("/api/sessions/:id/history", compress());
  app.use("/api/sessions/:id/system-prompt", compress());
  app.use("/api/sessions/:id/turns/:index/steps", compress());

  guarded(app, "GET", "/api/sessions/:id/history", 404, async (c) => {
    const id = c.req.param("id");
    // Nothing live to snapshot: no cursor, no state, the transcript and its run cards.
    if (older(id)) return c.json({ turns: (await turnsOf(id)).map(slim), backgroundRuns: backgroundRuns?.(id) ?? [], skills: [], readonly: true });
    const session = await ensure(id);
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
        queue: { ...queue, parked: parkedMessages?.(id) ?? [] },
        backgroundRuns: backgroundRuns?.(id) ?? [],
        skills: session.skills(),
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
    const turn = (await turnsOf(c.req.param("id")))[index];
    if (!turn) return c.json({ error: `no turn at index ${index}` }, 404);
    return c.json({ steps: turn.steps ?? [] });
  });

  // Off the transcript, so an earlier member of the conversation answers too
  // and nothing is opened to answer it.
  guarded(app, "GET", "/api/sessions/:id/system-prompt", 404, async (c) => {
    const id = c.req.param("id");
    const prompt = await factory.readSystemPrompt(id);
    if (prompt === undefined) return c.json({ error: `no session ${id}` }, 404);
    if (prompt === null) return c.json({ error: "No request has carried a system prompt yet" }, 404);
    return c.json(prompt);
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
    sentByOperator(id);
    try {
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
    } catch (err) {
      if (err instanceof SkillAmbiguous) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  /** A rotation re-lists every surface. */
  const reached = <T extends { rotated?: unknown }>(head: T): T => {
    if (head.rotated) hub.emitWorkspace({ type: "sessions-changed" });
    return head;
  };

  // The chain, newest first; the client pages back through it with /history.
  app.get("/api/continuous", (c) => c.json({ chain: continuous.members(), rotateAt: CHAIN_FULL_TOKENS }));

  // The status panel's rows.
  app.get("/api/continuous/open", (c) => c.json(openItems?.() ?? { items: [], unlisted: [] }));

  // The alias send: the head is resolved (and rotated) here, so a rotation
  // between the client's snapshot and its send cannot land on an old head.
  guarded(app, "POST", "/api/continuous/messages", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400);
    const mode: InboundMessage["mode"] = body.mode === "steer" || body.mode === "followUp" ? body.mode : "auto";
    try {
      return c.json(reached(await continuous.send({ senderId: "web", sender: { id: "web", name: "operator" }, text: body.text, mode })), 202);
    } catch (err) {
      if (err instanceof ChatCommandRefused || err instanceof SkillAmbiguous) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  // Edit a user turn: rewind to just before it — dropping every turn after it —
  // then re-dispatch the edited text.
  guarded(app, "POST", "/api/sessions/:id/turns/:index/edit", 400, async (c) => {
    const id = c.req.param("id");
    const index = Number(c.req.param("index"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(index) || index < 0 || typeof body?.text !== "string" || !body.text.trim()) {
      return c.json({ error: "index and text required" }, 400);
    }
    if (older(id)) return c.json({ error: "an earlier session of the continuous conversation is read-only" }, 409);
    const session = await ensure(id);
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    const users = (await session.history()).filter((turn) => turn.role === "user").length;
    if (index >= users) return c.json({ error: "that message is gone — refresh and try again" }, 409);
    if (session.state !== "idle") return c.json({ error: "busy — stop the turn first" }, 409);
    await session.rewindToUserTurn(index);
    // The rewind took the speaker headers out of the context too.
    router.forgetSender(id);
    sentByOperator(id);
    await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      sender: { id: "web", name: "operator" },
      text: body.text,
      mode: "auto",
    });
    return c.json({ ok: true }, 202);
  });

  // Core owns exclusion and reports a failed delivery with the originals.
  guarded(app, "POST", "/api/sessions/:id/queue/deliver", 404, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const mode: unknown = body?.mode;
    if (mode !== "steer" && mode !== "restart") {
      return c.json({ error: "mode must be steer or restart" }, 400);
    }
    sentByOperator(id);
    return queueResponse(async () => ({ submitted: await router.deliverQueue(id, mode) }), 202);
  });

  guarded(app, "POST", "/api/sessions/:id/queue/recall", 404, async (c) => {
    const id = c.req.param("id");
    return queueResponse(async () => {
      const { steering, followUp } = await router.recallQueue(id);
      return { messages: [...steering, ...followUp] };
    });
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
    passkeys,
    subscribed,
  });
  registerProviderRoutes(app, providers, () => recycle("provider configuration"));
  registerConfigRoutes(app, { factory, config, onConfigWritten: () => recycle("an agent file"), subscribed });
  registerPackageRoutes(app, { factory, packages, onConfigWritten: () => recycle("the package registry") });
  registerFsRoutes(app);
  registerExplorerRoutes(app);

  // serveStatic resolves `root` against the working directory, and an installed
  // Pier is started from wherever the operator happens to be.
  const bundle = fileURLToPath(new URL("./public", import.meta.url));

  // The workbench lives under /app/ (vite.config.ts `base`): a manifest scope
  // is a path prefix with no exclusions, so at `/` an installed Pier would
  // capture the Show pages at /boards/* and /b/*.
  app.get("/", (c) => c.redirect("/app/"));

  // The tab says which instance this is: mistaking staging for production is
  // the mistake worth a few lines. Behind the auth guard, so a stranger at
  // /login learns neither fact.
  const prefix = tabPrefix(process.env.PIER_TITLE, hostname().split(".")[0] ?? "");
  let shell: string | null = null;
  const serveShell = async (c: Context, next: Next): Promise<Response | void> => {
    // A cached index must not name bundles a release has replaced: the build
    // replaces `public/assets`, so an old shell's hashes are 404s and the page
    // renders unstyled. `no-store`, not `no-cache` — Safari restores a
    // no-cache document from its cache without revalidating it.
    c.header("cache-control", "private, no-store");
    if (shell === null) {
      try {
        shell = withTabPrefix(await readFile(join(bundle, "index.html"), "utf8"), prefix);
      } catch (err) {
        // A workbench that will not load is not worth a nicer tab.
        log.warn(`shell unreadable, serving it unpatched: ${String(err)}`);
        return next();
      }
    }
    // Per request, not cached: the accent is a setting.
    return c.html(withAccent(shell, settings.get().accent));
  };
  // Answers from the patched string, not from disk, so the precompressed
  // siblings below cannot cover it. Exact paths: never the SSE streams.
  for (const path of ["/app", "/app/"]) {
    app.use(path, compress());
    app.get(path, serveShell);
  }

  // The two install assets that carry the instance's identity, rendered from
  // the shipped files; `no-cache` so a changed accent shows on the next load.
  // Unreadable → the static copy below, and the log says so.
  const identity = (file: string, render: (text: string, accent: string) => string, type: string) =>
    async (c: Context, next: Next): Promise<Response | void> => {
      let text: string;
      try {
        text = await readFile(join(bundle, file), "utf8");
      } catch (err) {
        log.warn(`${file} unreadable, serving it unpatched: ${String(err)}`);
        return next();
      }
      c.header("cache-control", "private, no-cache");
      return c.body(render(text, settings.get().accent), 200, { "content-type": type });
    };
  app.get("/app/manifest.webmanifest", identity(
    "manifest.webmanifest",
    (text, accent) => JSON.stringify(instanceManifest(JSON.parse(text), process.env.PIER_TITLE, accent)),
    "application/manifest+json",
  ));
  app.get("/app/icon.svg", identity("icon.svg", withAccentIcon, "image/svg+xml"));

  // The one unhashed asset: an installed app keeps its worker until the
  // re-fetched script differs, so a cached copy is a fix that never ships.
  app.get("/app/sw.js", async (c, next) => {
    c.header("cache-control", "private, no-cache");
    await next();
  });
  // Hashed bundles never change under their name; without this the auth
  // layer's bare `private` costs a revalidation round trip per bundle per open.
  // Never on a miss: a build replaces `public/assets`, and a year-long 404 is a
  // stale shell's blank page that no longer even reaches the server.
  app.get("/app/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200 || c.res.status === 206) {
      c.header("cache-control", "private, max-age=31536000, immutable");
    } else c.header("cache-control", "private, no-store");
  });
  // The build writes `.br`/`.gz` siblings (vite.config.ts). serveStatic sets
  // Vary only when it selects one; identity must carry it too, or a cache can
  // reuse that response for a later Brotli request.
  app.use("/app/*", async (c, next) => {
    await next();
    c.header("Vary", "Accept-Encoding");
  });
  app.use("/app/*", serveStatic({
    root: relative(process.cwd(), bundle) || ".",
    rewriteRequestPath: (path) => path.replace(/^\/app/, ""),
    precompressed: true,
  }));
  return app;
}
