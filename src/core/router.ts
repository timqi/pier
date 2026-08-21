// Conversation → session routing plus event wiring. In-memory for v1;
// persistence arrives with task storage (docs/plans/bootstrap.md step 4).

import { EventHub } from "./hub.js";
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

  constructor(
    private readonly hub: EventHub,
    /** Create or resume the session owning a conversation (wired in main.ts). */
    private readonly resolve: (key: ConversationKey) => Promise<AgentSession>,
  ) {}

  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
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
            this.hub.emit(session.id, {
              type: "error",
              message: `outbound to ${key.channelId} failed: ${String(err)}`,
            });
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
    // Turn outcomes flow through the event stream; a rejected call surfaces
    // there too, never as a thrown exception across the seam.
    session[action](text, msg.images).catch((err) => {
      this.hub.emit(session.id, { type: "error", message: String(err) });
    });
    return { sessionId: session.id };
  }
}
