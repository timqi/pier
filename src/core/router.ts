// Conversation → session routing plus event wiring. In-memory for v1;
// persistence arrives with the scheduler (docs/plans/bootstrap.md step 5).

import { EventHub } from "./hub.js";
import { decide } from "./queue.js";
import type {
  AgentSession,
  Channel,
  ConversationKey,
  InboundMessage,
  SessionState,
} from "./types.js";

function keyOf(key: ConversationKey): string {
  return `${key.channelId}:${key.conversationId}`;
}

export class Router {
  private readonly byKey = new Map<string, AgentSession>();
  private readonly bySession = new Map<
    string,
    { session: AgentSession; key: ConversationKey }
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

  /** Attach an existing session to a conversation and wire its events. */
  attach(key: ConversationKey, session: AgentSession): void {
    this.byKey.set(keyOf(key), session);
    this.bySession.set(session.id, { session, key });
    session.subscribe((payload) => {
      this.hub.emit(session.id, payload);
      if (payload.type === "turn-end" && payload.text) {
        const channel = this.channels.get(key.channelId);
        if (channel) {
          channel.send(key.conversationId, payload.text).catch((err) => {
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

  /** Session owning a conversation, resolving and attaching it on first use. */
  async ensure(key: ConversationKey): Promise<AgentSession> {
    let session = this.byKey.get(keyOf(key));
    if (!session) {
      session = await this.resolve(key);
      this.attach(key, session);
    }
    return session;
  }

  async dispatch(msg: InboundMessage): Promise<{ sessionId: string }> {
    const session = await this.ensure(msg.key);
    const { action, text } = decide(msg, session.state);
    if (action !== "prompt") {
      this.hub.emit(session.id, { type: "queued", mode: action, text });
    }
    // Turn outcomes flow through the event stream; a rejected call surfaces
    // there too, never as a thrown exception across the seam.
    session[action](text, msg.images).catch((err) => {
      this.hub.emit(session.id, { type: "error", message: String(err) });
    });
    return { sessionId: session.id };
  }
}
