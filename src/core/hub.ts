// Per-session event fan-out with a replay ring buffer. The single stamping
// point for seq/ts — nothing else in the system numbers events.

import { logger } from "../log.js";
import type { SessionEvent, SessionEventPayload, WorkspaceEvent } from "./types.js";

const log = logger("core");
const RING_SIZE = 1000;

/** emit() runs on the emitter's stack (Pi's dispatch path), which must not unwind. */
function fanOut<E>(subscribers: Iterable<(e: E) => void>, event: E): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      log.warn(`event subscriber threw: ${String(err)}`);
    }
  }
}

interface SessionBus {
  seq: number;
  replayFloor: number; // highest replayable seq discarded, not a live-only delta
  buffer: SessionEvent[]; // ring of replayable events, oldest first; emptied once nobody watches
  subscribers: Set<(e: SessionEvent) => void>;
}

export class EventHub {
  private readonly buses = new Map<string, SessionBus>();
  // No seq, no replay: a client that missed events re-lists on reconnect.
  private readonly workspace = new Set<(e: WorkspaceEvent) => void>();

  private bus(sessionId: string): SessionBus {
    let b = this.buses.get(sessionId);
    if (!b) {
      b = { seq: 0, replayFloor: 0, buffer: [], subscribers: new Set() };
      this.buses.set(sessionId, b);
    }
    return b;
  }

  emit(sessionId: string, payload: SessionEventPayload): void {
    const b = this.bus(sessionId);
    const event: SessionEvent = {
      seq: ++b.seq,
      ts: Date.now(),
      sessionId,
      ...payload,
    };
    // One long reply emits thousands of text deltas; a ring holding them would
    // hold only them. `turn-end` carries the full text. Thinking stays
    // replayable: an EventSource reconnect does not reload the transcript.
    if (payload.type !== "text-delta") {
      b.buffer.push(event);
      if (b.buffer.length > RING_SIZE) b.replayFloor = b.buffer.shift()!.seq;
    }
    fanOut(b.subscribers, event);
  }

  subscribe(sessionId: string, fn: (e: SessionEvent) => void): () => void {
    const b = this.bus(sessionId);
    b.subscribers.add(fn);
    return () => b.subscribers.delete(fn);
  }

  /** Events with seq > afterSeq still held in the ring buffer — oldest first,
   *  and without text deltas, which are live-only. */
  replay(sessionId: string, afterSeq: number): SessionEvent[] {
    return this.bus(sessionId).buffer.filter((e) => e.seq > afterSeq);
  }

  /** Whether replay covers this cursor; live-only text gaps are intentional. */
  covers(sessionId: string, afterSeq: number): boolean {
    const b = this.bus(sessionId);
    return Number.isSafeInteger(afterSeq) && afterSeq >= b.replayFloor && afterSeq <= b.seq;
  }

  emitWorkspace(event: WorkspaceEvent): void {
    fanOut(this.workspace, event);
  }

  subscribeWorkspace(fn: (e: WorkspaceEvent) => void): () => void {
    this.workspace.add(fn);
    return () => this.workspace.delete(fn);
  }

  /** Highest seq stamped so far (0 if none). */
  lastSeq(sessionId: string): number {
    return this.buses.get(sessionId)?.seq ?? 0;
  }

  /** Whether anyone is still watching this session (an open SSE stream). */
  hasSubscribers(sessionId: string): boolean {
    return (this.buses.get(sessionId)?.subscribers.size ?? 0) > 0;
  }

  /** The bus keeps its seq: a client reconnecting with a Last-Event-ID drops
   *  anything numbered at or below what it saw. */
  dropReplay(sessionId: string): void {
    if (this.hasSubscribers(sessionId)) return;
    const b = this.buses.get(sessionId);
    if (b) {
      b.replayFloor = b.buffer.at(-1)?.seq ?? b.replayFloor;
      b.buffer = [];
    }
  }
}
