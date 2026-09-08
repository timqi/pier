// What the workbench decided about a session, and nothing a transcript already
// knows. Stuck to the top of the rail (`pinned`), a finished turn nobody has
// looked at (`unread`), and the place a hand dragged it to up there (`sort`).
//
// It used to mirror the summary too — cwd, title, created_at, last_active —
// because listing sessions meant parsing every transcript on disk (~237ms) and
// the rail could not pay that on every read. agent/listing.ts made a listing
// cheap, so the mirror bought nothing and cost two stores kept in step: a
// backfill gate, a repair pass on every full listing, a touch at the end of
// every turn, a title write on the first prompt, a second write on rename.
// Deriving beats syncing; all of it is gone.
//
// `cwd` and `project_sort` stayed as columns nothing reads: they keyed the
// per-directory order the rail no longer has (migration 19).
//
// One row per session rather than two JSON files: the unread flag is written at
// the end of every turn, and rewriting a whole file on each of those writes
// loses the entire set when the process dies mid-write — a truncated file reads
// back as "no pins", which is indistinguishable from a fresh install.

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";

export interface SessionFlags {
  pinned: boolean;
  unread: boolean;
  sort?: number;
}

export class SessionStateStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  unread(sessionId: string): boolean {
    const row = this.#db.prepare(
      "SELECT unread FROM session_state WHERE session_id = ?",
    ).get(sessionId) as { unread: number } | undefined;
    return row?.unread === 1;
  }

  setUnread(sessionId: string, unread: boolean): void {
    this.#db.prepare(
      `INSERT INTO session_state(session_id, unread) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET unread = excluded.unread`,
    ).run(sessionId, unread ? 1 : 0);
  }

  /** Stuck to the top, or let go. Nothing expires: what is pinned stays on top
   *  until a hand unpins it. */
  pin(sessionId: string, pinned: boolean): void {
    this.#db.prepare(
      `INSERT INTO session_state(session_id, pinned) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned`,
    ).run(sessionId, pinned ? 1 : 0);
  }

  /** One drag = one write of the whole pinned list it reordered: index is the
   *  place. */
  reorder(sessions: string[]): void {
    const bySession = this.#db.prepare("UPDATE session_state SET sort = ? WHERE session_id = ?");
    this.#tx(() => sessions.forEach((id, i) => bySession.run(i, id)));
  }

  /** Drop a session's organization row entirely — pin, order, unread. For
   *  ghosts: Pi persists a session only once its first assistant reply lands,
   *  so a created-and-never-messaged one cannot be resumed, and its remembered
   *  row would otherwise sit in the rail 404ing forever. */
  forget(sessionId: string): void {
    this.#db.prepare("DELETE FROM session_state WHERE session_id = ?").run(sessionId);
  }

  /** All-or-nothing: a half-written order is a list nobody arranged. */
  #tx(run: () => void): void {
    this.#db.exec("BEGIN");
    try {
      run();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** What this store knows about the sessions it knows anything about, for a
   *  caller holding the listing. */
  flags(): Map<string, SessionFlags> {
    const rows = this.#db.prepare(
      `SELECT session_id AS id, pinned, unread, sort
       FROM session_state WHERE pinned = 1 OR unread = 1`,
    ).all() as unknown as {
      id: string;
      pinned: number;
      unread: number;
      sort: number | null;
    }[];
    return new Map(rows.map((r) => [r.id, {
      pinned: r.pinned === 1,
      unread: r.unread === 1,
      ...(r.sort === null ? {} : { sort: r.sort }),
    }]));
  }

}
