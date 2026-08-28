// The shapes web's HTTP answers carry beyond the stores they come from — the
// area's own wire vocabulary, and the one file in web/ the browser may import
// type-only (docs/architecture.md, same rule as tasks/types.ts). Nothing here
// runs: no imports, no values, so a page pays nothing for reading it.

/**
 * What became of the install a switch asked for.
 *
 * `waiting` is its own state on purpose: a sync was already running, so this
 * change goes in the run right after it — which is neither a failure nor the
 * bare "saved" that used to be the last thing anyone was told while nothing
 * happened.
 */
export type ToolsSyncNote =
  | { state: "started" }
  | { state: "waiting" }
  | { state: "refused"; reason: string };
