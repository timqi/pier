// `pier task <operation> …`: the task tool from a shell, so a session pays for
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
  run: { type: "string" },
  group: { type: "string" },
  message: { type: "string" },
  "message-id": { type: "string" },
  reason: { type: "string" },
  prompt: { type: "string" },
  cwd: { type: "string" },
  name: { type: "string" },
  timeout: { type: "string" },
  callback: { type: "string" },
  "callback-session": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;
type Flag = keyof typeof OPTIONS;

/** Flag → tool parameter; a flag not listed here is the operation's own affair. */
const PARAM: Partial<Record<Flag, string>> = {
  run: "run_id", group: "group_id", message: "message", "message-id": "message_id", reason: "reason",
  prompt: "prompt", cwd: "cwd", name: "name", callback: "callback", "callback-session": "callback_session_id",
};

/** `json`: the params object arrives on stdin; flags are a shorthand for one of them. */
const COMMANDS: Record<string, { flags: Flag[]; json?: true; help: string }> = {
  list: { flags: [], help: "stored definitions (subagent one-offs excluded)" },
  models: { flags: [], help: "the model menu to pick launch.model from" },
  run: { flags: ["prompt", "cwd", "name", "timeout", "callback", "callback-session"], json: true, help: "JSON params on stdin, or --prompt <text|-> for a one-shot subagent" },
  create: { flags: [], json: true, help: "{task: draft} on stdin — a definition the operator sees" },
  update: { flags: [], json: true, help: "{task_id, task: draft} on stdin — the whole draft, trigger included" },
  recover: { flags: ["run", "group", "reason"], help: "a finished result again; --reason required" },
  cancel: { flags: ["run", "group"], help: "a run or a group, descendants included" },
  steer: { flags: ["run", "message"], help: "interrupt a child now" },
  follow_up: { flags: ["run", "message"], help: "queue guidance after its current turn" },
  resume: { flags: ["run", "message", "callback", "callback-session"], help: "a terminal run again, --message as its prompt" },
  contact: { flags: ["reason", "message"], help: "your supervisor: --reason progress|decision" },
  reply: { flags: ["message-id", "message"], help: "answer a child's decision" },
};

const usageOf = (name: string): string =>
  [`pier task ${name}`, ...COMMANDS[name]!.flags.map((f) => (f === "timeout" ? "[--timeout <seconds>]" : `[--${f} <${f === "message" || f === "prompt" ? "text|-" : f}>]`))].join(" ");

const USAGE = [
  "usage: pier task <operation> … — subagents and scheduled tasks (skills/pier-tasks)",
  ...Object.entries(COMMANDS).map(([name, cmd]) => `  ${usageOf(name).slice("pier task ".length)}${cmd.json ? " [< params.json]" : ""}\n      ${cmd.help}`),
  "`-` reads the text from stdin. The answer is one line of JSON; a refusal is one `task:` line, exit 1.",
].join("\n");

const processIo: TaskCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  stdin: () => readFileSync(0, "utf8"),
};

/** The exit code: 0, 1 when the tool refused, 2 for a malformed command line
 *  — decided before `post` is called, so usage never reaches the socket. */
export async function runTaskCli(argv: string[], post: TaskPost, io: TaskCliIo = processIo): Promise<number> {
  const usage = (message: string): number => {
    io.stderr(`task: ${message}`);
    return 2;
  };
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 2;
  }
  const cmd = COMMANDS[name];
  if (!cmd) return usage(`unknown operation "${name}"\n${USAGE}`);
  let values: Partial<Record<Flag, string | boolean>>;
  try {
    values = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false, strict: true }).values;
  } catch (err) {
    return usage(`${err instanceof Error ? err.message : String(err)}\n${usageOf(name)}`);
  }
  if (values.help) {
    io.stdout(`${usageOf(name)}\n    ${cmd.help}`);
    return 0;
  }
  const given = (Object.keys(values) as Flag[]).filter((flag) => flag !== "help");
  const stray = given.find((flag) => !cmd.flags.includes(flag));
  if (stray) return usage(`--${stray} is not an option of ${name}\n${usageOf(name)}`);
  let params: Record<string, unknown> = {};
  if (cmd.json && !given.length) {
    // The whole parameter object, as a tool call would carry it; only the
    // operation is argv's.
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.stdin());
    } catch (err) {
      return usage(`stdin must be the JSON params object: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return usage("stdin must be a JSON object");
    params = parsed as Record<string, unknown>;
  } else {
    for (const flag of given) {
      const raw = values[flag];
      if (typeof raw !== "string") continue;
      const text = (flag === "message" || flag === "prompt") && raw === "-" ? io.stdin() : raw;
      if (flag === "timeout") {
        const seconds = Number(text);
        if (!Number.isInteger(seconds)) return usage(`--timeout must be a whole number of seconds\n${usageOf(name)}`);
        params.timeoutSeconds = seconds;
      } else {
        params[PARAM[flag]!] = text;
      }
    }
  }
  const { status, body } = await post({ ...params, operation: name });
  if (status === 200) {
    // Compact: the reader is a model, and the ids are what it keeps.
    io.stdout(JSON.stringify(body.result));
    return 0;
  }
  io.stderr(`task: ${body.error ?? `socket answered ${String(status)}`}`);
  return 1;
}
