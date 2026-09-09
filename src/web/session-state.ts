// What the workbench decided about a session, and nothing a transcript already
// knows. A finished turn nobody has looked at (`unread`), and the rail's
// working set: the rank of a row kept on top (`sort`).
//
// The working set replaced pinning and dragging. Ordering the rail by activity
// made it jump — a scheduled task, a subagent, anyone's Slack message moved the
// row somebody was about to click — and ordering it by hand asked for the
// arranging. So: a session enters the set at the front when a human speaks to
// it and it is not in the set already, and members never move relative to each
// other until one is pushed out of the last slot. A three-week-old session is
// back on top the moment it is used; the four you switch between hold still.
//
// Remembered rather than derived on purpose: "the last time a human spoke" is
// there in the transcript and still jumps, because it reorders on every
// message. Only an order nothing recomputes can hold still.
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
// The rank does not bring that back: it is written only when a session outside
// the set is spoken to, not once per turn.
//
// One row per session rather than two JSON files: the unread flag is written at
// the end of every turn, and rewriting a whole file on each of those writes
// loses the entire set when the process dies mid-write — a truncated file reads
// back as "nothing on top", which is indistinguishable from a fresh install.

import type { DatabaseSync } from "node:sqlite";
import { pierDb, transact } from "../db.js";

/** How many rows the rail keeps on top. The handful anybody actually switches
 *  between, and small enough that every member is somewhere a hand can see: a
 *  set as deep as the page (20) would count a row nobody has scrolled to as
 *  "already up there" and never bring it back. */
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

  /** A human spoke to this session. Already in the working set → nothing moves
   *  and nothing is written; otherwise it takes the front slot and whatever
   *  sat in the last one falls out. Answers whether the order changed, so the
   *  caller broadcasts a re-list only when there is something to see. */
  promote(sessionId: string): boolean {
    // `session_id` breaks a tie the migration can leave behind: several pinned
    // rows nobody ever dragged share rank -1 until the first promotion
    // renumbers them.
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
    // Every rank rewritten rather than the new one prepended: the places are
    // 0..n and a half-renumbered set is an order nobody would recognize.
    transact(this.#db, () => {
      kept.forEach((id, i) => rank.run(id, i));
      for (const id of evicted) drop.run(id);
    });
    return true;
  }

  /** Drop a session's organization row entirely — rank and unread. For
   *  ghosts: Pi persists a session only once its first assistant reply lands,
   *  so a created-and-never-messaged one cannot be resumed, and its remembered
   *  row would otherwise sit in the rail 404ing forever — holding a slot in the
   *  working set while it does. */
  forget(sessionId: string): void {
    this.#db.prepare("DELETE FROM session_state WHERE session_id = ?").run(sessionId);
  }

  /** What this store knows about the sessions it knows anything about, for a
   *  caller holding the listing. */
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
