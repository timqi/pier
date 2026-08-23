// Conversation → session routing plus event wiring. In-memory on purpose:
// the durable chat → session map lives in channels/conversations.ts.

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
  SessionState,
} from "./types.js";

const log = logger("core");

/** How long a session may sit idle in memory before it is let go. Generous on
 *  purpose: eviction is a memory measure, and re-opening one costs a Pi
 *  resume plus the transcript being read back. */
const IDLE_TTL_MS = 30 * 60_000;
/** Sweep interval. Nothing here is urgent, so it is coarse. */
const SWEEP_MS = 5 * 60_000;

/** An error goes into a chat window, so it is trimmed to something readable. */
const truncate = (message: string): string =>
  message.length > 600 ? `${message.slice(0, 600)}…` : message;

function keyOf(key: ConversationKey): string {
  return `${key.channelId}:${key.conversationId}`;
}

interface Attached {
  session: AgentSession;
  key: ConversationKey;
  stateSince: number;
  /** Last time this session was reached for or ran a turn — what eviction
   *  ages. Distinct from stateSince, which the UI reads as "idle since". */
  activeAt: number;
  /** Its event subscription, so eviction can stop listening to a disposed
   *  session instead of leaking the closure that holds it. */
  unsubscribe: () => void;
}

export class Router {
  private readonly byKey = new Map<string, AgentSession>();
  private readonly bySession = new Map<string, Attached>();
  /** Resolves in flight, so two surfaces asking at once share one session
   *  object instead of opening a second Pi runtime on the same transcript.
   *  Web and task keys collapse to the session id they both name. */
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly channels = new Map<string, Channel>();
  /** Who each session last heard from, so a header costs tokens only on news. */
  private readonly senders = new SenderPrefix();

  constructor(
    private readonly hub: EventHub,
    /** Create or resume the session owning a conversation (wired in main.ts). */
    private readonly resolve: (key: ConversationKey) => Promise<AgentSession>,
  ) {}

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  /**
   * Tell the conversation something went wrong, then the event stream.
   *
   * Applies to every channel, because the failure mode is the same everywhere:
   * an IM user watching the eyes come off with no reply cannot tell a crash
   * from a deliberate silence, and the operator cannot debug what they never
   * saw. The web reads errors off the hub already, so only a registered channel
   * gets a note; `notify` is used rather than `send` so it is never mistaken
   * for an assistant turn.
   */
  private report(sessionId: string, key: ConversationKey, message: string): void {
    // Three surfaces, one failure: the chat that is waiting, the web timeline,
    // and the log the operator greps once it is reported to them.
    log.error(`${keyOf(key)} session ${sessionId}: ${message}`);
    this.hub.emit(sessionId, { type: "error", message });
    const channel = this.channels.get(key.channelId);
    // Best-effort and never recursive: if telling the chat also fails, the hub
    // already has the original.
    channel?.notify(key.conversationId, { text: truncate(message), origin: { kind: "error" } })
      .catch((err) => {
        log.error(`could not report the failure to ${key.channelId}`, err);
        this.hub.emit(sessionId, {
          type: "error",
          message: `could not report the failure to ${key.channelId}: ${String(err)}`,
        });
      });
  }

  /**
   * Report something that happened *to* a session rather than in it: a task
   * result that could not be delivered, say. Its conversation is told when one
   * is attached — an agent that was promised an answer and a human watching the
   * same thread learn it is not coming from the same place they were waiting.
   * Otherwise the hub carries it for the web timeline.
   */
  reportTo(sessionId: string, message: string): void {
    const key = this.conversationOf(sessionId);
    if (key) this.report(sessionId, key, message);
    else this.hub.emit(sessionId, { type: "error", message });
  }

  /**
   * Let go of every session that has been idle too long, so a process serving
   * IM threads and task runs for weeks does not hold one live Pi runtime per
   * conversation it ever saw. Only the in-memory attachment goes: the durable
   * conversation → session mapping stays, so the next message resumes the very
   * same transcript (channels/conversations.ts).
   *
   * Skipped for anything that would notice: a streaming turn, and a session
   * someone is still watching over SSE.
   */
  async evictIdle(ttlMs = IDLE_TTL_MS, now = Date.now()): Promise<number> {
    let evicted = 0;
    for (const [id, attached] of [...this.bySession]) {
      if (attached.session.state === "streaming") continue;
      if (this.hub.hasSubscribers(id)) continue;
      if (now - attached.activeAt < ttlMs) continue;
      this.bySession.delete(id);
      this.forgetKeys(attached.session);
      attached.unsubscribe();
      this.senders.forget(id);
      this.hub.dropReplay(id);
      evicted += 1;
      log.info(`evicted idle session ${id} (${keyOf(attached.key)})`);
      // Best-effort: a runtime that will not shut down must not keep the
      // sweeper from releasing the rest.
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

  /**
   * Which conversation a session is answering, if any. The inverse of
   * `sessionOf`, and what lets a tool act on "here" — an agent reached through
   * a Slack thread otherwise has no way to name the thread it is replying in.
   * A task or subagent session is attached to nothing and answers undefined.
   */
  conversationOf(sessionId: string): ConversationKey | undefined {
    return this.bySession.get(sessionId)?.key;
  }

  /** Every key that points at this session object. One session can be reached
   *  under more than one — `web:<id>` and `task:<id>` name the same session —
   *  and a key left behind hands out a session that is no longer live. */
  private forgetKeys(session: AgentSession): void {
    for (const [key, held] of this.byKey) if (held === session) this.byKey.delete(key);
  }

  /** Attach an existing session to a conversation and wire its events. */
  attach(key: ConversationKey, session: AgentSession): void {
    const existing = this.bySession.get(session.id);
    if (existing?.session === session) {
      this.byKey.set(keyOf(key), session);
      existing.activeAt = Date.now();
      return;
    }
    if (existing) {
      // Two live objects on one transcript: both would write it and both would
      // answer the chat. Single-flight `ensure` closes the race that makes
      // this, so reaching here is a bug worth seeing — the replaced one is
      // silenced and unreachable, rather than left answering under aliases
      // nobody knows are stale.
      log.warn(`session ${session.id} replaced while attached to ${keyOf(existing.key)}`);
      existing.unsubscribe();
      this.forgetKeys(existing.session);
    }
    this.byKey.set(keyOf(key), session);
    log.info(`attached ${keyOf(key)} → session ${session.id}`);
    const unsubscribe = session.subscribe((payload) => {
      this.hub.emit(session.id, payload);
      // Run state is workspace-visible: every client's session list shows it.
      if (payload.type === "state") {
        const attached = this.bySession.get(session.id);
        // Every turn passes through here, so this is also where a session
        // proves to the sweeper that it is still in use.
        if (attached) attached.stateSince = attached.activeAt = Date.now();
        this.hub.emitWorkspace({
          type: "session-state",
          sessionId: session.id,
          state: payload.state,
        });
      }
      // An error the session itself reported (a tool that threw, a model
      // refusal, a lost connection). Without this it lands only in the web
      // timeline and the IM side goes quiet for no visible reason.
      if (payload.type === "error") {
        log.error(`${keyOf(key)} session ${session.id} reported: ${payload.message}`);
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, {
          text: truncate(payload.message),
          origin: { kind: "error" },
        }).catch((err) => log.error(`notify ${key.channelId} failed`, err));
      }
      // A system input is context the chat did not see being typed. It goes
      // out before the turn it triggers, so the answer has a visible cause.
      if (payload.type === "system-input") {
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, { text: payload.text, origin: payload.origin })
          .catch((err) => {
            log.error(`notify ${key.channelId} failed`, err);
            this.hub.emit(session.id, {
              type: "error",
              message: `notify ${key.channelId} failed: ${String(err)}`,
            });
          });
      }
      // Every turn-end reaches the channel, empty text included: an adapter's
      // per-turn UI (Telegram's 👀 receipts) is retired here, and a turn that
      // settled with nothing to say still has to settle.
      if (payload.type === "turn-end") {
        log.info(
          `turn end ${keyOf(key)} session ${session.id}: ${String(payload.text.length)} chars`,
        );
        const channel = this.channels.get(key.channelId);
        if (channel) {
          channel.send(key.conversationId, splitReply(payload.text, payload.meta)).catch((err) => {
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

  async abort(sessionId: string): Promise<void> {
    await this.bySession.get(sessionId)?.session.abort();
  }

  /**
   * The session already attached to a conversation, if any. Never creates one:
   * a channel's stop or settings command must not be what opens a session.
   */
  sessionOf(key: ConversationKey): AgentSession | undefined {
    return this.byKey.get(keyOf(key));
  }

  async abortConversation(key: ConversationKey): Promise<void> {
    await this.sessionOf(key)?.abort();
  }

  /** Session owning a conversation, resolving and attaching it on first use. */
  async ensure(key: ConversationKey): Promise<AgentSession> {
    let session = this.byKey.get(keyOf(key));
    // Web and task conversation ids are session ids. Reuse an attached
    // instance so two surfaces never open the same Pi transcript twice.
    if (!session && (key.channelId === "web" || key.channelId === "task")) {
      session = this.bySession.get(key.conversationId)?.session;
      if (session) this.byKey.set(keyOf(key), session);
    }
    if (!session) {
      // Aliases share one lock: web:<id> and task:<id> must not each open one.
      const lock = key.channelId === "web" || key.channelId === "task"
        ? `session:${key.conversationId}`
        : keyOf(key);
      const inflight = this.opening.get(lock);
      // A second caller rides the first one's resolve — which attaches before
      // this continuation runs, having awaited it first — and registers its own
      // key against the session that came back.
      if (inflight) {
        session = await inflight;
        this.byKey.set(keyOf(key), session);
        return this.reached(session);
      }
      try {
        // Inside the try: a resolver that throws synchronously is the same
        // failure as one that rejects, and reports the same way.
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
    return this.reached(session);
  }

  /** A session that would not open has no event stream of its own to report on
   *  — unless its id is what we were asked for, which is what a web or task key
   *  is. Otherwise the chat that is waiting is told directly. Callers still get
   *  the rejection; this is only so the waiting side is not left with nothing. */
  private unopened(key: ConversationKey, err: unknown): void {
    log.error(`could not open a session for ${keyOf(key)}`, err);
    const message = truncate(`could not open a session: ${String(err)}`);
    // A web or task key names the session that would not open, so its own
    // stream is where the waiting surface is looking; an IM key names a chat.
    if (key.channelId === "web" || key.channelId === "task") {
      this.reportTo(key.conversationId, message);
      return;
    }
    this.channels.get(key.channelId)
      ?.notify(key.conversationId, { text: message, origin: { kind: "error" } })
      .catch((e: unknown) => log.error(`could not report it to ${key.channelId}`, e));
  }

  /** Reached for, so not idle — every surface that uses a session comes
   *  through `ensure`, including the ones that only read it. */
  private reached(session: AgentSession): AgentSession {
    const attached = this.bySession.get(session.id);
    if (attached) attached.activeAt = Date.now();
    return session;
  }

  async dispatch(msg: InboundMessage): Promise<{ sessionId: string }> {
    const session = await this.ensure(msg.key);
    const { action, text } = decide(msg, session.state);
    // A group chat is many people talking into one session; without a speaker
    // line the agent cannot tell them apart or mention anyone back. Emitted
    // only when the speaker or the clock says something new.
    const prompt = withPrefix(this.senders.next(session.id, msg.sender), text);
    log.debug(
      `${action} ${keyOf(msg.key)} → session ${session.id} (${String(prompt.length)} chars)`,
    );
    // Turn outcomes flow through the event stream; a rejected call surfaces
    // there too, never as a thrown exception across the seam.
    session[action](prompt).catch((err) => {
      this.report(session.id, msg.key, String(err));
    });
    return { sessionId: session.id };
  }
}
