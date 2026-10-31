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

/** `GET /api/chains`, and what `PUT /api/chains/mode` answers: active chains
 *  first, newest user message first, then the archived. */
export interface ChainList {
  mode: "session" | "chain";
  chains: ChainInfo[];
}

/** A chain `PUT /api/chains/mode` would archive, in its 409's `chains`. */
export interface ChainOpen {
  id: string;
  name: string;
  open: number;
  waiting: number;
}
