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

/** The desk folder: the dispatcher conversation's cwd, and its identity —
 *  its `AGENTS.md` is the prompt, its `projects.md` the routing index
 *  (docs/design/06-desk.md). Nothing stores that it exists; the folder is the
 *  record. */
export const DESK_DIR = pierPath("desk");

/** The one SQLite file; every store opens this same path. In its own
 *  directory so db.ts can lock that directory down to 0700 without touching
 *  the boards PIER_HOME also holds. */
export const PIER_DB = pierPath("db", "pier.db");

/**
 * Which Pi agent dir this process should use, given its environment.
 *
 * `PI_CODING_AGENT_DIR` is an operator override and wins — but Pier exports it
 * for the SDK, so everything Pier spawns inherits it, and a Pier started from
 * inside another one would take the parent's agent dir however different its
 * own PIER_HOME is. `PIER_AGENT_DIR` carries the value Pier itself set: when
 * the two match, the variable is a leak rather than an instruction, and this
 * instance derives its own. Pure, because the rule is worth a test and the
 * process only gets to apply it once (main.ts).
 */
export function resolveAgentDir(
  env: { PI_CODING_AGENT_DIR?: string; PIER_AGENT_DIR?: string },
  derived: string = pierPath("pi"),
): string {
  const given = env.PI_CODING_AGENT_DIR;
  return !given || given === env.PIER_AGENT_DIR ? derived : given;
}
