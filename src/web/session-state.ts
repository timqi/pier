// Workbench organization state: which sessions show up under Projects (created
// in Pier means pinned, everything else waits in All sessions) and which have
// a finished turn no client has looked at yet.
//
// One row per session rather than two JSON files: the unread flag is written at
// the end of every turn, and rewriting a whole file on each of those writes
// loses the entire set when the process dies mid-write — a truncated file reads
// back as "no pins", which is indistinguishable from a fresh install.

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";

/** One durable boolean per session, two of them. */
export type SessionFlag = "pinned" | "unread";

// Written out per flag rather than interpolated: the union type only holds at
// compile time, and a cast at some future route is all it would take to put
// request text into SQL.
const SQL = {
  pinned: {
    has: "SELECT pinned AS on_ FROM session_state WHERE session_id = ?",
    set: `INSERT INTO session_state(session_id, pinned) VALUES (?, ?)
          ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned`,
  },
  unread: {
    has: "SELECT unread AS on_ FROM session_state WHERE session_id = ?",
    set: `INSERT INTO session_state(session_id, unread) VALUES (?, ?)
          ON CONFLICT(session_id) DO UPDATE SET unread = excluded.unread`,
  },
} as const satisfies Record<SessionFlag, { has: string; set: string }>;

export class SessionStateStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  has(flag: SessionFlag, sessionId: string): boolean {
    const row = this.#db.prepare(SQL[flag].has).get(sessionId) as { on_: number } | undefined;
    return row?.on_ === 1;
  }

  set(flag: SessionFlag, sessionId: string, on: boolean): void {
    // Upsert on the flag alone: the row may already exist for the other one,
    // and a session's two flags are set from unrelated places.
    this.#db.prepare(SQL[flag].set).run(sessionId, on ? 1 : 0);
  }
}
