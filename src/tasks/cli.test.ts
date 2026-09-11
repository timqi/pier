// Argv → the exact params object posted, and the answer's two shapes; the
// socket is a recorder, as cli.test.ts's fakeVault is for `vault run`.

import { describe, expect, it } from "vitest";
import { runTaskCli, type TaskCliIo, type TaskPost } from "./cli.js";

function rig(answer: { status: number; body: { result?: unknown; error?: string } } = { status: 200, body: { result: { ok: true } } }, stdin = "") {
  const posted: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let reads = 0;
  const io: TaskCliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: () => {
      reads++;
      return stdin;
    },
  };
  const post: TaskPost = async (params) => {
    posted.push(params);
    return answer;
  };
  const run = (...argv: string[]) => runTaskCli(argv, post, io);
  return { run, posted, out, err, reads: () => reads };
}

describe("pier task", () => {
  it("maps every flag operation onto the tool's parameter names", async () => {
    const { run, posted, out } = rig();
    const cases: [string[], Record<string, unknown>][] = [
      [["list"], { operation: "list" }],
      [["models"], { operation: "models" }],
      [["cancel", "--run", "r1"], { operation: "cancel", run_id: "r1" }],
      [["cancel", "--group", "g1"], { operation: "cancel", group_id: "g1" }],
      [["steer", "--run", "r1", "--message", "stop"], { operation: "steer", run_id: "r1", message: "stop" }],
      [["follow_up", "--run", "r1", "--message", "then this"], { operation: "follow_up", run_id: "r1", message: "then this" }],
      [["resume", "--run", "r1", "--message", "again", "--callback", "steer", "--callback-session", "s9"],
        { operation: "resume", run_id: "r1", message: "again", callback: "steer", callback_session_id: "s9" }],
      [["contact", "--reason", "decision", "--message", "A or B?"], { operation: "contact", reason: "decision", message: "A or B?" }],
      [["contact", "--message", "halfway"], { operation: "contact", message: "halfway" }],
      [["reply", "--message-id", "m1", "--message", "A"], { operation: "reply", message_id: "m1", message: "A" }],
      [["recover", "--run", "r1", "--reason", "truncated"], { operation: "recover", run_id: "r1", reason: "truncated" }],
      [["recover", "--group", "g1", "--reason", "lost"], { operation: "recover", group_id: "g1", reason: "lost" }],
      [["run", "--prompt", "Review", "--cwd", "/repo", "--name", "rev", "--timeout", "600", "--callback", "none"],
        { operation: "run", prompt: "Review", cwd: "/repo", name: "rev", timeoutSeconds: 600, callback: "none" }],
    ];
    for (const [argv] of cases) expect(await run(...argv), argv.join(" ")).toBe(0);
    expect(posted).toEqual(cases.map(([, params]) => params));
    expect(out).toEqual(cases.map(() => '{"ok":true}'));
  });

  it("reads `-` from stdin for message and prompt, once", async () => {
    const { run, posted, reads } = rig(undefined, "multi\nline\n");
    expect(await run("steer", "--run", "r1", "--message", "-")).toBe(0);
    expect(await run("run", "--prompt", "-")).toBe(0);
    expect(posted).toEqual([
      { operation: "steer", run_id: "r1", message: "multi\nline\n" },
      { operation: "run", prompt: "multi\nline\n" },
    ]);
    expect(reads()).toBe(2);
  });

  it("passes a JSON params object on stdin through untouched for run, create and update, the operation being argv's", async () => {
    const draft = { task: { name: "nightly", trigger: { type: "cron", expression: "0 3 * * *", timezone: "UTC" }, action: { type: "bash", script: "make", cwd: "/repo" } } };
    const { run, posted } = rig(undefined, JSON.stringify({ ...draft, operation: "run" }));
    expect(await run("create")).toBe(0);
    expect(await run("update")).toBe(0);
    expect(await run("run")).toBe(0);
    expect(posted).toEqual([
      { ...draft, operation: "create" },
      { ...draft, operation: "update" },
      { ...draft, operation: "run" },
    ]);
    const fanout = rig(undefined, JSON.stringify({ tasks: ["a", { prompt: "b", launch: { thinking: "high" } }], join: "first" }));
    expect(await fanout.run("run")).toBe(0);
    expect(fanout.posted).toEqual([{ tasks: ["a", { prompt: "b", launch: { thinking: "high" } }], join: "first", operation: "run" }]);
  });

  it("exits 2 on argv it cannot shape, without posting", async () => {
    const { run, posted, err, out } = rig(undefined, "[1]");
    expect(await run()).toBe(2);
    expect(await run("frobnicate")).toBe(2);
    expect(await run("list", "--run", "r1")).toBe(2);
    expect(await run("cancel", "--porrt", "1")).toBe(2);
    expect(await run("cancel", "r1")).toBe(2);
    expect(await run("run", "--prompt", "x", "--timeout", "soon")).toBe(2);
    expect(await run("create")).toBe(2);
    expect(posted).toEqual([]);
    expect(err.map((line) => line.split("\n")[0])).toEqual([
      "task: unknown operation \"frobnicate\"",
      "task: --run is not an option of list",
      expect.stringMatching(/^task: Unknown option '--porrt'/),
      expect.stringMatching(/^task: Unexpected argument 'r1'/),
      "task: --timeout must be a whole number of seconds",
      "task: stdin must be a JSON object",
    ]);
    // Bare `pier task` is the usage on stdout, exit 2; `--help` is the same text, exit 0.
    expect(out[0]).toContain("pier task <operation>");
    expect(await run("--help")).toBe(0);
    expect(await run("steer", "-h")).toBe(0);
    expect(out.at(-1)).toContain("pier task steer [--run <id>] [--message <text|->]");
    const bad = rig(undefined, "{not json");
    expect(await bad.run("run")).toBe(2);
    expect(bad.err[0]).toMatch(/^task: stdin must be the JSON params object: /);
  });

  it("prints the tool's refusal as one task: line, exit 1", async () => {
    const { run, err, out } = rig({ status: 422, body: { error: "session does not own this run" } });
    expect(await run("cancel", "--run", "r1")).toBe(1);
    expect(err).toEqual(["task: session does not own this run"]);
    expect(out).toEqual([]);
    const broken = rig({ status: 500, body: {} });
    expect(await broken.run("list")).toBe(1);
    expect(broken.err).toEqual(["task: socket answered 500"]);
  });
});
