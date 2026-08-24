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
    this.#db.prepare(
      `INSERT INTO session_state(session_id, pinned, cwd, title, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         pinned = excluded.pinned,
         cwd = excluded.cwd,
         title = COALESCE(excluded.title, session_state.title),
         created_at = excluded.created_at`,
    ).run(summary.id, pinned ? 1 : 0, summary.cwd, summary.title ?? null, summary.createdAt);
  }

  /** Project rows only; unlike AgentFactory.list(), this never touches disk. */
  projects(): (SessionSummary & { unread: boolean })[] {
    const rows = this.#db.prepare(
      `SELECT session_id AS id, cwd, title, created_at AS createdAt, unread
       FROM session_state
       WHERE pinned = 1 AND cwd IS NOT NULL AND created_at IS NOT NULL
       ORDER BY created_at DESC`,
    ).all() as unknown as {
      id: string;
      cwd: string;
      title: string | null;
      createdAt: number;
      unread: number;
    }[];
    return rows.map(({ title, unread, ...row }) => ({
      ...row,
      ...(title ? { title } : {}),
      unread: unread === 1,
    }));
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
    this.#db.exec("BEGIN");
    try {
      for (const s of summaries) update.run(s.cwd, s.title ?? null, s.createdAt, s.id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  flags(): Map<string, { pinned: boolean; unread: boolean }> {
    const rows = this.#db.prepare(
      "SELECT session_id AS id, pinned, unread FROM session_state WHERE pinned = 1 OR unread = 1",
    ).all() as unknown as { id: string; pinned: number; unread: number }[];
    return new Map(rows.map((r) => [r.id, { pinned: r.pinned === 1, unread: r.unread === 1 }]));
  }

  /** The first prompt supplies the title of a newly-created pinned session. */
  title(sessionId: string, text: string): boolean {
    const result = this.#db.prepare(
      "UPDATE session_state SET title = ? WHERE session_id = ? AND pinned = 1 AND title IS NULL",
    ).run(text.trim().slice(0, 80), sessionId);
    return result.changes > 0;
  }
}
