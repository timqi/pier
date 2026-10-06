// One of the two files (with packages.ts) allowed to import @earendil-works/pi-*.
// Implements the AgentFactory/AgentSession seam from src/core/types.ts on the
// Pi SDK. No Pi type may appear in an exported signature.

import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  CredentialSynchronizationError,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
  VERSION,
  type AgentSession as PiAgentSession,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentFactory,
  AgentLaunchOptions,
  AgentRole,
  AgentSession,
  ChatTurn,
  ContextUsage,
  ModelRef,
  SearchHit,
  SearchScope,
  SessionEventPayload,
  SessionState,
  SessionSummary,
  SystemInputOrigin,
  SystemPrompt,
  ThinkingLevel,
  TurnMeta,
} from "../core/types.js";
import type {
  ProviderAuthEvent,
  ProviderAuthPrompt,
  ProviderAuthType,
  ProviderCheck,
  ProviderInfo,
  ProviderManager,
  ProviderSetup,
  WebAuth,
  WebContext,
} from "./types.js";
import { SESSION_TITLE_MAX } from "../core/types.js";
import { logger } from "../log.js";
import { pierPath } from "../paths.js";
import { DISPATCHER, lead, WORKER, WORKER_TOOL_CALLS } from "./roles.js";
import {
  lastAssistant,
  textOf,
  toChatTurns,
  toSessionEvents,
  turnMetaAt,
  type PiEvent,
  type PiMessage,
} from "./events.js";
import { defaultAgentDir, PiConfigStore } from "./config.js";
import { IndexedListing, type SessionListing, type SessionRecord } from "./listing.js";
import type { CredentialStore, ProviderCredential } from "./credentials.js";
import { curateModels, pinFirst } from "./models.js";
import { replaySystemPrompt, type PiSystemMessage } from "./system-prompt.js";

const log = logger("agent");

/** Sessions are grouped by directory, so two names for one directory (a
 *  symlinked home) are two projects. A directory that is gone is still a cwd:
 *  the deepest resolvable ancestor carries the rest of the path. */
const realPaths = new Map<string, string>();
function realPath(cwd: string): string {
  const known = realPaths.get(cwd);
  if (known !== undefined) return known;
  let real = cwd;
  const missing: string[] = [];
  for (let head = cwd; ; ) {
    try {
      real = join(realpathSync(head), ...missing);
      break;
    } catch (err) {
      const parent = dirname(head);
      if (parent === head) {
        log.debug(`cwd ${cwd} has no resolvable ancestor; using it as recorded`, err);
        break;
      }
      missing.unshift(basename(head));
      head = parent;
    }
  }
  realPaths.set(cwd, real);
  return real;
}

const summaryOf = (s: SessionRecord): SessionSummary => ({
  id: s.id,
  cwd: realPath(s.cwd),
  createdAt: s.created,
  modified: s.modified,
  ...(s.title ? { title: s.title } : {}),
});

/** Pi's bash tool has no default timeout, and nobody is watching a scheduled
 *  task. Below the default task-run timeout, so a stuck command comes back as a
 *  tool error instead of killing the run. */
const BASH_DEFAULT_TIMEOUT_SECONDS = 600;

/** Long enough that one workspace event, answered by several surfaces, scans
 *  disk once; short enough that a title no invalidation covers is never stale. */
const LIST_TTL_MS = 3_000;

const PROVIDER_CHECK_TIMEOUT_MS = 20_000;
/** An ordinary budget: a 1-token cap is a request no real turn ever makes. */
const PROVIDER_CHECK_MAX_TOKENS = 8192;
const clip = (text: string): string =>
  text.length > 4000 ? `${text.slice(0, 4000)}\n[… ${text.length - 4000} more characters]` : text;

/** The subject of an exchange is in its opening lines; the answer is one line. */
const TITLE_INPUT_CHARS = 600;
const TITLE_MAX_TOKENS = 40;
const TITLE_TIMEOUT_MS = 20_000;
const TITLE_PROMPT =
  "Name this conversation for a session list. Reply with the title only: at most 12 Chinese characters " +
  "or 6 English words, in the language the user wrote in, no quotes, no trailing period. " +
  "A leading `[name time]` or `[name<id> time]` on the user's message is a speaker header, not content.";

/** The halves are labelled so a reply quoting an instruction back is not
 *  mistaken for one. */
const titleRequest = (first: string, reply: string): string =>
  `${TITLE_PROMPT}\n\n<user>\n${first.slice(0, TITLE_INPUT_CHARS)}\n</user>\n\n<assistant>\n${reply.slice(0, TITLE_INPUT_CHARS)}\n</assistant>`;

/** A provider can decline as a message rather than a throw; only the stop
 *  reason tells that from an answer. */
function textOfAnswer(answer: PiMessage): string {
  if (answer.stopReason === "error" || answer.stopReason === "aborted") {
    throw new Error(answer.errorMessage ?? `the provider stopped: ${answer.stopReason}`);
  }
  return textOf(answer.content).trim();
}

/** Empty is a failure, not a cleared name — the caller reports it. */
export function titleFromAnswer(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.replace(/^["'“‘「]+|["'”’」.。]+$/g, "").trim().slice(0, SESSION_TITLE_MAX);
}

/** The two Communication rules that hold for a reply an agent reads. */
const VERBATIM_RULES = `- Paths, identifiers and quoted output stay verbatim.
- \`path:line\` when you're pointing at one line; the bare path otherwise.`;

const CHAT_RULES = `These rules govern conversational replies. A human reads them on a phone-sized screen, so the cap is about their attention, not about tokens. When the reply is the deliverable — the request names an artifact (report, review, digest, plan) or another agent reads the result (task runs) — the length rules don't apply; the style rules still do.
- Answer with the conclusion. Add the one fact that changes what the user does next — a failure and its cause, an assumption you made, a risk. Trade-offs, process, alternatives: only when asked.
- Cap per reply: 60 words (90 Chinese chars), max 3 bullets; 120 words (180 Chinese chars) when the question asks for reasoning, comparison or options. A command the user is meant to run counts as one line. Don't paste code or diffs to explain — name the file.
- Past the cap by a lot? Conclusion plus one short "want the details?" — don't dump it. Past it by a sentence? Finish the sentence.
${VERBATIM_RULES}
- Never: preamble, restating the question, closing summaries, "I'm going to..." narration, narrating each edit.
- After edits: files touched, result, risk.
- Don't quote code to explain it — no snippets, no walkthroughs. Code the user asked for (a command, a one-liner, a value) is the answer: one block, nothing around it.
- Blocked on a decision only the requester can make? Ask them, one short question. Otherwise pick the sensible default and note it.`;

/** Pier's baseline replaces Pi's generic default; a user's SYSTEM.md follows
 *  it. A worker's replies are read by an agent (roles.ts), so its
 *  Communication holds only the rules that are not about a human's screen. */
const pierBaseline = (role: AgentRole | undefined, codemode = false): string => `You are a general-purpose agent with a live workspace: you can read and change files and run shell commands. Act with expert care — do the work and verify the result.

# Communication
${role === "worker" ? VERBATIM_RULES : CHAT_RULES}

# Working style
- Before touching files: list and search first. Never guess a path or a line number.
- Read before you edit. Match the surrounding code's style, naming, and comment density.
- Do exactly what was asked. No unrequested refactors, no extra files, no README updates.
- Each bash call is a fresh shell in the working directory, the \`<cwd>\` at the end of this prompt.
- Destructive or irreversible actions on things you didn't create — deleting user files, force push, migrations, deploys, service restarts: ask first; unattended, don't do them and report what you would have done. The one exception: a step your prompt names on an \`Approved: <step>\` line was asked and answered — take that step, and only that one.
- Say plainly when something failed, was skipped, or is unverified. Never claim a test passed without running it.${codemode ? WORKER_TOOL_CALLS : ""}`;

export const pierSystemPrompt = (userPrompt?: string, role?: AgentRole, codemode = false): string =>
  userPrompt ? `${pierBaseline(role, codemode)}\n\n${userPrompt}` : pierBaseline(role, codemode);

/** Patching the call keeps the built-in's shell settings. */
const bashTimeoutDefault = (pi: ExtensionAPI) => {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) {
      event.input.timeout = BASH_DEFAULT_TIMEOUT_SECONDS;
    }
  });
};

/** A chat command's answer is the user's to read, not the model's: shown and
 *  kept in the transcript, never sent — neither in a turn's request nor in the
 *  messages compaction summarizes. */
export const chatCommandsOffContext = (pi: ExtensionAPI) => {
  const sent = <T extends { role: string }>(messages: T[]): T[] => messages.filter((m) => !(m.role === "custom"
    && (m as { customType?: unknown }).customType === "pier.system-input"
    && ((m as { details?: unknown }).details as { kind?: unknown } | undefined)?.kind === "chat-command"));
  pi.on("context", (event) => ({ messages: sent(event.messages) }));
  // Pi summarizes the very `preparation` it handed the event, so narrowing it in place is the filter.
  pi.on("session_before_compact", ({ preparation }) => {
    preparation.messagesToSummarize = sent(preparation.messagesToSummarize);
    preparation.turnPrefixMessages = sent(preparation.turnPrefixMessages);
  });
};

/** The transcript's current branch in order, compacted entries included. */
const branchMessages = (sessionManager: SessionManager): PiMessage[] =>
  sessionManager.getBranch().flatMap((entry) => sessionEntryToContextMessages(entry)) as PiMessage[];

/** Where a session compacts — a main session
 *  and a session a run launched from a session made (a lead or a worker, which
 *  never rotate); above 200K input, 1M-context models price higher. */
const MAIN_COMPACTION_CAP = 100_000;
const CHILD_COMPACTION_CAP = 150_000;

/** Read per request by the runtime wrapper in `open()`, so a task can
 *  downgrade the cache TTL after the session is open. */
type CacheRetentionBox = { value: "short" | "long" };

/** Pi builds the system prompt only on `prompt()` and between turns;
 *  `sendCustomMessage({ triggerTurn })` skips it (pi#5581), so a session whose
 *  first turn is a system input would run it with no prompt at all. The
 *  privates that `prompt()` uses (Pi 0.87); gone once Pi prepares a
 *  custom-triggered turn itself. */
type PromptLoadout = {
  _baseSystemPromptOptions: BuildSystemPromptOptions;
  _preparePromptAndToolLoadout(options: BuildSystemPromptOptions): Parameters<SessionManager["appendMessage"]>[0] | undefined;
};

/** At open, not at the first system input: a Pi that dropped the privates
 *  would otherwise run turns with no system prompt (principle 5). */
function assertPromptLoadout(pi: unknown): void {
  const live = pi as Partial<PromptLoadout>;
  if (typeof live._preparePromptAndToolLoadout === "function" && typeof live._baseSystemPromptOptions === "object" && live._baseSystemPromptOptions) return;
  throw new Error(`pi ${VERSION}: prompt loadout shim no longer applies (pi#5581)`);
}

export class PiSession implements AgentSession {
  constructor(
    private readonly pi: PiAgentSession,
    /** Read per call — the menu can change while we run. */
    private readonly pinned: () => ModelRef[] = () => [],
    /** Drops the factory's retained listing: a title lands in exactly the
     *  window it covers, and every surface would keep the old one. */
    private readonly wrote: () => void = () => {},
    private readonly retention: CacheRetentionBox = { value: "long" },
    /** Read per turn: switching auto-titling on takes effect without a restart. */
    private readonly suggestTitle: () => ((first: string, reply: string) => Promise<string>) | undefined = () => undefined,
    /** Auto-compaction triggers once the context passes this many tokens. */
    private readonly cap?: number,
  ) {
    this.applyCap();
  }

  /** A turn started after Pi's dispose runs for real and lands nowhere — no
   *  transcript, no event, a promise that resolves. Refusing makes it a failure (§5). */
  private disposed = false;

  private live(): void {
    if (this.disposed) throw new Error(`session ${this.pi.sessionId} is closed`);
  }

  get id(): string {
    return this.pi.sessionId;
  }

  get state(): SessionState {
    return this.pi.isStreaming ? "streaming" : "idle";
  }

  get model(): ModelRef | undefined {
    const m = this.pi.model;
    return m ? { provider: m.provider, id: m.id } : undefined;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.pi.thinkingLevel;
  }

  get contextUsage(): ContextUsage | undefined {
    const u = this.pi.getContextUsage();
    return u ? { tokens: u.tokens, contextWindow: u.contextWindow, compactAt: u.contextWindow - this.reserve(u.contextWindow) } : undefined;
  }

  async setModel(ref: ModelRef): Promise<void> {
    const m = this.pi.modelRuntime.getModel(ref.provider, ref.id);
    if (!m) {
      const available = (await this.availableModels())
        .slice(0, 8).map((entry) => `${entry.provider}/${entry.id}`).join(", ");
      throw new Error(`unknown model: ${ref.provider}/${ref.id}; available: ${available}`);
    }
    await this.pi.setModel(m);
    // The reserve is per context window, so a cap outlives a model switch only if recomputed.
    this.applyCap();
  }

  async availableModels(): Promise<ModelRef[]> {
    const available = await this.pi.modelRuntime.getAvailable();
    const curated = pinFirst(
      curateModels(
        available.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning })),
      ),
      this.pinned(),
    );
    // The active model must stay selectable even when curation would hide it.
    const current = this.model;
    if (current && !curated.some((m) => m.provider === current.provider && m.id === current.id)) {
      curated.unshift(current);
    }
    return curated;
  }

  availableThinkingLevels(): ThinkingLevel[] {
    return this.pi.getAvailableThinkingLevels();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.pi.setThinkingLevel(level);
  }

  setCacheRetention(retention: "short" | "long"): void {
    this.retention.value = retention;
  }

  private instanceReserve?: number;

  /** Pi compacts past `contextWindow − reserveTokens`; this session's settings
   *  manager is its own, so the override reaches no other session. Never later
   *  than the instance's own reserve. */
  private applyCap(): void {
    const window = this.pi.model?.contextWindow;
    if (this.cap === undefined || !window) return;
    this.pi.settingsManager.applyOverrides({ compaction: { reserveTokens: this.reserve(window) } });
  }

  /** The instance's reserve is read once under a cap, before the first override replaces it. */
  private reserve(window: number): number {
    const settings = this.pi.settingsManager;
    if (this.cap === undefined) return settings.getCompactionSettings().reserveTokens;
    this.instanceReserve ??= settings.getCompactionSettings().reserveTokens;
    return Math.max(window - this.cap, this.instanceReserve);
  }

  skills(): { name: string; description: string }[] {
    return this.pi.resourceLoader.getSkills().skills.map(({ name, description }) => ({ name, description }));
  }

  async pendingQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return {
      steering: [...this.pi.getSteeringMessages()],
      followUp: [...this.pi.getFollowUpMessages()],
    };
  }

  /** A system input handed to a streaming session goes into Pi's *agent*
   *  queue, which `pendingQueue` cannot see; this list is the only thing that
   *  says it exists. */
  private readonly queuedInputs: SystemInputOrigin[] = [];

  async pendingSystemInputs(): Promise<SystemInputOrigin[]> {
    // Pi drains its queue before the turn ends; anything still listed on an
    // idle session was aborted, and calling it queued would leave its sender
    // waiting forever (§5).
    if (!this.pi.isStreaming) this.queuedInputs.length = 0;
    return [...this.queuedInputs];
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    // Not returned (a system input is nobody's draft), but dropped, so its
    // sender stops being told it is on its way.
    this.queuedInputs.length = 0;
    return this.pi.clearQueue();
  }

  async history(): Promise<ChatTurn[]> {
    this.live();
    return toChatTurns(branchMessages(this.pi.sessionManager));
  }

  async rewindToUserTurn(index: number): Promise<void> {
    const total = (await this.history()).filter((t) => t.role === "user").length;
    // End-relative: a user entry toChatTurns would not count cannot shift the target.
    const back = total - index;
    const users = this.pi.sessionManager
      .getBranch()
      .filter((e) => e.type === "message" && e.message.role === "user");
    const target = back >= 1 ? users[users.length - back] : undefined;
    if (!target) throw new Error(`no user turn at index ${index}`);
    // The old branch stays in the file but leaves the context.
    const { cancelled } = await this.pi.navigateTree(target.id);
    if (cancelled) throw new Error("rewind cancelled");
  }

  // Async, so a refusal is a rejected promise the seam lets callers `.catch()`.
  async prompt(text: string): Promise<void> {
    this.live();
    // A turn may have started since the caller read the state. Bare, Pi throws
    // "already processing" and the message is gone (§5); queued, it is the
    // same "delivered when idle" core/queue.ts picks for a mid-turn message.
    // Pi reports only an accepted prompt; a throw before that is a refusal.
    let accepted = false;
    try {
      await this.pi.prompt(text, { streamingBehavior: "followUp", preflightResult: () => { accepted = true; } });
    } catch (error) {
      if (!accepted) this.recordRefusal(text, error);
      throw error;
    }
  }

  /** Pi refuses before writing anything (no model, no key), so without this the
   *  message and its reason would exist only as a live event (§5). Recorded the
   *  way a provider failure is — an errored reply the model's context drops. */
  private recordRefusal(text: string, error: unknown): void {
    const now = Date.now();
    const manager = this.pi.sessionManager;
    manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: now });
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: this.pi.model?.api ?? "",
      provider: this.pi.model?.provider ?? "",
      model: this.pi.model?.id ?? "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: now,
    });
    this.pi.refreshContext();
  }

  async steer(text: string): Promise<void> {
    this.live();
    await this.pi.steer(text);
  }

  async followUp(text: string): Promise<void> {
    this.live();
    await this.pi.followUp(text);
  }

  async systemInput(
    text: string,
    origin: SystemInputOrigin,
    mode: "prompt" | "steer" | "followUp" | "append",
  ): Promise<void> {
    this.live();
    // A running turn means the call below queues.
    const queued = this.pi.isStreaming && mode !== "append";
    if (queued) this.queuedInputs.push(origin);
    else if (mode !== "append") this.loadSystemPrompt();
    else if (this.pi.isStreaming) {
      // Pi records it only after the running turn; a /status answer that waits
      // for the reply it asks about is no answer. Its later message_start is skipped.
      this.shownEarly.add(origin);
      for (const fn of this.listeners) fn({ type: "system-input", text, origin, at: Date.now() });
    }
    try {
      // Without a turn Pi appends it now, or after a running turn's tool results.
      return await this.pi.sendCustomMessage(
        { customType: "pier.system-input", content: text, display: true, details: origin },
        { triggerTurn: mode !== "append", deliverAs: mode === "prompt" || mode === "append" ? undefined : mode },
      );
    } catch (error) {
      // Refused: nothing is in flight. The entry may be gone already.
      const at = this.queuedInputs.indexOf(origin);
      if (at >= 0) this.queuedInputs.splice(at, 1);
      throw error;
    }
  }

  /** What `prompt()` does before a turn: the prompt sections the model does
   *  not have yet, recorded ahead of the turn's own messages. */
  private loadSystemPrompt(): void {
    const pi = this.pi as unknown as PromptLoadout;
    const update = pi._preparePromptAndToolLoadout({ ...pi._baseSystemPromptOptions, selectedTools: this.pi.getActiveToolNames() });
    if (!update) return;
    this.pi.sessionManager.appendMessage(update);
    this.pi.refreshContext();
  }

  abort(): Promise<void> {
    return this.pi.abort();
  }

  /** Every subscriber, for the payloads that start here rather than in Pi. */
  private readonly listeners = new Set<(e: SessionEventPayload) => void>();
  /** Appended inputs already emitted, keyed by the origin Pi carries back as `details`. */
  private readonly shownEarly = new WeakSet<object>();

  subscribe(fn: (e: SessionEventPayload) => void): () => void {
    let retryPending = false;
    this.listeners.add(fn);
    const unsubscribe = this.pi.subscribe((event) => {
      const piEvent = event as PiEvent;
      if (piEvent.type === "agent_end") {
        // Pi's backoff is otherwise silent: a timed-out request reads as a hung reply (§5).
        if (piEvent.willRetry && !retryPending) fn({ type: "error", message: `model request failed (${lastAssistant(piEvent.messages)?.errorMessage || "unknown error"}) — retrying` });
        retryPending = piEvent.willRetry === true;
      }
      if (piEvent.type === "agent_settled" && retryPending) {
        // Aborting Pi during retry backoff produces no final agent_end.
        retryPending = false;
        fn({ type: "turn-end", text: "", meta: this.lastTurnMeta() });
      }
      if (piEvent.type === "message_start" && this.shownEarly.has(piEvent.message?.details as object)) return;
      for (const payload of toSessionEvents(piEvent)) {
        fn(payload.type === "turn-end" ? { ...payload, meta: this.lastTurnMeta() } : payload);
        if (payload.type === "turn-end" && !payload.error) this.autoTitle(payload.text, fn);
      }
    });
    return () => { this.listeners.delete(fn); unsubscribe(); };
  }

  /** Several subscribers see every turn-end; this is what makes the request one. */
  private titleDecided = false;

  /** A failure is announced too: a title that silently stayed the prompt looks
   *  like the setting did nothing (§5). */
  private autoTitle(reply: string, fn: (e: SessionEventPayload) => void): void {
    if (this.titleDecided) return;
    const suggest = this.suggestTitle();
    if (!suggest) return; // off is not decided: switched on later, the next turn still counts
    this.titleDecided = true;
    if (this.pi.sessionManager.getSessionName()) return;
    const users = (this.pi.messages as PiMessage[]).filter((m) => m.role === "user");
    const first = users.length === 1 ? textOf(users[0]?.content) : "";
    if (!first.trim()) return;
    void suggest(first, reply).then(
      (title) => {
        if (this.disposed) return;
        this.pi.sessionManager.appendSessionInfo(title);
        this.wrote();
        fn({ type: "renamed", title });
      },
      (err: unknown) => {
        log.warn(`session ${this.pi.sessionId} could not be titled`, err);
        fn({ type: "error", message: `session title: ${err instanceof Error ? err.message : String(err)} — the first message stays the title` });
      },
    );
  }

  private lastTurnMeta(): TurnMeta | undefined {
    const messages = this.pi.messages as PiMessage[];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return turnMetaAt(messages, i, Date.now());
    }
    return undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pi.dispose();
  }
}

export class PiAgentFactory implements AgentFactory, ProviderManager, WebAuth {
  constructor(
    /** Read per session open, so a Console change reaches the next session
     *  without a restart; appended as a context file so the user's own
     *  instructions still win. */
    private readonly instructions: (role?: AgentRole) => string = () => "",
    /** Loaded per session, never installed into the user's skill directories. */
    private readonly skillPaths: string[] = [],
    /** Optional only for bare test factories; an OAuth refresh persists here,
     *  never to a plaintext auth.json. */
    private readonly credentials?: CredentialStore,
    private readonly providerConfig: PiConfigStore = new PiConfigStore(),
    private readonly pinned: () => ModelRef[] = () => [],
    /** The built-in `pier` package's one switch list: Pier's own skills switched off;
     *  and whether a worker gets Pi's `codemode` tool. */
    private readonly pier: () => { skillsOff: string[]; workerCodemode?: boolean } = () => ({ skillsOff: [] }),
    private readonly titleModel: () => ModelRef | undefined = () => undefined,
    /** Injected so a test needs no session directory or database. */
    private readonly listings: SessionListing = new IndexedListing(),
    /** A reopened session's role and a lead's phase, which only its runs record (tasks/). */
    private readonly roleOf: (sessionId: string) => Pick<AgentLaunchOptions, "role" | "phase"> = () => ({}),
  ) {}

  /** Catalogs are global, not per session. */
  private catalog?: Promise<ModelRuntime>;
  /** A scan stats every session file, which `resume` would otherwise pay on
   *  every cold open. */
  private located = new Map<string, { path: string; cwd: string }>();
  /** Retained for LIST_TTL_MS; one workspace event has three asking surfaces. */
  private listing?: { at: number; infos: Promise<SessionRecord[]> };
  private refreshQueue: Promise<void> = Promise.resolve();
  private builtinProviderIds?: Promise<Set<string>>;

  /** CredentialStore mirrors pi-ai's interface structurally, so no SDK type is exported. */
  private createRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create(this.credentials ? { credentials: this.credentials } : {});
  }

  private authRuntime(): Promise<ModelRuntime> {
    return (this.catalog ??= this.createRuntime());
  }

  private refreshedRuntime(): Promise<ModelRuntime> {
    const result = this.refreshQueue.then(async () => {
      const runtime = await this.authRuntime();
      await runtime.refresh({ allowNetwork: false });
      return runtime;
    });
    this.refreshQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private builtinIds(): Promise<Set<string>> {
    return (this.builtinProviderIds ??= ModelRuntime.create({
      ...(this.credentials ? { credentials: this.credentials } : {}),
      modelsPath: null,
      refreshOnCreate: false,
    }).then((runtime) => new Set(runtime.getProviders().map((provider) => provider.id))));
  }

  async availableModels(): Promise<ModelRef[]> {
    const available = await (await this.refreshedRuntime()).getAvailable();
    return pinFirst(
      curateModels(
        available.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning })),
      ),
      this.pinned(),
    );
  }

  async providers(): Promise<ProviderInfo[]> {
    const [builtinIds, structures] = await Promise.all([
      this.builtinIds(),
      this.providerConfig.providerStructures(),
    ]);
    // After queued config writes settle, so runtime and structure never
    // combine an older catalog with a newer models.json.
    const runtime = await this.refreshedRuntime();
    const stored = new Map((await runtime.listCredentials()).map((c) => [c.providerId, c.type]));
    return runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const methods: ProviderInfo["methods"] = [];
      if (provider.auth.apiKey?.login) {
        methods.push({ type: "api_key", name: provider.auth.apiKey.name });
      }
      if (provider.auth.oauth) {
        methods.push({
          type: "oauth",
          name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
          ...(provider.auth.oauth.isSubscription ? { subscription: true } : {}),
        });
      }
      const credential = stored.get(provider.id);
      const structure = structures[provider.id];
      return {
        id: provider.id,
        name: structure?.name ?? provider.name,
        builtin: builtinIds.has(provider.id),
        methods,
        configured: status.configured,
        ...(status.label ? { source: status.label } : status.source ? { source: status.source } : {}),
        ...(credential ? { stored: credential } : {}),
        ...(structure?.endpoint ? { endpoint: structure.endpoint } : {}),
        ...(structure?.api ? { api: structure.api } : {}),
        ...(structure?.models ? { models: structure.models } : {}),
      };
    });
  }

  /** A fetch of our own records what the provider (or a proxy in front of it)
   *  was actually sent and actually said; a summary would be Pier's word for
   *  someone else's. */
  async check(providerId: string, modelId: string): Promise<ProviderCheck> {
    const started = Date.now();
    const signal = AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS);
    let request = "";
    let body: Promise<string> = Promise.resolve("");
    const recorded: typeof globalThis.fetch = async (input, init) => {
      request = typeof init?.body === "string" ? init.body : "";
      const response = await globalThis.fetch(input, init);
      // Cloned: the SDK still needs the real stream.
      body = response.clone().text().then(clip, () => "");
      return response;
    };
    const answered = (text: string, ok: boolean): ProviderCheck => ({
      ok,
      model: modelId,
      ms: Date.now() - started,
      request: clip(request),
      response: text,
    });
    try {
      const runtime = await this.refreshedRuntime();
      const model = runtime.getModel(providerId, modelId);
      if (!model) throw new Error(`unknown model: ${providerId}/${modelId}`);
      const answer = await runtime.completeSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { maxTokens: PROVIDER_CHECK_MAX_TOKENS, signal, fetch: recorded },
      );
      const text = textOfAnswer(answer as PiMessage);
      return answered(clip(text) || `(no text; stop reason: ${answer.stopReason})`, true);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`provider check failed for ${providerId}/${modelId}`, err);
      const raw = await body;
      return answered(
        signal.aborted
          ? `no answer within ${PROVIDER_CHECK_TIMEOUT_MS / 1000}s (${error})`
          : raw || error,
        false,
      );
    }
  }

  private async suggestTitle(model: ModelRef, first: string, reply: string): Promise<string> {
    const runtime = await this.refreshedRuntime();
    const resolved = runtime.getModel(model.provider, model.id);
    if (!resolved) throw new Error(`title model ${model.provider}/${model.id} is not in the catalog`);
    // Unset means the provider's default, which on gpt-5 is medium and spends
    // the whole output cap thinking. Anthropic's default is off, and any level turns it on.
    const reasoning = resolved.reasoning && resolved.api !== "anthropic-messages" ? "minimal" : undefined;
    const answer = await runtime.completeSimple(
      resolved,
      { messages: [{ role: "user", content: titleRequest(first, reply), timestamp: Date.now() }] },
      { maxTokens: TITLE_MAX_TOKENS, reasoning, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
    );
    const title = titleFromAnswer(textOfAnswer(answer as PiMessage));
    if (!title) throw new Error(`${model.provider}/${model.id} answered with no title`);
    return title;
  }

  async setup(input: ProviderSetup): Promise<void> {
    const builtins = await this.builtinIds();
    if (input.kind === "builtin" && !builtins.has(input.id)) {
      throw new Error(`not a built-in provider: ${input.id}`);
    }
    if (input.kind === "custom" && builtins.has(input.id)) {
      throw new Error(`built-in provider must use built-in setup: ${input.id}`);
    }
    try {
      await this.providerConfig.setupProvider(input, async () => {
        const runtime = await this.refreshedRuntime();
        const error = runtime.getError();
        if (error) throw new Error(error);
        if (!runtime.getProvider(input.id)) throw new Error(`provider did not load: ${input.id}`);
      });
    } catch (err) {
      try {
        await this.refreshedRuntime();
      } catch (refreshErr) {
        log.warn("provider runtime refresh failed after config rollback", refreshErr);
      }
      throw err;
    }
  }

  async login(
    providerId: string,
    type: ProviderAuthType,
    interaction: {
      signal: AbortSignal;
      prompt(prompt: ProviderAuthPrompt): Promise<string>;
      notify(event: ProviderAuthEvent): void;
    },
  ): Promise<() => Promise<void>> {
    const store = this.credentials;
    const previous = await store?.read(providerId);
    const restore = async (committed: ProviderCredential): Promise<void> => {
      if (store && await store.replaceIfCurrent(providerId, committed, previous)) {
        await this.refreshedRuntime();
      }
    };
    try {
      // Sign in with ChatGPT names this installation; Pi keeps the id in settings.json.
      const getDeviceId = () => SettingsManager.create(defaultAgentDir(), defaultAgentDir()).getOrCreateDeviceId();
      const committed = await (await this.authRuntime()).login(providerId, type, interaction, { getDeviceId });
      return () => restore(committed as ProviderCredential);
    } catch (err) {
      if (err instanceof CredentialSynchronizationError && err.credential) {
        try {
          await restore(err.credential as ProviderCredential);
        } catch (rollback) {
          throw new AggregateError([err, rollback], `failed to restore credential for ${providerId}`);
        }
      }
      throw err;
    }
  }

  async logout(providerId: string): Promise<void> {
    await (await this.authRuntime()).logout(providerId, { signal: AbortSignal.timeout(15_000) });
  }

  /** Pi's registry over the shared runtime, so an OAuth refresh lands in the
   *  credential store like every other request's. */
  async webContext(active?: ModelRef): Promise<WebContext> {
    const modelRegistry = new ModelRegistry(await this.refreshedRuntime());
    return { modelRegistry, model: active && modelRegistry.find(active.provider, active.id) };
  }

  private async resourceLoader(cwd: string, { role, phase }: Pick<AgentLaunchOptions, "role" | "phase">, dispatcher: boolean, codemode: boolean): Promise<DefaultResourceLoader> {
    // A worker never delegates (tasks/operations.ts refuses it), so it is not taught how.
    const skillsOff = role === "worker" ? [...this.pier().skillsOff, "pier-tasks"] : this.pier().skillsOff;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: defaultAgentDir(),
      // The user's SYSTEM.md is appended after Pier's baseline, so it still wins.
      systemPromptOverride: (user) => pierSystemPrompt(user, role, codemode),
      additionalSkillPaths: this.skillPaths,
      // Only Pier's own skills answer to the off-list; a user's skill of the
      // same name is Pi's to switch (settings.json).
      skillsOverride: (base) => ({
        ...base,
        skills: base.skills.filter((skill) =>
          !skillsOff.includes(skill.name) || !this.skillPaths.some((dir) => skill.filePath.startsWith(dir + sep))),
      }),
      extensionFactories: [
        { name: "pier-bash-timeout", factory: bashTimeoutDefault, hidden: true },
        { name: "pier-chat-commands", factory: chatCommandsOffContext, hidden: true },
        // Registered inactive; `defaultTools` in openSnapshot switches it on.
        ...(codemode ? [{ name: "codemode", factory: createCodemodeExtension({ models: false }) }] : []),
      ],
      agentsFilesOverride: (current) => {
        const content = this.instructions(role);
        return {
          agentsFiles: [
            ...current.agentsFiles,
            ...(content ? [{ path: "<pier>/AGENTS.md", content }] : []),
            ...(dispatcher ? [{ path: "<pier>/dispatcher.md", content: DISPATCHER }] : []),
            // A lead with no recorded phase builds: `design` is the flagged one.
            ...(role === "lead" ? [{ path: "<pier>/lead.md", content: lead(phase ?? "build") }] : []),
            ...(role === "worker" ? [{ path: "<pier>/worker.md", content: WORKER }] : []),
          ],
        };
      },
    });
    await loader.reload();
    return loader;
  }

  private open(sessionManager: SessionManager, opts: AgentLaunchOptions): Promise<AgentSession> {
    return this.providerConfig.withWrite(() => this.openSnapshot(sessionManager, opts));
  }

  private async openSnapshot(sessionManager: SessionManager, opts: AgentLaunchOptions): Promise<AgentSession> {
    const { cwd, role, phase } = opts;
    // The home is where the continuous conversation's sessions run: only they
    // dispatch, and they compact at main's cap.
    const main = realPath(cwd) === realPath(pierPath("home"));
    const cap = main ? MAIN_COMPACTION_CAP : role ? CHILD_COMPACTION_CAP : undefined;
    // A locked store is a refusal with a reason here, not "provider not
    // configured" later. Before appendSessionInfo, so nothing is written.
    await this.credentials?.assertUnlocked();
    if (opts.name) sessionManager.appendSessionInfo(opts.name);
    // This runtime serves one session, so shadowing streamSimple is the
    // per-session seam for the cache TTL. Default before the spread: compaction
    // passes cacheRetention: "none" and must keep it.
    const runtime = await this.createRuntime();
    const retention: CacheRetentionBox = { value: "long" };
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = ((model, context, options) =>
      stream(model, context, { cacheRetention: retention.value, ...options })) as typeof runtime.streamSimple;
    // Pi defaults to one follow-up per turn boundary, so N queued messages cost
    // N turns. An in-memory override on this session's own manager; Pi reads
    // it at creation, and `setFollowUpMode` would write settings.json.
    const settingsManager = SettingsManager.create(cwd, defaultAgentDir());
    // Only a worker: its result is read by an agent, so a script's batched
    // calls change nothing a person sees.
    const codemode = role === "worker" && this.pier().workerCodemode === true;
    settingsManager.applyOverrides({ followUpMode: "all", ...(codemode ? { defaultTools: ["+codemode"] } : {}) });
    const { session: live } = await createAgentSession({
      cwd,
      sessionManager,
      settingsManager,
      modelRuntime: runtime,
      resourceLoader: await this.resourceLoader(cwd, { role, phase }, main, codemode),
    });
    try {
      assertPromptLoadout(live);
    } catch (error) {
      live.dispose();
      throw error;
    }
    const session = new PiSession(live, this.pinned, () => {
      this.listing = undefined;
    }, retention, () => {
      const model = this.titleModel();
      return model && ((first, reply) => this.suggestTitle(model, first, reply));
    }, cap);
    if (opts.model) await session.setModel(opts.model);
    if (opts.thinking) session.setThinkingLevel(opts.thinking);
    log.info(`session ${session.id} open in ${cwd}${opts.name ? ` (${opts.name})` : ""}`);
    return session;
  }

  async create(opts: AgentLaunchOptions): Promise<AgentSession> {
    this.listing = undefined;
    // Resolved before Pi records it, so every later listing names it the same way.
    const cwd = realPath(opts.cwd);
    return this.open(SessionManager.create(cwd), { ...opts, cwd });
  }

  async resume(sessionId: string): Promise<AgentSession> {
    const role = this.roleOf(sessionId);
    const known = this.located.get(sessionId);
    if (known) {
      try {
        return await this.open(SessionManager.open(known.path), { cwd: known.cwd, ...role });
      } catch (err) {
        log.warn(`cached path for session ${sessionId} did not open; re-listing`, err);
        this.located.delete(sessionId);
      }
    }
    const info = await this.locate(sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    return this.open(SessionManager.open(info.path), { cwd: info.cwd || process.cwd(), ...role });
  }

  /** The one place "no such session" is decided. A retained listing is not
   *  evidence a session is gone, and callers read a miss as permission to start
   *  a replacement, so a miss earns a fresh scan. */
  private async locate(sessionId: string): Promise<SessionRecord | undefined> {
    const find = (infos: SessionRecord[]) => infos.find((s) => s.id === sessionId);
    const reused = this.listing;
    return find(await this.listed()) ??
      (reused && this.listing === reused ? find(await this.listed(true)) : undefined);
  }

  async readHistory(sessionId: string): Promise<ChatTurn[] | undefined> {
    const info = await this.locate(sessionId);
    return info && toChatTurns(branchMessages(SessionManager.open(info.path)));
  }

  /** Off disk for a live session too: Pier is the one writer and Pi appends
   *  each entry as it lands, so the file is the transcript. */
  async readSystemPrompt(sessionId: string): Promise<SystemPrompt | null | undefined> {
    const info = await this.locate(sessionId);
    if (!info) return undefined;
    const { messages } = SessionManager.open(info.path).buildSessionContext();
    // Longest first: the plain worker baseline is a prefix of the codemode one.
    return replaySystemPrompt(messages as PiSystemMessage[], [pierBaseline("worker", true), pierBaseline("worker"), pierBaseline(undefined)]);
  }

  async find(sessionId: string): Promise<SessionSummary | undefined> {
    const info = await this.locate(sessionId);
    return info ? summaryOf(info) : undefined;
  }

  /** agent/listing.ts parses Pi's transcripts itself; only a comparison
   *  notices when that format moves under it. */
  private audited = false;

  private listed(force = false): Promise<SessionRecord[]> {
    const now = Date.now();
    if (!force && this.listing && now - this.listing.at < LIST_TTL_MS) return this.listing.infos;
    const infos = this.listings.scan().then((listed) => {
      for (const s of listed) {
        this.located.set(s.id, { path: s.path, cwd: s.cwd || process.cwd() });
      }
      if (!this.audited && this.listings.audit) {
        this.audited = true;
        void this.listings.audit(() => SessionManager.listAll()).then(
          (wrong) => wrong || log.debug("session index agrees with Pi's own listing"),
          (err: unknown) => log.warn("session index cross-check failed", err),
        );
      }
      return listed;
    });
    // A failed scan is not an answer to hand the next caller for three seconds.
    void infos.catch(() => {
      if (this.listing?.infos === infos) this.listing = undefined;
    });
    this.listing = { at: now, infos };
    return infos;
  }

  async list(): Promise<SessionSummary[]> {
    return (await this.listed()).map(summaryOf);
  }

  /** After a listing, so a transcript that grew is indexed before it is asked about. */
  async search(query: string, scope: SearchScope): Promise<SearchHit[]> {
    await this.listed();
    return this.listings.search?.(query, scope) ?? [];
  }
}
