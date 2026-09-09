// Conversation → session routing plus event wiring. In-memory on purpose:
// the durable chat → session map lives in channels/conversations.ts.

import { randomUUID } from "node:crypto";
import { logger } from "../log.js";
import { EventHub } from "./hub.js";
import { SenderPrefix, withPrefix } from "./identity.js";
import { decide } from "./queue.js";
import { splitReply } from "./reply.js";
import type {
  AgentSession,
  Channel,
  ConversationKey,
  InboundMessage,
  ModelRef,
  QueueRecovery,
  SessionState,
} from "./types.js";

const log = logger("core");

/** Generous: eviction is a memory measure, and re-opening costs a Pi resume
 *  plus a transcript read. */
const IDLE_TTL_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;

/** An error goes into a chat window, so it is trimmed to something readable. */
const truncate = (message: string): string =>
  message.length > 600 ? `${message.slice(0, 600)}…` : message;

/** What a chat window gets of a system input; a task callback carries up to
 *  8000 characters of result text (tasks/callbacks.ts). */
const NOTE_CHARS = 200;
const NOTE_LINES = 4;

/** A note is context for the turn it precedes, not the message: pasted whole,
 *  a run result buries the chat on IM, which cannot collapse it. The hub and
 *  the transcript keep every character. */
function digest(text: string): string {
  const body = text.trimEnd();
  let head = body.split("\n").slice(0, NOTE_LINES).join("\n");
  if (head.length > NOTE_CHARS) {
    const capped = head.slice(0, NOTE_CHARS);
    // A boundary before the midpoint loses more than the ragged edge costs.
    const boundary = Math.max(capped.lastIndexOf("\n"), capped.lastIndexOf(" "));
    head = capped.slice(0, boundary > NOTE_CHARS / 2 ? boundary : NOTE_CHARS);
  }
  const rest = body.slice(head.length).trim();
  if (!rest) return body;
  const dropped = rest.split("\n").length;
  return `${head.trimEnd()}\n… +${String(dropped)} more line${dropped === 1 ? "" : "s"}`;
}

function keyOf(key: ConversationKey): string {
  return `${key.channelId}:${key.conversationId}`;
}

/** `web:<id>` and `task:<id>` name one session id and neither is a chat — no
 *  Channel is registered under them — so they share a lock in `ensure`. */
const isAlias = (key: ConversationKey): boolean =>
  key.channelId === "web" || key.channelId === "task";

interface Attached {
  session: AgentSession;
  key: ConversationKey;
  stateSince: number;
  /** What eviction ages; distinct from stateSince, which the UI reads as "idle since". */
  activeAt: number;
  /** So eviction stops listening instead of leaking the closure that holds the session. */
  unsubscribe: () => void;
}

export class QueueOperationError extends Error {
  constructor(readonly reason: "busy" | "empty" | "draining" | "missing", message: string) {
    super(message);
  }
}

export class Router {
  private readonly byKey = new Map<string, AgentSession>();
  private readonly bySession = new Map<string, Attached>();
  /** Resolves in flight: two surfaces asking at once must share one session
   *  object, not open a second Pi runtime on the same transcript. */
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly channels = new Map<string, Channel>();
  /** Who each session last heard from, so a header costs tokens only on news. */
  private readonly senders = new SenderPrefix();
  /** Set by a graceful restart (src/drain.ts); `endDrain` is for the caller
   *  that drains speculatively and may not get to exit. */
  private draining = false;
  private spokenTo?: (sessionId: string) => void;

  constructor(
    private readonly hub: EventHub,
    /** Create or resume the session owning a conversation (wired in main.ts). */
    private readonly resolve: (key: ConversationKey) => Promise<AgentSession>,
  ) {}

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  /** Fires for humans only: chats and the workbench pass through `dispatch`,
   *  tasks and subagents do not. Registered late because the listener
   *  (web/session-state.ts) is built with the web surface. */
  onSpokenTo(listener: (sessionId: string) => void): void {
    this.spokenTo = listener;
  }

  /** A failure reaches the chat as well as the hub (§5): on IM, silence is
   *  indistinguishable from a crash. `notify`, not `send`, so it is never
   *  mistaken for an assistant turn. */
  private report(sessionId: string, key: ConversationKey, message: string): void {
    log.error(`${keyOf(key)} session ${sessionId}: ${message}`);
    this.hub.emit(sessionId, { type: "error", message });
    const channel = this.channels.get(key.channelId);
    // Never recursive: if telling the chat also fails, the hub has the original.
    channel?.notify(key.conversationId, { text: truncate(message), origin: { kind: "error" } })
      .catch((err) => {
        log.error(`could not report the failure to ${key.channelId}`, err);
        this.hub.emit(sessionId, {
          type: "error",
          message: `could not report the failure to ${key.channelId}: ${String(err)}`,
        });
      });
  }

  /** Something that happened *to* a session (an undeliverable task result): the
   *  attached conversation is told where it was waiting, else the hub carries it. */
  reportTo(sessionId: string, message: string): void {
    const key = this.conversationOf(sessionId);
    if (key) this.report(sessionId, key, message);
    else this.hub.emit(sessionId, { type: "error", message });
  }

  /** Only the in-memory attachment goes; the durable mapping
   *  (channels/conversations.ts) resumes the same transcript on the next message.
   *  `includeWatched` is for config a session reads only at open: the session
   *  most likely to need it is the one open in the tab that changed it. A
   *  streaming turn is never evicted. */
  async evictIdle(
    ttlMs = IDLE_TTL_MS,
    now = Date.now(),
    { includeWatched = false }: { includeWatched?: boolean } = {},
  ): Promise<number> {
    let evicted = 0;
    // Snapshot: the loop awaits dispose(), and the map may change meanwhile.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, attached] of [...this.bySession]) {
      if (attached.session.state === "streaming") continue;
      if (this.queueOperations.has(id) || this.recoveries.get(id)?.some((b) => b.status === "submitting")) continue;
      if (!includeWatched && this.hub.hasSubscribers(id)) continue;
      if (now - attached.activeAt < ttlMs) continue;
      this.bySession.delete(id);
      this.forgetKeys(attached.session);
      attached.unsubscribe();
      this.senders.forget(id);
      this.hub.dropReplay(id);
      evicted += 1;
      log.info(`evicted idle session ${id} (${keyOf(attached.key)})`);
      // A runtime that will not shut down must not block releasing the rest.
      await attached.session.dispose().catch((err) =>
        log.error(`disposing session ${id} failed`, err)
      );
    }
    return evicted;
  }

  /** Run evictIdle on a timer. Returns the stop function (main.ts owns it). */
  startIdleEviction(): () => void {
    // Unref'd: a sweep pending is never a reason for the process to stay up.
    const timer = setInterval(() => {
      void this.evictIdle().catch((err) => log.error("idle sweep failed", err));
    }, SWEEP_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  stateOf(sessionId: string): SessionState | undefined {
    return this.bySession.get(sessionId)?.session.state;
  }

  stateSinceOf(sessionId: string): number | undefined {
    return this.bySession.get(sessionId)?.stateSince;
  }

  /** Current in-memory model of a live session (undefined when not attached). */
  modelOf(sessionId: string): ModelRef | undefined {
    return this.bySession.get(sessionId)?.session.model;
  }

  /** Inverse of `sessionOf`; lets a tool act on "here". A task or subagent
   *  session is attached to nothing and answers undefined. */
  conversationOf(sessionId: string): ConversationKey | undefined {
    return this.bySession.get(sessionId)?.key;
  }

  /** Every alias: a key left behind hands out a session that is no longer live. */
  private forgetKeys(session: AgentSession): void {
    for (const [key, held] of this.byKey) if (held === session) this.byKey.delete(key);
  }

  /** Attach an existing session to a conversation and wire its events. */
  attach(key: ConversationKey, session: AgentSession): void {
    const existing = this.bySession.get(session.id);
    if (existing?.session === session) {
      this.byKey.set(keyOf(key), session);
      this.reached(session, key);
      return;
    }
    if (existing) {
      // Two live objects on one transcript would both write it and both answer
      // the chat; single-flight `ensure` should make this unreachable.
      log.warn(`session ${session.id} replaced while attached to ${keyOf(existing.key)}`);
      existing.unsubscribe();
      this.forgetKeys(existing.session);
    }
    this.byKey.set(keyOf(key), session);
    log.info(`attached ${keyOf(key)} → session ${session.id}`);
    const unsubscribe = session.subscribe((payload) => {
      this.hub.emit(session.id, payload);
      if (payload.type === "state") {
        const attached = this.bySession.get(session.id);
        // Every turn passes here, so it also proves liveness to the sweeper.
        if (attached) attached.stateSince = attached.activeAt = Date.now();
        this.hub.emitWorkspace({
          type: "session-state",
          sessionId: session.id,
          state: payload.state,
        });
      }
      if (payload.type === "renamed") this.hub.emitWorkspace({ type: "sessions-changed" });
      // Without this a session-reported error lands only in the web timeline
      // and the IM side goes quiet for no visible reason.
      if (payload.type === "error") {
        log.error(`${keyOf(key)} session ${session.id} reported: ${payload.message}`);
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, {
          text: truncate(payload.message),
          origin: { kind: "error" },
        }).catch((err) => log.error(`notify ${key.channelId} failed`, err));
      }
      // Context the chat did not see typed goes out before the turn it
      // triggers, so the answer has a visible cause. The hub carries it whole.
      if (payload.type === "system-input") {
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, { text: digest(payload.text), origin: payload.origin })
          .catch((err) => {
            log.error(`notify ${key.channelId} failed`, err);
            this.hub.emit(session.id, {
              type: "error",
              message: `notify ${key.channelId} failed: ${String(err)}`,
            });
          });
      }
      // A steer chosen against a turn that ended before the call landed sits in
      // Pi's queue until some later turn — on IM, a message that never arrived
      // (§5). A non-empty queue on an idle session is exactly that case.
      if (payload.type === "queue-state" && (payload.steering.length || payload.followUp.length)) {
        this.promoteQueued(session);
      }
      // Empty text included: adapters retire per-turn UI (👀 receipts) on it.
      if (payload.type === "turn-end") {
        log.info(
          `turn end ${keyOf(key)} session ${session.id}: ${String(payload.text.length)} chars`,
        );
        const channel = this.channels.get(key.channelId);
        if (channel) {
          const reply = splitReply(payload.text, payload.meta);
          this.deliver(key, () => channel.send(key.conversationId, reply))
            .catch((err: unknown) => {
              this.report(session.id, key, `outbound to ${key.channelId} failed: ${String(err)}`);
            });
        }
      }
    });
    this.bySession.set(session.id, {
      session,
      key,
      stateSince: Date.now(),
      activeAt: Date.now(),
      unsubscribe,
    });
  }

  /** An adapter's send is several platform calls (chunks, then attachments),
   *  so two answers left to overlap interleave in the chat. Per conversation:
   *  a slow chat may not hold up another. */
  private readonly delivering = new Map<string, Promise<void>>();

  private deliver(key: ConversationKey, send: () => Promise<void>): Promise<void> {
    const id = keyOf(key);
    const pending = this.delivering.get(id);
    // The async wrapper turns a synchronous throw into this reply's rejection.
    const done = pending ? pending.then(send) : (async () => send())();
    // A rejection is the caller's to report; inherited, it would fail every
    // later reply to this conversation.
    const settled = done.catch(() => {});
    this.delivering.set(id, settled);
    // Only the tail clears the slot — a newer reply owns it by then.
    void settled.then(() => {
      if (this.delivering.get(id) === settled) this.delivering.delete(id);
    });
    return done;
  }

  private readonly queueOperations = new Set<string>();
  private readonly promotionRequested = new Set<string>();
  private readonly recoveries = new Map<string, QueueRecovery[]>();
  // Latest failed batch id, so a clear cannot erase a newer rejection that
  // arrived while it awaited the backend.
  private readonly uncertaintyHeld = new Map<string, string>();

  queueUncertain(sessionId: string): boolean {
    return this.uncertaintyHeld.has(sessionId);
  }

  recoveryOf(sessionId: string): QueueRecovery[] {
    return structuredClone(this.recoveries.get(sessionId) ?? []);
  }

  private recoveryChanged(sessionId: string): void {
    if (!this.recoveries.get(sessionId)?.length) this.recoveries.delete(sessionId);
    this.hub.emit(sessionId, {
      type: "queue-recovery", batches: this.recoveryOf(sessionId), uncertain: this.queueUncertain(sessionId),
    });
  }

  acknowledgeRecovery(sessionId: string, batchId: string): void {
    const batches = this.recoveries.get(sessionId);
    const batch = batches?.find((b) => b.id === batchId);
    if (!batch) throw new QueueOperationError("missing", "No such recovery batch");
    if (batch.status === "submitting") throw new QueueOperationError("busy", "Submission has not settled");
    this.recoveries.set(sessionId, batches!.filter((b) => b !== batch));
    this.promotionRequested.delete(sessionId);
    this.recoveryChanged(sessionId);
  }

  /** Only queue mutation holds this lock; a running turn does not, so manual
   *  controls stay available while it runs. */
  private async useQueue<T>(
    sessionId: string,
    action: (session: AgentSession) => Promise<T>,
    key: ConversationKey = { channelId: "web", conversationId: sessionId },
  ): Promise<T> {
    if (this.queueOperations.has(sessionId)) throw new QueueOperationError("busy", "Queue operation in progress");
    this.queueOperations.add(sessionId);
    try {
      return await action(await this.ensure(key));
    } finally {
      this.queueOperations.delete(sessionId);
      this.resumePromotion(sessionId);
    }
  }

  async recallQueue(sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
    return this.useQueue(sessionId, async (session) => {
      const held = this.uncertaintyHeld.get(sessionId);
      const queue = await session.clearQueue();
      if (this.uncertaintyHeld.get(sessionId) === held && this.uncertaintyHeld.delete(sessionId)) this.recoveryChanged(sessionId);
      if (queue.steering.length || queue.followUp.length) this.forgetSender(sessionId);
      return queue;
    });
  }

  private checkQueueDrain(): void {
    if (this.draining) throw new QueueOperationError("draining", "Pier is restarting; queued messages were not submitted");
  }

  async deliverQueue(sessionId: string, mode: "steer" | "restart" | "auto"): Promise<string> {
    let retained = false;
    try {
      this.checkQueueDrain();
      return await this.useQueue(sessionId, async (session) => {
        this.checkQueueDrain();
        if (mode === "auto" && (session.state !== "idle" || this.queueUncertain(sessionId) || this.recoveries.get(sessionId)?.length)) return "";
        const held = this.uncertaintyHeld.get(sessionId);
        const queue = await session.clearQueue();
        if (mode !== "auto" && this.uncertaintyHeld.get(sessionId) === held && this.uncertaintyHeld.delete(sessionId)) this.recoveryChanged(sessionId);
        if (!queue.steering.length && !queue.followUp.length) throw new QueueOperationError("empty", "Queue is empty");
        const batch: QueueRecovery = { id: randomUUID(), ...queue, status: "submitting" };
        this.recoveries.set(sessionId, [...(this.recoveries.get(sessionId) ?? []), batch]);
        retained = true;
        this.recoveryChanged(sessionId);
        const text = [...batch.steering, ...batch.followUp].join("\n");
        let invoked = false;
        const failed = (err: unknown): void => {
          this.forgetSender(sessionId);
          this.promotionRequested.delete(sessionId);
          batch.status = invoked ? "uncertain" : "not-submitted";
          if (invoked) this.uncertaintyHeld.set(sessionId, batch.id);
          batch.error = String(err);
          this.recoveryChanged(sessionId);
          this.reportTo(sessionId, `Queue promotion failed (${batch.status}); automatic queue paused, originals remain available in queue recovery: ${String(err)}`);
        };
        try {
          this.checkQueueDrain();
          if (mode === "restart") await this.abort(sessionId);
          this.checkQueueDrain();
          // Not via dispatch: the text was headed at original dispatch, and a
          // second pass could attribute these words to the operator.
          invoked = true;
          const submitted = mode === "steer" && session.state === "streaming"
            ? session.steer(text) : session.prompt(text);
          void submitted.then(() => {
            this.recoveries.set(sessionId, (this.recoveries.get(sessionId) ?? []).filter((b) => b !== batch));
            this.recoveryChanged(sessionId);
          }, failed).finally(() => this.resumePromotion(sessionId));
          return text;
        } catch (err) {
          failed(err);
          throw err;
        }
      }, mode === "auto" ? this.conversationOf(sessionId) : undefined);
    } catch (err) {
      if (!retained && !(err instanceof QueueOperationError && (err.reason === "busy" || err.reason === "empty"))) {
        this.reportTo(sessionId, `Could not promote queued messages: ${String(err)}`);
      }
      throw err;
    }
  }

  /** Only from a queue-state event, never from a turn ending: Pi leaves the
   *  queue alone on `abort()`, so promoting on idle would make /stop start the
   *  very turn it was asked to stop. */
  private promoteQueued(session: AgentSession): void {
    if (session.state !== "idle") return;
    this.promotionRequested.add(session.id);
    this.resumePromotion(session.id);
  }

  private resumePromotion(sessionId: string): void {
    // queue_update precedes the backend's enqueue. Never clear it reentrantly.
    queueMicrotask(() => {
      if (!this.promotionRequested.has(sessionId) || this.queueOperations.has(sessionId)) return;
      // Retained failures require a human decision, not an automatic resend.
      if (this.queueUncertain(sessionId) || this.recoveries.get(sessionId)?.length) return;
      this.promotionRequested.delete(sessionId);
      const attached = this.bySession.get(sessionId);
      if (!attached || attached.session.state !== "idle") return;
      void this.deliverQueue(sessionId, "auto").catch((err: unknown) => {
        // deliverQueue reports failures; empty/busy simply lost the race.
        log.debug(`automatic promotion of ${sessionId} stopped: ${String(err)}`);
      });
    });
  }

  async abort(sessionId: string): Promise<void> {
    this.promotionRequested.delete(sessionId);
    try {
      await this.bySession.get(sessionId)?.session.abort();
    } finally {
      this.promotionRequested.delete(sessionId);
    }
  }

  /** For surfaces that take a prefixed message back out of the context it was
   *  counted into (recalled queue, rewound turn): the tracker means "the model
   *  has been told" (identity.ts), and here it has not. */
  forgetSender(sessionId: string): void {
    this.senders.forget(sessionId);
  }

  /** Refuse new work from every surface; in-flight turns keep running. */
  beginDrain(): void {
    this.draining = true;
  }

  /** The auto-updater closes the gate before handing over; when the handover
   *  never happens, refusing every message forever is the worse outcome. */
  endDrain(): void {
    this.draining = false;
  }

  /** For surfaces that mutate state before dispatching (edit, queue-deliver):
   *  a refused dispatch must not cost a rewound transcript or a cleared queue. */
  isDraining(): boolean {
    return this.draining;
  }

  /** Told to the chat directly (§5): an adapter's dispatch catch only logs. */
  private refuseDraining(key: ConversationKey): void {
    const message = "Pier is restarting — this message was not taken; send it again in a moment.";
    this.channels.get(key.channelId)
      ?.notify(key.conversationId, { text: message, origin: { kind: "error" } })
      .catch((err) => log.error(`could not report the drain to ${key.channelId}`, err));
    throw new Error(message);
  }

  /** Attached sessions still mid-turn — what the drain waits on, and what its
   *  deadline snapshots into the ledger. */
  busy(): { session: AgentSession; key: ConversationKey }[] {
    return [...this.bySession.values()]
      .filter((attached) => attached.session.state === "streaming")
      .map((attached) => ({ session: attached.session, key: attached.key }));
  }

  /** Never creates one: a stop or settings command must not open a session. */
  sessionOf(key: ConversationKey): AgentSession | undefined {
    return this.byKey.get(keyOf(key));
  }

  async abortConversation(key: ConversationKey): Promise<void> {
    const session = this.sessionOf(key);
    if (session) await this.abort(session.id);
  }

  /** Session owning a conversation, resolving and attaching it on first use. */
  async ensure(key: ConversationKey): Promise<AgentSession> {
    let session = this.byKey.get(keyOf(key));
    if (!session && isAlias(key)) {
      session = this.bySession.get(key.conversationId)?.session;
      if (session) this.byKey.set(keyOf(key), session);
    }
    if (!session) {
      const lock = isAlias(key) ? `session:${key.conversationId}` : keyOf(key);
      const inflight = this.opening.get(lock);
      // The first caller attaches before this continuation runs.
      if (inflight) {
        session = await inflight;
        this.byKey.set(keyOf(key), session);
        return this.reached(session, key);
      }
      try {
        // Inside the try: a synchronous throw must report like a rejection.
        const opening = this.resolve(key);
        this.opening.set(lock, opening);
        session = await opening;
      } catch (err) {
        this.unopened(key, err);
        throw err;
      } finally {
        this.opening.delete(lock);
      }
      this.attach(key, session);
    }
    return this.reached(session, key);
  }

  /** A web or task key names the session's own stream; an IM key names a chat
   *  that is waiting. Either way the waiting side is not left with nothing. */
  private unopened(key: ConversationKey, err: unknown): void {
    log.error(`could not open a session for ${keyOf(key)}`, err);
    const message = truncate(`could not open a session: ${String(err)}`);
    if (key.channelId === "web" || key.channelId === "task") {
      this.reportTo(key.conversationId, message);
      return;
    }
    this.channels.get(key.channelId)
      ?.notify(key.conversationId, { text: message, origin: { kind: "error" } })
      .catch((e: unknown) => log.error(`could not report it to ${key.channelId}`, e));
  }

  /** Also where a session learns which alias is current: a task callback
   *  attaches under `task:<id>`, and the workbench's next turn must not still
   *  read as "a task" (web/push.ts). A chat key is never overwritten. */
  private reached(session: AgentSession, key: ConversationKey): AgentSession {
    const attached = this.bySession.get(session.id);
    if (!attached) return session;
    attached.activeAt = Date.now();
    if (isAlias(key) && isAlias(attached.key)) attached.key = key;
    return session;
  }

  async dispatch(msg: InboundMessage): Promise<{ sessionId: string }> {
    // Before ensure — a drain must not open a session — and after, for a
    // dispatch that was inside a slow ensure when the gate closed.
    if (this.draining) this.refuseDraining(msg.key);
    const session = await this.ensure(msg.key);
    if (this.draining) this.refuseDraining(msg.key);
    this.spokenTo?.(session.id);
    const { action, text } = decide(msg, session.state);
    const prompt = withPrefix(this.senders.next(session.id, msg.sender), text);
    log.debug(
      `${action} ${keyOf(msg.key)} → session ${session.id} (${String(prompt.length)} chars)`,
    );
    // A rejected call surfaces on the event stream, never as a throw across the seam.
    session[action](prompt).catch((err) => {
      // The header was counted as delivered above; it never arrived.
      this.senders.forget(session.id);
      this.report(session.id, msg.key, String(err));
    });
    return { sessionId: session.id };
  }
}
