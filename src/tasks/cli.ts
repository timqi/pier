// `pier task <command> …`: the task tool from a shell, so a session pays for
// its schema only when it reaches for it. Argv shape is the only thing checked
// here; the params object goes to the tool over the socket, which validates
// it as it would a tool call, and the tool's answer comes back verbatim.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface TaskCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  stdin(): string;
}

/** `POST /task` as cli.ts performs it; the socket's own refusals never return. */
export type TaskPost = (params: Record<string, unknown>) => Promise<{ status: number; body: { result?: unknown; error?: string } }>;

const OPTIONS = {
  prompt: { type: "string" }, run: { type: "string" }, after: { type: "boolean" },
  "task-id": { type: "string" }, session: { type: "string" },
  model: { type: "string" }, thinking: { type: "string" }, cwd: { type: "string" }, name: { type: "string" },
  timeout: { type: "string" }, callback: { type: "string" }, "callback-session": { type: "string" }, join: { type: "string" },
  bash: { type: "string" }, cron: { type: "string" }, tz: { type: "string" },
  watch: { type: "string" }, every: { type: "string" }, repeat: { type: "boolean" },
  group: { type: "string" }, reason: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;
type Flag = keyof typeof OPTIONS;
type Values = Partial<Record<Flag, string | boolean>>;
type Params = Record<string, unknown>;

/** The usage line is the contract (docs/design/09-tasks-cli.md); the flags a
 *  command accepts are read off it, so the two cannot drift. */
const COMMANDS: Record<string, { usage: string; help: string }> = {
  run: {
    usage: "run [--prompt <text|->] [--run <id> [--after]] [--task-id <id>] [--session <id>]\n" +
      "        [--model <name|?>] [--thinking <level>] [--cwd <dir>] [--name <text>] [--timeout <seconds>]\n" +
      "        [--callback origin|none|steer] [--callback-session <id>] [--join all|first] [--member <flags…>]…",
    help: "a prompt on a run: a new one (--prompt | --task-id | --session … --prompt), a batch (--member), or an existing one (--run)",
  },
  save: {
    usage: "save [--task-id <id>] --name <text> (--prompt <text|-> | --bash <script>)\n" +
      "        [--cron \"<expr>\" --tz <zone> | --watch <script> --every <seconds> [--repeat]]\n" +
      "        [--cwd <dir>] [--timeout <seconds>] [--model <name>] [--thinking <level>] [--callback-session <id>]",
    help: "file a definition the operator sees, or update one by --task-id; no trigger means manual",
  },
  list: { usage: "list", help: "stored definitions, one line each" },
  cancel: { usage: "cancel (--run <id> | --group <id>)", help: "a run or a group, descendants included" },
  recover: { usage: "recover (--run <id> | --group <id>) --reason <text>", help: "a finished result after its callback settled; never a progress check" },
};

const USAGE = [
  "usage: pier task <command> … — subagents and scheduled tasks (skills/pier-tasks)",
  ...Object.values(COMMANDS).map(({ usage, help }) => `  ${usage}\n      ${help}`),
  "`--prompt -` reads stdin. The receipt is one line of JSON, exit 0; a refusal is one `task:` line, exit 1.",
].join("\n");

/** Flags that belong to the batch, never to one member. */
const GROUP_FLAGS: Flag[] = ["join", "callback", "callback-session"];

const processIo: TaskCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  stdin: () => readFileSync(0, "utf8"),
};

class ArgvError extends Error {}
const refuse = (message: string): never => {
  throw new ArgvError(message);
};

const compact = (value: Record<string, unknown>): Params =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

const flagsOf = (values: Values): Flag[] => (Object.keys(values) as Flag[]).filter((flag) => flag !== "help");

const seconds = (flag: Flag, raw: string | boolean | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : refuse(`--${flag} must be a whole number of seconds`);
};

/** `launch` as the tool takes it: `model` is a menu name the server resolves. */
const launchOf = (v: Values): Params | undefined =>
  v.model === undefined && v.thinking === undefined ? undefined : compact({ model: v.model, thinking: v.thinking });

/** Argv is split at each bare `--member`; a value equal to it is unreachable,
 *  since parseArgs (strict) refuses option-like values anyway. */
function segments(argv: string[]): string[][] {
  const out: string[][] = [[]];
  for (const arg of argv) {
    if (arg === "--member") out.push([]);
    else out.at(-1)!.push(arg);
  }
  return out;
}

export async function runTaskCli(argv: string[], post: TaskPost, io: TaskCliIo = processIo): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 2;
  }
  const cmd = COMMANDS[name];
  const usage = (message: string): number => {
    io.stderr(`task: ${message}\n${cmd ? `pier task ${cmd.usage}` : USAGE}`);
    return 2;
  };
  if (!cmd) return usage(`unknown command "${name}"`);
  const allowed = new Set((cmd.usage.match(/--[a-z-]+/g) ?? []).map((flag) => flag.slice(2)));
  let params: Params;
  try {
    const parsed = (name === "run" ? segments(rest) : [rest]).map((args) => {
      const values = parseArgs({ args, options: OPTIONS, allowPositionals: false, strict: true }).values as Values;
      const stray = flagsOf(values).find((flag) => !allowed.has(flag));
      return stray ? refuse(`--${stray} is not an option of ${name}`) : values;
    });
    if (parsed.some((values) => values.help)) {
      io.stdout(`pier task ${cmd.usage}\n    ${cmd.help}`);
      return 0;
    }
    params = build(name, parsed, io);
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
  const { status, body } = await post(params);
  if (status === 200) {
    // Compact: the reader is a model, and the ids are what it keeps.
    io.stdout(JSON.stringify(body.result));
    return 0;
  }
  io.stderr(`task: ${body.error ?? `socket answered ${String(status)}`}`);
  return 1;
}

/** Argv → the exact params object, or an ArgvError before the socket is touched. */
function build(name: string, parsed: Values[], io: TaskCliIo): Params {
  let stdinReads = 0;
  const text = (raw: string | boolean | undefined): string | undefined => {
    if (raw !== "-") return raw === undefined ? undefined : String(raw);
    if (stdinReads++) refuse("only one --prompt may read stdin (-)");
    return io.stdin();
  };
  if (parsed.some((v) => v.model === "?")) return { operation: "run", launch: { model: "?" } };
  const [values, ...members] = parsed as [Values, ...Values[]];
  if (name === "list") return { operation: "list" };
  if (name === "cancel" || name === "recover") {
    if ((values.run === undefined) === (values.group === undefined)) refuse(`${name} takes exactly one of --run or --group`);
    return compact({ operation: name, run_id: values.run, group_id: values.group, reason: values.reason });
  }
  if (name === "save") return saveParams(values, text);

  /** One new run, in the three shapes the tool's `tasks[]` accepts. A saved
   *  definition runs as is: batch defaults pass it by, its own flags are refused. */
  const entry = (v: Values, own = v): Params => {
    const launch = launchOf(v);
    const timeoutSeconds = seconds("timeout", v.timeout);
    if (v["task-id"] !== undefined) {
      const extra = flagsOf(own).find((flag) => ["prompt", "session", "cwd", "model", "thinking", "name", "timeout"].includes(flag));
      if (extra) refuse(`--${extra} does not apply to a saved definition (--task-id)`);
      return { task_id: v["task-id"] };
    }
    const prompt = text(v.prompt) ?? refuse("a new run needs --prompt or --task-id");
    if (v.session === undefined) return compact({ prompt, cwd: v.cwd, launch, name: v.name, timeoutSeconds });
    if (v.cwd !== undefined) refuse("--cwd applies to a fresh session, not --session");
    return compact({ name: v.name, timeoutSeconds, action: compact({ type: "agent", session: { mode: "reuse", sessionId: v.session }, prompt, launch }) });
  };
  const delivery = compact({ callback: values.callback, callback_session_id: values["callback-session"] });

  if (values.run !== undefined) {
    if (members.length) refuse("--run addresses one existing run; --member starts new ones");
    const extra = flagsOf(values).find((flag) => !["run", "after", "prompt", "callback", "callback-session"].includes(flag));
    if (extra) refuse(`--${extra} does not apply to an existing run (--run)`);
    const message = text(values.prompt) ?? refuse("--run needs --prompt");
    return compact({ operation: "message", run_id: values.run, message, after: values.after || undefined, ...delivery });
  }
  if (values.after) refuse("--after applies to --run only");
  if (members.length) {
    if (members.length < 2) refuse("a batch needs at least two --member");
    const grouped = members.find((m) => flagsOf(m).some((flag) => GROUP_FLAGS.includes(flag)));
    if (grouped) refuse(`--${flagsOf(grouped).find((flag) => GROUP_FLAGS.includes(flag))!} belongs before the first --member`);
    const defaults = Object.fromEntries(Object.entries(values).filter(([flag]) => !GROUP_FLAGS.includes(flag as Flag)));
    return compact({ operation: "run", tasks: members.map((m) => entry({ ...defaults, ...m }, m)), join: values.join, ...delivery });
  }
  if (values.join !== undefined) refuse("--join applies to a batch (--member)");
  const single = entry(values);
  if (single.task_id !== undefined || single.action === undefined) return { operation: "run", ...single, ...delivery };
  return { operation: "run", task: single, ...delivery };
}

function saveParams(v: Values, text: (raw: string | boolean | undefined) => string | undefined): Params {
  if ((v.prompt === undefined) === (v.bash === undefined)) refuse("save takes exactly one of --prompt or --bash");
  const cron = v.cron !== undefined || v.tz !== undefined;
  const watch = v.watch !== undefined || v.every !== undefined || v.repeat !== undefined;
  if (cron && watch) refuse("a task has one trigger: --cron/--tz or --watch/--every/--repeat");
  if (cron && (v.cron === undefined || v.tz === undefined)) refuse("--cron and --tz go together");
  if (watch && (v.watch === undefined || v.every === undefined)) refuse("--watch and --every go together");
  const launch = launchOf(v);
  if (launch && v.bash !== undefined) refuse("--model/--thinking apply to a prompt, not --bash");
  const trigger = cron
    ? { type: "cron", expression: v.cron, timezone: v.tz }
    : watch
      ? compact({ type: "watch", script: v.watch, cwd: v.cwd, intervalSeconds: seconds("every", v.every), mode: v.repeat ? "repeat" : "once" })
      : { type: "manual" };
  const task = compact({
    name: v.name,
    timeoutSeconds: seconds("timeout", v.timeout),
    trigger,
    callback: v["callback-session"] === undefined ? undefined : { type: "session", sessionId: v["callback-session"] },
    ...(v.bash === undefined
      ? { prompt: text(v.prompt), cwd: v.cwd, launch }
      : { action: compact({ type: "bash", script: v.bash, cwd: v.cwd }) }),
  });
  return compact({ operation: "save", task_id: v["task-id"], task });
}
