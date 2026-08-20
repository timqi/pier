// The ONLY file allowed to import @earendil-works/pi-*. Implements the
// AgentFactory/AgentSession seam from src/core/types.ts on the Pi SDK.
// No Pi type may appear in an exported signature.

import {
  createAgentSession,
  SessionManager,
  type AgentSession as PiAgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentFactory,
  AgentSession,
  ChatTurn,
  ContextUsage,
  ImageAttachment,
  ModelRef,
  SessionEventPayload,
  SessionState,
  ThinkingLevel,
  TurnMeta,
} from "../core/types.js";
import {
  toChatTurns,
  toSessionEvents,
  turnMetaAt,
  type PiEvent,
  type PiMessage,
} from "./events.js";
import { curateModels } from "./models.js";

const toImageContent = (images?: ImageAttachment[]) =>
  images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));

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
    if (!m) throw new Error(`unknown model: ${ref.provider}/${ref.id}`);
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
  async create(opts: { cwd: string }): Promise<AgentSession> {
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      sessionManager: SessionManager.create(opts.cwd),
    });
    return new PiSession(session);
  }

  async resume(sessionId: string): Promise<AgentSession> {
    const infos = await SessionManager.listAll();
    const info = infos.find((s) => s.id === sessionId);
    if (!info) throw new Error(`unknown session: ${sessionId}`);
    const { session } = await createAgentSession({
      cwd: info.cwd || process.cwd(),
      sessionManager: SessionManager.open(info.path),
    });
    return new PiSession(session);
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
