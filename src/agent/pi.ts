// One of the two files (with packages.ts) allowed to import @earendil-works/pi-*.
// Implements the AgentFactory/AgentSession seam from src/core/types.ts on the
// Pi SDK. No Pi type may appear in an exported signature.

import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import {
  createAgentSession,
  CredentialSynchronizationError,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSession as PiAgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
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
  SearchHit,
  SessionEventPayload,
  SessionState,
  SessionSummary,
  SystemInputOrigin,
  ThinkingLevel,
  TurnMeta,
  WebAuth,
  WebContext,
} from "../core/types.js";
import { SESSION_TITLE_MAX } from "../core/types.js";
import { logger } from "../log.js";
import {
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
  "A leading `[name<id> time]` on the user's message is a speaker header, not content.";

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

/** Pier's baseline replaces Pi's generic default; a user's SYSTEM.md follows it. */
const PIER_SYSTEM_PROMPT = `You are a general-purpose agent with a live workspace: you can read and change files and run shell commands. Act with expert care — do the work and verify the result.

# Communication
These rules govern conversational replies. A human reads them on a phone-sized screen, so the cap is about their attention, not about tokens. When the reply is the deliverable — the request names an artifact (report, review, digest, plan) or another agent reads the result (task runs) — the length rules don't apply; the style rules still do.
- Answer with the conclusion. Add the one fact that changes what the user does next — a failure and its cause, an assumption you made, a risk. Trade-offs, process, alternatives: only when asked.
- Cap per reply: 60 words (90 Chinese chars), max 3 bullets; 120 words (180 Chinese chars) when the question asks for reasoning, comparison or options. A command the user is meant to run counts as one line. Don't paste code or diffs to explain — name the file.
- Past the cap by a lot? Conclusion plus one short "want the details?" — don't dump it. Past it by a sentence? Finish the sentence.
- Reply in the language of the request; paths, identifiers and quoted output stay verbatim.
- Never: preamble, restating the question, closing summaries, "I'm going to..." narration, narrating each edit.
- After edits, say only: file(s) touched + one line on the result.
- Don't quote code to explain it — no snippets, no walkthroughs. Code the user asked for (a command, a one-liner, a value) is the answer: one block, nothing around it.
- \`path:line\` when you're pointing at one line; the bare path otherwise.
- Blocked on a decision only the requester can make? Ask them, one short question. Otherwise pick the sensible default and note it.

# Working style — holds on any machine; a user's SYSTEM.md adds the local facts (tools, hosts, paths)
- Before touching files: list and search first. Never guess a path or a line number.
- Read before you edit. Match the surrounding code's style, naming, and comment density.
- Do exactly what was asked. No unrequested refactors, no extra files, no README updates.
- Each bash call is a fresh shell in the working directory; chain what must share state.
- Destructive or irreversible actions on things you didn't create — deleting user files, force push, migrations, deploys, service restarts: ask first; unattended, don't do them and report what you would have done.
- Say plainly when something failed, was skipped, or is unverified. Never claim a test passed without running it.`;

export const pierSystemPrompt = (userPrompt?: string): string =>
  userPrompt ? `${PIER_SYSTEM_PROMPT}\n\n${userPrompt}` : PIER_SYSTEM_PROMPT;

/** Patching the call keeps the built-in's shell settings. */
const bashTimeoutDefault = (pi: ExtensionAPI) => {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) {
      event.input.timeout = BASH_DEFAULT_TIMEOUT_SECONDS;
    }
  });
};

/** Read per request by the runtime wrapper in `open()`, so a task can
 *  downgrade the cache TTL after the session is open. */
type CacheRetentionBox = { value: "short" | "long" };

export class PiSession implements AgentSession {
  constructor(
    private readonly pi: PiAgentSession,
    /** Read per call — the menu can change while we run. */
    private readonly pinned: () => ModelRef[] = () => [],
    /** Drops the factory's retained listing: a rename lands in exactly the
     *  window it covers, and every surface would keep the old title. */
    private readonly wrote: () => void = () => {},
    private readonly retention: CacheRetentionBox = { value: "long" },
    /** Read per turn: switching auto-titling on takes effect without a restart. */
    private readonly suggestTitle: () => ((first: string, reply: string) => Promise<string>) | undefined = () => undefined,
  ) {}

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
    return u ? { tokens: u.tokens, contextWindow: u.contextWindow } : undefined;
  }

  async setModel(ref: ModelRef): Promise<void> {
    const m = this.pi.modelRuntime.getModel(ref.provider, ref.id);
    if (!m) {
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
    return toChatTurns(this.pi.messages as PiMessage[]);
  }

  async rewindToUserTurn(index: number): Promise<void> {
    const total = (await this.history()).filter((t) => t.role === "user").length;
    // Branch entries keep compacted-away history that history() no longer
    // shows, so only end-relative indices line up.
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

  /** Pi keeps no lock of its own: a second `compact()` summarizes a transcript
   *  being replaced under it, and two POSTs a millisecond apart both pass the
   *  route's idle check. */
  private compacting: Promise<void> | null = null;

  async compact(): Promise<void> {
    this.live();
    if (this.compacting) throw new Error(`session ${this.pi.sessionId} is already compacting`);
    // Recorded in the same tick, no await between: that is what makes the check a gate.
    const running = this.pi.compact().then(() => undefined);
    this.compacting = running;
    try {
      await running;
    } finally {
      this.compacting = null;
    }
  }

  /** An append: Pi's reader takes the latest `session_info`. Never refused for
   *  being busy. TODO: renaming a cold session costs a whole resume for one
   *  appended line; revisit when Pi offers a lightweight append. */
  async rename(name: string): Promise<void> {
    this.live();
    this.pi.sessionManager.appendSessionInfo(name);
    this.wrote();
  }

  /** A dispatch landing mid-compaction waits for the summary instead of
   *  starting a turn over it. Not Pi's follow-up queue: that is drained only by
   *  the *next* turn, so a message parked there while idle would sit unsent. */
  private async whenCompacted(): Promise<void> {
    while (this.compacting) await this.compacting.catch(() => undefined);
  }

  // Async, so a refusal is a rejected promise the seam lets callers `.catch()`.
  async prompt(text: string): Promise<void> {
    this.live();
    await this.whenCompacted();
    // The wait above is long enough for a dispose to land.
    this.live();
    // A turn may have started since the caller read the state. Bare, Pi throws
    // "already processing" and the message is gone (§5); queued, it is the
    // same "delivered when idle" core/queue.ts picks for a mid-turn message.
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
    // Same gate as prompt(): an idle session takes a system input as a turn.
    await this.whenCompacted();
    this.live();
    // Read after the wait: a running turn means the call below queues.
    const queued = this.pi.isStreaming;
    if (queued) this.queuedInputs.push(origin);
    try {
      return await this.pi.sendCustomMessage(
        { customType: "pier.system-input", content: text, display: true, details: origin },
        { triggerTurn: true, deliverAs: mode === "prompt" ? undefined : mode },
      );
    } catch (error) {
      // Refused: nothing is in flight. The entry may be gone already.
      const at = this.queuedInputs.indexOf(origin);
      if (at >= 0) this.queuedInputs.splice(at, 1);
      throw error;
    }
  }

  abort(): Promise<void> {
    return this.pi.abort();
  }

  subscribe(fn: (e: SessionEventPayload) => void): () => void {
    let retryPending = false;
    return this.pi.subscribe((event) => {
      const piEvent = event as PiEvent;
      if (piEvent.type === "agent_end") retryPending = piEvent.willRetry === true;
      if (piEvent.type === "agent_settled" && retryPending) {
        // Aborting Pi during retry backoff produces no final agent_end.
        retryPending = false;
        fn({ type: "turn-end", text: "", meta: this.lastTurnMeta() });
      }
      for (const payload of toSessionEvents(piEvent)) {
        fn(payload.type === "turn-end" ? { ...payload, meta: this.lastTurnMeta() } : payload);
        if (payload.type === "turn-end" && !payload.error) this.autoTitle(payload.text, fn);
      }
    });
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
        // Named while we waited, by a person: their word beats the model's.
        if (this.disposed || this.pi.sessionManager.getSessionName()) return;
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
    private readonly instructions: () => string = () => "",
    /** Loaded per session, never installed into the user's skill directories. */
    private readonly skillPaths: string[] = [],
    /** Optional only for bare test factories; an OAuth refresh persists here,
     *  never to a plaintext auth.json. */
    private readonly credentials?: CredentialStore,
    private readonly providerConfig: PiConfigStore = new PiConfigStore(),
    private readonly pinned: () => ModelRef[] = () => [],
    /** The built-in `pier` package's one switch list: Pier's own skills switched off. */
    private readonly pier: () => { skillsOff: string[] } = () => ({ skillsOff: [] }),
    private readonly titleModel: () => ModelRef | undefined = () => undefined,
    /** Injected so a test needs no session directory or database. */
    private readonly listings: SessionListing = new IndexedListing(),
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

  /** Pi's registry over the shared runtime, so an OAuth refresh lands in the
   *  credential store like every other request's. */
  async webContext(active?: ModelRef): Promise<WebContext> {
    const modelRegistry = new ModelRegistry(await this.refreshedRuntime());
    return { modelRegistry, model: active && modelRegistry.find(active.provider, active.id) };
  }

  private async resourceLoader(cwd: string): Promise<DefaultResourceLoader> {
    const { skillsOff } = this.pier();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: defaultAgentDir(),
      // The user's SYSTEM.md is appended after Pier's baseline, so it still wins.
      systemPromptOverride: pierSystemPrompt,
      additionalSkillPaths: this.skillPaths,
      // Only Pier's own skills answer to the off-list; a user's skill of the
      // same name is Pi's to switch (settings.json).
      skillsOverride: (base) => ({
        ...base,
        skills: base.skills.filter((skill) =>
          !skillsOff.includes(skill.name) || !this.skillPaths.some((dir) => skill.filePath.startsWith(dir + sep))),
      }),
      extensionFactories: [{ name: "pier-bash-timeout", factory: bashTimeoutDefault, hidden: true }],
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

  private open(cwd: string, sessionManager: SessionManager, opts: AgentLaunchOptions = { cwd }): Promise<AgentSession> {
    return this.providerConfig.withWrite(() => this.openSnapshot(cwd, sessionManager, opts));
  }

  private async openSnapshot(cwd: string, sessionManager: SessionManager, opts: AgentLaunchOptions): Promise<AgentSession> {
    // A locked store is a refusal with a reason here, not "provider not
    // configured" later. Before appendSessionInfo, so nothing is written.
    this.credentials?.assertUnlocked();
    if (opts.name) sessionManager.appendSessionInfo(opts.name);
    // This runtime serves one session, so shadowing streamSimple is the
    // per-session seam for the cache TTL. Default before the spread: compaction
    // passes cacheRetention: "none" and must keep it.
    const runtime = await this.createRuntime();
    const retention: CacheRetentionBox = { value: "long" };
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = ((model, context, options) =>
      stream(model, context, { cacheRetention: retention.value, ...options })) as typeof runtime.streamSimple;
    const created = await createAgentSession({
      cwd,
      sessionManager,
      modelRuntime: runtime,
      resourceLoader: await this.resourceLoader(cwd),
    });
    const live = created.session;
    // Pi defaults to one follow-up per turn boundary, so N queued messages cost
    // N turns. The agent's setter flips only the in-memory queue;
    // `session.setFollowUpMode` would persist it to Pi's settings.json.
    live.agent.followUpMode = "all";
    const session = new PiSession(live, this.pinned, () => {
      this.listing = undefined;
    }, retention, () => {
      const model = this.titleModel();
      return model && ((first, reply) => this.suggestTitle(model, first, reply));
    });
    if (opts.model) await session.setModel(opts.model);
    if (opts.thinking) session.setThinkingLevel(opts.thinking);
    log.info(`session ${session.id} open in ${cwd}${opts.name ? ` (${opts.name})` : ""}`);
    return session;
  }

  async create(opts: AgentLaunchOptions): Promise<AgentSession> {
    this.listing = undefined;
    // Resolved before Pi records it, so every later listing names it the same way.
    const cwd = realPath(opts.cwd);
    return this.open(cwd, SessionManager.create(cwd), { ...opts, cwd });
  }

  async resume(sessionId: string): Promise<AgentSession> {
    const known = this.located.get(sessionId);
    if (known) {
      try {
        return await this.open(known.cwd, SessionManager.open(known.path));
      } catch (err) {
        log.warn(`cached path for session ${sessionId} did not open; re-listing`, err);
        this.located.delete(sessionId);
      }
    }
    const info = await this.locate(sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    return this.open(info.cwd || process.cwd(), SessionManager.open(info.path));
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
  async search(query: string): Promise<SearchHit[]> {
    await this.listed();
    return this.listings.search?.(query) ?? [];
  }
}
