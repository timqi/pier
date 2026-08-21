// The ONLY file allowed to import @earendil-works/pi-*. Implements the
// AgentFactory/AgentSession seam from src/core/types.ts on the Pi SDK.
// No Pi type may appear in an exported signature.

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession as PiAgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  AgentCustomTool,
  AgentFactory,
  AgentLaunchOptions,
  AgentSession,
  ChatTurn,
  ContextUsage,
  ImageAttachment,
  ModelRef,
  SessionEventPayload,
  SessionState,
  SystemInputOrigin,
  ThinkingLevel,
  TurnMeta,
} from "../core/types.js";
import {
  imageAt,
  toChatTurns,
  toSessionEvents,
  turnMetaAt,
  type PiEvent,
  type PiMessage,
} from "./events.js";
import { defaultAgentDir } from "./config.js";
import { curateModels } from "./models.js";

const toImageContent = (images?: ImageAttachment[]) =>
  images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));

/** Pi's bash tool has no default timeout, so a hung command holds the turn
 * until someone aborts it — nobody is watching in a scheduled task. Kept below
 * the task-run timeout (tasks/definitions.ts) so a stuck command comes back as
 * a tool error the agent can retry with an explicit longer timeout, instead of
 * killing the whole run. */
const BASH_DEFAULT_TIMEOUT_SECONDS = 600;

/** Patching the call is cheaper than replacing the tool: the built-in keeps its
 * shell settings, and the agent spends no tokens deciding a timeout. */
const bashTimeoutDefault = (pi: ExtensionAPI) => {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) {
      event.input.timeout = BASH_DEFAULT_TIMEOUT_SECONDS;
    }
  });
};

class PiSession implements AgentSession {
  constructor(private readonly pi: PiAgentSession) {}

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
    const curated = curateModels(
      available.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning })),
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
    return toChatTurns(this.pi.messages as PiMessage[]);
  }

  async image(ordinal: number): Promise<ImageAttachment | undefined> {
    return imageAt(this.pi.messages as PiMessage[], ordinal);
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

  prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    return this.pi.prompt(text, { images: toImageContent(images) });
  }

  steer(text: string, images?: ImageAttachment[]): Promise<void> {
    return this.pi.steer(text, toImageContent(images));
  }

  followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    return this.pi.followUp(text, toImageContent(images));
  }

  systemInput(
    text: string,
    origin: SystemInputOrigin,
    mode: "prompt" | "steer" | "followUp",
  ): Promise<void> {
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
    this.pi.dispose();
  }
}

export class PiAgentFactory implements AgentFactory {
  constructor(
    private readonly extraTools: AgentCustomTool[] = [],
    /** Appended as a virtual context file, so Pi's own prompt stays intact. */
    private readonly instructions = "",
    /** Skills documenting Pier's own tools: loaded per session, never installed
     * into the user's global or project skill directories. */
    private readonly skillPaths: string[] = [],
  ) {}

  /** One runtime for the whole process; catalogs are global, not per session. */
  private catalog?: Promise<ModelRuntime>;

  async availableModels(): Promise<ModelRef[]> {
    this.catalog ??= ModelRuntime.create();
    const available = await (await this.catalog).getAvailable();
    return curateModels(
      available.map((m) => ({ provider: m.provider, id: m.id, reasoning: m.reasoning })),
    );
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
      additionalSkillPaths: this.skillPaths,
      extensionFactories: [{ name: "pier-bash-timeout", factory: bashTimeoutDefault, hidden: true }],
      agentsFilesOverride: (current) => ({
        agentsFiles: this.instructions
          ? [...current.agentsFiles, { path: "<pier>/AGENTS.md", content: this.instructions }]
          : current.agentsFiles,
      }),
    });
    await loader.reload();
    return loader;
  }

  private async open(cwd: string, sessionManager: SessionManager, opts: AgentLaunchOptions = { cwd }): Promise<AgentSession> {
    let live: PiAgentSession | undefined;
    // Generic translation only — tool contracts are data owned by their feature.
    const customTools = this.extraTools.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as TSchema,
        execute: async (_id, params, signal) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await tool.execute(params, live?.sessionId ?? "unknown", signal), null, 2),
            },
          ],
          details: {},
        }),
      }),
    );
    if (opts.name) sessionManager.appendSessionInfo(opts.name);
    const tools = opts.capabilities === "read"
      ? ["read", "grep", "find", "ls", ...this.extraTools.map((tool) => tool.name)]
      : undefined;
    const created = await createAgentSession({
      cwd,
      sessionManager,
      customTools,
      tools,
      resourceLoader: await this.resourceLoader(cwd),
    });
    live = created.session;
    const session = new PiSession(live);
    if (opts.model) await session.setModel(opts.model);
    if (opts.thinking) session.setThinkingLevel(opts.thinking);
    return session;
  }

  async create(opts: AgentLaunchOptions): Promise<AgentSession> {
    return this.open(opts.cwd, SessionManager.create(opts.cwd), opts);
  }

  async fork(sourceSessionId: string, opts: AgentLaunchOptions): Promise<AgentSession> {
    const infos = await SessionManager.listAll();
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
    const infos = await SessionManager.listAll();
    const info = infos.find((s) => s.id === sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    return this.open(info.cwd || process.cwd(), SessionManager.open(info.path));
  }

  async list(): Promise<
    { id: string; cwd: string; createdAt: number; title?: string }[]
  > {
    const infos = await SessionManager.listAll();
    return infos.map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.created.getTime(),
      title: s.name ?? (s.firstMessage ? s.firstMessage.slice(0, 80) : undefined),
    }));
  }
}
