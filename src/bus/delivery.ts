// Write-triggers-notify: a publish finds its subscribers and each is owed one
// pointer — never the payload, only "n new events on this pattern, read with
// log, then ack". Delivery itself is the tasks outbox engine (proof, backoff,
// ceiling); this file owns only the bus vocabulary around it.

import { randomUUID } from "node:crypto";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { Outbox } from "../tasks/outbox.js";
import type { BusEvent, BusStore } from "./store.js";
import type { BusNote, BusSub, SubStore } from "./subs.js";

const log = logger("bus");

export class BusDelivery {
  readonly #outbox: Outbox<BusNote>;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    router: Router,
    private readonly events: BusStore,
    private readonly subs: SubStore,
    unreachable: (sessionId: string, what: string, why: string) => void,
    /** The capability switch: off freezes delivery — owed notes keep their
     * attempts and resume when the operator re-enables, rather than being
     * spent against sessions that were told the bus is off. */
    private readonly enabled: () => boolean = () => true,
  ) {
    this.#outbox = new Outbox<BusNote>(router, {
      id: (note) => note.id,
      reload: (id) => this.subs.getNote(id),
      save: (note) => { this.subs.saveNote(note); },
      // No surface renders a note's lifecycle — the recipient sees the input,
      // the operator sees `unreachable` when it gives up. Nothing to emit.
      changed: () => {},
      proven: (origin) => (origin.kind === "bus-notify" ? origin.noteIds : []),
      urgency: (note) => (note.mode === "steer" ? "steer" : "followUp"),
      // One line per subscription even when it is owed several notes (a note
      // sent into the proof window plus the fresh one a newer event opened):
      // the count is against the sub's cursor, so a second line says nothing.
      input: (notes) => {
        const seen = new Set<string>();
        const lines = notes
          .filter((note) => !seen.has(note.subId) && seen.add(note.subId))
          .map((note) => this.text(note));
        return {
          text: lines.join("\n"),
          origin: { kind: "bus-notify", noteIds: notes.map((note) => note.id) },
        };
      },
      describe: (note) => `bus events on '${note.topicGlob}'`,
    }, unreachable);
  }

  /** Fans a fresh write out to its subscribers. One open note per sub is the
   * coalescing: a subscriber that is already owed a pointer is not owed two. */
  notify(event: BusEvent): void {
    if (!this.enabled()) return;
    for (const sub of this.subs.matching(event.topic, event.scope, event.writerSession)) {
      const open = this.subs.openNote(sub.id);
      // Coalesce only into a note nothing has been done with. A sent-but-
      // unproven note may settle any moment — the transcript proves its id,
      // not the cursor — so an event absorbed into it in that window would
      // never wake anyone again.
      if (open && open.callbackAttempts === 0) {
        open.lastEventId = event.id;
        this.subs.saveNote(open);
      } else {
        this.subs.saveNote(this.note(sub, event));
      }
      void this.deliver(sub.sessionId).catch((err: unknown) =>
        log.error(`bus delivery to session ${sub.sessionId} failed`, err));
    }
  }

  /** Everything *due* to one session rides in one input. Due, not pending:
   * a fresh note (no attempt yet) is due immediately, but a chatty topic must
   * not burn an unrelated failing note's attempts off its backoff curve. */
  async deliver(sessionId: string, now = Date.now()): Promise<void> {
    const batch = this.subs.dueNotes(now)
      .filter((note) => note.sessionId === sessionId)
      .filter((note) => this.stillOwed(note));
    if (batch.length > 0) await this.#outbox.deliver(sessionId, batch);
  }

  /** Crash recovery and retry backoff, swept like the tasks service does. */
  recover(now = Date.now()): void {
    if (!this.enabled()) return;
    for (const sessionId of new Set(this.subs.dueNotes(now).map((note) => note.sessionId))) {
      void this.deliver(sessionId, now).catch((err: unknown) =>
        log.error(`bus delivery sweep for session ${sessionId} failed`, err));
    }
  }

  start(tickMs = 1000): void {
    this.#timer = setInterval(() => { this.recover(); }, tickMs);
    this.#timer.unref();
    this.recover();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** A reader that caught up on its own (log + ack) is not woken for nothing:
   * the note is settled as delivered without ever becoming an input. */
  private stillOwed(note: BusNote): boolean {
    const sub = this.subs.bySubId(note.subId);
    if (sub && this.events.countSince(sub.topicGlob, sub.scopes, sub.cursor) > 0) return true;
    note.callbackState = "delivered";
    note.callbackNextAttemptAt = null;
    this.subs.saveNote(note);
    return false;
  }

  private note(sub: BusSub, event: BusEvent): BusNote {
    return {
      id: randomUUID(),
      subId: sub.id,
      sessionId: sub.sessionId,
      topicGlob: sub.topicGlob,
      mode: sub.mode,
      scopes: sub.scopes,
      lastEventId: event.id,
      createdAt: Date.now(),
      callbackState: "pending",
      callbackAttempts: 0,
      callbackError: null,
      callbackNextAttemptAt: null,
    };
  }

  /** The pointer: count is computed against the sub's cursor and *current*
   * pinned scopes at render time, so it is true when read, not when queued —
   * and it agrees with what the reader's log will return, which honors the
   * same pinned set (bus/tool.ts). */
  private text(note: BusNote): string {
    const sub = this.subs.bySubId(note.subId);
    const cursor = sub?.cursor ?? "";
    const count = this.events.countSince(note.topicGlob, sub?.scopes ?? note.scopes, cursor);
    return [
      `[bus] ${count} new event${count === 1 ? "" : "s"} on '${note.topicGlob}'${cursor ? ` since ${cursor}` : ""}.`,
      `Read with bus log {topic_glob: '${note.topicGlob}', after: '${cursor}'}, then ack {topic_glob, cursor}.`,
      `If you publish in reaction, pass caused_by: '${note.lastEventId}'.`,
    ].join(" ");
  }
}
