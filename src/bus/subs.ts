// Delivery bookkeeping: who hears about a bus write (bus_subs) and which
// pointer notifications are still owed (bus_notes). Queries only — matching
// policy lives in delivery.ts, the tables in db.ts (migration 8).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CallbackFields } from "../tasks/types.js";
import { pierDb } from "../db.js";
// The admin pages are one surface across two stores; the ceiling and the
// search predicate are shared so the halves cannot disagree (bus/store.ts).
import { adminCap as cap, adminMatch } from "./store.js";

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

  /** Retires a subscription whose session nothing can reach: the sub and the
   * notes still owed go, but abandoned notes stay — the record of the failure
   * remains visible in adminNotes (AGENTS.md 5b). Distinct from remove():
   * that is the reader asking, this is the delivery engine concluding the
   * reader is gone (delivery.ts owns the when and the log line). Returns
   * false when already retired, so the caller logs it once. */
  retire(subId: string): boolean {
    if (!this.bySubId(subId)) return false;
    this.#db.prepare(
      "DELETE FROM bus_notes WHERE sub_id = ? AND (state IS NULL OR state != 'abandoned')",
    ).run(subId);
    this.#db.prepare("DELETE FROM bus_subs WHERE id = ?").run(subId);
    return true;
  }

  /** Confirms progress: get never moves a cursor, only ack does — and only
   * forward. An ack at or below the current cursor would silently reopen the
   * confirmed backlog and re-trigger a wake for events already read; refusing
   * here, not in the tool, so no caller can move a cursor backwards. ULIDs
   * compare lexicographically and '' means everything unread, so any real id
   * passes a fresh subscription. */
  ack(sessionId: string, topicGlob: string, cursor: string): BusSub {
    const sub = this.get(sessionId, topicGlob);
    if (!sub) throw new Error(`no subscription on '${topicGlob}' — subscribe first`);
    if (cursor <= sub.cursor) {
      throw new Error(`cursor must advance — the subscription is already at '${sub.cursor}'`);
    }
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

  /** The *unsent* open note for a subscription — the only one a new event may
   * coalesce into. A sent or failed note (attempts > 0) may settle any moment,
   * and an arbitrary open row here would fan new events out into one note
   * each instead of coalescing them. */
  unsentNote(subId: string): BusNote | undefined {
    const row = this.#db.prepare(`
      SELECT json FROM bus_notes
      WHERE sub_id = ? AND state = 'pending'
        AND json_extract(json, '$.callbackAttempts') = 0 LIMIT 1
    `).get(subId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as BusNote : undefined;
  }

  // Read-only, fence-free admin queries for the Console's Bus view; the reason
  // there is no session fence is recorded once, in bus/store.ts.

  /** Subscriptions, newest first, capped: a row lives until its reader
   * unsubscribes or an abandoned delivery retires it (delivery.ts), so the
   * table still grows with the months — and each row costs the caller one
   * countSince, which is the real reason for a ceiling. */
  adminSubs(limit = 200, q = ""): { rows: BusSub[]; total: number } {
    const match = adminMatch(["session_id", "topic_glob", "mode", "scopes"], q);
    const where = match.sql ? `WHERE ${match.sql}` : "";
    const total = this.#db.prepare(`SELECT COUNT(*) AS n FROM bus_subs ${where}`)
      .get(...match.args) as { n: number };
    const rows = this.#db.prepare(
      `SELECT * FROM bus_subs ${where} ORDER BY created_at DESC, session_id, topic_glob LIMIT ?`,
    ).all(...match.args, cap(limit)) as unknown as SubRow[];
    return { rows: rows.map(subOf), total: total.n };
  }

  /** Notes still owed or given up on — settled ones only. Abandoned first,
   * then newest: nothing ever deletes an abandoned note, so on a long-lived
   * instance they are also the *oldest* rows, and a plain newest-first page
   * would truncate away exactly the failures this list exists to show
   * (AGENTS.md 5b). */
  adminNotes(limit = 100, q = ""): { notes: BusNote[]; total: number } {
    // Named columns, not the whole JSON document: matching that would also hit
    // internal ids, and a search that answers with rows the searcher cannot
    // see the reason for is worse than one that misses.
    const match = adminMatch([
      "session_id",
      "state",
      "json_extract(json, '$.topicGlob')",
      "json_extract(json, '$.callbackError')",
    ], q);
    const open = `WHERE (state IS NULL OR state != 'delivered')${match.sql ? ` AND ${match.sql}` : ""}`;
    const total = this.#db.prepare(`SELECT COUNT(*) AS n FROM bus_notes ${open}`)
      .get(...match.args) as { n: number };
    const rows = this.#db.prepare(`
      SELECT json FROM bus_notes ${open}
      ORDER BY (state = 'abandoned') DESC, json_extract(json, '$.createdAt') DESC
      LIMIT ?
    `).all(...match.args, cap(limit)) as unknown as { json: string }[];
    return { notes: rows.map((row) => JSON.parse(row.json) as BusNote), total: total.n };
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
