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
  it("maps every command onto the tool's parameter names", async () => {
    const { run, posted, out } = rig();
    const cases: [string[], Record<string, unknown>][] = [
      [["list"], { operation: "list" }],
      [["cancel", "--run", "r1"], { operation: "cancel", run_id: "r1" }],
      [["cancel", "--group", "g1"], { operation: "cancel", group_id: "g1" }],
      [["recover", "--run", "r1", "--reason", "truncated"], { operation: "recover", run_id: "r1", reason: "truncated" }],
      [["recover", "--group", "g1", "--reason", "lost"], { operation: "recover", group_id: "g1", reason: "lost" }],
      [["run", "--prompt", "Review", "--cwd", "/repo", "--name", "rev", "--timeout", "600", "--callback", "none"],
        { operation: "run", prompt: "Review", cwd: "/repo", name: "rev", timeoutSeconds: 600, callback: "none" }],
      [["run", "--prompt", "Review", "--model", "gpt", "--thinking", "high", "--callback-session", "s9"],
        { operation: "run", prompt: "Review", launch: { model: "gpt", thinking: "high" }, callback_session_id: "s9" }],
      [["run", "--task-id", "t1", "--callback", "steer"], { operation: "run", task_id: "t1", callback: "steer" }],
      [["run", "--session", "s2", "--prompt", "Check the result", "--timeout", "60"],
        { operation: "run", task: { timeoutSeconds: 60, action: { type: "agent", session: { mode: "reuse", sessionId: "s2" }, prompt: "Check the result" } } }],
    ];
    for (const [argv] of cases) expect(await run(...argv), argv.join(" ")).toBe(0);
    expect(posted).toEqual(cases.map(([, params]) => params));
    expect(out).toEqual(cases.map(() => '{"ok":true}'));
  });

  it("puts a prompt on an existing run as one message request; the server picks steer, follow-up or resume", async () => {
    const { run, posted, out } = rig({ status: 200, body: { result: { delivery: "steer" } } });
    expect(await run("run", "--run", "r1", "--prompt", "stop")).toBe(0);
    expect(await run("run", "--run", "r1", "--prompt", "then this", "--after")).toBe(0);
    expect(await run("run", "--run", "r1", "--prompt", "again", "--callback", "steer", "--callback-session", "s9")).toBe(0);
    expect(posted).toEqual([
      { operation: "message", run_id: "r1", message: "stop" },
      { operation: "message", run_id: "r1", message: "then this", after: true },
      { operation: "message", run_id: "r1", message: "again", callback: "steer", callback_session_id: "s9" },
    ]);
    expect(out).toEqual(['{"delivery":"steer"}', '{"delivery":"steer"}', '{"delivery":"steer"}']);
    // The run's state lives on the server: callback options on a running run are its refusal, exit 1.
    const running = rig({ status: 422, body: { error: "run r1 is running: callback options apply to a resumed run only; drop them to steer or follow up" } });
    expect(await running.run("run", "--run", "r1", "--prompt", "again", "--callback", "steer")).toBe(1);
    expect(running.err).toEqual(["task: run r1 is running: callback options apply to a resumed run only; drop them to steer or follow up"]);
  });

  it("turns --member into tasks[]: flags before the first are every member's defaults, each member overrides them", async () => {
    const { run, posted } = rig();
    expect(await run("run", "--cwd", "/repo", "--model", "gpt", "--join", "first", "--callback", "steer",
      "--member", "--prompt", "Review correctness",
      "--member", "--prompt", "Review tests", "--cwd", "/repo/tests", "--thinking", "low", "--name", "tests",
      "--member", "--task-id", "t1")).toBe(0);
    expect(posted).toEqual([{
      operation: "run",
      join: "first",
      callback: "steer",
      tasks: [
        { prompt: "Review correctness", cwd: "/repo", launch: { model: "gpt" } },
        { prompt: "Review tests", cwd: "/repo/tests", launch: { model: "gpt", thinking: "low" }, name: "tests" },
        { task_id: "t1" },
      ],
    }]);
  });

  it("saves a definition: create without --task-id, update with it; one action, one trigger", async () => {
    const { run, posted } = rig();
    expect(await run("save", "--name", "nightly", "--bash", "make", "--cwd", "/repo", "--cron", "0 3 * * *", "--tz", "UTC", "--timeout", "900")).toBe(0);
    expect(await run("save", "--task-id", "t1", "--name", "watcher", "--prompt", "Look", "--watch", "test -f flag", "--every", "30", "--repeat", "--cwd", "/repo", "--model", "gpt", "--callback-session", "s9")).toBe(0);
    expect(await run("save", "--name", "role", "--prompt", "Do the thing")).toBe(0);
    expect(posted).toEqual([
      { operation: "create", task: { name: "nightly", timeoutSeconds: 900, trigger: { type: "cron", expression: "0 3 * * *", timezone: "UTC" }, action: { type: "bash", script: "make", cwd: "/repo" } } },
      { operation: "update", task_id: "t1", task: {
        name: "watcher", trigger: { type: "watch", script: "test -f flag", cwd: "/repo", intervalSeconds: 30, mode: "repeat" },
        callback: { type: "session", sessionId: "s9" }, prompt: "Look", cwd: "/repo", launch: { model: "gpt" },
      } },
      { operation: "create", task: { name: "role", trigger: { type: "manual" }, prompt: "Do the thing" } },
    ]);
  });

  it("reads `-` from stdin for --prompt, once per command", async () => {
    const { run, posted, reads } = rig(undefined, "multi\nline\n");
    expect(await run("run", "--run", "r1", "--prompt", "-")).toBe(0);
    expect(await run("run", "--prompt", "-")).toBe(0);
    expect(await run("save", "--name", "n", "--prompt", "-")).toBe(0);
    expect(await run("run", "--member", "--prompt", "a", "--member", "--prompt", "-")).toBe(0);
    expect(posted).toEqual([
      { operation: "message", run_id: "r1", message: "multi\nline\n" },
      { operation: "run", prompt: "multi\nline\n" },
      { operation: "create", task: { name: "n", trigger: { type: "manual" }, prompt: "multi\nline\n" } },
      { operation: "run", tasks: [{ prompt: "a" }, { prompt: "multi\nline\n" }] },
    ]);
    expect(reads()).toBe(4);
    const twice = rig(undefined, "x");
    expect(await twice.run("run", "--member", "--prompt", "-", "--member", "--prompt", "-")).toBe(2);
    expect(twice.err[0]).toMatch(/^task: only one --prompt may read stdin/);
    expect(twice.posted).toEqual([]);
  });

  it("asks the server for the menu on --model ?, whatever else was said", async () => {
    const { run, posted } = rig();
    expect(await run("run", "--prompt", "Review", "--model", "?")).toBe(0);
    expect(await run("save", "--name", "n", "--prompt", "x", "--model", "?")).toBe(0);
    expect(posted).toEqual([{ operation: "run", launch: { model: "?" } }, { operation: "run", launch: { model: "?" } }]);
  });

  it("exits 2 on argv it cannot shape, without posting", async () => {
    const { run, posted, err, out } = rig();
    const bad: [string[], unknown][] = [
      [[], "usage"],
      [["frobnicate"], 'task: unknown command "frobnicate"'],
      [["list", "--run", "r1"], "task: --run is not an option of list"],
      [["cancel", "--porrt", "1"], expect.stringMatching(/^task: Unknown option '--porrt'/)],
      [["cancel", "r1"], expect.stringMatching(/^task: Unexpected argument 'r1'/)],
      [["cancel"], "task: cancel takes exactly one of --run or --group"],
      [["recover", "--run", "r", "--group", "g", "--reason", "x"], "task: recover takes exactly one of --run or --group"],
      [["run", "--prompt", "x", "--timeout", "soon"], "task: --timeout must be a whole number of seconds"],
      [["run"], "task: a new run needs --prompt or --task-id"],
      [["run", "--task-id", "t1", "--prompt", "x"], "task: --prompt does not apply to a saved definition (--task-id)"],
      [["run", "--session", "s1", "--prompt", "x", "--cwd", "/x"], "task: --cwd applies to a fresh session, not --session"],
      [["run", "--run", "r1"], "task: --run needs --prompt"],
      [["run", "--run", "r1", "--prompt", "x", "--cwd", "/x"], "task: --cwd does not apply to an existing run (--run)"],
      [["run", "--run", "r1", "--prompt", "x", "--member", "--prompt", "y"], "task: --run addresses one existing run; --member starts new ones"],
      [["run", "--prompt", "x", "--after"], "task: --after applies to --run only"],
      [["run", "--prompt", "x", "--join", "first"], "task: --join applies to a batch (--member)"],
      [["run", "--member", "--prompt", "x"], "task: a batch needs at least two --member"],
      [["run", "--member", "--prompt", "x", "--member", "--prompt", "y", "--join", "all"], "task: --join belongs before the first --member"],
      [["save", "--name", "n"], "task: save takes exactly one of --prompt or --bash"],
      [["save", "--name", "n", "--prompt", "x", "--bash", "y"], "task: save takes exactly one of --prompt or --bash"],
      [["save", "--name", "n", "--prompt", "x", "--cron", "* * * * *"], "task: --cron and --tz go together"],
      [["save", "--name", "n", "--prompt", "x", "--watch", "true"], "task: --watch and --every go together"],
      [["save", "--name", "n", "--prompt", "x", "--cron", "* * * * *", "--tz", "UTC", "--every", "5"], "task: a task has one trigger: --cron/--tz or --watch/--every/--repeat"],
      [["save", "--name", "n", "--bash", "x", "--model", "gpt"], "task: --model/--thinking apply to a prompt, not --bash"],
      [["save", "--name", "n", "--prompt", "x", "--watch", "true", "--every", "soon"], "task: --every must be a whole number of seconds"],
    ];
    for (const [argv] of bad) expect(await run(...argv), argv.join(" ")).toBe(2);
    expect(posted).toEqual([]);
    // Bare `pier task` is the usage on stdout; every other refusal is a task: line plus the command's usage on stderr.
    expect(out[0]).toContain("pier task <command>");
    expect(err.map((line) => line.split("\n")[0])).toEqual(bad.slice(1).map(([, first]) => first));
    expect(err[1]).toContain("\npier task list");
    expect(await run("--help")).toBe(0);
    expect(await run("save", "-h")).toBe(0);
    expect(out.at(-1)).toContain("pier task save [--task-id <id>] --name <text> (--prompt <text|-> | --bash <script>)");
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
