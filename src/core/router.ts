// Conversation → session routing plus event wiring. In-memory on purpose:
// the durable chat → session map lives in channels/conversations.ts.

import { logger } from "../log.js";
import { EventHub } from "./hub.js";
import { SenderPrefix, withoutLanguage, withPrefix } from "./identity.js";
import { decide } from "./queue.js";
import { cut, splitReply } from "./reply.js";
import { isChatCommand } from "./types.js";
import type {
  AgentSession,
  Channel,
  ConversationKey,
  InboundMessage,
  ModelRef,
  SessionState,
} from "./types.js";

const log = logger("core");

/** Generous: eviction is a memory measure, and re-opening costs a Pi resume
 *  plus a transcript read. */
const IDLE_TTL_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;

function keyOf(key: ConversationKey): string {
  return `${key.channelId}:${key.conversationId}`;
}

/** `web:<id>` and `task:<id>` name one session id and neither is a chat — no
 *  Channel is registered under them — so they share a lock in `ensure`. */
const isAlias = (key: ConversationKey): boolean =>
  key.channelId === "web" || key.channelId === "task";
const webKey = (sessionId: string): ConversationKey => ({ channelId: "web", conversationId: sessionId });

interface Attached {
  session: AgentSession;
  key: ConversationKey;
  /** What eviction ages. */
  activeAt: number;
  /** Bumped with activeAt; the sweep compares it across its await, where a
   *  clock cannot tell a same-millisecond dispatch from none. */
  touched: number;
  /** So eviction stops listening instead of leaking the closure that holds the session. */
  unsubscribe: () => void;
}

export class QueueOperationError extends Error {
  constructor(readonly reason: "busy" | "empty" | "draining", message: string) {
    super(message);
  }
}

/** A message the router did not take and has already told the chat about
 *  (`refuse`): a caller that reports its own failures skips these. */
export class Refused extends Error {}

/** A short skill spelling that names more than one skill: not sent, the chat told. */
export class SkillAmbiguous extends Refused {}

/** `/<word> <rest>` or `%<word> <rest>` (also `/skill:<word>`) resolved to the
 *  one skill `word` is a prefix of — of the name, or of the name after any `-`;
 *  the text unchanged when it names none (docs/design/11-im-conversation.md). */
function skillText(text: string, skills: { name: string }[]): string | SkillAmbiguous {
  // Two characters at least: `/s <text>` is the settings draft's spelling (channels/commands.ts).
  const [, kept, spelled, rest] = /^[/%](skill:)?([^\s/%]{2,})(?:[ \t]+([\s\S]*))?$/i.exec(text.trim()) ?? [];
  const word = spelled?.toLowerCase();
  if (!word || (!kept && isChatCommand(word))) return text;
  const names = skills.map((s) => s.name);
  const found = names.includes(word) ? [word] : names.filter((name) =>
    name.split("-").some((_, i, parts) => parts.slice(i).join("-").startsWith(word)));
  if (found.length > 1) return new SkillAmbiguous(`/${word} matches ${found.join(", ")} — say more`);
  return found[0] ? `/skill:${found[0]}${rest ? ` ${rest}` : ""}` : text;
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
  /** Set by the stop (src/stop.ts): no turn end is delivered or settled from
   *  here on — the boot's resume owns every turn that was running. */
  private stopped = false;
  private turnStarted?: (sessionId: string, key: ConversationKey) => void;
  private turnEnded?: (sessionId: string, text: string) => void;

  constructor(
    private readonly hub: EventHub,
    /** Create or resume the session owning a conversation (wired in main.ts). */
    private readonly resolve: (key: ConversationKey) => Promise<AgentSession>,
    /** The durable chat → session mapping, read before opening: a chat and the
     *  workbench asking for one transcript must share one lock and one object.
     *  Undefined for a chat that has none yet. */
    private readonly sessionIdOf: (key: ConversationKey) => string | undefined = () => undefined,
    /** The inverse: the durable chat of a session an alias is opening, so the
     *  chat is the delivery key from the first turn (wired in main.ts). */
    private readonly chatKeyOf: (sessionId: string) => ConversationKey | undefined = () => undefined,
  ) {}

  /** A session its adapter's stop sent back to its own stream takes its chat again. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    for (const attached of this.bySession.values()) this.toChat(attached);
  }

  /** A stopped adapter's sessions answer on their own stream until it is back:
   *  a key on a dead channel delivers nowhere, and Web Push reads it as a chat's. */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
    for (const key of this.byKey.keys()) if (key.startsWith(`${channelId}:`)) this.byKey.delete(key);
    for (const attached of this.bySession.values()) {
      if (attached.key.channelId === channelId) attached.key = webKey(attached.session.id);
    }
  }

  /** The durable chat outranks the alias that happened to open the session
   *  first (a restart, the web speaking first), same rule as `reached`. */
  private toChat(attached: Attached): void {
    const chat = isAlias(attached.key) ? this.chatKeyOf(attached.session.id) : undefined;
    if (!chat || !this.channels.has(chat.channelId)) return;
    this.hold(chat, attached.session);
    attached.key = chat;
  }

  /** A chat key taken from another session (the chain's rotation) leaves it,
   *  or two sessions would answer one chat. */
  private hold(key: ConversationKey, session: AgentSession): void {
    const previous = this.byKey.get(keyOf(key));
    const left = previous && previous !== session ? this.bySession.get(previous.id) : undefined;
    if (left && keyOf(left.key) === keyOf(key)) left.key = webKey(left.session.id);
    this.byKey.set(keyOf(key), session);
  }

  /** Every attached session's answered turn, runs' and humans' alike; a failed
   *  turn is not one. Registered by the task service (tasks/service.ts). */
  onTurnEnd(listener: (sessionId: string, text: string) => void): void {
    this.turnEnded = listener;
  }

  /** Every attached session's turn as it begins, with the key it will answer
   *  on: the in-flight record (src/stop.ts) is written here, not at the stop. */
  onTurnStart(listener: (sessionId: string, key: ConversationKey) => void): void {
    this.turnStarted = listener;
  }

  /** Delivery and settlement close for the exit; nothing reopens them. */
  stopping(): void {
    this.stopped = true;
  }

  isStopping(): boolean {
    return this.stopped;
  }

  /** A failure reaches the chat as well as the hub (§5): on IM, silence is
   *  indistinguishable from a crash. `notify`, not `send`, so it is never
   *  mistaken for an assistant turn. */
  private report(sessionId: string, key: ConversationKey, message: string): void {
    log.error(`${keyOf(key)} session ${sessionId}: ${message}`);
    this.hub.emit(sessionId, { type: "error", message });
    const channel = this.channels.get(key.channelId);
    // Never recursive: if telling the chat also fails, the hub has the original.
    channel?.notify(key.conversationId, { text: cut(message, 600), origin: { kind: "error" } })
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
   *  streaming turn is never evicted, nor a session holding queued messages:
   *  Pi's queue lives only in the runtime, so disposing it would drop them. */
  async evictIdle(
    ttlMs = IDLE_TTL_MS,
    now = Date.now(),
    { includeWatched = false }: { includeWatched?: boolean } = {},
  ): Promise<number> {
    let evicted = 0;
    // Snapshot: the loop awaits dispose(), and the map may change meanwhile.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, attached] of [...this.bySession]) {
      if (this.queueOperations.has(id) || this.submitting.has(id)) continue;
      if (!includeWatched && this.hub.hasSubscribers(id)) continue;
      if (now - attached.activeAt < ttlMs) continue;
      const touched = attached.touched;
      const queued = await attached.session.pendingQueue();
      // Everything re-read after the await: a dispatch, a queue operation or a
      // replacement may have landed meanwhile, and a prompt already accepted
      // must not run against a disposed session.
      if (this.bySession.get(id) !== attached || attached.touched !== touched || this.queueOperations.has(id)) continue;
      if (attached.session.state === "streaming" || queued.steering.length || queued.followUp.length) continue;
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
      this.hold(key, session);
      this.reached(session, key);
      return;
    }
    if (existing) {
      // Two live objects on one transcript would both write it and both answer
      // the chat; single-flight `ensure` should make this unreachable.
      log.warn(`session ${session.id} replaced while attached to ${keyOf(existing.key)}`);
      existing.unsubscribe();
      this.forgetKeys(existing.session);
      void existing.session.dispose().catch((err) =>
        log.error(`disposing replaced session ${session.id} failed`, err)
      );
    }
    this.hold(key, session);
    log.info(`attached ${keyOf(key)} → session ${session.id}`);
    // Delivery reads `attached.key` live: a chat attaching after the workbench
    // opened the session takes over (`reached`), and the closure must follow.
    const attached: Attached = {
      session,
      key,
      activeAt: Date.now(),
      touched: 0,
      unsubscribe: session.subscribe((payload) => {
        const key = attached.key;
        this.hub.emit(session.id, payload);
        if (payload.type === "state") {
          // Every turn passes here, so it also proves liveness to the sweeper.
          attached.activeAt = Date.now();
          attached.touched += 1;
          this.hub.emitWorkspace({
            type: "session-state",
            sessionId: session.id,
            state: payload.state,
          });
          if (payload.state === "streaming") this.turnStarted?.(session.id, key);
        }
        if (payload.type === "renamed") this.hub.emitWorkspace({ type: "sessions-changed" });
        // Without this a session-reported error lands only in the web timeline
        // and the IM side goes quiet for no visible reason.
        if (payload.type === "error") {
          log.error(`${keyOf(key)} session ${session.id} reported: ${payload.message}`);
          const channel = this.channels.get(key.channelId);
          channel?.notify(key.conversationId, {
            text: cut(payload.message, 600),
            origin: { kind: "error" },
          }).catch((err) => log.error(`notify ${key.channelId} failed`, err));
        }
        // Context the chat did not see typed goes out before the turn it
        // triggers, so the answer has a visible cause. The hub carries it whole.
        if (payload.type === "system-input") {
          const channel = this.channels.get(key.channelId);
          channel?.notify(key.conversationId, {
            text: withoutLanguage(payload.text),
            origin: payload.origin,
            at: payload.at,
          })
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
          if (this.stopped) return;
          if (!payload.error) this.turnEnded?.(session.id, payload.text);
          const channel = this.channels.get(key.channelId);
          if (channel) {
            const reply = splitReply(payload.text, payload.meta);
            this.deliver(session, key, () => channel.send(key.conversationId, reply))
              .catch((err: unknown) => {
                this.report(session.id, key, `outbound to ${key.channelId} failed: ${String(err)}`);
              });
          }
        }
      }),
    };
    this.bySession.set(session.id, attached);
    this.toChat(attached);
  }

  /** An adapter's send is several platform calls (chunks, then attachments),
   *  so two answers left to overlap interleave in the chat. Per conversation:
   *  a slow chat may not hold up another. Also what `busy` counts as still
   *  sending: a finished turn is not delivered until the adapter says so. */
  private readonly delivering = new Map<string, {
    session: AgentSession; key: ConversationKey; settled: Promise<void>;
  }>();

  private deliver(session: AgentSession, key: ConversationKey, send: () => Promise<void>): Promise<void> {
    const id = keyOf(key);
    const pending = this.delivering.get(id)?.settled;
    // The async wrapper turns a synchronous throw into this reply's rejection.
    const done = pending ? pending.then(send) : (async () => send())();
    // A rejection is the caller's to report; inherited, it would fail every
    // later reply to this conversation.
    const settled = done.catch(() => {});
    this.delivering.set(id, { session, key, settled });
    // Only the tail clears the slot — a newer reply owns it by then.
    void settled.then(() => {
      if (this.delivering.get(id)?.settled === settled) this.delivering.delete(id);
    });
    return done;
  }

  private readonly queueOperations = new Set<string>();
  private readonly promotionRequested = new Set<string>();
  // Promotions launched but not settled, per session: automatic promotion
  // waits for them, and eviction must not dispose a preflight.
  private readonly submitting = new Map<string, number>();

  /** Only queue mutation holds this lock; a running turn does not, so manual
   *  controls stay available while it runs. */
  private async useQueue<T>(
    sessionId: string,
    action: (session: AgentSession) => Promise<T>,
    key: ConversationKey = webKey(sessionId),
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
      const queue = await session.clearQueue();
      if (queue.steering.length || queue.followUp.length) this.forgetSender(sessionId);
      return queue;
    });
  }

  private checkQueueDrain(): void {
    if (this.draining) throw new QueueOperationError("draining", "Pier is restarting; queued messages were not submitted");
  }

  /** Once cleared, the originals exist only here: a failure hands them back
   *  to the conversation with the error, and nothing is kept for a resend. */
  async deliverQueue(sessionId: string, mode: "steer" | "restart" | "auto"): Promise<string> {
    let cleared = false;
    try {
      this.checkQueueDrain();
      return await this.useQueue(sessionId, async (session) => {
        this.checkQueueDrain();
        if (mode === "auto" && session.state !== "idle") return "";
        const queue = await session.clearQueue();
        if (!queue.steering.length && !queue.followUp.length) throw new QueueOperationError("empty", "Queue is empty");
        cleared = true;
        const text = [...queue.steering, ...queue.followUp].join("\n");
        const failed = (err: unknown): void => {
          this.forgetSender(sessionId);
          this.promotionRequested.delete(sessionId);
          this.reportTo(sessionId, `Queued messages were not delivered — send them again: ${String(err)}\n\n${text}`);
        };
        try {
          this.checkQueueDrain();
          if (mode === "restart") await this.abort(sessionId);
          this.checkQueueDrain();
          // Not via dispatch: the text was headed at original dispatch, and a
          // second pass could attribute these words to the operator.
          const submitted = mode === "steer" && session.state === "streaming"
            ? session.steer(text) : session.prompt(text);
          this.submitting.set(sessionId, (this.submitting.get(sessionId) ?? 0) + 1);
          void submitted.catch(failed).finally(() => {
            const left = this.submitting.get(sessionId)! - 1;
            if (left) this.submitting.set(sessionId, left);
            else this.submitting.delete(sessionId);
            this.resumePromotion(sessionId);
          });
          return text;
        } catch (err) {
          failed(err);
          throw err;
        }
      }, mode === "auto" ? this.conversationOf(sessionId) : undefined);
    } catch (err) {
      if (!cleared && !(err instanceof QueueOperationError && (err.reason === "busy" || err.reason === "empty"))) {
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
      if (!this.promotionRequested.has(sessionId) || this.queueOperations.has(sessionId) || this.submitting.has(sessionId)) return;
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
  private refuse(key: ConversationKey, err: Error): never {
    this.channels.get(key.channelId)
      ?.notify(key.conversationId, { text: err.message, origin: { kind: "error" } })
      .catch((e: unknown) => log.error(`could not report the refusal to ${key.channelId}`, e));
    throw err;
  }

  private refuseDraining(key: ConversationKey): never {
    this.refuse(key, new Refused("Pier is restarting — this message was not taken; send it again in a moment."));
  }

  /** Attached sessions still mid-turn, and conversations whose answer is still
   *  going out (`sending`) — what the drain waits on, and what its deadline
   *  writes into the ledger. */
  busy(): { session: AgentSession; key: ConversationKey; sending?: true }[] {
    return [
      ...[...this.bySession.values()]
        .filter((attached) => attached.session.state === "streaming")
        .map((attached) => ({ session: attached.session, key: attached.key })),
      ...[...this.delivering.values()]
        .map(({ session, key }) => ({ session, key, sending: true as const })),
    ];
  }

  /** Every attached session, mid-turn or not — what the drain snapshots: Pi's
   *  queue lives only in the runtime, so an idle session's queued messages die
   *  with the process just the same. */
  attachedSessions(): { session: AgentSession; key: ConversationKey }[] {
    return [...this.bySession.values()].map(({ session, key }) => ({ session, key }));
  }

  /** Never creates one: a stop or settings command must not open a session. */
  sessionOf(key: ConversationKey): AgentSession | undefined {
    return this.byKey.get(keyOf(key));
  }

  async abortConversation(key: ConversationKey): Promise<void> {
    const session = this.sessionOf(key);
    if (session) await this.abort(session.id);
  }

  /** Session owning a conversation, resolving and attaching it on first use.
   *  One object per session id whichever key asks first: an IM key is looked up
   *  to its session id so it shares the lock with `web:`/`task:` aliases. */
  async ensure(key: ConversationKey): Promise<AgentSession> {
    let session = this.byKey.get(keyOf(key));
    if (session) return this.reached(session, key);
    const id = isAlias(key) ? key.conversationId : this.sessionIdOf(key);
    session = id === undefined ? undefined : this.bySession.get(id)?.session;
    if (!session) {
      const lock = id === undefined ? keyOf(key) : `session:${id}`;
      const inflight = this.opening.get(lock);
      if (inflight) {
        session = await inflight;
      } else {
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
      }
    }
    // Attaches fresh, or adds this key to the object already attached.
    this.attach(key, session);
    return session;
  }

  /** A web or task key names the session's own stream; an IM key names a chat
   *  that is waiting. Either way the waiting side is not left with nothing. */
  private unopened(key: ConversationKey, err: unknown): void {
    log.error(`could not open a session for ${keyOf(key)}`, err);
    const message = cut(`could not open a session: ${String(err)}`, 600);
    if (key.channelId === "web" || key.channelId === "task") {
      this.reportTo(key.conversationId, message);
      return;
    }
    this.channels.get(key.channelId)
      ?.notify(key.conversationId, { text: message, origin: { kind: "error" } })
      .catch((e: unknown) => log.error(`could not report it to ${key.channelId}`, e));
  }

  /** Also where a session learns which key is current: a task callback
   *  attaches under `task:<id>`, and the workbench's next turn must not still
   *  read as "a task" (web/push.ts). A chat outranks an alias — the workbench
   *  may have opened the session, but its turns are answered in the chat — and
   *  an alias never overwrites a chat. */
  private reached(session: AgentSession, key: ConversationKey): AgentSession {
    const attached = this.bySession.get(session.id);
    if (!attached) return session;
    attached.activeAt = Date.now();
    attached.touched += 1;
    if (!isAlias(key) || isAlias(attached.key)) attached.key = key;
    return session;
  }

  async dispatch(msg: InboundMessage): Promise<{ sessionId: string }> {
    // Before ensure — a drain must not open a session — and after, for a
    // dispatch that was inside a slow ensure when the gate closed.
    if (this.draining) this.refuseDraining(msg.key);
    const session = await this.ensure(msg.key);
    if (this.draining) this.refuseDraining(msg.key);
    const skilled = skillText(msg.text, session.skills());
    if (skilled instanceof SkillAmbiguous) this.refuse(msg.key, skilled);
    const { action, text } = decide({ ...msg, text: skilled }, session.state);
    // A chat is named so the agent can hand it to a script (skills/pier-slack);
    // an alias names nothing a shell could reach.
    const where = isAlias(msg.key) ? undefined : keyOf(msg.key);
    const opaque = this.channels.get(msg.key.channelId)?.opaqueIds;
    const header = this.senders.next(session.id, msg.sender, Date.now(), where, opaque, text);
    // Pi expands `/skill:<name>` only at the very start, so a header rides in its args.
    const skill = header ? /^\/skill:\S+/.exec(text)?.[0] : undefined;
    const prompt = skill ? `${skill} ${withPrefix(header, text.slice(skill.length).trimStart())}` : withPrefix(header, text);
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
