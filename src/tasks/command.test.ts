// What a bash run has to get right regardless of what the script does: the
// input reaches it, the exit code comes back, and output is capped as it
// arrives rather than after.

import { describe, expect, it } from "vitest";
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
    // that is main.ts exiting the process (§5b in the worst possible place).
    const result = await run("exit 7");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("");
  });

  it("caps output instead of holding a whole run in memory", async () => {
    const result = await run("head -c 2000000 /dev/zero | tr '\\0' 'a'", null);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it("reports a cancelled run as an error, not as an exit code", async () => {
    const controller = new AbortController();
    const promise = runBash("sleep 5", process.cwd(), null, controller.signal);
    controller.abort();
    await expect(promise).resolves.toMatchObject({ exitCode: null });
  });
});
