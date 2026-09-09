// The invariant is the directory, not the port: a second Pier told to listen
// elsewhere is still a second writer of these files, so the claim never sees a
// port at all.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A second Pier caught mid-claim: the child stalls on its first call to `fn`
 *  until `go()` (or a 3s deadline, so a rig mismatch fails instead of hanging),
 *  and the test decides which process reaches the file first. */
const stalledClaim = async (path: string, fn: string): Promise<{ go: () => Promise<string> }> => {
  const ready = `${path}.ready`;
  const go = `${path}.go`;
  const module = new URL("./lock.ts", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
    const original = fs.${fn}; let first = true;
    fs.${fn} = (...args) => {
      if (first) { first = false; fs.writeFileSync(${JSON.stringify(ready)}, ""); const until = Date.now() + 3000;
        while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
      return original(...args);
    }; syncBuiltinESMExports();
    const { acquireInstanceLock } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify(acquireInstanceLock(${JSON.stringify(path)})));`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const closed = new Promise<string>((resolve) => child.once("close", () => resolve(out.trim())));
  const until = Date.now() + 3000;
  while (!existsSync(ready) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  expect(existsSync(ready), `the child never reached ${fn}`).toBe(true);
  return {
    go: () => {
      writeFileSync(go, "");
      return closed;
    },
  };
};

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

  it("grants exactly one of two starts racing for an unclaimed directory", async () => {
    const path = lockPath();
    const child = await stalledClaim(path, "linkSync");

    expect(acquireInstanceLock(path)).toEqual({ release: expect.any(Function) });
    expect(JSON.parse(await child.go())).toEqual({ heldBy: process.pid });
    expect(pidIn(path)).toBe(process.pid);
  });

  it("never lets a late reclaimer of a stale file take a claim that replaced it", async () => {
    const path = lockPath();
    writeFileSync(path, `${String(await deadPid())}\n`);
    // The child has read the dead pid and is about to move the file aside.
    const child = await stalledClaim(path, "renameSync");

    expect(acquireInstanceLock(path)).toEqual({ release: expect.any(Function) });
    expect(JSON.parse(await child.go())).toEqual({ heldBy: process.pid });
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
