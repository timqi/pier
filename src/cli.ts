#!/usr/bin/env node
// What `pier` does when typed. Dispatch only — no logic, and no imports of the
// server until a command that needs it: `pier service install` on a machine
// with no database should not open one.
//
// Hand-rolled against node:util's parseArgs rather than a CLI framework: this
// small command set does not earn a dependency (AGENTS.md 8).

import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { currentVersion, UpdateCheck } from "./update.js";

const version = currentVersion();

const HELP = `pier ${version} — a self-hosted workspace for coding agents

Usage
  pier                        run the workbench in this terminal
  pier service install        write and start a systemd user unit (Linux)
  pier service uninstall      stop it and remove the unit
  pier service status         what systemd thinks of it
  pier update                 install the latest release and restart the service
  pier update --check         only say whether one exists
  pier restart                finish running turns first, then restart the service
  pier reload                 re-read channel config and recycle idle sessions
  pier backup                 snapshot pier.db before a manual update
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

const fail = (message: string): never => {
  process.stderr.write(`pier: ${message}\n`);
  process.exit(2);
};

const parsed = (() => {
  try {
    return parseArgs({
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
if (extra.length) fail(`unexpected argument "${extra[0]}"`);
const allowOnly = (allowed: string[], usage: string): void => {
  const invalid = Object.keys(values).find((key) => !allowed.includes(key));
  if (invalid) fail(`--${invalid} is not valid for ${usage}`);
};

if (values.help || command === "help") {
  process.stdout.write(HELP);
} else if (values.version || command === "version") {
  process.stdout.write(`${version}\n`);
} else if (!command) {
  allowOnly([], "pier");
  // The server starts on import; this file stays a dispatcher.
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
} else if (command === "restart" || command === "reload") {
  if (subcommand) fail(`unexpected argument "${subcommand}"`);
  allowOnly([], `pier ${command}`);
  await signalService(command);
} else {
  process.stderr.write(`pier: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

/**
 * Checking is Pier's own code; applying it is npm's. Under systemd the work is
 * handed to a second unit — this process is about to be restarted, and a child
 * of the service being restarted dies with it.
 */
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

  // No service manager owns this process, so do not mutate its rollback point
  // until the operator is ready to run all three steps.
  say(`pier backup`);
  say(`npm install -g @timqi/pier@${latest}`);
  say(`then restart Pier.`);
}

/** Both are signals to the running unit: SIGUSR2 drains then exits (systemd
 * starts the next process), SIGHUP reloads config in place (main.ts). */
async function signalService(command: "restart" | "reload"): Promise<void> {
  if (process.platform !== "linux") {
    return fail(`only under the systemd service — send ${command === "restart" ? "SIGUSR2" : "SIGHUP"} to the pier process yourself`);
  }
  const { UNIT_NAME } = await import("./service.js");
  const signal = command === "restart" ? "SIGUSR2" : "SIGHUP";
  try {
    // `--kill-who`, not the newer `--kill-whom`: the old spelling is the one
    // every systemd still parses (systemd/systemd#29793).
    execFileSync("systemctl", ["--user", "kill", "-s", signal, "--kill-who=main", UNIT_NAME], { stdio: "inherit" });
  } catch (err) {
    // A failed kill already printed why on the inherited stderr; a missing
    // systemctl printed nothing, so name it (same shape as `service status`).
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
  const path = backupDb(PIER_DB);
  process.stdout.write(path ? `backed up ${path}\n` : `no database yet — nothing to back up.\n`);
}

function commandPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir || ".", name);
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      // Keep looking: version managers commonly put several prefixes on PATH.
    }
  }
  return fail(`${name} is not executable on PATH`);
}

async function service(action = "status"): Promise<void> {
  const { install, uninstall, UNIT_NAME } = await import("./service.js");
  const systemdAction = action === "install" || action === "uninstall";

  if (systemdAction && process.platform !== "linux") {
    process.stderr.write(
      `pier service is systemd, so Linux only — this is ${process.platform}.\n` +
        `Run "pier" in a terminal, or under whatever supervisor you already use;\n` +
        `it needs no arguments and keeps its state in $PIER_HOME (~/.pier).\n`,
    );
    process.exit(2);
  }

  switch (action) {
    case "install": { // The installed unit owns this Node prefix until replaced.
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
        // Inherited, not captured: systemctl's own output is the answer, and
        // its exit code is nonzero for a service that is merely stopped.
        execFileSync("systemctl", ["--user", "status", UNIT_NAME], { stdio: "inherit" });
      } catch (err) {
        // A stopped service already printed its status; a missing systemctl
        // printed nothing, so name it.
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
