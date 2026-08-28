// Web workbench backend: REST + SSE, a pure consumer of core.
// See docs/design/03-web-workbench.md for the route contract.

import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { EventHub } from "../core/hub.js";
import { logger } from "../log.js";
import { Router } from "../core/router.js";
import { registerExplorerRoutes } from "./explorer.js";
import { guarded, registerFileRoutes } from "./files.js";
import type {
  AgentFactory,
  AgentSession,
  BackgroundRun,
  BundledExtensionInfo,
  ChatTurn,
  ConfigStore,
  InboundMessage,
  ManagedToolInfo,
  ProviderManager,
  SessionSummary,
  ThinkingLevel,
} from "../core/types.js";
import { isThinkingLevel } from "../core/types.js";
import { SESSION_TITLE_MAX } from "../limits.js";
import { saveInbound } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { RepoIndex } from "./repos.js";
import { type SessionFlags, type SessionStateStore } from "./session-state.js";
import type { SettingsStore } from "../settings.js";
import type { UpdateCheck } from "../update.js";
import { registerInstanceRoutes, type SecretsControl, type UpdateApplier } from "./instance.js";
import { registerProviderRoutes } from "./providers.js";

const log = logger("web");

/** A transcript without the bytes nobody has asked to see yet. A step's `args`
 *  and `output` are ~90% of a long session's snapshot and sit inside a
 *  collapsed group; the client fetches one turn's worth when it is opened. */
const slim = (turn: ChatTurn): ChatTurn =>
  turn.steps
    ? { ...turn, steps: turn.steps.map(({ args: _args, output: _output, ...step }) => step) }
    : turn;

/** What goes in front of `Pier` in the tab: `$PIER_TITLE`, then the machine.
 *  The label leads because a tab is narrow and "which instance is this" is the
 *  question it has to answer before the browser truncates — `staging - g1`. */
export const tabPrefix = (title: string | undefined, host: string): string =>
  [title?.trim(), host.trim()].filter(Boolean).join(" - ").slice(0, 60);

/** `<title>staging - g1 - Pier</title>`. Nothing to say, or a shell that does
 *  not say `Pier`: leave it exactly as built. */
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
  /** Pinned sessions, and the ones whose last finished turn nobody viewed. */
  sessions: SessionStateStore;
  config: ConfigStore;
  providers: ProviderManager;
  settings: SettingsStore;
  /** The extensions Pier ships with, and which are on. Passed as data by
   *  main.ts: the catalog is code that imports the Pi SDK, and web/ may not. */
  extensions?: () => BundledExtensionInfo[];
  /** The managed CLI tools and what is installed today; main.ts again, because
   *  running ubix is the instance layer's business, not a route's. */
  tools?: () => Promise<{ catalog: ManagedToolInfo[]; taskId: string | null }>;
  /** Ran with the new tool set after it is stored — main.ts installs it. */
  onToolsChanged?: (names: string[]) => void;
  /** Whether a newer Pier exists; answered from cache, refreshed in the
   *  background. */
  updates: UpdateCheck;
  /** How this instance applies one; `null`/absent where nothing supervises it. */
  updater?: UpdateApplier | null;
  secrets: SecretsControl;
  /** Ran after a successful unlock; main.ts starts the channels it held back.
   *  A callback because web/ must not import channels/. */
  onUnlocked?: () => void;
  /** `pier reload`, defined by main.ts because half of it is the adapters:
   *  re-read their configuration, let the sessions go, answer how many. */
  reload?: () => Promise<number>;
  /** Injected by main.ts; web stays blind to the task service. */
  backgroundRuns?: (sessionId: string) => BackgroundRun[];
  /** The IM channel that durably owns a session, absent for everything else.
   *  Injected because the mapping lives in channels/. Not push.ts's question:
   *  that one asks which conversation produced *this* turn and is answered
   *  from the live router, so a chat session prompted from the workbench
   *  answers "web" there and its owning channel here. */
  channelOf?: (sessionId: string) => string | undefined;
}

const HEARTBEAT_MS = 15_000;
// Canonical base64 only: Buffer.from(.., "base64") happily "decodes" garbage.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function createServer(
  {
    factory,
    router,
    hub,
    sessions: state,
    config,
    providers,
    settings,
    extensions,
    tools,
    onToolsChanged,
    secrets,
    onUnlocked,
    reload,
    updates,
    updater,
    backgroundRuns,
    channelOf,
  }: WebDeps,
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
    state.setUnread(e.sessionId, true);
    hub.emitWorkspace({ type: "sessions-changed" });
  });

  // Repository identity per project directory, refreshed off the request path.
  const repos = new RepoIndex(() => hub.emitWorkspace({ type: "sessions-changed" }));

  /** Background runs this session launched that are still in flight. */
  const activeRuns = (id: string): number =>
    backgroundRuns?.(id).filter((r) => r.state === "queued" || r.state === "running").length ?? 0;

  /** The web channel's session for `id` — every session route resolves here. */
  const ensure = (id: string) => router.ensure({ channelId: "web", conversationId: id });

  // Sessions created here that Pi doesn't list yet — it persists a session
  // only once the first assistant message lands. Merged into the list below
  // so every client sees a new session immediately; dropped once Pi lists it.
  const nascent = new Map<string, { cwd: string; createdAt: number }>();

  /** `ensure`, plus ghost cleanup. A session created and never messaged does
   *  not survive a restart or an eviction (Pi persisted nothing), but while
   *  this process lives it is in `nascent` and therefore in the rail — left
   *  alone, clicking it 404s forever. The load path is where a ghost is
   *  discovered, so it is where the entry and its pin are dropped and every
   *  rail told; the 404 then says what happened instead of looking like a
   *  crash (§5b). */
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

  // A listing stats every session file and parses whatever grew — milliseconds
  // warm, one scan cold. Concurrent consumers share it, whatever the factory
  // behind the seam retains of its own; nothing here is cached past the last
  // of them.
  let listing: Promise<SessionSummary[]> | undefined;
  const listSessions = (): Promise<SessionSummary[]> =>
    listing ??= factory.list().finally(() => {
      listing = undefined;
    });

  /** Every session a surface may show: what Pi has written, plus the ones
   *  created here that it has not persisted yet. */
  const allSessions = async (): Promise<SessionSummary[]> => {
    const sessions = await listSessions();
    for (const s of sessions) nascent.delete(s.id);
    // A session created but never prompted would otherwise be listed forever.
    for (const [id, n] of nascent) if (Date.now() - n.createdAt > 86_400_000) nascent.delete(id);
    return [
      ...[...nascent].map(([id, n]) => ({ id, ...n })),
      ...sessions,
    ];
  };

  // One session as every list renders it: the summary, what the workbench
  // decided about it, and what is true of it right now.
  // The listing's `modified` is dropped rather than forwarded: it dates a
  // transcript, and no surface renders it.
  const present = ({ modified: _drop, ...s }: SessionSummary, own: SessionFlags | undefined) => {
    return {
      ...s,
      ...(own?.sort === undefined ? {} : { sort: own.sort }),
      ...(own?.projectSort === undefined ? {} : { projectSort: own.projectSort }),
      // Which repository the directory belongs to, on every list and not only
      // on the rail's: All sessions replaces the client's whole list, so a row
      // without it there un-groups the worktrees the rail had just grouped.
      // Whatever is known now — the probe is never waited on, and its answer
      // arrives as a `sessions-changed`.
      ...repos.get(s.cwd),
      state: router.stateOf(s.id) ?? "idle",
      listed: own?.pinned ?? false,
      unread: own?.unread ?? false,
      channel: channelOf?.(s.id) ?? "web",
      activeRuns: activeRuns(s.id),
    };
  };

  // The rail: the same rows as the full list, minus everything Projects is not
  // showing. One source, one shape — the rail used to read a second copy of
  // the summaries out of SQLite, which is what had to be kept in step.
  app.get("/api/projects", async (c) => {
    const flags = state.flags();
    return c.json(
      (await allSessions())
        .map((s) => present(s, flags.get(s.id)))
        .filter((row) => row.listed),
    );
  });

  // One drag, one write of the list that changed: the projects, or one
  // project's sessions. Whole lists rather than a move — the client has just
  // rendered the result, and replaying a move on top of a stale list would put
  // the row somewhere nobody dropped it.
  app.post("/api/projects/order", async (c) => {
    const body = await c.req.json().catch(() => null);
    const list = (raw: unknown): string[] | null | undefined =>
      raw === undefined
        ? undefined
        : Array.isArray(raw) && raw.every((x) => typeof x === "string" && x)
          ? (raw as string[])
          : null;
    const sessions = list(body?.sessions);
    const projects = list(body?.projects);
    if (sessions === null || projects === null || (!sessions && !projects)) {
      return c.json({ error: "sessions and/or projects must be lists of ids" }, 400);
    }
    state.reorder({ sessions, projects });
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ ok: true });
  });

  app.get("/api/sessions", async (c) => {
    const flags = state.flags();
    return c.json((await allSessions()).map((s) => present(s, flags.get(s.id))));
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // A session always starts in its project directory — never in pier's own.
    if (typeof body.cwd !== "string" || !body.cwd) return c.json({ error: "cwd required" }, 400);
    const session = await factory.create({ cwd: body.cwd });
    const createdAt = Date.now();
    nascent.set(session.id, { cwd: body.cwd, createdAt });
    router.attach({ channelId: "web", conversationId: session.id }, session);
    // Created here = part of the workspace; pinning is what Projects lists.
    state.pin(session.id, body.cwd, true);
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ id: session.id }, 201);
  });

  // Seen = read: a client with the session selected and the tab visible acks
  // here; the broadcast moves every other client's dot back to idle.
  app.post("/api/sessions/:id/read", (c) => {
    const id = c.req.param("id");
    if (state.unread(id)) {
      state.setUnread(id, false);
      hub.emitWorkspace({ type: "sessions-changed" });
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/pin", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.pinned !== "boolean") return c.json({ error: "pinned required" }, 400);
    const id = c.req.param("id");
    // The directory comes from the listing, not from the client that clicked:
    // it is the one fact this row keeps about the session, it is the key a
    // project's manual place is stamped on, and the browser is not where a
    // path should come from when the server already knows it.
    const cwd = (await factory.find(id))?.cwd ?? nascent.get(id)?.cwd;
    if (!cwd) return c.json({ error: `session ${id} has no directory Pier can find` }, 404);
    state.pin(id, cwd, body.pinned);
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ pinned: body.pinned });
  });

  // The two responses big enough to matter: a transcript, and one turn's tool
  // detail. Scoped to these routes on purpose — compressing the SSE streams
  // would sit on events until the encoder's buffer filled.
  app.use("/api/sessions/:id/history", compress());
  app.use("/api/sessions/:id/turns/:index/steps", compress());

  // Snapshot: everything a fresh client needs before it starts consuming
  // deltas from SSE — transcript, live state, pending queue, model.
  guarded(app, "GET", "/api/sessions/:id/history", 404, async (c) => {
    const id = c.req.param("id");
    const session = await ensureLoadable(id);
    return c.json({
      turns: (await session.history()).map(slim),
      lastSeq: hub.lastSeq(id),
      model: session.model ?? null,
      state: session.state,
      context: session.contextUsage ?? null,
      thinkingLevel: session.thinkingLevel,
      queue: await session.pendingQueue(),
      backgroundRuns: backgroundRuns?.(id) ?? [],
    });
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
    // Already capped at MAX_STEP_OUTPUT by the transcript rebuild: this route
    // hands back what a surface shows, not the untruncated tool result.
    return c.json({ steps: turn.steps ?? [] });
  });

  // Composer attachments: bytes land in the inbox, the message carries the
  // path as a `[name](file:///…)` line the client builds itself — upload
  // first, so the text it sends (and optimistically renders) is final.
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
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text required" }, 400);
    }
    const mode: InboundMessage["mode"] =
      body.mode === "steer" || body.mode === "followUp" ? body.mode : "auto";
    const { sessionId } = await router.dispatch({
      key: { channelId: "web", conversationId: id },
      senderId: "web",
      // Named, not anonymous: a session reached from a group chat as well as
      // from here attributes an unheaded message to whoever spoke last
      // (core/identity.ts), which is the operator's own words in someone
      // else's mouth.
      sender: { id: "web", name: "operator" },
      text: body.text,
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
    // Asked before touching anything: the dispatch below would be refused by
    // the drain gate, and by then the transcript is already rewound.
    if (router.isDraining()) return c.json({ error: "Pier is restarting — try again in a moment" }, 503);
    const session = await ensure(id);
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    await session.rewindToUserTurn(index);
    // The rewind took the turns after this one out of the context, headers and
    // all; what the model was told about who is speaking went with them.
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
    // Same reason as edit above: a refused dispatch must not cost the queue.
    if (router.isDraining()) return c.json({ error: "Pier is restarting — try again in a moment" }, 503);
    const session = await ensure(id);
    const { steering, followUp } = await session.clearQueue();
    const text = [...steering, ...followUp].join("\n").trim();
    if (!text) return c.json({ error: "queue is empty" }, 409);
    if (mode === "restart") await router.abort(id); // resolves once idle
    // No sender here, unlike the other dispatches: the queued texts were
    // headed when they were first dispatched — and in a shared session they
    // are other speakers' words, which an operator header would claim.
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
    const id = c.req.param("id");
    const session = await ensure(id);
    const { steering, followUp } = await session.clearQueue();
    // Those messages carried the header that told the session who is speaking,
    // and they are going back to the composer instead of to the model.
    if (steering.length || followUp.length) router.forgetSender(id);
    return c.json({ messages: [...steering, ...followUp] });
  });

  // Shrink the context on demand: Pi summarizes the older transcript away and
  // the session continues from the summary. Refused while streaming, like the
  // edit route above and for the same reason — Pi's own compaction aborts a
  // running turn to do it, and losing a turn is not what the button offered.
  // The result is not in this response: it arrives on the session's stream as
  // `context-compacted` (agent/events.ts), which is also the only place the
  // automatic compaction can be seen.
  guarded(app, "POST", "/api/sessions/:id/compact", 404, async (c) => {
    const session = await ensure(c.req.param("id"));
    if (session.state === "streaming") return c.json({ error: "busy — stop the turn first" }, 409);
    // The check above is a courtesy, not the lock: two clicks pass it on the
    // same tick, so the seam refuses the second one (agent/pi.ts) and its
    // refusal keeps the status this route already uses for "not now" — a 404
    // from `guarded` would have read as "no such session".
    return await session.compact().then(
      () => c.json({ ok: true }, 202),
      (err: unknown) => c.json({ error: String(err) }, 409),
    );
  });

  // A name, so a title is what you called it instead of the first 80
  // characters you happened to type. Not refused while streaming: a rename has
  // nothing to do with the turn running, and the transcript takes an append.
  guarded(app, "POST", "/api/sessions/:id/rename", 404, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.name !== "string") return c.json({ error: "name required" }, 400);
    const id = c.req.param("id");
    await (await ensure(id)).rename(body.name.trim().slice(0, SESSION_TITLE_MAX));
    // Nothing to write and nothing to report: the name went into the
    // transcript, which is what every list reads. The event is how the
    // surfaces learn to re-read it, and the seam dropped its retained scan on
    // the way out so the re-read sees the new name.
    hub.emitWorkspace({ type: "sessions-changed" });
    return c.json({ ok: true });
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
      // A write to a torn-down stream must not become an unhandled rejection.
      const unsubscribe = hub.subscribeWorkspace(
        (e) => void stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {}),
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
      // Same as above: the client may be gone by the time an event fires.
      const unsubscribe = hub.subscribe(id, (e) => void send(e).catch(() => {}));
      stream.onAbort(unsubscribe);
      // Heartbeat keeps proxies from closing the stream; loop ends on abort.
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        await stream.write(": ping\n\n");
      }
    });
  });

  // Provider credentials, the agent files and the surface prompt are read when
  // a session *opens*: a live one keeps what it opened with, so a Console save
  // would otherwise reach nothing until the idle sweep got around to it half an
  // hour later. Letting the idle sessions go is what `pier reload` does — the
  // next message re-opens them with the configuration just written. Watched
  // included, unlike the background sweep: the session open in the tab that
  // just saved is the likeliest one to need it. A turn in flight is still never
  // interrupted; it picks the change up at its next natural eviction.
  const recycle = (what: string): void => {
    void router.evictIdle(0, Date.now(), { includeWatched: true })
      .then((n) => {
        if (n) log.info(`${what} changed — recycled ${n} idle session(s)`);
      })
      .catch((err: unknown) => log.error(`recycling sessions after ${what} failed`, err));
  };

  // `pier reload` on a button. The callbacks below already recycle when the
  // Console is what changed the configuration; an agent editing AGENTS.md or a
  // file edited over ssh has nothing to trigger them, and this is that trigger.
  // `busy` is reported rather than waited on: a streaming session is never
  // interrupted (core/router.ts evictIdle), so that count is the honest answer
  // to "why is my change not live yet".
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
    extensions,
    tools,
    onToolsChanged,
    onUnlocked,
    onSettingsChanged: () => recycle("instance settings"),
  });
  registerProviderRoutes(app, providers, () => recycle("provider configuration"));
  registerFileRoutes(app, {
    factory,
    config,
    nascentCwd: (id) => nascent.get(id)?.cwd,
    onConfigWritten: () => recycle("an agent file"),
  });
  registerExplorerRoutes(app);

  // serveStatic resolves `root` against the *working directory*, and an
  // installed Pier is started from wherever the operator happens to be. The
  // bundle sits beside this module in both trees — src/web/public when tsx
  // runs the source, dist/web/public in a build — so the path is derived from
  // the module and handed over as the relative form the option wants.
  const bundle = fileURLToPath(new URL("./public", import.meta.url));

  // The tab says which instance this is (`staging - g1 - Pier`): an operator
  // keeps a workbench open per environment and they are otherwise identical,
  // and mistaking the test one for production is the mistake worth a few lines.
  // Both facts are known only at runtime, so they are patched into the shell
  // here rather than built in — and served behind the auth guard, so a stranger
  // at /login learns neither. Read once: neither can change under a process.
  const prefix = tabPrefix(process.env.PIER_TITLE, hostname().split(".")[0] ?? "");
  let shell: string | null = null;
  app.get("/", async (c, next) => {
    // A release replaces hashed assets. Revalidate the shell on every
    // navigation so a cached index cannot name bundles that no longer exist.
    c.header("cache-control", "private, no-cache");
    if (shell === null) {
      try {
        shell = withTabPrefix(await readFile(join(bundle, "index.html"), "utf8"), prefix);
      } catch (err) {
        // A workbench that will not load is not worth a nicer tab: hand the
        // request back to the static handler, which answers as it always did.
        log.warn(`shell unreadable, serving it unpatched: ${String(err)}`);
        return next();
      }
    }
    return c.html(shell);
  });

  // Same reasoning as the shell above, for the one asset that is not hashed:
  // an installed app keeps its worker until the script it re-fetches differs,
  // so a cached copy is a released fix that never ships.
  app.get("/sw.js", async (c, next) => {
    c.header("cache-control", "private, no-cache");
    await next();
  });
  // Hashed bundles never change under their name — a release writes new names,
  // and the shell above is what re-points at them. Without this they carry only
  // the auth layer's bare `private`, so a browser revalidates each one before it
  // may reuse it: three round trips on a remote instance, one of them in front
  // of the 636KB terminal emulator, every time the workbench is opened.
  app.get("/assets/*", async (c, next) => {
    c.header("cache-control", "private, max-age=31536000, immutable");
    await next();
  });
  app.use("/*", serveStatic({ root: relative(process.cwd(), bundle) || "." }));
  return app;
}
