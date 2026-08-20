// The ONLY file allowed to import @mariozechner/pi-*. Implements the
// AgentFactory/AgentSession seam from src/core/types.ts on the Pi SDK.
// No Pi type may appear in an exported signature.

import {
  createAgentSession,
  SessionManager,
  type AgentSession as PiAgentSession,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentFactory,
  AgentSession,
  SessionEventPayload,
  SessionState,
} from "../core/types.js";
import { toSessionEvents, type PiEvent } from "./events.js";

class PiSession implements AgentSession {
  constructor(private readonly pi: PiAgentSession) {}

  get id(): string {
    return this.pi.sessionId;
  }

  get state(): SessionState {
    return this.pi.isStreaming ? "streaming" : "idle";
  }

  prompt(text: string): Promise<void> {
    return this.pi.prompt(text);
  }

  steer(text: string): Promise<void> {
    return this.pi.steer(text);
  }

  followUp(text: string): Promise<void> {
    return this.pi.followUp(text);
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
