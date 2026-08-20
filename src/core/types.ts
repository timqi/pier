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
  // A user message entered the model's context: a fresh prompt, a steer, or a
  // queued message the agent just picked up. Clients render it as a user turn.
  | { type: "user-message"; text: string }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-end"; toolCallId: string; isError: boolean; output: string }
  | { type: "turn-end"; text: string; meta?: TurnMeta } // full assistant text of the turn
  | { type: "state"; state: SessionState }
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

/**
 * Workspace-scoped events: pointers only (which sessions exist, how they are
 * organized, whether they run), never content. Every client keeps its session
 * list in sync from this stream instead of polling; a session's content still
 * comes from that session's own event stream.
 */
export type WorkspaceEvent =
  | { type: "sessions-changed" } // created, pinned/unpinned → re-list
  | { type: "session-state"; sessionId: string; state: SessionState };

/**
 * One step of an assistant turn's activity, reconstructed from the transcript
 * so a reloaded client shows the same Activity group the live stream built.
 */
export interface ActivityStep {
  kind: "thinking" | "tool";
  text?: string; // thinking steps
  toolName?: string; // tool steps
  args?: unknown;
  output?: string;
  isError?: boolean;
}

/** A completed conversation turn, for history rendering. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  meta?: TurnMeta; // assistant turns only
  steps?: ActivityStep[]; // assistant turns only; activity preceding the text
}

/** Completion metadata of an assistant turn (bubble hover hints). */
export interface TurnMeta {
  completedAt: number; // ms epoch
  durationMs: number; // preceding user prompt → completion
  tokens: number; // context size at completion (last usage, never a sum)
}

/** Context-window usage of a live session; unknown before the first turn. */
export interface ContextUsage {
  tokens: number | null; // null right after compaction, before the next response
  contextWindow: number;
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
  readonly contextUsage: ContextUsage | undefined;
  /** Completed turns of the persisted transcript (no partial streaming). */
  history(): Promise<ChatTurn[]>;
  setModel(model: ModelRef): Promise<void>;
  /** Models with configured auth, selectable via setModel. */
  availableModels(): Promise<ModelRef[]>;
  /** Pending queue as-is, for snapshotting a session into a fresh client. */
  pendingQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /** Drop all pending queued messages and return them (for recall-to-composer). */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /**
   * Rewind the transcript to just before the index-th user turn (as counted
   * in history()), dropping it and everything after from the context — the
   * edit-message primitive. The caller re-prompts with the edited text.
   * Rejects while streaming.
   */
  rewindToUserTurn(index: number): Promise<void>;
  prompt(text: string, images?: ImageAttachment[]): Promise<void>; // resolves when the turn settles
  steer(text: string, images?: ImageAttachment[]): Promise<void>; // interrupt mid-run
  followUp(text: string, images?: ImageAttachment[]): Promise<void>; // deliver when idle
  abort(): Promise<void>;
  /** Emits payloads only; core/hub.ts owns seq/ts stamping. */
  subscribe(fn: (e: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

/** Where agent configuration lives: Pi's global dir or a project checkout. */
export type ConfigScope = { kind: "global" } | { kind: "project"; cwd: string };

export type ConfigResourceKind = "extensions" | "skills";

/**
 * Core ↔ agent-config seam: whitelisted file editing plus read-only resource
 * browsing. Changes apply to sessions created afterwards — Pi reads these
 * files at session start, never mid-run.
 */
export interface ConfigStore {
  /** The scope's editable files (fixed whitelist; missing files included). */
  listFiles(scope: ConfigScope): Promise<{ name: string; exists: boolean }[]>;
  /** Whitelisted file content, "" if absent. Secrets arrive masked. */
  readFile(scope: ConfigScope, name: string): Promise<string>;
  /** Masked secrets that come back unchanged keep their stored value. */
  writeFile(scope: ConfigScope, name: string, content: string): Promise<void>;
  /** Relative file paths under each resource dir (read-only surface). */
  listResources(scope: ConfigScope): Promise<Record<ConfigResourceKind, string[]>>;
  readResource(scope: ConfigScope, kind: ConfigResourceKind, name: string): Promise<string>;
}

export interface AgentFactory {
  create(opts: { cwd: string }): Promise<AgentSession>;
  resume(sessionId: string): Promise<AgentSession>;
  list(): Promise<
    { id: string; cwd: string; createdAt: number; title?: string }[]
  >;
}
