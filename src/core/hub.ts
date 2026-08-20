// Per-session event fan-out with a replay ring buffer. The single stamping
// point for seq/ts — nothing else in the system numbers events.

import type { SessionEvent, SessionEventPayload, WorkspaceEvent } from "./types.js";

const RING_SIZE = 1000;

interface SessionBus {
  seq: number;
  buffer: SessionEvent[]; // ring, oldest first
  subscribers: Set<(e: SessionEvent) => void>;
}

export class EventHub {
  private readonly buses = new Map<string, SessionBus>();
  // Workspace bus: no seq, no replay — a client that missed events just
  // re-lists on reconnect, so there is nothing to renumber.
  private readonly workspace = new Set<(e: WorkspaceEvent) => void>();

  private bus(sessionId: string): SessionBus {
    let b = this.buses.get(sessionId);
    if (!b) {
      b = { seq: 0, buffer: [], subscribers: new Set() };
      this.buses.set(sessionId, b);
    }
    return b;
  }

  emit(sessionId: string, payload: SessionEventPayload): SessionEvent {
    const b = this.bus(sessionId);
    const event: SessionEvent = {
      seq: ++b.seq,
      ts: Date.now(),
      sessionId,
      ...payload,
    };
    b.buffer.push(event);
    if (b.buffer.length > RING_SIZE) b.buffer.shift();
    for (const fn of b.subscribers) fn(event);
    return event;
  }

  subscribe(sessionId: string, fn: (e: SessionEvent) => void): () => void {
    const b = this.bus(sessionId);
    b.subscribers.add(fn);
    return () => b.subscribers.delete(fn);
  }

  /** Events with seq > afterSeq still held in the ring buffer. */
  replay(sessionId: string, afterSeq: number): SessionEvent[] {
    return this.bus(sessionId).buffer.filter((e) => e.seq > afterSeq);
  }

  emitWorkspace(event: WorkspaceEvent): void {
    for (const fn of this.workspace) fn(event);
  }

  subscribeWorkspace(fn: (e: WorkspaceEvent) => void): () => void {
    this.workspace.add(fn);
    return () => this.workspace.delete(fn);
  }

  /** Highest seq stamped so far (0 if none). */
  lastSeq(sessionId: string): number {
    return this.buses.get(sessionId)?.seq ?? 0;
  }
}
