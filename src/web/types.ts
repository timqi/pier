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
