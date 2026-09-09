// One delivery engine for everything that reaches a session as a system input:
// run callbacks, group callbacks and run messages.

import type { AgentSession, SystemInputOrigin } from "../core/types.js";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { MAX_DELIVERY_ATTEMPTS, retryDelay, undeliverable, type CallbackFields } from "./types.js";

const log = logger("tasks");

/** The records a delivery names, from either side of the seam: a batch names
 *  every one of them, a group names itself, a message names its id. */
const recordIds = (origin: SystemInputOrigin | undefined): string[] => {
  if (origin?.kind === "task-callback") return origin.runIds ?? [origin.runId];
  if (origin?.kind === "task-message") return [origin.messageId];
  return [];
};

/** What a kind of delivery has to say about itself; the engine owns the rest. */
export interface Deliverable<T extends CallbackFields> {
  /** Its id, which is also how the recipient's transcript names it. */
  id(record: T): string;
  reload(id: string): T | undefined;
  save(record: T): void;
  changed(record: T): void;
  /** What the recipient reads, and the origin that identifies it afterwards. */
  input(records: T[]): { text: string; origin: SystemInputOrigin };
  /** Reports a delivery nobody can complete; the record already says so. */
  abandoned(record: T, sessionId: string, why: string): void;
  /** A follow-up to a busy recipient waits for idle so a batch stays one turn;
   *  a kind that never batches joins Pi's queue at once instead. */
  queues?: true;
}

export class Outbox<T extends CallbackFields> {
  private readonly delivering = new Set<string>();

  constructor(private readonly router: Router, private readonly kind: Deliverable<T>) {}

  /** One model turn drains the batch instead of one per record. `delivered` is
   *  written only against the input visible in the recipient's transcript: Pi's
   *  queues are memory, so a resolved `systemInput` proves nothing. */
  async deliver(sessionId: string, batch: T[]): Promise<void> {
    const mine = batch.filter((record) => !this.delivering.has(this.kind.id(record)));
    if (mine.length === 0) return;
    for (const record of mine) this.delivering.add(this.kind.id(record));
    const counted = new Set<string>();
    try {
      const session = await this.router.ensure({ channelId: "task", conversationId: sessionId });
      // The transcript read is both the crash-window dedupe and the proof.
      const unproven = await this.settle(mine, session);
      // Checked after the proof: a record whose input did land must not be
      // given up on for having spent its last attempt landing it.
      const live = unproven.filter((record) => !this.spent(record, sessionId));
      if (live.length === 0) return;
      let sending = live;
      // Waiting for a busy target is not an attempt, or the ceiling arrives in
      // seconds. A `steer` record joins the running turn instead, but only once:
      // handed over, it sits in Pi's in-memory queue, invisible in the transcript.
      if (session.state === "streaming") {
        const handedOver = await this.queued(session);
        const sendNow = (record: T): boolean =>
          (record.callbackMode === "steer" || this.kind.queues === true) && !handedOver.has(this.kind.id(record));
        sending = live.filter(sendNow);
        for (const record of live) if (!sendNow(record)) this.defer(record);
        if (sending.length === 0) return;
      }
      for (const record of sending) {
        this.sent(record);
        counted.add(this.kind.id(record));
      }
      const { text, origin } = this.kind.input(sending);
      const mode = sending.every((record) => record.callbackMode === "steer") ? "steer" : "followUp";
      log.debug(`callback for ${sending.map((r) => this.kind.id(r)).join(", ")} → session ${sessionId}`);
      // Not awaited: `systemInput` settles with the recipient's whole turn.
      session.systemInput(text, origin, mode)
        .catch((error: unknown) => this.retry(sessionId, sending, error, counted));
      // Pi records the input as it starts the turn; the tick sweep is the backstop.
      await this.settle(sending, session);
    } catch (error) {
      this.retry(sessionId, mine, error, counted);
    } finally {
      for (const record of mine) this.delivering.delete(this.kind.id(record));
    }
  }

  /** What the transcript cannot answer yet; empty unless the session is streaming. */
  private async queued(session: AgentSession): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const origin of await session.pendingSystemInputs()) for (const id of recordIds(origin)) ids.add(id);
    return ids;
  }

  /** Marks every record the transcript proves; returns the ones it does not. */
  private async settle(records: T[], session: AgentSession): Promise<T[]> {
    const seen = new Set<string>();
    for (const turn of await session.history()) {
      if (turn.role !== "system") continue;
      for (const id of recordIds(turn.origin)) seen.add(id);
    }
    const unproven: T[] = [];
    for (const stale of records) {
      const record = this.kind.reload(this.kind.id(stale)) ?? stale;
      if (!seen.has(this.kind.id(record))) unproven.push(record);
      else if (record.callbackState !== "delivered") this.delivered(record);
    }
    return unproven;
  }

  /** The retry itself is silent, so this line is the only sign of it. */
  private retry(sessionId: string, batch: T[], error: unknown, counted: Set<string>): void {
    log.warn(`callback to session ${sessionId} failed, will retry`, error);
    for (const stale of batch) {
      const record = this.kind.reload(this.kind.id(stale));
      // Already proven delivered, or already given up on: not a failure.
      if (!record || (record.callbackState !== "pending" && record.callbackState !== "failed")) continue;
      this.failed(record, error, counted.has(this.kind.id(record)));
      counted.add(this.kind.id(record));
      this.spent(record, sessionId);
    }
  }

  /** An agent waiting on a result it will never get must not wait on silence. */
  private spent(record: T, sessionId: string): boolean {
    if (record.callbackAttempts < MAX_DELIVERY_ATTEMPTS) return false;
    if (record.callbackState !== "abandoned") {
      record.callbackState = "abandoned";
      record.callbackError = undeliverable(record.callbackAttempts, record.callbackError);
      record.callbackNextAttemptAt = null;
      this.write(record);
      this.kind.abandoned(record, sessionId, record.callbackError);
    }
    return true;
  }

  /** Busy target: try again shortly, and do not count it. */
  private defer(record: T): void {
    record.callbackNextAttemptAt = Date.now() + 1000;
    this.kind.save(record);
  }

  /** Backs off like a failure, so an input never recorded is re-sent on a
   *  curve, not once a second. */
  private sent(record: T): void {
    record.callbackAttempts += 1;
    record.callbackState = "pending";
    record.callbackError = null;
    record.callbackNextAttemptAt = Date.now() + retryDelay(record.callbackAttempts);
    this.kind.save(record);
  }

  private delivered(record: T): void {
    record.callbackState = "delivered";
    record.callbackError = null;
    record.callbackNextAttemptAt = null;
    this.write(record);
  }

  /** A failed pass costs one attempt, whether it died before or after send. */
  private failed(record: T, error: unknown, counted: boolean): void {
    if (!counted) record.callbackAttempts += 1;
    record.callbackState = "failed";
    record.callbackError = String(error);
    record.callbackNextAttemptAt = Date.now() + retryDelay(record.callbackAttempts);
    this.write(record);
  }

  private write(record: T): void {
    this.kind.save(record);
    this.kind.changed(record);
  }
}
