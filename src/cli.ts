#!/usr/bin/env node
// What `pier` does when typed. Dispatch only — no logic, and no imports of the
// server until a command that needs it: `pier service install` on a machine
// with no database should not open one.
//
// Hand-rolled against node:util's parseArgs rather than a CLI framework: three
// commands and four flags do not earn a dependency (AGENTS.md 8).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `pier ${version} — a self-hosted workspace for coding agents

Usage
  pier                        run the workbench in this terminal
  pier service install        write and start a systemd user unit (Linux)
  pier service uninstall      stop it and remove the unit
  pier service status         what systemd thinks of it
  pier --version | --help

Options for "service install"
  --port <n>       what to listen on            (default 3141)
  --host <addr>    what to bind                 (default 127.0.0.1, loopback)
  --pier-home <d>  where state lives            (default ~/.pier)
  --force          replace a unit already there

The workbench is behind a password generated on first run and printed once.
Under systemd that print lands in the journal: journalctl --user -u pier -e
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    force: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    "pier-home": { type: "string" },
  },
});

const [command, subcommand] = positionals;

if (values.help || command === "help") {
  process.stdout.write(HELP);
} else if (values.version || command === "version") {
  process.stdout.write(`${version}\n`);
} else if (!command) {
  // The server starts on import; this file stays a dispatcher.
  await import("./main.js");
} else if (command === "service") {
  await service(subcommand);
} else {
  process.stderr.write(`pier: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

async function service(action = "status"): Promise<void> {
  const { install, uninstall, UNIT_NAME } = await import("./service.js");
  const say = (message: string): void => void process.stdout.write(`${message}\n`);

  if (action !== "status" && process.platform !== "linux") {
    process.stderr.write(
      `pier service is systemd, so Linux only — this is ${process.platform}.\n` +
        `Run "pier" in a terminal, or under whatever supervisor you already use;\n` +
        `it needs no arguments and keeps its state in $PIER_HOME (~/.pier).\n`,
    );
    process.exit(2);
  }

  switch (action) {
    case "install":
      install({
        // The node running this command, not whatever systemd would find on a
        // minimal PATH — and the entry beside this file, not a checkout.
        execPath: process.execPath,
        entry: fileURLToPath(new URL("./main.js", import.meta.url)),
        host: typeof values.host === "string" ? values.host : "127.0.0.1",
        port: typeof values.port === "string" ? Number(values.port) : 3141,
        pierHome: typeof values["pier-home"] === "string" ? values["pier-home"] : undefined,
        force: values.force === true,
        say,
      });
      return;
    case "uninstall":
      uninstall(undefined, say);
      return;
    case "status":
      try {
        // Inherited, not captured: systemctl's own output is the answer, and
        // its exit code is nonzero for a service that is merely stopped.
        execFileSync("systemctl", ["--user", "status", UNIT_NAME], { stdio: "inherit" });
      } catch {
        process.exitCode = 1;
      }
      return;
    default:
      process.stderr.write(`pier service: unknown action "${action}"\n\n${HELP}`);
      process.exit(2);
  }
}
