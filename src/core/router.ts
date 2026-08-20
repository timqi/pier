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
      if (payload.type === "turn-end" && payload.text) {
        const channel = this.channels.get(key.channelId);
        if (channel) {
          channel.send(key.conversationId, splitReply(payload.text)).catch((err) => {
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
