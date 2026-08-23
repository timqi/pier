// Normative seam types — THIS FILE is the system contract (docs/architecture.md
// documents the rules around it). Changing a seam is a design decision, not a
// refactor; keep it implementable over RPC (no Pi types may appear here).

/** A conversation is the unit of session routing. */
export interface ConversationKey {
  channelId: string; // "web" | "telegram" | "slack" | "lark"
  conversationId: string; // platform thread/chat id, or web session ui id
}

/**
 * What an assistant turn renders as on any surface: markdown plus the
 * next-step labels the agent offered. Every surface renders the labels as
 * buttons (web chat now, IM quick replies later) and a click sends the label
 * back as an ordinary user message. Parsed by core/reply.ts — the syntax is
 * never a platform's business.
 */
export interface AgentReply {
  text: string;
  suggestions: string[];
  /**
   * Set when the turn deliberately said nothing (`<silent>`), carrying the
   * reason. Distinguishes a chosen silence from a turn that produced nothing,
   * which look identical on the wire and must not look identical on screen.
   */
  silence?: string;
  /** Completion stats of the turn. Surfaces that cannot hover (IM) render
   * them as a footer; the web shows them on the bubble. */
  meta?: TurnMeta;
}

export interface InboundMessage {
  key: ConversationKey;
  senderId: string;
  /**
   * Who sent it, for the prompt. The adapter resolves the display name because
   * that is platform-specific; core decides whether it is worth the tokens
   * (see `core/identity.ts`). Absent for surfaces with one obvious author.
   */
  sender?: { id: string; name: string };
  /**
   * The prompt, markdown. A file the sender attached arrives as a trailing
   * `[name](file:///abs/path)` line (grammar: core/inbound-file.ts, bytes:
   * core/inbox.ts) — the agent reads it only if it chooses to.
   */
  text: string;
  /** How to deliver when the agent is busy. "auto" = queue policy decides. */
  mode: "auto" | "steer" | "followUp";
}

/** Platform ↔ core seam. Implemented once per platform, ≤200 lines. */
export interface Channel {
  readonly id: string;
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  /**
   * Render the reply (markdown + next-step buttons) and send it. Called on
   * every turn-end, including one whose text is empty — that is the signal a
   * turn settled, and adapters retire per-turn UI (reaction receipts) on it.
   */
  send(conversationId: string, reply: AgentReply): Promise<void>;
  /**
   * Context that entered the session without a human typing it: a task
   * delegation, a callback, a supervisor message. Rendered as a system note,
   * never as an assistant turn — the people in the chat otherwise see the
   * agent answer a question nobody asked.
   */
  notify(conversationId: string, note: { text: string; origin: NoteOrigin }): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Why a note is being posted into a conversation. A system input is one reason;
 * a failure is the other, and it must reach the chat rather than only the web
 * timeline — an IM user who sees the eyes come off with no reply has no way to
 * tell a crash from a deliberate silence.
 */
export type NoteOrigin = SystemInputOrigin | { kind: "error" };

export type SystemInputOrigin = {
  kind: "task-delegation" | "task-callback";
  taskId: string;
  runId: string;
  sourceSessionId: string | null;
  /** Batched callback delivery: every run id contained in this input. */
  runIds?: string[];
} | {
  kind: "task-message";
  taskId: string;
  runId: string;
  sourceSessionId: string;
  messageId: string;
  messageKind: "steer" | "follow_up" | "progress" | "decision" | "reply";
};

export interface BackgroundRun {
  runId: string;
  taskId: string;
  taskName: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";
  targetSessionId: string | null;
  sessionMode: "reuse" | "fresh" | "fork" | null;
  depth: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Pier's normalized event. The ONLY observability currency in the system. */
export type SessionEventPayload =
  | { type: "turn-start" }
  // A user message entered the model's context: a fresh prompt, a steer, or a
  // queued message the agent just picked up. Clients render it as a user turn.
  | { type: "user-message"; text: string }
  | { type: "system-input"; text: string; origin: SystemInputOrigin }
  | { type: "task-status"; run: BackgroundRun }
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
  | { type: "session-state"; sessionId: string; state: SessionState }
  | { type: "tasks-changed" }
  | { type: "task-run-changed"; taskId: string; runId: string }
  | { type: "task-message-changed"; runId: string; messageId: string }
  | { type: "task-group-changed"; groupId: string };

/**
 * One step of an assistant turn's activity, reconstructed from the transcript
 * so a reloaded client shows the same Activity group the live stream built.
 */
export interface ActivityStep {
  kind: "thinking" | "tool";
  text?: string; // thinking steps
  id?: string; // tool call id — lets a client resuming mid-turn close the row
  toolName?: string; // tool steps
  args?: unknown;
  output?: string;
  isError?: boolean;
}

/** A completed conversation turn, for history rendering. */
export interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  origin?: SystemInputOrigin; // system inputs only
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

/** Every level Pi accepts, in order. The union is derived so the two cannot
 *  drift, and boundary validators use isThinkingLevel instead of their own copy. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (v: unknown): v is ThinkingLevel =>
  typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);

/** Core ↔ Pi seam. Must stay implementable over RPC later. */
export interface AgentSession {
  readonly id: string;
  readonly state: SessionState;
  readonly model: ModelRef | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly contextUsage: ContextUsage | undefined;
  /** Completed turns of the persisted transcript (no partial streaming). */
  history(): Promise<ChatTurn[]>;
  setModel(model: ModelRef): Promise<void>;
  /** Models with configured auth, selectable via setModel. */
  availableModels(): Promise<ModelRef[]>;
  availableThinkingLevels(): ThinkingLevel[];
  setThinkingLevel(level: ThinkingLevel): void;
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
  prompt(text: string): Promise<void>; // resolves when the turn settles
  steer(text: string): Promise<void>; // interrupt mid-run
  followUp(text: string): Promise<void>; // deliver when idle
  /** Persisted non-user input with provenance. Resolves when the turn the input
   * triggers settles — immediately for a queued mode the recipient is already
   * streaming through. Resolution is not an acceptance signal: callers that
   * need "the session took it" must not wait for this promise. */
  systemInput(text: string, origin: SystemInputOrigin, mode: "prompt" | "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  /** Emits payloads only; core/hub.ts owns seq/ts stamping. */
  subscribe(fn: (e: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

/** Where agent configuration lives: Pi's global dir or a project checkout. */
export type ConfigScope = { kind: "global" } | { kind: "project"; cwd: string };

export type ConfigResourceKind = "extensions" | "skills";

/**
 * One read-only resource file, by path relative to its resource dir. `link`
 * marks a file reached through a symlink (a skills repo checked out elsewhere
 * is the common case) — surfaces say so instead of pretending it lives here.
 */
export interface ConfigResource {
  name: string;
  link: boolean;
}

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
  /** Compare-and-write when `expected` is present; unchanged masks restore stored secrets. */
  writeFile(scope: ConfigScope, name: string, content: string, expected?: string): Promise<void>;
  /** Absolute path of the global scope's directory — the UI shows where
   *  "Global" actually lives, which moves with PIER_HOME. */
  readonly globalDir: string;
  /** Files under each resource dir, symlinks followed (read-only surface). */
  listResources(scope: ConfigScope): Promise<Record<ConfigResourceKind, ConfigResource[]>>;
  readResource(scope: ConfigScope, kind: ConfigResourceKind, name: string): Promise<string>;
}

/**
 * Backend-neutral custom tool: schema as plain data, owned by the feature
 * that defines the contract (tasks/), translated to the backend by agent/.
 */
export interface AgentCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: object; // JSON Schema
  execute(params: unknown, callerSessionId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentLaunchOptions {
  cwd: string;
  name?: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  capabilities?: "read" | "write";
}

export interface AgentFactory {
  /**
   * Models with configured auth, independent of any session. Session-scoped
   * `availableModels()` cannot answer this: a surface that configures which
   * model a *future* session launches with (IM chats, task definitions) has no
   * session to ask.
   */
  availableModels(): Promise<ModelRef[]>;
  create(opts: AgentLaunchOptions): Promise<AgentSession>;
  fork(sourceSessionId: string, opts: AgentLaunchOptions): Promise<AgentSession>;
  resume(sessionId: string): Promise<AgentSession>;
  list(): Promise<
    { id: string; cwd: string; createdAt: number; title?: string }[]
  >;
}

export type ProviderAuthType = "api_key" | "oauth";
// Wire-protocol names, not SDK types — but they are pi-ai's spellings, and a
// non-Pi backend is bound to them by this seam.
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ProviderApi = typeof PROVIDER_APIS[number];
export const isProviderApi = (value: unknown): value is ProviderApi =>
  typeof value === "string" && (PROVIDER_APIS as readonly string[]).includes(value);

export type ProviderSetup =
  | { kind: "builtin"; id: string; endpoint?: string }
  | {
      kind: "custom";
      id: string;
      name?: string;
      endpoint: string;
      api: ProviderApi;
      models: { id: string; reasoning: boolean }[];
    };

/** The rules of the ProviderSetup seam, in one place: agent/ enforces them on
 *  write and web/ pre-checks them at its HTTP boundary, and neither may import
 *  the other. Throws the message the surface shows. */
export function validateProviderSetup(input: ProviderSetup): void {
  if (input.id.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) {
    throw new Error("invalid provider id");
  }
  if (input.endpoint) {
    if (input.endpoint.length > 2048 || input.endpoint !== input.endpoint.trim()) {
      throw new Error("invalid endpoint");
    }
    validateEndpoint(input.endpoint);
  }
  if (input.kind === "builtin") return;
  if (!input.endpoint) throw new Error("custom provider endpoint required");
  if (input.name && (input.name.length > 200 || input.name !== input.name.trim())) {
    throw new Error("invalid provider name");
  }
  if (!isProviderApi(input.api)) throw new Error("unsupported provider API");
  if (!input.models.length || input.models.length > 100) throw new Error("1-100 models required");
  const ids = input.models.map((model) => model.id);
  if (ids.some((id) => !id || id.length > 200 || id !== id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("model ids must be non-empty, trimmed and unique");
  }
}

export function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("endpoint must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("endpoint must be an http(s) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint must not contain credentials, query or fragment");
  }
}

export type ProviderAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
);

export type ProviderAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface ProviderInfo {
  id: string;
  name: string;
  builtin: boolean;
  methods: { type: ProviderAuthType; name: string; subscription?: boolean }[];
  configured: boolean;
  source?: string;
  stored?: ProviderAuthType;
  endpoint?: string;
  api?: ProviderApi;
  models?: { id: string; reasoning: boolean }[];
}

/** Core ↔ Pi provider seam: structural setup plus provider-owned auth flows. */
export interface ProviderManager {
  providers(): Promise<ProviderInfo[]>;
  setup(input: ProviderSetup): Promise<void>;
  /** Returns a compare-and-restore action until the caller commits setup. */
  login(
    providerId: string,
    type: ProviderAuthType,
    interaction: {
      signal: AbortSignal;
      prompt(prompt: ProviderAuthPrompt): Promise<string>;
      notify(event: ProviderAuthEvent): void;
    },
  ): Promise<() => Promise<void>>;
  logout(providerId: string): Promise<void>;
}
