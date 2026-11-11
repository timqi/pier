// The area's own wire vocabulary, and the one file in web/ the browser may
// import type-only (docs/architecture.md). No imports, no values.

/** `waiting`: a sync was already running and this change goes in the run
 *  right after it — neither a failure nor a bare "saved". */
export type ToolsSyncNote =
  | { state: "started" }
  | { state: "waiting" }
  | { state: "refused"; reason: string };

/** Settings -> Agent configuration subscription, without credential material. */
export interface ConfigSyncStatus {
  publishedPath: string | null;
  sourceUrl: string;
  enabled: boolean;
  lastChecked: number | null;
  lastApplied: number | null;
  error: string | null;
  needsReload: boolean;
  taskId?: string | null;
  nextRunAt?: number | null;
  publicUrl?: string;
}

/** One row of `GET /api/chains`: `head` absent before the chain's first message,
 *  `waiting` its open items waiting on you, `unread` its head's reply not viewed yet. */
export interface ChainInfo {
  id: string;
  name: string;
  createdAt: number;
  archivedAt?: number;
  lastUserAt?: number;
  head?: { sessionId: string; state: "idle" | "streaming" };
  unread: boolean;
  waiting: number;
}

/** `GET /api/chains`: active chains first, newest user message first, then the archived. */
export interface ChainList {
  chains: ChainInfo[];
}

/** `GET` and `PUT /api/chains/:id/charter`: `text` empty for none; the `PUT` adds `head`,
 *  whether the chain has a head, which keeps the old charter until the next. */
export interface Charter {
  text: string;
  head?: boolean;
}
