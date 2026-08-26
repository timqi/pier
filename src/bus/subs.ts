// Delivery bookkeeping: who hears about a bus write (bus_subs) and which
// pointer notifications are still owed (bus_notes). Queries only — matching
// policy lives in delivery.ts, the tables in db.ts (migration 8).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CallbackFields } from "../tasks/types.js";
import { pierDb } from "../db.js";

export type BusSubMode = "steer" | "queue" | "wake";

export interface BusSub {
  id: string;
  sessionId: string;
  topicGlob: string;
  mode: BusSubMode;
  /** Pinned at subscribe time: a cursor is just an id, and a scope set that
   * grew mid-stream would silently skip the new scope's history. */
  scopes: string[];
  /** Last event id the subscriber acked; '' means everything is unread. */
  cursor: string;
  createdAt: string;
}

/** One owed notification. At most one open per subscription — coalescing is
 * the row, not a counter: the count is computed against the sub's cursor at
 * delivery time, so it is true when read. */
export interface BusNote extends CallbackFields {
  id: string;
  subId: string;
  sessionId: string;
  topicGlob: string;
  mode: BusSubMode;
  scopes: string[];
  /** The newest event at notify time — what a reactive publish names as caused_by. */
  lastEventId: string;
  createdAt: number;
}

interface SubRow {
  id: string;
  session_id: string;
  topic_glob: string;
  mode: BusSubMode;
  scopes: string;
  cursor: string;
  created_at: string;
}

const subOf = (row: SubRow): BusSub => ({
  id: row.id,
  sessionId: row.session_id,
  topicGlob: row.topic_glob,
  mode: row.mode,
  scopes: JSON.parse(row.scopes) as string[],
  cursor: row.cursor,
  createdAt: row.created_at,
});

export class SubStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  /** Create or re-point a subscription; re-subscribing updates mode and scopes
   * but keeps the cursor — the reader's progress is theirs, not the pattern's. */
  upsert(sessionId: string, topicGlob: string, mode: BusSubMode, scopes: string[], cursor: string): BusSub {
    this.#db.prepare(`
      INSERT INTO bus_subs(id, session_id, topic_glob, mode, scopes, cursor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, topic_glob) DO UPDATE SET
        mode = excluded.mode, scopes = excluded.scopes
    `).run(randomUUID(), sessionId, topicGlob, mode, JSON.stringify(scopes), cursor, new Date().toISOString());
    return this.get(sessionId, topicGlob)!;
  }

  get(sessionId: string, topicGlob: string): BusSub | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM bus_subs WHERE session_id = ? AND topic_glob = ?",
    ).get(sessionId, topicGlob) as unknown as SubRow | undefined;
    return row ? subOf(row) : undefined;
  }

  bySubId(id: string): BusSub | undefined {
    const row = this.#db.prepare("SELECT * FROM bus_subs WHERE id = ?").get(id) as unknown as SubRow | undefined;
    return row ? subOf(row) : undefined;
  }

  list(sessionId: string): BusSub[] {
    const rows = this.#db.prepare(
      "SELECT * FROM bus_subs WHERE session_id = ? ORDER BY created_at",
    ).all(sessionId) as unknown as SubRow[];
    return rows.map(subOf);
  }

  /** Removes the subscription and the notifications it still owed — a reader
   * that unsubscribed asked not to be woken. Returns false when nothing was there. */
  remove(sessionId: string, topicGlob: string): boolean {
    const sub = this.get(sessionId, topicGlob);
    if (!sub) return false;
    this.#db.prepare("DELETE FROM bus_notes WHERE sub_id = ?").run(sub.id);
    this.#db.prepare("DELETE FROM bus_subs WHERE id = ?").run(sub.id);
    return true;
  }

  /** Confirms progress: get never moves a cursor, only ack does. */
  ack(sessionId: string, topicGlob: string, cursor: string): BusSub {
    const sub = this.get(sessionId, topicGlob);
    if (!sub) throw new Error(`no subscription on '${topicGlob}' — subscribe first`);
    this.#db.prepare("UPDATE bus_subs SET cursor = ? WHERE id = ?").run(cursor, sub.id);
    return { ...sub, cursor };
  }

  /** Subscriptions a write must notify: pattern matches, scope pinned, and
   * never the writer itself — its own transcript already shows the write. */
  matching(topic: string, scope: string, writerSession: string): BusSub[] {
    const rows = this.#db.prepare(
      "SELECT * FROM bus_subs WHERE ? GLOB topic_glob AND session_id != ?",
    ).all(topic, writerSession) as unknown as SubRow[];
    return rows.map(subOf).filter((sub) => sub.scopes.includes(scope));
  }

  saveNote(note: BusNote): void {
    // An unsubscribe can race a delivery still holding this object; the
    // engine's bookkeeping write must not resurrect the deleted row.
    if (!this.bySubId(note.subId)) return;
    this.#db.prepare(`
      INSERT INTO bus_notes(id, sub_id, session_id, state, next_attempt_at, json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, next_attempt_at = excluded.next_attempt_at, json = excluded.json
    `).run(note.id, note.subId, note.sessionId, note.callbackState, note.callbackNextAttemptAt, JSON.stringify(note));
  }

  getNote(id: string): BusNote | undefined {
    const row = this.#db.prepare("SELECT json FROM bus_notes WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BusNote : undefined;
  }

  /** The open (undelivered, not given up) note for a subscription, if any. */
  openNote(subId: string): BusNote | undefined {
    const row = this.#db.prepare(
      "SELECT json FROM bus_notes WHERE sub_id = ? AND state IN ('pending', 'failed') LIMIT 1",
    ).get(subId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BusNote : undefined;
  }

  /** Notes whose retry is due — the delivery sweep's worklist. */
  dueNotes(now: number): BusNote[] {
    const rows = this.#db.prepare(`
      SELECT json FROM bus_notes
      WHERE state IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).all(now) as unknown as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as BusNote);
  }
}
