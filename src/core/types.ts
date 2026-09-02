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

/**
 * What produced a system input, for the card that renders it: an id says which
 * run, this says what it was. Written into the transcript with the input
 * because a card must not have to fetch a run to name it — and every field is
 * optional: a bash run has no model, a subagent that inherited its effort has
 * no requested level, and an input delivered before this shipped has none of
 * it.
 */
export interface SystemInputSource {
  /** The task's own name — what the operator called the work. Required: every
   *  run has one, so a source without it is a source with nothing to say. */
  taskName: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
}

export type SystemInputOrigin = {
  kind: "task-delegation" | "task-callback";
  taskId: string;
  runId: string;
  sourceSessionId: string | null;
  /** Batched callback delivery: every run id contained in this input. */
  runIds?: string[];
  source?: SystemInputSource;
} | {
  kind: "task-message";
  taskId: string;
  runId: string;
  sourceSessionId: string;
  messageId: string;
  messageKind: "steer" | "follow_up" | "progress" | "decision" | "reply";
  source?: SystemInputSource;
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
  // Full assistant text of the turn, plus how the turn ended: `error` is set
  // when the last assistant message stopped on a provider failure, so a turn
  // with nothing to say is never mistaken for one that chose to say nothing.
  | { type: "turn-end"; text: string; meta?: TurnMeta; error?: string }
  // The context was summarized away and replaced by that summary: the token
  // counts either side of it. Not a `system-input` — nothing entered the
  // model's context, the opposite happened — and the only trace compaction
  // leaves on a surface, because the transcript renders none.
  | { type: "context-compacted"; before: number; after: number }
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

/** How much of a tool result any surface ever shows. A transcript replay
 *  carries no more than that: a session's tool output is most of its history
 *  payload, and the bytes past this point were downloaded to be sliced off. */
export const MAX_STEP_OUTPUT = 8_000;

/**
 * One step of an assistant turn's activity, reconstructed from the transcript
 * so a reloaded client shows the same Activity group the live stream built.
 * `output` is capped at MAX_STEP_OUTPUT.
 */
export interface ActivityStep {
  kind: "thinking" | "tool";
  text?: string; // thinking steps
  id?: string; // tool call id — lets a client resuming mid-turn close the row
  toolName?: string; // tool steps
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** The tool returned. Says so explicitly because `args`/`output` are the
   *  bulk of a transcript and a surface may be handed a step without them:
   *  "no output" then means "not fetched", never "cut short". */
  done?: boolean;
}

/** A completed conversation turn, for history rendering. */
export interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  origin?: SystemInputOrigin; // system inputs only
  meta?: TurnMeta; // assistant turns only
  steps?: ActivityStep[]; // assistant turns only; activity preceding the text
  /** When it arrived, ms epoch — user and system turns, which have no `meta`
   *  to carry it. Absent when Pi stamped the message without one. */
  at?: number;
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
  /** Anthropic prompt-cache TTL for this session's requests: "long" = 1h
   * (interactive chat — turns arrive minutes apart), "short" = 5m (task runs —
   * requests arrive seconds apart, the 1h write premium never pays off).
   * Read per request, so it may change after open; other providers ignore it. */
  setCacheRetention(retention: "short" | "long"): void;
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
  /**
   * Shrink the context: summarize the older transcript and continue from the
   * summary. Backend-neutral — anything that can compact its own context can
   * implement it — and deliberately returns nothing: what happened reaches
   * surfaces as a `context-compacted` event, which auto-compaction emits too
   * and no caller of this method would otherwise ever see.
   */
  compact(): Promise<void>;
  /**
   * Name the session. Persisted in the transcript, not beside it, so every
   * surface and every later listing reads the same title and a restart keeps
   * it. An empty name clears it, and the title then falls back to whatever a
   * listing derives — which is also why nothing comes back: the transcript is
   * the answer, and a second derivation here would be a second rule.
   */
  rename(name: string): Promise<void>;
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

/** What a switch that installs something knows about the thing on disk. */
export interface CatalogBinary {
  /** The `spec = "…"` line of its ubix block. */
  spec: string;
  /** Installed *and* present on disk. A binary the installer records and the
   *  filesystem no longer has is broken, and says so in `error`. */
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Why the state above is not what it should be, when it is not. */
  error: string | null;
}

/**
 * One switch in the Console: something this instance can turn on. Not a
 * `ConfigResource` — it is not a file anyone can open, and its state is an
 * instance setting rather than something on disk.
 *
 * One shape for extensions and command-line tools because they share the whole
 * vocabulary, and `rtk` is the proof: it is an extension *and* a binary. The
 * union is on `source`, which is the question every consumer actually asks —
 * which set the switch writes, and whether there is a version to show — so an
 * extension with a version or a tool without one cannot be spelled at all.
 */
export type CatalogEntry =
  | {
    /** Loaded from inside Pier: nothing is installed, nothing to update. */
    source: "bundled";
    kind: "extension";
    name: string;
    summary: string;
    enabled: boolean;
    /** The tools it adds, and what each needs — which providers an extension
     *  works with is the question asked in front of its switch, and it does
     *  not always have one answer for the whole extension. */
    adds: { name: string; needs: string }[];
  }
  | {
    /** Installed by ubix into Pier's own bin (src/tools.ts). */
    source: "binary";
    /** `extension` when the command *is* an extension (rtk registers its own
     *  Pi extension); `tool` when it is just a command. */
    kind: "extension" | "tool";
    name: string;
    summary: string;
    enabled: boolean;
    binary: CatalogBinary;
    /** A block the operator wrote themselves, and may remove again. */
    custom?: boolean;
  };

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
  /**
   * Whether a session opened now should be given this tool at all. Asked per
   * open; absent means always.
   *
   * A tool nobody configured is not free to leave switched on: its schema and
   * description sit in the prompt of every turn of every session, paid for
   * whether or not it could have answered. `execute` still refuses with a
   * reason — this answer can go stale while a long-lived session is open.
   */
  available?(): boolean;
  /**
   * The bundled skill that documents this tool. It stands down with the tool:
   * a skill's description is resident in every prompt, and one pointing at a
   * tool the session was not given is a route the agent cannot take.
   */
  skill?: string;
}

export interface AgentLaunchOptions {
  cwd: string;
  name?: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  /** When its transcript was last written — the one record of activity that
   *  survives a restart and counts turns this process never saw. Absent only
   *  from a summary that did not come from a listing. */
  modified?: number;
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
  list(): Promise<SessionSummary[]>;
  /**
   * One session by id — the lookup four surfaces were each doing by scanning
   * the whole list for it (a chat's cwd, a task's source or reuse target, a
   * task asking whether a session still exists, a file served out of a
   * session's directory).
   *
   * A miss is checked against disk before it is reported, for the reason
   * `resume` does the same: every caller reads `undefined` as a fact and acts
   * on it — starting a session in the wrong directory, refusing a file,
   * rejecting a task's target — and a listing retained for a few seconds is
   * not evidence that a session does not exist.
   */
  find(sessionId: string): Promise<SessionSummary | undefined>;
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

/**
 * What one probe of a provider answers. Deliberately not part of
 * `ProviderInfo` and stored nowhere: `configured` means a credential exists,
 * this means the endpoint, the credential and a model id actually work
 * together — and that is a fact about a moment, not a state.
 *
 * `request` and `response` are the probe's whole point: a refusal is only
 * useful next to what provoked it, and a proxy in the path can change either.
 * Both are verbatim and both are shown.
 */
export interface ProviderCheck {
  ok: boolean;
  model: string;
  ms: number;
  /** The request body as the provider received it, "" if none was sent. */
  request: string;
  /** The answer's text when there was one, otherwise the refusal verbatim. */
  response: string;
}

/** Core ↔ Pi provider seam: structural setup plus provider-owned auth flows. */
export interface ProviderManager {
  providers(): Promise<ProviderInfo[]>;
  setup(input: ProviderSetup): Promise<void>;
  /** One real request against the provider, on the model the operator picked
   *  — nothing here chooses one, because a probe that answers about a model
   *  nobody named answers nothing. Answers rather than throws: "it does not
   *  work, and here is what it said" is the result, not an exception. */
  check(providerId: string, modelId: string): Promise<ProviderCheck>;
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
