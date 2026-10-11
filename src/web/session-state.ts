// What the workbench decided about a session, and nothing a transcript already
// knows: a finished turn nobody looked at (`unread`), and the browser that
// last spoke into it (`browserOf`, memory only: a restart forgets it).

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";

export interface SessionFlags {
  unread: boolean;
}

export class SessionStateStore {
  readonly #db: DatabaseSync;
  readonly #spoke = new Map<string, string>();

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

  flags(): Map<string, SessionFlags> {
    const rows = this.#db.prepare(
      "SELECT session_id AS id FROM session_state WHERE unread = 1",
    ).all() as unknown as { id: string }[];
    return new Map(rows.map((r) => [r.id, { unread: true }]));
  }

  /** `browser` is the web auth session id (`sessionIdOf`, web/auth.ts). */
  spokeFrom(sessionId: string, browser: string): void {
    this.#spoke.set(sessionId, browser);
  }

  browserOf(sessionId: string): string | undefined {
    return this.#spoke.get(sessionId);
  }
}
