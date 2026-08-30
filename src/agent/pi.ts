// The only file outside src/extensions allowed to import @earendil-works/pi-*.
// Implements the AgentFactory/AgentSession seam from src/core/types.ts on the
// Pi SDK. No Pi type may appear in an exported signature.

import {
  createAgentSession,
  CredentialSynchronizationError,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession as PiAgentSession,
  type Extension,
  type ExtensionAPI,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  AgentCustomTool,
  AgentFactory,
  AgentLaunchOptions,
  AgentSession,
  ChatTurn,
  ContextUsage,
  ModelRef,
  ProviderAuthEvent,
  ProviderAuthPrompt,
  ProviderAuthType,
  ProviderCheck,
  ProviderInfo,
  ProviderManager,
  ProviderSetup,
  SessionEventPayload,
  SessionState,
  SessionSummary,
  SystemInputOrigin,
  ThinkingLevel,
  TurnMeta,
} from "../core/types.js";
import { inlineExtensions } from "../extensions/index.js";
import { logger } from "../log.js";
import {
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

const log = logger("agent");

/** A listed record as the seam reports it. The one mapping, because `list` and
 *  `find` answer with the same shape and drifting would mean two answers about
 *  one session. */
const summaryOf = (s: SessionRecord): SessionSummary => ({
  id: s.id,
  cwd: s.cwd,
  createdAt: s.created,
  modified: s.modified,
  ...(s.title ? { title: s.title } : {}),
});

type SessionInfos = SessionRecord[];

/** Pi's bash tool has no default timeout, so a hung command holds the turn
 * until someone aborts it — nobody is watching in a scheduled task. Kept below
 * the default task-run timeout so a stuck command comes back as
 * a tool error the agent can retry with an explicit longer timeout, instead of
 * killing the whole run. */
const BASH_DEFAULT_TIMEOUT_SECONDS = 600;

/** How long a session listing stays usable: long enough that one workspace
 *  event, which several surfaces answer at once, scans disk once; short enough
 *  that a title no invalidation covers is never stale on screen. */
const LIST_TTL_MS = 3_000;

/** A probe nobody is watching is a hung page: the Console waits on this. */
const PROVIDER_CHECK_TIMEOUT_MS = 20_000;
/** An ordinary budget, not a token: a 1-token cap is a request no real turn
 *  ever makes, and answers about it are answers about a different request. */
const PROVIDER_CHECK_MAX_TOKENS = 8192;
/** Neither half of a probe is worth more than a screen. */
const clip = (text: string): string =>
  text.length > 4000 ? `${text.slice(0, 4000)}\n[… ${text.length - 4000} more characters]` : text;

/** Pier's baseline replaces Pi's generic default; a user's SYSTEM.md follows it. */
const PIER_SYSTEM_PROMPT = `You are a general-purpose agent with a live workspace: you can read and change files and run shell commands. Act with expert care — do the work, verify results, and state what you could not check.

# Communication
These rules govern conversational replies. When the reply *is* the deliverable — a report that was asked for, a review, a task run whose result another agent reads — the work sets the length: complete beats brief, and nothing below caps it.
- Answer with the conclusion only. Reasons, process, trade-offs, alternatives: only when asked.
- Cap per reply: 60 words (90 Chinese chars), max 3 bullets; 180 words (270 Chinese chars) when explicitly asked why or how. Code blocks, diffs and commands don't count.
- Reply in the language of the request; code, paths, identifiers and quoted output stay verbatim.
- Never: preamble, restating the question, closing summaries, "I'm going to..." narration, listing changes already visible in the diff.
- After edits, say only: file(s) touched + one line on the result. Don't explain self-evident code.
- Show file paths as \`path:line\`, or the path alone when no single line is the point — never invent a number.
- If the honest answer needs more than the cap, give the conclusion plus one short "want the details?" — don't dump it.
- Blocked on a decision only the person you work for can make? Ask one short question. Otherwise pick the sensible default and note it.

# Working style (any machine)
These hold wherever Pier runs; a user's SYSTEM.md adds the local ones (which tools exist, which hosts, which paths).
- Orient first — list and search before you act. Never guess a path.
- Read before you edit. Match the surrounding code's style, naming, and comment density.
- Do exactly what was asked. No unrequested refactors, no extra files, no README updates.
- Destructive or irreversible actions (rm, force push, migrations, deploys): ask first.
- Say plainly when something failed, was skipped, or is unverified. Never claim a test passed without running it.
- Every bash call already runs in the working directory this prompt names — don't prefix \`cd <cwd> &&\`, \`cd\` only to go somewhere else. Each call is a fresh shell: \`cd\`, \`export\`, \`source\` never carry over, so chain what must share state into one command.`;

export const pierSystemPrompt = (userPrompt?: string): string =>
  userPrompt ? `${PIER_SYSTEM_PROMPT}\n\n${userPrompt}` : PIER_SYSTEM_PROMPT;

/** Patching the call is cheaper than replacing the tool: the built-in keeps its
 * shell settings, and the agent spends no tokens deciding a timeout. */
const bashTimeoutDefault = (pi: ExtensionAPI) => {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) {
      event.input.timeout = BASH_DEFAULT_TIMEOUT_SECONDS;
    }
  });
};

/**
 * A bundled extension stands down when a copy on disk already registers one of
 * its tools. Pi loads both and reports the clash as a diagnostic nobody reads,
 * leaving two tools of the same name and no way to tell which one answered;
 * the copy the user put there wins, and the journal says so (§5b).
 */
export const standDownShadowed = (base: LoadExtensionsResult): LoadExtensionsResult => {
  const inline = (ext: Extension): boolean => ext.path.startsWith("<inline:");
  const onDisk = new Set(
    base.extensions.filter((ext) => !inline(ext)).flatMap((ext) => [...ext.tools.keys()]),
  );
  if (!onDisk.size) return base;
  return {
    ...base,
    extensions: base.extensions.filter((ext) => {
      const clash = inline(ext) && [...ext.tools.keys()].filter((tool) => onDisk.has(tool));
      if (!clash || !clash.length) return true;
      log.info(`bundled ${ext.path} stood down — ${clash.join(", ")} already loaded from disk`);
      return false;
    }),
  };
};

/** Shared with the runtime wrapper in `open()`, which reads it per request —
 *  so tasks can downgrade a session's cache TTL after it is already open. */
type CacheRetentionBox = { value: "short" | "long" };

export class PiSession implements AgentSession {
  constructor(
    private readonly pi: PiAgentSession,
    /** Operator pins, read per call — the menu can change while we run. */
    private readonly pinned: () => ModelRef[] = () => [],
    /** "What I just wrote is not in your listing yet." The factory retains a
     *  scan for a few seconds, which is exactly the window a rename lands in:
     *  every surface would re-read the old title and keep it until some
     *  unrelated event moved the list again. Same drop `create` and `fork`
     *  do — a callback only because the session is what knows it happened. */
    private readonly wrote: () => void = () => {},
    private readonly retention: CacheRetentionBox = { value: "long" },
  ) {}

  /** Pi's dispose unhooks the one listener that persists and emits, so a turn
   *  started after it runs for real — model call, tools and all — and lands
   *  nowhere: no transcript entry, no event, and a promise that resolves as if
   *  it worked. Refusing is what turns that silence into the failure it is;
   *  callers already report or retry a rejection (§5b). */
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
    return u ? { tokens: u.tokens, contextWindow: u.contextWindow } : undefined;
  }

  async setModel(ref: ModelRef): Promise<void> {
    const m = this.pi.modelRuntime.getModel(ref.provider, ref.id);
    if (!m) {
      // Lazy discovery: the failure itself documents what is selectable.
      const available = (await this.availableModels())
        .slice(0, 8).map((entry) => `${entry.provider}/${entry.id}`).join(", ");
      throw new Error(`unknown model: ${ref.provider}/${ref.id}; available: ${available}`);
    }
    await this.pi.setModel(m);
  }

  async availableModels(): Promise<ModelRef[]> {
    const available = await this.pi.modelRuntime.getAvailable();
    const curated = pinFirst(
      curateModels(
        available.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning })),
      ),
      this.pinned(),
    );
    // The session's active model must stay selectable even when curation
    // (or an older catalog) would hide it.
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

  async pendingQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return {
      steering: [...this.pi.getSteeringMessages()],
      followUp: [...this.pi.getFollowUpMessages()],
    };
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.pi.clearQueue();
  }

  async history(): Promise<ChatTurn[]> {
    this.live();
    return toChatTurns(this.pi.messages as PiMessage[]);
  }

  async rewindToUserTurn(index: number): Promise<void> {
    const total = (await this.history()).filter((t) => t.role === "user").length;
    // Anchor at the tail: branch entries keep compacted-away history that
    // history() no longer shows, so only end-relative indices line up.
    const back = total - index;
    const users = this.pi.sessionManager
      .getBranch()
      .filter((e) => e.type === "message" && e.message.role === "user");
    const target = back >= 1 ? users[users.length - back] : undefined;
    if (!target) throw new Error(`no user turn at index ${index}`);
    // navigateTree on a user message moves the leaf to its parent — the old
    // branch stays in the file but leaves the context.
    const { cancelled } = await this.pi.navigateTree(target.id);
    if (cancelled) throw new Error("rewind cancelled");
  }

  /** The compaction running right now, or null. Pi keeps no lock of its own —
   *  a second `compact()` aborts the first's turn and summarizes a transcript
   *  that is being replaced under it — and two POSTs a millisecond apart both
   *  pass the route's idle check, so the gate has to be here. */
  private compacting: Promise<void> | null = null;

  /** Pi's own compaction, minus its `CompactionResult`: the numbers reach
   *  surfaces as the `context-compacted` event the seam already emits for the
   *  automatic one, so a caller has nothing to do with them. Refused while one
   *  is running, rather than run twice over one context. */
  async compact(): Promise<void> {
    this.live();
    if (this.compacting) throw new Error(`session ${this.pi.sessionId} is already compacting`);
    // Started and recorded in the same tick, with no await between: that is
    // what makes the check above a gate and not a hint.
    const running = this.pi.compact().then(() => undefined);
    this.compacting = running;
    try {
      await running;
    } finally {
      this.compacting = null;
    }
  }

  /** One `session_info` entry, which Pi's own reader takes the latest of — so
   *  a rename is an append like everything else in a transcript, and nothing
   *  has to be rewritten. Never refused for being busy: a name has nothing to
   *  do with the turn running.
   *
   *  Returns nothing, because the transcript is the answer: what the session is
   *  called after this — the name, or the title a cleared one falls back to —
   *  is what the next listing reads off the file, and deriving it here as well
   *  was a second copy of a rule agent/listing.ts already owns.
   *
   *  TODO: renaming a cold session costs a whole resume, because the route
   *  reaches it through `ensure` and this method needs a live Pi session to
   *  append through. The work is one line in a file. Revisit when Pi offers a
   *  lightweight append to a session it has not loaded. */
  async rename(name: string): Promise<void> {
    this.live();
    this.pi.sessionManager.appendSessionInfo(name);
    this.wrote();
  }

  /** Compaction replaces the context a turn would run against, so a dispatch
   *  that lands mid-compaction waits for the summary instead of starting a turn
   *  over it — the follow-up promise ("delivered when idle") without Pi's
   *  follow-up queue, which is only drained by the *next* turn: a message
   *  parked there while nothing is running would sit unsent, and Pi's own
   *  `prompt()` guard would have thrown the user's message away (§5b). */
  private async whenCompacted(): Promise<void> {
    while (this.compacting) await this.compacting.catch(() => undefined);
  }

  // Async, so a refusal is a rejected promise: the seam promises callers they
  // may only `.catch()` (core/types.ts), and dispatch does exactly that.
  async prompt(text: string): Promise<void> {
    this.live();
    await this.whenCompacted();
    // Re-checked: the wait above is long enough for a dispose to land.
    this.live();
    // A turn may have started since the caller read the state this prompt was
    // decided against — two messages arriving together, or several released at
    // once by the wait above. Bare, Pi throws that back as "already
    // processing" and the message is gone (§5b); queued, it is the same
    // "delivered when idle" the core's own policy picks for an auto message
    // that lands mid-turn (core/queue.ts).
    return this.pi.prompt(text, { streamingBehavior: "followUp" });
  }

  async steer(text: string): Promise<void> {
    this.live();
    return this.pi.steer(text);
  }

  async followUp(text: string): Promise<void> {
    this.live();
    return this.pi.followUp(text);
  }

  async systemInput(
    text: string,
    origin: SystemInputOrigin,
    mode: "prompt" | "steer" | "followUp",
  ): Promise<void> {
    this.live();
    // Same gate as prompt(): an idle session takes a system input as a turn
    // whatever the mode says, so a callback landing mid-compaction would race
    // the summary too.
    await this.whenCompacted();
    this.live();
    return this.pi.sendCustomMessage(
      { customType: "pier.system-input", content: text, display: true, details: origin },
      { triggerTurn: true, deliverAs: mode === "prompt" ? undefined : mode },
    );
  }

  abort(): Promise<void> {
    return this.pi.abort();
  }

  subscribe(fn: (e: SessionEventPayload) => void): () => void {
    return this.pi.subscribe((event) => {
      for (const payload of toSessionEvents(event as PiEvent)) {
        fn(payload.type === "turn-end" ? { ...payload, meta: this.lastTurnMeta() } : payload);
      }
    });
  }

  /** Meta of the just-finished turn; live path, so "now" is the completion. */
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

export class PiAgentFactory implements AgentFactory, ProviderManager {
  constructor(
    private readonly extraTools: AgentCustomTool[] = [],
    /** Appended as a virtual context file, so Pi's own prompt stays intact.
     * Read per session, not captured once: it carries settings a user can
     * change while the process runs, and the next session must say the new
     * ones. */
    private readonly instructions: () => string = () => "",
    /** Skills documenting Pier's own tools: loaded per session, never installed
     * into the user's global or project skill directories. */
    private readonly skillPaths: string[] = [],
    /** Provider credentials from pier.db instead of <agentDir>/auth.json.
     * Optional only for bare test factories; main.ts always passes one, and
     * every runtime built here reads and writes through it — an OAuth refresh
     * persists to the database, never to a plaintext file. */
    private readonly credentials?: CredentialStore,
    private readonly providerConfig: PiConfigStore = new PiConfigStore(),
    /** Operator-pinned models (Console → Settings → Models), surfaced first in
     * every picker. A getter for the same reason `instructions` is one. */
    private readonly pinned: () => ModelRef[] = () => [],
    /** Which bundled extensions the Console has switched on. A getter for the
     * same reason again: the toggle takes effect on the next session open. */
    private readonly enabledExtensions: () => string[] = () => [],
    /** What exists on disk. Injected so a test can hand this factory a listing
     * instead of a session directory and a database. */
    private readonly listings: SessionListing = new IndexedListing(),
  ) {}

  /** One runtime for the whole process; catalogs are global, not per session. */
  private catalog?: Promise<ModelRuntime>;
  /** Where each listed session lives. A scan still stats every session file on
   *  disk, which `resume` would pay on every cold open — web selection, an IM
   *  message, a task run. The sidebar's own listing keeps this warm; a miss
   *  still lists. */
  private located = new Map<string, { path: string; cwd: string }>();
  /** That same scan, retained for LIST_TTL_MS instead of paid once per asking
   *  surface — one workspace event has three (sidebar, Activity, task lookups).
   *  Dropped on create/fork; ids appear for reasons this factory never sees, so
   *  a miss that decides something re-lists rather than trusts it (`resume`). */
  private listing?: { at: number; infos: Promise<SessionInfos> };
  private refreshQueue: Promise<void> = Promise.resolve();
  private builtinProviderIds?: Promise<Set<string>>;

  /** Structural fit: CredentialStore mirrors pi-ai's interface of the same
   * name, so the SDK accepts it without this file exporting any SDK type. */
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
    // Refresh after queued config writes settle, so runtime and structure never
    // combine an older catalog with a newer models.json snapshot.
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

  /**
   * One real request on the model the operator named. `configured` only ever
   * meant "a credential is stored", and a wrong base URL, a revoked key, a
   * gateway rewriting the request and a model this endpoint has never heard of
   * all look identical until a turn fails hours later.
   *
   * The request goes out through a fetch of our own for one reason: what a
   * provider (or a proxy in front of it) was actually sent, and what it
   * actually said, is the answer here — a summary of either would be Pier's
   * word for someone else's.
   */
  async check(providerId: string, modelId: string): Promise<ProviderCheck> {
    const started = Date.now();
    const signal = AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS);
    let request = "";
    let body: Promise<string> = Promise.resolve("");
    const recorded: typeof globalThis.fetch = async (input, init) => {
      request = typeof init?.body === "string" ? init.body : "";
      const response = await globalThis.fetch(input, init);
      // Cloned, not consumed: the SDK still needs to read the real stream.
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
      // A refusal can arrive as a message rather than a throw; the stop reason
      // is the only thing separating it from an answer.
      const refused = answer.stopReason === "error" || answer.stopReason === "aborted";
      if (refused) {
        throw new Error(answer.errorMessage ?? `the provider stopped: ${answer.stopReason}`);
      }
      const text = answer.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      // An empty answer is still an answer; say which kind of nothing it was.
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
      const committed = await (await this.authRuntime()).login(providerId, type, interaction);
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

  /**
   * Pi discovers AGENTS.md itself; we append one more, in memory, telling the
   * agent what the surface it is talking to can render. Layered as a context
   * file (not a systemPromptOverride) so the user's own instructions still win.
   */
  private async resourceLoader(cwd: string): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: defaultAgentDir(), // same discovery Pi would have done itself
      // SYSTEM.md remains user-owned: append it after Pier's replacement for
      // Pi's generic default, preserving the user's later instruction layer.
      systemPromptOverride: pierSystemPrompt,
      additionalSkillPaths: this.skillPaths,
      extensionFactories: [
        { name: "pier-bash-timeout", factory: bashTimeoutDefault, hidden: true },
        ...inlineExtensions(this.enabledExtensions()),
      ],
      extensionsOverride: standDownShadowed,
      agentsFilesOverride: (current) => {
        const content = this.instructions();
        return {
          agentsFiles: content
            ? [...current.agentsFiles, { path: "<pier>/AGENTS.md", content }]
            : current.agentsFiles,
        };
      },
    });
    await loader.reload();
    return loader;
  }

  private async open(cwd: string, sessionManager: SessionManager, opts: AgentLaunchOptions = { cwd }): Promise<AgentSession> {
    let live: PiAgentSession | undefined;
    // Asked per open, not captured at wiring: a tool whose channel is not
    // configured yet would otherwise cost context on every turn of every
    // session and be able to answer nothing.
    const active = this.extraTools.filter((tool) => tool.available?.() ?? true);
    // Generic translation only — tool contracts are data owned by their feature.
    const customTools = active.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as TSchema,
        execute: async (_id, params, signal) => {
          const caller = live?.sessionId ?? "unknown";
          log.debug(`tool ${tool.name} called by ${caller}`);
          try {
            return {
              content: [
                {
                  type: "text",
                  // Compact, not indented: pretty-printing a nested result
                  // costs ~20% more tokens and buys the model nothing.
                  text: JSON.stringify(await tool.execute(params, caller, signal)),
                },
              ],
              details: {},
            };
          } catch (err) {
            // Pi turns this into tool-result text the model reads, which is the
            // right recovery and the wrong record: rethrown, but logged first.
            log.warn(`tool ${tool.name} failed for ${caller}`, err);
            throw err;
          }
        },
      }),
    );
    // Locked Secrets is a refusal with a reason, here — not "provider is not
    // configured" three calls later, and never a fall back to auth.json. Before
    // appendSessionInfo, so the refused open writes nothing to disk.
    this.credentials?.assertUnlocked();
    if (opts.name) sessionManager.appendSessionInfo(opts.name);
    // This runtime serves exactly this one session, so shadowing its
    // streamSimple is the per-session seam for the Anthropic cache TTL:
    // interactive sessions keep "long" (1h — turns arrive minutes apart),
    // tasks downgrade to "short" (5m) via setCacheRetention. The default sits
    // before the spread so an explicit per-request value still wins —
    // compaction passes cacheRetention: "none" and must keep it.
    const runtime = await this.createRuntime();
    const retention: CacheRetentionBox = { value: "long" };
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = ((model, context, options) =>
      stream(model, context, { cacheRetention: retention.value, ...options })) as typeof runtime.streamSimple;
    const created = await createAgentSession({
      cwd,
      sessionManager,
      customTools,
      modelRuntime: runtime,
      resourceLoader: await this.resourceLoader(cwd),
    });
    live = created.session;
    const session = new PiSession(live, this.pinned, () => {
      this.listing = undefined;
    }, retention);
    if (opts.model) await session.setModel(opts.model);
    if (opts.thinking) session.setThinkingLevel(opts.thinking);
    log.info(`session ${session.id} open in ${cwd}${opts.name ? ` (${opts.name})` : ""}`);
    return session;
  }

  async create(opts: AgentLaunchOptions): Promise<AgentSession> {
    this.listing = undefined;
    return this.open(opts.cwd, SessionManager.create(opts.cwd), opts);
  }

  async fork(sourceSessionId: string, opts: AgentLaunchOptions): Promise<AgentSession> {
    const infos = await this.listed();
    const source = infos.find((session) => session.id === sourceSessionId);
    if (!source) throw new Error(`unknown session: ${sourceSessionId}`);
    const targetDir = SessionManager.create(opts.cwd).getSessionDir();
    const manager = SessionManager.open(source.path, targetDir, opts.cwd);
    const branch = manager.getBranch();
    const latest = branch.at(-1);
    const hasPendingToolCall = latest?.type === "message" &&
      latest.message.role === "assistant" &&
      Array.isArray(latest.message.content) &&
      latest.message.content.some((part) => part.type === "toolCall");
    const leafId = hasPendingToolCall ? latest.parentId : latest?.id;
    if (!leafId) throw new Error("cannot fork a session before its first persisted input");
    manager.createBranchedSession(leafId);
    this.listing = undefined;
    return this.open(opts.cwd, manager, opts);
  }

  async resume(sessionId: string): Promise<AgentSession> {
    const known = this.located.get(sessionId);
    if (known) {
      try {
        return await this.open(known.cwd, SessionManager.open(known.path));
      } catch (err) {
        // The file moved or went away under us: the cache was the only thing
        // that claimed otherwise, so drop it and take the slow, true path.
        log.warn(`cached path for session ${sessionId} did not open; re-listing`, err);
        this.located.delete(sessionId);
      }
    }
    const info = await this.locate(sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    return this.open(info.cwd || process.cwd(), SessionManager.open(info.path));
  }

  /** The listed record for one id, and the one place "no such session" is
   *  decided. A retained listing is not evidence that a session is gone: it may
   *  have been written since — by another Pier, or by the first turn of a
   *  session this factory opened. The miss is what earns a fresh scan, because
   *  callers read it as permission to start a replacement session
   *  (channels/conversations.ts), which costs a conversation its history, or as
   *  a session that no longer exists (tasks/, web/files.ts). `reused` is how we
   *  know a scan is owed: same entry back, same disk state. */
  private async locate(sessionId: string): Promise<SessionRecord | undefined> {
    const find = (infos: SessionInfos) => infos.find((s) => s.id === sessionId);
    const reused = this.listing;
    return find(await this.listed()) ??
      (reused && this.listing === reused ? find(await this.listed(true)) : undefined);
  }

  async find(sessionId: string): Promise<SessionSummary | undefined> {
    const info = await this.locate(sessionId);
    return info ? summaryOf(info) : undefined;
  }

  /** Once per process, after the first listing: agent/listing.ts reads Pi's
   *  transcripts with a parser of its own, and only a comparison notices when
   *  that format moves under it. */
  private audited = false;

  /** Every listing goes through here, so it also refreshes `located`. */
  private listed(force = false): Promise<SessionInfos> {
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
}
