#!/usr/bin/env node
// What `pier` does when typed. Dispatch only, and no server imports until a
// command needs them: `pier service install` must not open a database.

import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
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

function commandPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir || ".", name);
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      // Keep looking: version managers put several prefixes on PATH.
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
