// Where Pier keeps its state, resolved once.
//
// This is process configuration, not a per-call decision: the same
// `PIER_HOME ?? ~/.pier` line had grown six copies, one per module that needed
// a file, and no area could own the fix — channels/ must not import tasks/,
// web/ must not import channels/. So it lives in a leaf that everything may
// depend on and that depends on nothing.

import { homedir } from "node:os";
import { join } from "node:path";

/** `$PIER_HOME`, or `~/.pier`. Fixed for the life of the process. */
export const PIER_HOME = process.env.PIER_HOME ?? join(homedir(), ".pier");

/** A path inside it — `pierPath("boards")`. */
export const pierPath = (...parts: string[]): string => join(PIER_HOME, ...parts);

/** The one SQLite file; every store opens this same path. */
export const PIER_DB = pierPath("pier.db");
