// Normative seam types — THIS FILE is the system contract (docs/architecture.md
// documents the rules around it). Changing a seam is a design decision, not a
// refactor; keep it implementable over RPC (no Pi types may appear here).

/** A conversation is the unit of session routing. */
export interface ConversationKey {
  channelId: string; // "web" | "telegram" | "slack" | "lark"
  conversationId: string; // platform thread/chat id, or web session ui id
}

/** Base64 image payload (no data: URL prefix), IM- and web-friendly. */
export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface InboundMessage {
  key: ConversationKey;
  senderId: string;
  text: string;
  images?: ImageAttachment[];
  /** How to deliver when the agent is busy. "auto" = queue policy decides. */
  mode: "auto" | "steer" | "followUp";
}

/** Platform ↔ core seam. Implemented once per platform, ≤200 lines. */
export interface Channel {
  readonly id: string;
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  /** Render markdown to the platform's format and send it. */
  send(conversationId: string, markdown: string): Promise<void>;
  stop(): Promise<void>;
}

/** Pier's normalized event. The ONLY observability currency in the system. */
export type SessionEventPayload =
  | { type: "turn-start" }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-end"; toolCallId: string; isError: boolean; output: string }
  | { type: "turn-end"; text: string } // full assistant text of the turn
  | { type: "state"; state: SessionState }
  | { type: "queued"; mode: "steer" | "followUp"; text: string }
  // Authoritative pending-queue snapshot (emitted whenever it changes).
  | { type: "queue-state"; steering: string[]; followUp: string[] }
  | { type: "error"; message: string };

/** Stamped by core/hub.ts — seq is per-session monotonic. */
export type SessionEvent = {
  seq: number;
  ts: number;
  sessionId: string;
} & SessionEventPayload;

export type SessionState = "idle" | "streaming";

/** A completed conversation turn, for history rendering. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** Backend-neutral model reference. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** Core ↔ Pi seam. Must stay implementable over RPC later. */
export interface AgentSession {
  readonly id: string;
  readonly state: SessionState;
  readonly model: ModelRef | undefined;
  /** Completed turns of the persisted transcript (no partial streaming). */
  history(): Promise<ChatTurn[]>;
  setModel(model: ModelRef): Promise<void>;
  /** Models with configured auth, selectable via setModel. */
  availableModels(): Promise<ModelRef[]>;
  /** Drop all pending queued messages and return them (for recall-to-composer). */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  prompt(text: string, images?: ImageAttachment[]): Promise<void>; // resolves when the turn settles
  steer(text: string, images?: ImageAttachment[]): Promise<void>; // interrupt mid-run
  followUp(text: string, images?: ImageAttachment[]): Promise<void>; // deliver when idle
  abort(): Promise<void>;
  /** Emits payloads only; core/hub.ts owns seq/ts stamping. */
  subscribe(fn: (e: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentFactory {
  create(opts: { cwd: string }): Promise<AgentSession>;
  resume(sessionId: string): Promise<AgentSession>;
  list(): Promise<
    { id: string; cwd: string; createdAt: number; title?: string }[]
  >;
}
