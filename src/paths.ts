// Where Pier keeps its state, resolved once, in a leaf every area may import.

import { homedir } from "node:os";
import { join } from "node:path";

/** Empty is unset, not a value: `PIER_HOME=` would otherwise resolve every
 *  path relative to the working directory. */
export const resolveHome = (value: string | undefined, home: string = homedir()): string =>
  value || join(home, ".pier");

export const PIER_HOME = resolveHome(process.env.PIER_HOME);

export const pierPath = (...parts: string[]): string => join(PIER_HOME, ...parts);

/** In its own directory so db.ts can lock it down to 0700 without touching
 *  the boards PIER_HOME also holds. */
export const PIER_DB = pierPath("db", "pier.db");

/** `PI_CODING_AGENT_DIR` is an operator override — unless it equals
 *  `PIER_AGENT_DIR`, the value Pier itself set: then a Pier spawned from inside
 *  another inherited it, and a leak is not an instruction. */
export function resolveAgentDir(
  env: { PI_CODING_AGENT_DIR?: string; PIER_AGENT_DIR?: string },
  derived: string = pierPath("pi"),
): string {
  const given = env.PI_CODING_AGENT_DIR;
  return !given || given === env.PIER_AGENT_DIR ? derived : given;
}
