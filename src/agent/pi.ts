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
  ImageAttachment,
  ModelRef,
  SessionEventPayload,
  SessionState,
} from "../core/types.js";

const toImageContent = (images?: ImageAttachment[]) =>
  images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
import { textOf, toSessionEvents, type PiEvent, type PiMessage } from "./events.js";
import { curateModels } from "./models.js";

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

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.pi.clearQueue();
  }

  async history(): Promise<ChatTurn[]> {
    const turns: ChatTurn[] = [];
    for (const m of this.pi.messages as PiMessage[]) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      let text = textOf(m.content);
      const imageCount = Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "image").length
        : 0;
      if (imageCount) text = `${text}${text ? " " : ""}[${imageCount} image${imageCount > 1 ? "s" : ""}]`;
      if (text) turns.push({ role: m.role, text });
    }
    return turns;
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
      for (const payload of toSessionEvents(event as PiEvent)) fn(payload);
    });
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
