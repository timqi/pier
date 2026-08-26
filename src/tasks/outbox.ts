// One delivery engine for everything that has to reach a session as a system
// input: run callbacks and group callbacks. Its whole reason to exist is that
// this logic was written twice and the two copies drifted — the ceiling was
// checked in one order here and another there, and only one of them counted a
// failed attempt.

import type { AgentSession, SystemInputOrigin } from "../core/types.js";
import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { MAX_DELIVERY_ATTEMPTS, retryDelay, undeliverable, type CallbackFields } from "./types.js";

const log = logger("tasks");

/** What a kind of delivery has to say about itself; the engine owns the rest. */
export interface Deliverable<T extends CallbackFields> {
  /** Its id, which is also how the recipient's transcript names it. */
  id(record: T): string;
  reload(id: string): T | undefined;
  save(record: T): void;
  changed(record: T): void;
  /** What the recipient reads, and the origin that identifies it afterwards. */
  input(records: T[]): { text: string; origin: SystemInputOrigin };
  /** Which record ids an origin already in the transcript proves delivered —
   * the other half of `input`'s origin, and the crash-window dedupe. */
  proven(origin: SystemInputOrigin): string[];
  /** How a record enters a busy session: `followUp` waits for the turn
   * boundary (the default), `steer` reaches the running turn — for records
   * whose recipient asked to be interrupted. */
  urgency?(record: T): "steer" | "followUp";
  /** Named when giving up, e.g. `the result of "review-web"`. */
  describe(record: T): string;
}

export class Outbox<T extends CallbackFields> {
  private readonly delivering = new Set<string>();

  constructor(
    private readonly router: Router,
    private readonly kind: Deliverable<T>,
    /** Reports a delivery nobody can complete (service.ts owns the surfaces). */
    private readonly unreachable: (sessionId: string, what: string, why: string) => void,
  ) {}

  /**
   * Delivers a batch aimed at one session: one model turn drains the backlog
   * instead of one turn per record.
   *
   * `delivered` is written only against proof — the input visible in the
   * recipient's own transcript. Pi's queues are memory, so an abort or a
   * restart drops an accepted input and `systemInput` resolving proves
   * nothing; a delivery reported on a resolved send is how a delegating agent
   * ends up waiting forever on a result that was never read.
   */
  async deliver(sessionId: string, batch: T[]): Promise<void> {
    const mine = batch.filter((record) => !this.delivering.has(this.kind.id(record)));
    if (mine.length === 0) return;
    for (const record of mine) this.delivering.add(this.kind.id(record));
    try {
      const session = await this.router.ensure({ channelId: "task", conversationId: sessionId });
      // The transcript read is both the crash-window dedupe and the proof.
      const unproven = await this.settle(mine, session);
      // Checked after the proof: a record whose input did land must not be
      // given up on for having spent its last attempt landing it.
      const live = unproven.filter((record) => !this.spent(record, sessionId));
      if (live.length === 0) return;
      // Waiting for a busy target is not a delivery attempt: counting it would
      // inflate the attempts once per second and skip the failure backoff
      // straight to its ceiling. Steer-urgency records do not wait — reaching
      // the running turn is what their subscriber asked for.
      let batch = live;
      let mode: "steer" | "followUp" = "followUp";
      if (session.state === "streaming") {
        batch = live.filter((record) => this.kind.urgency?.(record) === "steer");
        for (const record of live) if (!batch.includes(record)) this.defer(record);
        if (batch.length === 0) return;
        mode = "steer";
      }
      for (const record of batch) this.sent(record);
      const { text, origin } = this.kind.input(batch);
      log.debug(`callback for ${batch.map((r) => this.kind.id(r)).join(", ")} → session ${sessionId}`);
      // Not awaited: `systemInput` settles with the recipient's whole turn, and
      // holding the delivery lock that long would keep the proof from ever
      // being read — which is the only thing that marks this delivered.
      session.systemInput(text, origin, mode)
        .catch((error: unknown) => this.retry(sessionId, batch, error));
      // Pi records the input as it starts the turn, so the proof is usually
      // here already; the tick sweep is the backstop when it is not.
      await this.settle(batch, session);
    } catch (error) {
      this.retry(sessionId, mine, error);
    } finally {
      for (const record of mine) this.delivering.delete(this.kind.id(record));
    }
  }

  /** Marks every record the transcript proves; returns the ones it does not. */
  private async settle(records: T[], session: AgentSession): Promise<T[]> {
    const seen = new Set<string>();
    for (const turn of await session.history()) {
      if (turn.role !== "system" || !turn.origin) continue;
      for (const id of this.kind.proven(turn.origin)) seen.add(id);
    }
    const unproven: T[] = [];
    for (const stale of records) {
      const record = this.kind.reload(this.kind.id(stale)) ?? stale;
      if (!seen.has(this.kind.id(record))) unproven.push(record);
      else if (record.callbackState !== "delivered") this.delivered(record);
    }
    return unproven;
  }

  /** The recipient is waiting for an answer that is now late: the retry itself
   *  is silent, so this line is the only sign it is being retried — and the
   *  ceiling is what ends the retrying out loud. */
  private retry(sessionId: string, batch: T[], error: unknown): void {
    log.warn(`callback to session ${sessionId} failed, will retry`, error);
    for (const stale of batch) {
      const record = this.kind.reload(this.kind.id(stale));
      // Already proven delivered, or already given up on: not a failure.
      if (!record || (record.callbackState !== "pending" && record.callbackState !== "failed")) continue;
      this.failed(record, error);
      this.spent(record, sessionId);
    }
  }

  /** Out of attempts: stop, record why, and report it. An agent waiting on a
   *  result it will never get must not be left waiting on silence. */
  private spent(record: T, sessionId: string): boolean {
    if (record.callbackAttempts < MAX_DELIVERY_ATTEMPTS) return false;
    if (record.callbackState !== "abandoned") {
      record.callbackState = "abandoned";
      record.callbackError = undeliverable(record.callbackAttempts, record.callbackError);
      record.callbackNextAttemptAt = null;
      this.write(record);
      this.unreachable(sessionId, this.kind.describe(record), record.callbackError);
    }
    return true;
  }

  /** Busy target: try again shortly, and do not count it. */
  private defer(record: T): void {
    record.callbackNextAttemptAt = Date.now() + 1000;
    this.kind.save(record);
  }

  /** Handed over, proof pending. Backs off like a failure, so an input the
   *  recipient never records is re-sent on a curve, not once a second. */
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

  /** Counts the attempt too: a target that fails before anything is sent (a
   *  transcript that no longer exists) would otherwise retry at attempt 0 for
   *  as long as the process lives, never reaching the ceiling. */
  private failed(record: T, error: unknown): void {
    record.callbackAttempts += 1;
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
