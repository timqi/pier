// One Pier per instance directory: the ownership claim, taken before anything
// under PIER_HOME is opened. A pid file, because Node's stdlib has no advisory
// locking and the pid is what makes a crashed holder's claim reclaimable.

import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PIER_LOCK } from "./paths.js";

/** `heldBy` is a pid that answered signal 0 — the caller owns nothing in the
 *  directory, the database included. `null` only where the file named no pid a
 *  losing racer could still read. */
export type InstanceLock = { release: () => void } | { heldBy: number | null };

/** Unreadable, gone, or not a pid: no holder anyone can name, so the file is
 *  not evidence of one. */
function holder(file: string | number): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
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

/** The pid is written to a private file and hard-linked into place: the link
 *  either creates the lock with the pid already in it or fails EEXIST, so no
 *  racer can ever read an empty lock. */
function take(path: string): { release: () => void } | null {
  const mine = `${path}.${String(process.pid)}`;
  writeFileSync(mine, `${String(process.pid)}\n`, { mode: 0o600 });
  try {
    linkSync(mine, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  } finally {
    rmSync(mine, { force: true });
  }
  // Only ours: a stale-lock takeover elsewhere may have replaced the file.
  return {
    release: () => {
      if (holder(path) === process.pid) rmSync(path, { force: true });
    },
  };
}

/** Moves the stale file aside under a name only this pid uses — never an unlink
 *  in place — then checks it moved the inode it read; a racer's fresh claim that
 *  landed in between goes straight back. ENOENT is the other reclaimer winning. */
function reclaim(path: string, fd: number): void {
  const aside = `${path}.${String(process.pid)}.stale`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (statSync(aside, { bigint: true }).ino === fstatSync(fd, { bigint: true }).ino) rmSync(aside, { force: true });
  else renameSync(aside, path);
}

export function acquireInstanceLock(path: string = PIER_LOCK): InstanceLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const first = take(path);
  if (first) return first;
  // Held open across the reclaim: an open inode cannot be reused by a new file,
  // so the comparison in `reclaim` is exact.
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
  } catch {
    fd = undefined;
  }
  if (fd !== undefined) {
    try {
      const pid = holder(fd);
      if (pid !== null && alive(pid)) return { heldBy: pid };
      reclaim(path, fd);
    } finally {
      closeSync(fd);
    }
  }
  // The retry can only lose to another start that claimed the same directory.
  return take(path) ?? { heldBy: holder(path) };
}
