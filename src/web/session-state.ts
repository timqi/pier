// What the workbench decided about a session, and nothing a transcript already
// knows: a finished turn nobody looked at (`unread`), and the rail's working
// set (`sort`). A session enters the set at the front when a human speaks to it
// and it is not already in; members never move relative to each other until one
// is pushed out. Remembered, not derived: any order recomputed from activity
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

  /** Already in the working set: nothing moves. Answers whether the order
   *  changed, so the caller re-lists only when there is something to see. */
  promote(sessionId: string): boolean {
    // `session_id` breaks a tie migration 20 can leave behind (several rows at -1).
    const ranked = (this.#db.prepare(
      "SELECT session_id AS id FROM session_state WHERE sort IS NOT NULL ORDER BY sort, session_id",
    ).all() as unknown as { id: string }[]).map((r) => r.id);
    if (ranked.includes(sessionId)) return false;
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
      `SELECT session_id AS id, unread, sort
       FROM session_state WHERE unread = 1 OR sort IS NOT NULL`,
    ).all() as unknown as {
      id: string;
      unread: number;
      sort: number | null;
    }[];
    return new Map(rows.map((r) => [r.id, {
      unread: r.unread === 1,
      ...(r.sort === null ? {} : { rank: r.sort }),
    }]));
  }

}
