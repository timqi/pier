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
import type { CredentialStore, ProviderCredential } from "./credentials.js";
import { curateModels, pinFirst } from "./models.js";

const log = logger("agent");

/** Pi's bash tool has no default timeout, so a hung command holds the turn
 * until someone aborts it — nobody is watching in a scheduled task. Kept below
 * the default task-run timeout so a stuck command comes back as
 * a tool error the agent can retry with an explicit longer timeout, instead of
 * killing the whole run. */
const BASH_DEFAULT_TIMEOUT_SECONDS = 600;
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
- Cap per reply: 100 words (or 100 Chinese chars), max 3 bullets; 300 when explicitly asked why or how. Code blocks, diffs and commands don't count.
- Never: preamble, restating the question, closing summaries, "I'm going to..." narration, listing changes already visible in the diff.
- After edits, say only: file(s) touched + one line on the result. Don't explain self-evident code.
- Show file paths as \`path:line\`.
- If the honest answer needs more than the cap, give the conclusion plus one short "want the details?" — don't dump it.
- Blocked on a decision only the person you work for can make? Ask one short question. Otherwise pick the sensible default and note it.`;

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

export class PiSession implements AgentSession {
  constructor(
    private readonly pi: PiAgentSession,
    /** Operator pins, read per call — the menu can change while we run. */
    private readonly pinned: () => ModelRef[] = () => [],
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

  // Async, so a refusal is a rejected promise: the seam promises callers they
  // may only `.catch()` (core/types.ts), and dispatch does exactly that.
  async prompt(text: string): Promise<void> {
    this.live();
    return this.pi.prompt(text);
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
  ) {}

  /** One runtime for the whole process; catalogs are global, not per session. */
  private catalog?: Promise<ModelRuntime>;
  /** Where each listed session lives. `listAll` reads the head of every
   *  session file on disk (~250ms at 200 sessions, and it only grows), which
   *  `resume` paid on every cold open — web selection, an IM message, a task
   *  run. The sidebar's own listing keeps this warm; a miss still lists. */
  private located = new Map<string, { path: string; cwd: string }>();
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
    const tools = opts.capabilities === "read"
      ? ["read", "grep", "find", "ls", ...active.map((tool) => tool.name)]
      : undefined;
    const created = await createAgentSession({
      cwd,
      sessionManager,
      customTools,
      tools,
      modelRuntime: await this.createRuntime(),
      resourceLoader: await this.resourceLoader(cwd),
    });
    live = created.session;
    const session = new PiSession(live, this.pinned);
    if (opts.model) await session.setModel(opts.model);
    if (opts.thinking) session.setThinkingLevel(opts.thinking);
    log.info(`session ${session.id} open in ${cwd}${opts.name ? ` (${opts.name})` : ""}`);
    return session;
  }

  async create(opts: AgentLaunchOptions): Promise<AgentSession> {
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
    const infos = await this.listed();
    const info = infos.find((s) => s.id === sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    return this.open(info.cwd || process.cwd(), SessionManager.open(info.path));
  }

  /** Every listing goes through here, so it also refreshes `located`. */
  private async listed(): Promise<Awaited<ReturnType<typeof SessionManager.listAll>>> {
    const infos = await SessionManager.listAll();
    for (const s of infos) {
      this.located.set(s.id, { path: s.path, cwd: s.cwd || process.cwd() });
    }
    return infos;
  }

  async list(): Promise<SessionSummary[]> {
    const infos = await this.listed();
    return infos.map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.created.getTime(),
      title: s.name ?? (s.firstMessage ? s.firstMessage.slice(0, 80) : undefined),
    }));
  }
}
