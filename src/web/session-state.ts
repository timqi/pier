// What the workbench decided about a session, and nothing a transcript already
// knows: a finished turn nobody looked at (`unread`), the rail's working set
// (`sort`), and a session the operator closed out of the rail (`closed`), which
// the next human message reopens. A session enters the set at the front when a
// human speaks to it and it is not already in; members never move relative to
// each other until one is pushed out. Remembered, not derived: any order recomputed from activity
// jumps on every message. `cwd` and `project_sort` are columns nothing reads.

import type { DatabaseSync } from "node:sqlite";
import { pierDb, transact } from "../db.js";

/** Small enough that every member is where a hand can see it: a set as deep as
 *  the page would count a row nobody scrolled to as "already up there". */
export const WORKING_SET = 5;

export interface SessionFlags {
  unread: boolean;
  /** Place in the working set on top of the rail; unset = not in it. */
  rank?: number;
  /** Left out of the rail's listing until a human speaks to it. */
  closed: boolean;
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

  /** Out of the working set too: a hidden member would hold a slot nobody sees,
   *  and the message that reopens it promotes it back to the front. */
  setClosed(sessionId: string, closed: boolean): void {
    this.#db.prepare(
      `INSERT INTO session_state(session_id, closed) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET closed = excluded.closed,
         sort = CASE WHEN excluded.closed = 1 THEN NULL ELSE sort END`,
    ).run(sessionId, closed ? 1 : 0);
  }

  /** Already in the working set: nothing moves. Reopens a closed session — a
   *  message to it must not happen out of sight. Answers whether the rail
   *  changed, so the caller re-lists only when there is something to see. */
  promote(sessionId: string): boolean {
    const reopened = this.#db.prepare(
      "UPDATE session_state SET closed = 0 WHERE session_id = ? AND closed = 1",
    ).run(sessionId).changes > 0;
    // `session_id` breaks a tie migration 20 can leave behind (several rows at -1).
    const ranked = (this.#db.prepare(
      "SELECT session_id AS id FROM session_state WHERE sort IS NOT NULL ORDER BY sort, session_id",
    ).all() as unknown as { id: string }[]).map((r) => r.id);
    if (ranked.includes(sessionId)) return reopened;
    const kept = [sessionId, ...ranked].slice(0, WORKING_SET);
    const evicted = ranked.filter((id) => !kept.includes(id));
    const rank = this.#db.prepare(
      `INSERT INTO session_state(session_id, sort) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET sort = excluded.sort`,
    );
    const drop = this.#db.prepare("UPDATE session_state SET sort = NULL WHERE session_id = ?");
    // Every rank rewritten: a half-renumbered set is an order nobody would recognize.
    transact(this.#db, () => {
      kept.forEach((id, i) => rank.run(id, i));
      for (const id of evicted) drop.run(id);
    });
    return true;
  }

  /** For ghosts: a created-and-never-messaged session cannot be resumed, and
   *  its row would otherwise hold a working-set slot while 404ing forever. */
  forget(sessionId: string): void {
    this.#db.prepare("DELETE FROM session_state WHERE session_id = ?").run(sessionId);
  }

  flags(): Map<string, SessionFlags> {
    const rows = this.#db.prepare(
      `SELECT session_id AS id, unread, sort, closed
       FROM session_state WHERE unread = 1 OR sort IS NOT NULL OR closed = 1`,
    ).all() as unknown as {
      id: string;
      unread: number;
      sort: number | null;
      closed: number;
    }[];
    return new Map(rows.map((r) => [r.id, {
      unread: r.unread === 1,
      closed: r.closed === 1,
      ...(r.sort === null ? {} : { rank: r.sort }),
    }]));
  }

}
