// Workbench organization state: which sessions show up under Projects, the
// summaries needed to render them without scanning Pi, and which have a
// finished turn no client has looked at yet.
//
// One row per session rather than two JSON files: the unread flag is written at
// the end of every turn, and rewriting a whole file on each of those writes
// loses the entire set when the process dies mid-write — a truncated file reads
// back as "no pins", which is indistinguishable from a fresh install.

import type { DatabaseSync } from "node:sqlite";
import type { SessionSummary } from "../core/types.js";
import { pierDb } from "../db.js";

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

  /** Pin plus the summary Projects needs, atomically in one row. */
  pin(summary: SessionSummary, pinned: boolean): void {
    // A new session joins a project that already has a place in the list.
    // Unranked it would sort on top — lifting the whole project with it, which
    // is the jump manual order exists to stop.
    const sibling = this.#db.prepare(
      "SELECT project_sort AS rank FROM session_state WHERE cwd = ? AND project_sort IS NOT NULL LIMIT 1",
    ).get(summary.cwd) as { rank: number } | undefined;
    this.#db.prepare(
      `INSERT INTO session_state(session_id, pinned, cwd, title, created_at, project_sort)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         pinned = excluded.pinned,
         cwd = excluded.cwd,
         title = COALESCE(excluded.title, session_state.title),
         created_at = excluded.created_at,
         project_sort = COALESCE(session_state.project_sort, excluded.project_sort)`,
    ).run(
      summary.id,
      pinned ? 1 : 0,
      summary.cwd,
      summary.title ?? null,
      summary.createdAt,
      sibling?.rank ?? null,
    );
  }

  /** One drag = one write of the whole list it reordered: index is the place.
   *  `sessions` are ids (a session's place inside its project), `projects` are
   *  cwds, whose place is stamped on every session that has that cwd. */
  reorder(order: { sessions?: string[]; projects?: string[] }): void {
    const bySession = this.#db.prepare("UPDATE session_state SET sort = ? WHERE session_id = ?");
    const byCwd = this.#db.prepare("UPDATE session_state SET project_sort = ? WHERE cwd = ?");
    this.#tx(() => {
      order.sessions?.forEach((id, i) => bySession.run(i, id));
      order.projects?.forEach((cwd, i) => byCwd.run(i, cwd));
    });
  }

  /** Project rows only; unlike AgentFactory.list(), this never touches disk. */
  projects(): (SessionSummary & { unread: boolean; sort?: number; projectSort?: number })[] {
    const rows = this.#db.prepare(
      `SELECT session_id AS id, cwd, title, created_at AS createdAt, unread,
              sort, project_sort AS projectSort
       FROM session_state
       WHERE pinned = 1 AND cwd IS NOT NULL AND created_at IS NOT NULL
       ORDER BY created_at DESC`,
    ).all() as unknown as {
      id: string;
      cwd: string;
      title: string | null;
      createdAt: number;
      unread: number;
      sort: number | null;
      projectSort: number | null;
    }[];
    return rows.map(({ title, unread, sort, projectSort, ...row }) => ({
      ...row,
      ...(title ? { title } : {}),
      ...(sort === null ? {} : { sort }),
      ...(projectSort === null ? {} : { projectSort }),
      unread: unread === 1,
    }));
  }

  /** What to call a session where there is room for one line — a push
   *  notification's title. Falls back to the project directory, then to the
   *  fact that it is a session at all: a notification with no title reads as a
   *  browser bug rather than as an unnamed session. */
  name(sessionId: string): string {
    const row = this.#db.prepare(
      "SELECT title, cwd FROM session_state WHERE session_id = ?",
    ).get(sessionId) as { title: string | null; cwd: string | null } | undefined;
    return row?.title || row?.cwd?.split("/").filter(Boolean).at(-1) || "Pier session";
  }

  needsProjectBackfill(): boolean {
    return this.#db.prepare(
      "SELECT 1 FROM session_state WHERE pinned = 1 AND (cwd IS NULL OR created_at IS NULL) LIMIT 1",
    ).get() !== undefined;
  }

  /** A full listing is rare; use it to repair metadata for rows we already own. */
  remember(summaries: SessionSummary[]): void {
    const update = this.#db.prepare(
      `UPDATE session_state SET
         cwd = ?, title = COALESCE(?, title), created_at = ?
       WHERE session_id = ?`,
    );
    this.#tx(() => {
      for (const s of summaries) update.run(s.cwd, s.title ?? null, s.createdAt, s.id);
    });
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

  flags(): Map<string, { pinned: boolean; unread: boolean; sort?: number; projectSort?: number }> {
    const rows = this.#db.prepare(
      `SELECT session_id AS id, pinned, unread, sort, project_sort AS projectSort
       FROM session_state WHERE pinned = 1 OR unread = 1`,
    ).all() as unknown as {
      id: string;
      pinned: number;
      unread: number;
      sort: number | null;
      projectSort: number | null;
    }[];
    return new Map(rows.map((r) => [r.id, {
      pinned: r.pinned === 1,
      unread: r.unread === 1,
      ...(r.sort === null ? {} : { sort: r.sort }),
      ...(r.projectSort === null ? {} : { projectSort: r.projectSort }),
    }]));
  }

  /** The first prompt supplies the title of a newly-created pinned session. */
  title(sessionId: string, text: string): boolean {
    const result = this.#db.prepare(
      "UPDATE session_state SET title = ? WHERE session_id = ? AND pinned = 1 AND title IS NULL",
    ).run(text.trim().slice(0, 80), sessionId);
    return result.changes > 0;
  }
}
