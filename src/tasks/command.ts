// A bash task's script, run in its cwd with its input on stdin. The output is
// capped as it arrives rather than after: a run that printed a gigabyte is a
// run whose result still has to fit in a row, a transcript and a callback.

import { spawn } from "node:child_process";
import { logger } from "../log.js";
import type { CommandResult } from "./types.js";

const log = logger("tasks");

const OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 250;

class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  add(chunk: Buffer): void {
    if (this.bytes >= OUTPUT_LIMIT) {
      this.truncated = true;
      return;
    }
    const kept = chunk.subarray(0, OUTPUT_LIMIT - this.bytes);
    this.chunks.push(kept);
    this.bytes += kept.length;
    if (kept.length < chunk.length) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function runBash(
  script: string,
  cwd: string,
  input: unknown,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const encodedInput = JSON.stringify(input ?? null);
    const child = spawn("/bin/bash", ["-lc", script], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, PIER_TASK_INPUT: encodedInput },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (err) {
        // ESRCH means the owned process group already exited.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") log.warn(`run ${signal} failed: ${String(err)}`);
      }
    };
    const abort = (): void => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const cleanup = (): void => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // A TERM trap may exit the shell while a descendant ignores TERM and
      // has redirected its pipes. Closing the shell must not spare that group.
      if (signal.aborted) kill("SIGKILL");
      cleanup();
      resolve({
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    // A script that never reads stdin is ordinary (`exit 0`, a one-line curl),
    // and writing the input to a pipe nobody is holding raises EPIPE *here*.
    // Unhandled, that is an `error` event on a stream, which is an uncaught
    // exception, which is main.ts exiting the process: one task script could
    // take every session and every other run down with it. The input not being
    // wanted is not a failure of the run — anything else still gets said.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") log.warn(`run input could not be written: ${err.message}`);
    });
    child.stdin.end(encodedInput);
  });
}
