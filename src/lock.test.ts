// The invariant is the directory, not the port: a second Pier told to listen
// elsewhere is still a second writer of these files, so the claim never sees a
// port at all.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "./lock.js";

const dirs = new Set<string>();
const lockPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pier-lock-"));
  dirs.add(dir);
  return join(dir, "pier.lock");
};

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

/** A pid that is certainly gone: Linux hands them out in ascending order, so a
 *  child that has already exited cannot be alive again. */
const deadPid = (): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("close", () => resolve(child.pid ?? 0));
  });

const pidIn = (path: string): number => Number(readFileSync(path, "utf8").trim());

describe("acquireInstanceLock", () => {
  it("refuses a second holder and names the pid that owns the directory", () => {
    const path = lockPath();
    const first = acquireInstanceLock(path);
    expect(first).toEqual({ release: expect.any(Function) });

    expect(acquireInstanceLock(path)).toEqual({ heldBy: process.pid });
  });

  it("reclaims a claim whose holder crashed", async () => {
    const path = lockPath();
    writeFileSync(path, `${String(await deadPid())}\n`);

    expect(acquireInstanceLock(path)).toEqual({ release: expect.any(Function) });
    expect(pidIn(path)).toBe(process.pid);
  });

  it("frees the directory on release, so the next start needs no takeover", () => {
    const path = lockPath();
    const held = acquireInstanceLock(path);
    if (!("release" in held)) throw new Error("the first claim must be granted");

    held.release();
    expect(acquireInstanceLock(path)).toEqual({ release: expect.any(Function) });
    expect(pidIn(path)).toBe(process.pid);
  });
});
