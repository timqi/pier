import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

const OUTPUT_LIMIT = 1024 * 1024;

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
    const kill = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may have exited between the state check and kill.
      }
    };
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", kill);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", kill);
      resolve({
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    child.stdin.end(encodedInput);
  });
}
