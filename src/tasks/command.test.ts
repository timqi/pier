// What a bash run has to get right regardless of what the script does: the
// input reaches it, the exit code comes back, and output is capped as it
// arrives rather than after.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runBash } from "./command.js";

const run = (script: string, input: unknown = { hello: "world" }): ReturnType<typeof runBash> =>
  runBash(script, process.cwd(), input, new AbortController().signal);

describe("runBash", () => {
  it("hands the input to a script that reads it", async () => {
    const result = await run("cat");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hello: "world" });
  });

  it("settles a script that exits without reading stdin", async () => {
    // The pipe is written whether or not anyone is holding the other end; an
    // EPIPE from that write is an `error` event on the stream, and unhandled
    // that is main.ts exiting the process (§5 in the worst possible place).
    const result = await run("exit 7");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("");
  });

  it("caps output instead of holding a whole run in memory", async () => {
    const result = await run("head -c 2000000 /dev/zero | tr '\\0' 'a'", null);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it("does not spawn work for a pre-cancelled signal", async () => {
    await expect(runBash("exit 0", process.cwd(), null, AbortSignal.abort())).rejects.toThrow("cancelled");
  });

  it.each([false, true])("bounds cancellation when TERM is ignored: %s", async (ignoreTerm) => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-command-"));
    const controller = new AbortController();
    // Builtins only: even a regression ends in four seconds and leaves no child.
    const result = runBash(`trap '${ignoreTerm ? "" : "echo cleaned; exit 0"}' TERM
      echo ready > ready
      deadline=$((SECONDS + 4))
      while (( SECONDS < deadline )); do :; done`, cwd, null, controller.signal);
    onTestFinished(async () => {
      controller.abort();
      await result;
      rmSync(cwd, { recursive: true, force: true });
    });
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    const began = Date.now();
    controller.abort();
    expect(await result).toMatchObject(ignoreTerm ? { exitCode: null } : { exitCode: 0, stdout: "cleaned\n" });
    expect(Date.now() - began).toBeLessThan(1500);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.skipIf(process.platform !== "linux")("kills an owned descendant even when its parent exits before the grace deadline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-command-child-"));
    const controller = new AbortController();
    let ownedPid: number | undefined;
    // Redirected pipes let the parent's close event arrive before this child
    // exits. Finite builtins bound a regression without spawning other work.
    const result = runBash(`trap 'exit 0' TERM
      (trap '' TERM; echo $BASHPID > owned; deadline=$((SECONDS + 4));
       while (( SECONDS < deadline )); do :; done) </dev/null >/dev/null 2>&1 &
      wait`, cwd, null, controller.signal);
    onTestFinished(async () => {
      controller.abort();
      await result;
      if (ownedPid) {
        try { process.kill(ownedPid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "owned"))).toBe(true));
    ownedPid = Number(readFileSync(join(cwd, "owned"), "utf8").trim());
    controller.abort();
    expect((await result).exitCode).toBe(0);
    // PID 1 can take time to reap an adopted child; a zombie is already dead.
    await vi.waitFor(() => {
      let state: string | undefined;
      try { state = readFileSync(`/proc/${String(ownedPid)}/stat`, "utf8").split(") ")[1]?.[0]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      expect(state === undefined || state === "Z").toBe(true);
    }, { timeout: 1500 });
  });

  it("reports a cancelled run as an error, not as an exit code", async () => {
    const controller = new AbortController();
    const promise = runBash("sleep 5", process.cwd(), null, controller.signal);
    controller.abort();
    await expect(promise).resolves.toMatchObject({ exitCode: null });
  });
});
