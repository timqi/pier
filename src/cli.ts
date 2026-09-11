#!/usr/bin/env node
// What `pier` does when typed. Dispatch only, and no server imports until a
// command needs them: `pier service install` must not open a database.

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { request } from "node:http";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Resolved } from "./vault.js";
import { currentVersion, UpdateCheck } from "./update.js";

const version = currentVersion();

const HELP = `pier ${version} — a self-hosted workspace for coding agents

Usage
  pier serve                  run the workbench in this terminal
  pier service install        write and start a systemd user unit (Linux)
  pier service uninstall      stop it and remove the unit
  pier service status         what systemd thinks of it
  pier update                 install the latest release and restart the service
  pier update --check         only say whether one exists
  pier tools sync             install/update the managed CLI tools (rtk, …)
  pier restart                finish running turns first, then restart the service
  pier reload                 re-read channel config and recycle idle sessions
  pier backup                 snapshot pier.db before a manual update
  pier vault run [ENV=NAME | NAME]... -- <command> [args...]
                              run a command with named secrets in its env
  pier slack <subcommand> ... Slack from a shell, token from the vault (pier slack --help)
  pier task <command> ...     subagents and scheduled tasks from a shell (pier task --help)
  pier --version | --help

Options for "service install"
  --port <n>       what to listen on            (default 3141)
  --host <addr>    what to bind                 (default 127.0.0.1, loopback)
  --pier-home <d>  where state lives            (default ~/.pier)
  --force          replace a unit already there

The workbench is behind a password generated on first run and printed once.
Under systemd that print lands in the journal: journalctl --user -u pier -e
`;

const say = (message: string): void => void process.stdout.write(`${message}\n`);

/** Every socket route answers from memory and the database, so a Pier that
 *  takes longer than this is stuck, and an agent's shell must not hang with it. */
const SOCKET_TIMEOUT_MS = 30_000;

/** Typed on the binding: only then does a call narrow the code after it. */
const die: (message: string) => never = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
const fail = (message: string): never => die(`pier: ${message}`);

const argv = process.argv.slice(2);
const parsed = (() => {
  try {
    return parseArgs({
      // `slack` and `task` own their options; only the name is parsed here.
      args: argv[0] === "slack" || argv[0] === "task" ? [argv[0]] : argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        check: { type: "boolean" },
        force: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
        "pier-home": { type: "string" },
      },
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
})();
const { values, positionals } = parsed;
const [command, subcommand, ...extra] = positionals;
// `vault run` reads process.argv itself: parseArgs cannot say where the `--` was.
if (command !== "vault" && extra.length) fail(`unexpected argument "${extra[0]}"`);
const allowOnly = (allowed: string[], usage: string): void => {
  const invalid = Object.keys(values).find((key) => !allowed.includes(key));
  if (invalid) fail(`--${invalid} is not valid for ${usage}`);
};

if (values.help || command === "help") {
  process.stdout.write(HELP);
} else if (values.version || command === "version") {
  process.stdout.write(`${version}\n`);
} else if (!command) {
  // The bare name must not start a server by accident.
  process.stdout.write(HELP);
} else if (command === "serve") {
  if (subcommand) fail(`unexpected argument "${subcommand}"`);
  allowOnly([], "pier serve");
  await import("./main.js");
} else if (command === "service") {
  await service(subcommand);
} else if (command === "backup") {
  if (subcommand) fail(`unexpected argument "${subcommand}"`);
  allowOnly([], "pier backup");
  await backup();
} else if (command === "update") {
  if (subcommand) fail(`unexpected argument "${subcommand}"`);
  allowOnly(["check"], "pier update");
  await update(values.check === true);
} else if (command === "tools") {
  await tools(subcommand);
} else if (command === "vault") {
  await vault(subcommand, argv);
} else if (command === "slack") {
  await slack(argv.slice(1));
} else if (command === "task") {
  const { runTaskCli } = await import("./tasks/cli.js");
  process.exitCode = await runTaskCli(argv.slice(1), (params) => askPier("/task", { params }));
} else if (command === "restart" || command === "reload") {
  if (subcommand) fail(`unexpected argument "${subcommand}"`);
  allowOnly([], `pier ${command}`);
  await signalService(command);
} else {
  process.stderr.write(`pier: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

/** Under systemd the install is handed to a second unit: a child of the
 *  service being restarted dies with it. */
async function update(checkOnly: boolean): Promise<void> {
  const check = new UpdateCheck(version);
  await check.refresh();
  const { current, latest, available } = check.status();

  if (latest === null) {
    process.stderr.write(`could not reach the registry — running ${current}.\n`);
    process.exitCode = 1;
    return;
  }
  if (!available) {
    process.stdout.write(`${current} is the latest.\n`);
    return;
  }
  process.stdout.write(`${latest} is out (running ${current}).\n`);
  if (checkOnly) return;

  const { startUpdate } = await import("./service.js");
  if (process.platform === "linux") {
    const started = startUpdate({ say });
    if (started === "started") return;
    if (started === "failed") {
      process.exitCode = 1;
      return;
    }
  }

  // No service manager: leave the rollback point to the operator's own sequence.
  say(`pier backup`);
  say(`npm install -g @timqi/pier@${latest}`);
  say(`then restart Pier.`);
}

/** Non-zero when anything failed: the task run is then a failed run with this
 *  text in it, which is the whole tools status surface. */
async function tools(action = ""): Promise<void> {
  if (action !== "sync") {
    process.stderr.write(`pier tools: unknown action "${action}"\n\n${HELP}`);
    process.exit(2);
  }
  allowOnly([], "pier tools sync");
  const [{ ManagedTools }, { SettingsStore }] = await Promise.all([
    import("./tools.js"),
    import("./settings.js"),
  ]);
  try {
    // Read inside the sync's lock: a queued sync converges on the set as it is then.
    const settings = new SettingsStore();
    const report = await new ManagedTools().sync(() => settings.get());
    say(report.summary);
    if (report.failed) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`pier: tools sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

async function signalService(command: "restart" | "reload"): Promise<void> {
  if (process.platform !== "linux") {
    return fail(`only under the systemd service — send ${command === "restart" ? "SIGUSR2" : "SIGHUP"} to the pier process yourself`);
  }
  const { UNIT_NAME } = await import("./service.js");
  const signal = command === "restart" ? "SIGUSR2" : "SIGHUP";
  try {
    // `--kill-who`, not `--kill-whom`: the spelling every systemd parses (systemd/systemd#29793).
    execFileSync("systemctl", ["--user", "kill", "-s", signal, "--kill-who=main", UNIT_NAME], { stdio: "inherit" });
  } catch (err) {
    // A failed kill already printed why; a missing systemctl printed nothing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`pier: systemctl is not on PATH — no systemd here.\n`);
    }
    process.exitCode = 1;
    return;
  }
  say(command === "restart"
    ? "draining — running turns finish first (up to 5 minutes), then Pier restarts."
    : "reloading — adapters re-read their config; idle sessions re-open with the current one.");
}

async function backup(): Promise<void> {
  const [{ backupDb }, { PIER_DB }] = await Promise.all([import("./db.js"), import("./paths.js")]);
  // This tree's version: the updater runs `backup` before npm replaces it.
  const path = backupDb(version, PIER_DB);
  process.stdout.write(path ? `backed up ${path}\n` : `no database yet — nothing to back up.\n`);
}

/** Everything after `--` runs with the named secrets in its env — plain values
 *  directly, `vt://` records through `vt inject`, which swaps them after the
 *  operator's approval. Nothing here prints a value. */
async function vault(action: string | undefined, argv: string[]): Promise<void> {
  const usage = "usage: pier vault run [ENV=NAME | NAME]... -- <command> [args...]";
  const split = argv.indexOf("--");
  const cmd = argv.slice(split + 1);
  if (action !== "run" || split < 2 || !cmd.length) die(usage);
  // `NAME` alone is `NAME=NAME`: names are env-var shaped so the common case needs no mapping.
  const wanted = argv.slice(2, split).map((spec) => {
    const parts = spec.split("=");
    const [env, name = env] = parts;
    if (parts.length > 2 || !env || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) die(usage);
    return [env!, name!] as const;
  });
  if (!wanted.length) die(usage);
  const values = await resolveSecrets([...new Set(wanted.map(([, name]) => name))]);
  return inject(wanted, values, cmd);
}

/** `cmd` with each secret in its env; `approve` records go through `vt inject`,
 *  which swaps them after approval. Never returns: the child's exit is ours. */
function inject(wanted: readonly (readonly [string, string])[], values: Resolved, cmd: readonly string[]): Promise<never> {
  const env = { ...process.env };
  const records: string[] = [];
  for (const [envName, name] of wanted) {
    const hit = values[name]!;
    env[envName] = hit.value;
    if (hit.kind === "record") records.push(envName);
  }
  let [file, ...args] = cmd as [string, ...string[]];
  if (records.length) {
    if (!findCommand("vt")) {
      const names = wanted.filter(([envName]) => records.includes(envName)).map(([, name]) => name);
      die(`vault: vt is required for ${names.join(", ")} (approve level) and was not found`);
    }
    // Only the record-carrying variables are swapped; everything else passes through untouched.
    [file, ...args] = ["vt", "inject", "--only-env", records.join(","), "--", ...cmd];
  }
  const child = spawn(file, args, { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (err) => die(`vault: ${cmd[0]}: ${err.message}`));
  child.on("exit", (code, signal) => {
    // The shell's convention for a signal death, so a caller sees the same number it would without us.
    process.exit(code ?? 128 + (signal ? osConstants.signals[signal] : 0));
  });
  return new Promise<never>(() => {});
}

/** One request to the running Pier over its socket, signed with the caller's
 *  session (`PIER_SESSION_ID`, the harness variable mapped by the shim). Not
 *  running, silent, unreadable, or an identity or body Pier refuses, is one
 *  `pier:` line and exit 2 before any route reads the answer. */
async function askPier<T extends { error?: string }>(path: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const { PIER_SOCK } = await import("./paths.js");
  const answer = await new Promise<{ status: number; body: T }>((done, reject) => {
    let responded = false;
    const req = request(
      { socketPath: PIER_SOCK, method: "POST", path, headers: { "content-type": "application/json" }, timeout: SOCKET_TIMEOUT_MS },
      (res) => {
        responded = true;
        let raw = "";
        const unreadable = (): void => reject(new Error(`unreadable answer from ${PIER_SOCK} (status ${String(res.statusCode ?? 0)})`));
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        // A connection cut mid-body reports on the response, and `end` never comes.
        res.on("error", unreadable);
        res.on("end", () => {
          try {
            done({ status: res.statusCode ?? 0, body: JSON.parse(raw) as T });
          } catch {
            unreadable();
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Pier did not answer within ${String(SOCKET_TIMEOUT_MS / 1000)} s`)));
    // A 413 arrives while the body is still being written; the EPIPE after it is not the news.
    req.on("error", (err) => responded || reject(err));
    req.end(JSON.stringify({ ...body, sessionId: process.env.PIER_SESSION_ID }));
  }).catch((err: NodeJS.ErrnoException) =>
    // A crash leaves the file with nobody behind it: that is "not running" too.
    err.code === "ENOENT" || err.code === "ECONNREFUSED"
      ? fail(`Pier is not running (no ${PIER_SOCK})`)
      : fail(err.message));
  if (answer.status === 400 || answer.status === 403 || answer.status === 413) fail(answer.body.error ?? `socket answered ${String(answer.status)}`);
  return answer;
}

/** The running Pier's answer for `names`, every name present; any failure is
 *  one `vault:` line and exit 2, so an agent reads words, not an empty variable. */
async function resolveSecrets(names: string[]): Promise<Resolved> {
  const { status, body } = await askPier<{ values?: Resolved; error?: string; file?: string }>("/resolve", { names });
  if (status === 404) die(`vault: ${body.error ?? "unknown name"} — file it at ${body.file ?? "the Console (Settings → Vault)"}`);
  const values = body.values;
  if (status !== 200 || !values) die(`vault: ${body.error ?? `socket answered ${String(status)}`}`);
  const missing = names.find((name) => !values[name]);
  if (missing) die(`vault: no secret named ${missing}`);
  return values;
}

/** `$SLACK_BOT_TOKEN` when set (the re-exec below, or a test); otherwise the
 *  vault's `SLACK_TOKEN`. An `approve` record is only readable inside `vt
 *  inject`, so the command re-runs itself under it — the agent never sees
 *  the vault. Lazy: `--help` and usage errors never touch the socket. */
async function slack(args: string[]): Promise<void> {
  const token = async (): Promise<string> => {
    const given = process.env.SLACK_BOT_TOKEN;
    if (given) return given;
    const values = await resolveSecrets(["SLACK_TOKEN"]);
    const hit = values.SLACK_TOKEN!;
    if (hit.kind === "plain") return hit.value;
    // argv[1], not `pier` on PATH: the same build that is running answers.
    return inject([["SLACK_BOT_TOKEN", "SLACK_TOKEN"]], values, [process.execPath, ...process.execArgv, process.argv[1]!, "slack", ...args]);
  };
  const { runSlackCli } = await import("./channels/slack-cli.js");
  process.exitCode = await runSlackCli(args, token);
}

/** Resolved through every PATH entry: version managers put several prefixes on it. */
function findCommand(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir || ".", name);
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

function commandPath(name: string): string {
  return findCommand(name) ?? fail(`${name} is not executable on PATH`);
}

async function service(action = "status"): Promise<void> {
  const { install, uninstall, UNIT_NAME } = await import("./service.js");
  const systemdAction = action === "install" || action === "uninstall";

  if (systemdAction && process.platform !== "linux") {
    process.stderr.write(
      `pier service is systemd, so Linux only — this is ${process.platform}.\n` +
        `Run "pier serve" in a terminal, or under whatever supervisor you already\n` +
        `use; it takes no arguments and keeps its state in $PIER_HOME (~/.pier).\n`,
    );
    process.exit(2);
  }

  switch (action) {
    case "install": {
      allowOnly(["force", "port", "host", "pier-home"], "pier service install");
      const port = typeof values.port === "string" ? Number(values.port) : 3141;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("--port must be an integer from 1 to 65535");
      const host = typeof values.host === "string" ? values.host : "127.0.0.1";
      if (!host || /\s|[\0\r\n]/.test(host)) fail("--host must be one address with no whitespace");
      const rawHome = values["pier-home"];
      if (rawHome === "") fail("--pier-home must not be empty");
      const pierHome = typeof rawHome === "string" ? resolve(rawHome) : undefined;
      if (!install({
        execPath: process.execPath,
        npmPath: commandPath("npm"),
        // Typed in the operator's shell, so this PATH is the one a turn should see.
        shellPath: process.env.PATH,
        entry: fileURLToPath(new URL("./main.js", import.meta.url)),
        host,
        port,
        pierHome,
        force: values.force === true,
        say,
      })) process.exitCode = 1;
      return;
    }
    case "uninstall":
      allowOnly([], "pier service uninstall");
      if (!uninstall(undefined, say)) process.exitCode = 1;
      return;
    case "status":
      allowOnly([], "pier service status");
      try {
        // Exit code is nonzero for a service that is merely stopped.
        execFileSync("systemctl", ["--user", "status", UNIT_NAME], { stdio: "inherit" });
      } catch (err) {
        // A stopped service already printed its status; a missing systemctl printed nothing.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          process.stderr.write(`pier: systemctl is not on PATH — no systemd here.\n`);
        }
        process.exitCode = 1;
      }
      return;
    default:
      process.stderr.write(`pier service: unknown action "${action}"\n\n${HELP}`);
      process.exit(2);
  }
}
