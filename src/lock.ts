// One Pier per instance directory: the ownership claim, taken before anything
// under PIER_HOME is opened. A pid file, because Node's stdlib has no advisory
// locking and the pid is what makes a crashed holder's claim reclaimable.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PIER_LOCK } from "./paths.js";

/** `heldBy` is a pid that answered signal 0 — the caller owns nothing in the
 *  directory, the database included. `null` only where the file named no pid a
 *  losing racer could still read. */
export type InstanceLock = { release: () => void } | { heldBy: number | null };

/** Unreadable, gone, or not a pid: no holder anyone can name, so the file is
 *  not evidence of one. */
function holder(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** EPERM is a live process owned by someone else; only ESRCH proves it is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `wx` is the atomic half: whoever creates the file owns the directory, and
 *  everyone else reads the winner's pid out of it. */
function take(path: string): { release: () => void } | null {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
  try {
    writeSync(fd, `${String(process.pid)}\n`);
  } finally {
    closeSync(fd);
  }
  // Only ours: a stale-lock takeover elsewhere may have replaced the file.
  return {
    release: () => {
      if (holder(path) === process.pid) rmSync(path, { force: true });
    },
  };
}

export function acquireInstanceLock(path: string = PIER_LOCK): InstanceLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const first = take(path);
  if (first) return first;
  const pid = holder(path);
  if (pid !== null && alive(pid)) return { heldBy: pid };
  rmSync(path, { force: true });
  // The retry can only lose to another start reclaiming the same stale file.
  return take(path) ?? { heldBy: holder(path) };
}
