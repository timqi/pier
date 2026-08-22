// Conversation → session routing plus event wiring. In-memory for v1;
// persistence arrives with task storage (docs/plans/bootstrap.md step 4).

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

/** An error goes into a chat window, so it is trimmed to something readable. */
const truncate = (message: string): string =>
  message.length > 600 ? `${message.slice(0, 600)}…` : message;

function keyOf(key: ConversationKey): string {
  return `${key.channelId}:${key.conversationId}`;
}

export class Router {
  private readonly byKey = new Map<string, AgentSession>();
  private readonly bySession = new Map<
    string,
    { session: AgentSession; key: ConversationKey; stateSince: number }
  >();
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
    this.hub.emit(sessionId, { type: "error", message });
    const channel = this.channels.get(key.channelId);
    // Best-effort and never recursive: if telling the chat also fails, the hub
    // already has the original.
    channel?.notify(key.conversationId, { text: truncate(message), origin: { kind: "error" } })
      .catch((err) => this.hub.emit(sessionId, {
        type: "error",
        message: `could not report the failure to ${key.channelId}: ${String(err)}`,
      }));
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

  /** Attach an existing session to a conversation and wire its events. */
  attach(key: ConversationKey, session: AgentSession): void {
    this.byKey.set(keyOf(key), session);
    const existing = this.bySession.get(session.id);
    if (existing?.session === session) return;
    this.bySession.set(session.id, { session, key, stateSince: Date.now() });
    session.subscribe((payload) => {
      this.hub.emit(session.id, payload);
      // Run state is workspace-visible: every client's session list shows it.
      if (payload.type === "state") {
        const attached = this.bySession.get(session.id);
        if (attached) attached.stateSince = Date.now();
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
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, {
          text: truncate(payload.message),
          origin: { kind: "error" },
        }).catch(() => {});
      }
      // A system input is context the chat did not see being typed. It goes
      // out before the turn it triggers, so the answer has a visible cause.
      if (payload.type === "system-input") {
        const channel = this.channels.get(key.channelId);
        channel?.notify(key.conversationId, { text: payload.text, origin: payload.origin })
          .catch((err) => {
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
        const channel = this.channels.get(key.channelId);
        if (channel) {
          channel.send(key.conversationId, splitReply(payload.text, payload.meta)).catch((err) => {
            this.report(session.id, key, `outbound to ${key.channelId} failed: ${String(err)}`);
          });
        }
      }
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
      session = await this.resolve(key);
      this.attach(key, session);
    }
    return session;
  }

  async dispatch(msg: InboundMessage): Promise<{ sessionId: string }> {
    const session = await this.ensure(msg.key);
    const { action, text } = decide(msg, session.state);
    // A group chat is many people talking into one session; without a speaker
    // line the agent cannot tell them apart or mention anyone back. Emitted
    // only when the speaker or the clock says something new.
    const prompt = withPrefix(this.senders.next(session.id, msg.sender), text);
    // Turn outcomes flow through the event stream; a rejected call surfaces
    // there too, never as a thrown exception across the seam.
    session[action](prompt, msg.images).catch((err) => {
      this.report(session.id, msg.key, String(err));
    });
    return { sessionId: session.id };
  }
}
