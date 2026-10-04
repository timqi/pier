// Normative seam types of the conversation — Channel, AgentSession, its events,
// the chain — THIS FILE is the system contract (docs/architecture.md documents
// the rules around it). Changing a seam is a design decision, not a refactor;
// keep it implementable over RPC (no Pi types may appear here).

/** A conversation is the unit of session routing. */
export interface ConversationKey {
  channelId: string; // "web" | "slack" | "lark"
  conversationId: string; // platform thread/chat id, or web session ui id
}

/**
 * What an assistant turn renders as on any surface: markdown plus the
 * next-step labels the agent offered. Every surface renders the labels as
 * buttons, and a click sends the label as a user reply quoting the message
 * that offered it (`withQuote`, core/identity.ts). Parsed by core/reply.ts — the syntax is
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
  /** The problems the reply's `<open>` markers named, in reply order; absent
   * when none. The home chat keeps the turn's receipts on the first one's item
   * (docs/design/11 §Status). */
  opened?: string[];
}

/** What `openItemsStatus` answers when nothing is open or running. */
export const NOTHING_OPEN = "Nothing open.";

/** The continuous conversation's open items as a chat's status message shows
 *  them: `text` is `/status`'s one string (`NOTHING_OPEN` when empty) and the
 *  plain rendering, `snapshot` the same items structured for a rich one, `items`
 *  each item's `problem` key and its status (tasks/types.ts `OpenStatus`), and
 *  `web` the instance's public address an item links into, absent when none is set. */
export interface OpenItemsView {
  text: string;
  snapshot: OpenItemsSnapshot;
  items: { problem: string; status: string }[];
  web?: string;
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
  /**
   * Set when nothing the agent can run takes this platform's ids — no
   * `pier <platform>` CLI, no mention syntax on the way out. The speaker
   * header then names the person and the platform instead of spending ~40
   * characters a turn on an id nothing can use (`core/identity.ts`).
   */
  readonly opaqueIds?: boolean;
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
   * agent answer a question nobody asked. `text` is the whole text; the
   * adapter decides how much a chat shows.
   */
  notify(
    conversationId: string,
    note: { text: string; origin: NoteOrigin; at?: number },
  ): Promise<void>;
  /**
   * Post the note as a root in the chat's main flow and answer the conversation
   * id of the thread under it, for a child session that waits on the user
   * (docs/design/11 §Child threads). Only the home chat has a main flow; any
   * other chat rejects.
   */
  openThread(chatId: string, note: { text: string; origin: NoteOrigin }): Promise<string>;
  /** Replace the text of the root `openThread` posted: the thread's state, shown where it was opened. */
  editRoot(conversationId: string, note: { text: string; origin: NoteOrigin }): Promise<void>;
  /**
   * Show the open items in the chat's one status message, kept below the
   * adapter's last main-flow post and removed at `NOTHING_OPEN`, and move each
   * message that opened an item to that item's reaction (docs/design/11
   * §Status). Only the home chat has one; any other chat rejects.
   */
  status(chatId: string, view: OpenItemsView): Promise<void>;
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
export interface SystemInputSource extends RunModel {
  /** The task's own name — what the operator called the work. Required: every
   *  run has one, so a source without it is a source with nothing to say. */
  taskName: string;
}

/** What a run worked on, as the run recorded it: the session's model and
 *  level once it opened, the launch's before. `tier` is the menu tier the
 *  launch resolved its model from, absent when the model is not that pin. */
export interface RunModel {
  model?: ModelRef;
  thinking?: ThinkingLevel;
  tier?: ModelTier;
}

export type SystemInputOrigin = {
  kind: "task-delegation" | "task-callback";
  taskId: string;
  runId: string;
  sourceSessionId: string | null;
  /** Batched callback delivery: every run id contained in this input. */
  runIds?: string[];
  source?: SystemInputSource;
  /** How the run ended, on a callback about one run: the card's caption says
   *  it beside the name instead of the reader finding it in the text. */
  state?: BackgroundRun["state"];
  /** Where the run worked, on a callback about one run: the result's relative
   *  paths are relative to it, not to the recipient's cwd. */
  cwd?: string;
} | {
  kind: "task-message";
  taskId: string;
  runId: string;
  sourceSessionId: string;
  messageId: string;
  messageKind: "steer" | "follow_up";
  source?: SystemInputSource;
} | {
  /** What a new session of the continuous conversation opens with: memory,
   *  the run ledger and the previous session's last exchanges (core/chain.ts). */
  kind: "session-seed";
  reason: ChainReason;
  previousSessionId: string | null;
} | {
  /** A turn the stop cut, picked back up at boot (src/stop.ts); the run fields
   *  when the turn was an agent run's, so the card links the run it continues. */
  kind: "restart";
  at: number;
  downMs: number;
  taskId?: string;
  runId?: string;
  sourceSessionId?: string | null;
  source?: SystemInputSource;
} | {
  /** The answer to a chat command the conversation took instead of the model
   *  (core/chain.ts), appended without a turn: the transcript shows it, and it
   *  never reaches the model's context. */
  kind: "chat-command";
  command: ChatCommand;
  /** Run id → session id for legacy `/status` text links. */
  sessions?: Record<string, string>;
  /** `/status` at answer time; replay never recalculates its ages or navigation. */
  statusSnapshot?: OpenItemsSnapshot;
  /** A malformed optional snapshot leaves the original text readable. */
  statusSnapshotError?: string;
};

/** A status row's navigation facts; a design entrance is independent of waiting. */
export interface OpenItemTarget {
  problem: string;
  status: "running" | "queued" | "waiting on you" | "pending release" | "stopped";
  designSessionId?: string;
  waitsIn?: string;
  /** Newest first, by queue time: the first with a session is where the item last happened. */
  runs: { runId: string; targetSessionId: string | null }[];
  /** Unlisted runs and independent sessions open directly, with no topic lookup. */
  direct?: boolean;
}

/** Browser-safe, already worded content shared by IM, live rows and command history. */
export interface OpenItemPresentation extends OpenItemTarget {
  key: string;
  title: string;
  statusLabel: string;
  stage: string;
  metadata: string[];
}

export interface OpenItemsSnapshot {
  version: 1;
  items: OpenItemPresentation[];
}

/** One read produces the compact answer, complete seed and fixed history content. */
export interface OpenItemsStatus {
  text: string;
  seed: string;
  sessions: Record<string, string>;
  snapshot: OpenItemsSnapshot;
}

/** The chat commands, each with the one line the composer's completion shows:
 *  a message to the continuous conversation that is exactly `/<word>` or `%<word>` is a
 *  command, never a message (core/chain.ts). Browser-safe: the composer
 *  lists this table. */
export const CHAT_COMMANDS = {
  status: "what is open — in flight, or waiting on you",
  new: "start a new session now",
  stop: "stop the reply in progress",
  skills: "the skills this session can run, by name",
} as const;

export type ChatCommand = keyof typeof CHAT_COMMANDS;

export const isChatCommand = (v: unknown): v is ChatCommand => typeof v === "string" && Object.hasOwn(CHAT_COMMANDS, v);

/** Why a session joined the continuous conversation's chain: the first one,
 *  the previous one idle past the rotation boundary, the previous one gone,
 *  the previous one's context past the size ceiling, or `/new`. */
export type ChainReason = "first" | "idle" | "lost" | "full" | "new";

/** How long the continuous conversation's head may go without a user message
 *  before the next one starts a new session: the "long" prompt-cache TTL
 *  interactive sessions request, past which the cache is cold anyway. */
export const CHAIN_IDLE_MS = 60 * 60_000;

/** The run ledger's recent window: what `pier task runs` lists by default. */
export const LEDGER_WINDOW_MS = 24 * 60 * 60_000;

/** How large the continuous conversation's head's context may grow before the
 *  next user message starts a new session: past it, a turn costs more than the
 *  rotation's one cache write pays back. */
export const CHAIN_FULL_TOKENS = 60_000;

/** One session of the continuous conversation, as `GET /api/continuous` lists it. */
export interface ChainMember {
  sessionId: string;
  startedAt: number;
  reason: ChainReason;
}

/** Declared here, not in tasks/, because `BackgroundRun`, the `task-status` event core carries, names it.
 *  In order: the Console lists them so, and a worker count reads so. */
export const TASK_RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"] as const;

export type TaskRunState = (typeof TASK_RUN_STATES)[number];

/** One run of the ledger, as `pier task runs` prints it. */
export interface LedgerRun {
  runId: string;
  name: string;
  state: string;
  targetSessionId: string | null;
  cwd: string | null;
  queuedAt: number;
  finishedAt: number | null;
}

/** The `state` of an open item's run token that names no stored run; its `name` is the id. */
export const NOT_IN_LEDGER = "not in the ledger";

export interface BackgroundRun extends RunModel {
  runId: string;
  taskId: string;
  taskName: string;
  state: TaskRunState;
  targetSessionId: string | null;
  /** `"fork"` exists only in stored runs; the timeline prints what it reads. */
  sessionMode: "reuse" | "fresh" | "fork" | null;
  /** What the run was asked to do — the card in the delegating session sits
   *  where the message was sent, so it shows the message. Null when the
   *  action has no text of its own (a task that runs another task). */
  prompt: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** `pier task run --run <id> --after` messages parked on this run, not yet delivered. */
  queuedMessages: number;
  /** The goal this run is a step of, its root run included. */
  goalId?: string;
  /** Launched by Pier itself — its goal's loop, a lead's milestone or design
   *  final — not by a turn of the invoking session. */
  byPier?: boolean;
}

/** Pier's normalized event. The ONLY observability currency in the system. */
export type SessionEventPayload =
  | { type: "turn-start" }
  // A user message entered the model's context: a fresh prompt, a steer, or a
  // queued message the agent just picked up. Clients render it as a user turn.
  | { type: "user-message"; text: string }
  // `at` is the transcript timestamp of the message that opened the turn: the
  // note an adapter posts for this input carries a receipt, and only that
  // timestamp books it to the turn about to answer it (channels/receipts.ts).
  | { type: "system-input"; text: string; origin: SystemInputOrigin; at?: number }
  | { type: "task-status"; run: BackgroundRun }
  | { type: "text-start" } // a new assistant message; prior text is intermediate
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
  // The session named itself (the operator's title model, after the first
  // exchange).
  | { type: "renamed"; title: string }
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
  | { type: "sessions-changed" } // created, renamed, promoted, read → re-list
  | { type: "session-state"; sessionId: string; state: SessionState }
  | { type: "tasks-changed" }
  | { type: "task-run-changed"; taskId: string; runId: string }
  | { type: "task-message-changed"; runId: string; messageId: string }
  | { type: "task-group-changed"; groupId: string }
  | { type: "open-items-changed" }; // a head's turn end wrote an `<open>`/`<done>` marker

/** How much of a tool result any surface ever shows. A transcript replay
 *  carries no more than that: a session's tool output is most of its history
 *  payload, and the bytes past this point were downloaded to be sliced off. */
export const MAX_STEP_OUTPUT = 8_000;

/** How much of a message becomes a title, wherever one is derived: the listing
 *  reading a transcript (agent/listing.ts), the title model's answer
 *  (agent/pi.ts), the fill at first prompt (web/). */
export const SESSION_TITLE_MAX = 80;

/**
 * One step of an assistant turn's activity, reconstructed from the transcript
 * so a reloaded client shows the same Activity group the live stream built.
 * `output` is capped at MAX_STEP_OUTPUT.
 */
export interface ActivityStep {
  kind: "thinking" | "progress" | "tool";
  text?: string; // thinking or intermediate assistant text
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
  /** Assistant turns only: why the turn failed — a provider error, or a prompt
   *  refused before it began (no model, no key). The live `error` event's
   *  durable twin, so a reload still says why nothing was answered. */
  error?: string;
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
  compactAt: number; // where Pi compacts: the window minus this session's reserve
}

/** Backend-neutral model reference. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** The one spelling a model is compared and printed by. */
export const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

/** Every level Pi accepts, in order. The union is derived so the two cannot
 *  drift, and boundary validators use isThinkingLevel instead of their own copy. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (v: unknown): v is ThinkingLevel =>
  typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);

/** The work classes a dispatcher names instead of a model; a tier's menu
 *  entries are tried in order. Here, not in settings.ts, so the browser shares it. */
export const MODEL_TIERS = ["hardest", "balanced", "cheap"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export const isModelTier = (v: unknown): v is ModelTier =>
  typeof v === "string" && (MODEL_TIERS as readonly string[]).includes(v);

/** Core ↔ Pi seam. Must stay implementable over RPC later. */
export interface AgentSession {
  readonly id: string;
  readonly state: SessionState;
  readonly model: ModelRef | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly contextUsage: ContextUsage | undefined;
  /** Completed turns of the transcript's current branch (no partial
   * streaming), those a compaction summarized away included. */
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
  /** The skills Pi loaded for this session: exactly what `/skill:<name>` expands. */
  skills(): { name: string; description: string }[];
  /** Pending queue as-is, for snapshotting a session into a fresh client. */
  pendingQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /** System inputs handed over while the session was streaming and not in the
   * transcript yet. A backend may queue such an input where its own queue
   * readers cannot see it, and a sender that cannot tell "in flight" from
   * "never arrived" re-sends it every sweep until it gives up on a message it
   * delivered several times over. Empty on an idle session: nothing survives a
   * turn, so the sender is free to try again. */
  pendingSystemInputs(): Promise<SystemInputOrigin[]>;
  /** Drop all pending queued messages and return them (for recall-to-composer). */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /**
   * Rewind the transcript to just before the index-th user turn (as counted
   * in history()), dropping it and everything after from the context — the
   * edit-message primitive. The caller re-prompts with the edited text.
   * Rejects while streaming.
   */
  rewindToUserTurn(index: number): Promise<void>;
  /** Resolves when the turn settles; a refusal before the turn (no model, no
   *  key) rejects, and the transcript keeps the message as a failed turn. */
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>; // interrupt mid-run
  followUp(text: string): Promise<void>; // deliver when idle
  /** Persisted non-user input with provenance. Resolves when the turn the input
   * triggers settles — immediately for a queued mode the recipient is already
   * streaming through. Resolution is not an acceptance signal: callers that
   * need "the session took it" must not wait for this promise. `append` starts
   * no turn: the input enters the context and the next prompt carries it, and
   * its `system-input` is emitted at once, a running turn or not. */
  systemInput(text: string, origin: SystemInputOrigin, mode: "prompt" | "steer" | "followUp" | "append"): Promise<void>;
  abort(): Promise<void>;
  /** Emits payloads only; core/hub.ts owns seq/ts stamping. */
  subscribe(fn: (e: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

/** A task-run session's role, kept for the session's life: a feature lead
 *  delegates to workers and opens with the lead contract; a worker never
 *  delegates and opens without the pier-tasks skill (docs/design/10-continuous-session.md). */
export type AgentRole = "lead" | "worker";

/** A lead's phase, the drawer's language-neutral tag: a lead launched with
 *  `launch.design` designs with the user, any other builds. */
export type LeadPhase = "design" | "build";

export interface AgentLaunchOptions {
  cwd: string;
  name?: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  role?: AgentRole;
  /** A lead's, fixed by its creating run: it reads only the contract of that phase. */
  phase?: LeadPhase;
}

/** A session's system prompt as its transcript replays it — the text Pi puts
 *  on the request, not a fresh render from today's files. */
export interface SystemPrompt {
  text: string;
  /** Pi's own estimate: characters / 4. */
  tokens: number;
  /** `text` in order, by where each part came from; section wrappers dropped. */
  blocks: SystemPromptBlock[];
}

export interface SystemPromptBlock {
  /** "Pier baseline", "SYSTEM.md", "Role prompt", a context file's name, "Skills", "Working directory", or Pi's section name. */
  label: string;
  /** The file a context block was read from; `<pier>/…` for Pier's own. */
  path?: string;
  text: string;
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

/** Where a search looks, every field ANDed. */
export interface SearchScope {
  /** Hits at most; the host refuses outside 1–50. */
  limit: number;
  /** ms; only messages at or after it. */
  since?: number;
  role?: "user" | "assistant";
  /** Only these sessions; empty finds nothing. */
  sessions?: string[];
  /** Every session but these; empty excludes none. */
  exclude?: string[];
}

/** One message that matched the query: `text` is the message with chat markup
 *  off, cut to ~600 characters around the first match, `…` at a cut, nothing
 *  marked. `at` names the turn — `ChatTurn.at` for a user turn,
 *  `meta.completedAt` for a reply. */
export interface SearchHit {
  sessionId: string;
  role: "user" | "assistant";
  at: number;
  text: string;
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
  resume(sessionId: string): Promise<AgentSession>;
  list(): Promise<SessionSummary[]>;
  /** One session by id. A miss is checked against disk before it is reported:
   *  every caller reads `undefined` as a fact, and a cached listing is not
   *  evidence that a session does not exist. */
  find(sessionId: string): Promise<SessionSummary | undefined>;
  /** A session's `history()` read off disk without opening it
   *  live; undefined for a session that does not exist. */
  readHistory(sessionId: string): Promise<ChatTurn[] | undefined>;
  /** The system prompt the model has, read off the transcript: undefined for
   *  a session that does not exist, null before any request carried one. */
  readSystemPrompt(sessionId: string): Promise<SystemPrompt | null | undefined>;
  /** Messages that say the query — user messages and replies, never steps —
   *  one hit per message, several from one session alike, ranked best match
   *  then newest. How the text is indexed is the backend's business; core sees
   *  the hits inside `scope`. */
  search(query: string, scope: SearchScope): Promise<SearchHit[]>;
}
