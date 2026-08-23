// The systemd user unit Pier writes for itself.
//
// A *user* unit, not a system one: Pier runs as you, reads your Pi
// configuration and drives sessions in your own directories. As root or a
// dedicated service user it would be an agent that cannot touch the files you
// wanted it to work on.
//
// Writing this file is a command rather than a page of documentation to copy
// because two of its lines are only knowable at runtime: the absolute path of
// the node that is running (systemd starts with a minimal PATH, so a node
// installed by fnm/nvm/asdf is not on it) and the absolute path of the
// installed entry point.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const UNIT_NAME = "pier.service";
export const UPDATE_UNIT_NAME = "pier-update.service";

/** `~/.config/systemd/user/pier.service` — where a user unit belongs. */
export const unitPath = (home = homedir()): string =>
  join(home, ".config", "systemd", "user", UNIT_NAME);

/** The drop-in Pier writes once and never touches again: what the unit may
 *  consume is the operator's call, not ours. */
export const limitsPath = (home = homedir()): string =>
  join(dirname(unitPath(home)), `${UNIT_NAME}.d`, "limits.conf");

/** The oneshot that installs a new version, beside the unit it restarts. */
export const updateUnitPath = (home = homedir()): string =>
  join(dirname(unitPath(home)), UPDATE_UNIT_NAME);

/** Runtime-only effective state for the updater, regenerated before each run. */
export const updateRuntimePath = (home = homedir()): string =>
  join(dirname(unitPath(home)), `${UPDATE_UNIT_NAME}.d`, "runtime.conf");

export interface UnitOptions {
  /** The node and npm that installed Pier, both absolute and kept as a pair. */
  execPath: string;
  npmPath: string;
  /** Absolute path of the entry point systemd should start. */
  entry: string;
  host: string;
  port: number;
  /** `$PIER_HOME`, or empty to leave Pier its own default. */
  pierHome?: string;
  /** The `PATH` of the shell that ran the install, recorded verbatim; absent
   *  when bridging an old unit that never recorded one. */
  shellPath?: string;
}

/** Quote one systemd word. Percent is doubled because specifier expansion runs
 * after parsing; dollar is doubled only for command lines. */
function quote(value: string, command = false): string {
  if (/[\0\r\n]/.test(value)) throw new Error("systemd values cannot contain control characters");
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (command) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

const environment = (key: string, value: string): string =>
  `Environment=${quote(`${key}=${value}`)}`;

/** The PATH both units carry: the recorded node first, then the shell that ran
 * the install (`pier service install` is typed in that shell, so its own PATH
 * *is* the login one), with the standard directories as a floor.
 *
 * Recorded at install rather than sourced from a login shell at start, which
 * would hand a dotfile the power to decide whether Pier boots and which node
 * npm installs into. Relative entries are dropped: they would resolve against
 * WorkingDirectory, which is not where the operator was standing. */
function pathEnv(execPath: string, shellPath?: string): string {
  const seen = new Set<string>();
  return [dirname(execPath), ...(shellPath ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((dir) => dir.startsWith("/") && !/[\0\r\n]/.test(dir) && !seen.has(dir) && seen.add(dir))
    .join(":");
}

export function renderUnit(options: UnitOptions): string {
  const { execPath, entry, host, port, pierHome, shellPath } = options;
  return `[Unit]
Description=Pier — agent workspace
Documentation=https://github.com/timqi/pier
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
# Absolute paths on purpose: systemd starts with a minimal PATH, and the node
# that installed Pier is usually not on it.
ExecStart=${quote(execPath, true)} ${quote(entry, true)}
${environment("NODE_ENV", "production")}
# Inherited by every command a turn runs, which is why it is here and not just
# in the updater: an agent typing "npm test" on systemd's minimal PATH would be
# told node does not exist on a machine that installed Pier with it.
${environment("PATH", pathEnv(execPath, shellPath))}
# Loopback by default. Put a reverse proxy in front before widening this —
# whoever reaches this port can drive an agent that runs a shell.
${environment("HOST", host)}
${environment("PORT", String(port))}
${pierHome ? `# Where the database, the boards and the password hash live.\n${environment("PIER_HOME", pierHome)}\n` : ""}Restart=always
RestartSec=2
# The journal is where the first-run password is printed, so keep it readable.
StandardOutput=journal
StandardError=journal
# Otherwise every line is tagged "node"; this makes \`journalctl -t pier\` work.
SyslogIdentifier=pier

[Install]
WantedBy=default.target
`;
}

/** The 0.0.1 unit did not record npm. This one-time bridge can only use npm
 * beside its recorded Node; a forced reinstall writes the exact executable. */
function legacyOptions(home: string): UnitOptions {
  const text = readFileSync(unitPath(home), "utf8");
  const start = text.match(/^ExecStart=(\S+) (\S+)$/m);
  const host = text.match(/^Environment=HOST=(\S+)$/m)?.[1];
  const rawPort = text.match(/^Environment=PORT=(\d+)$/m)?.[1];
  const pierHome = text.match(/^Environment=PIER_HOME=(\S+)$/m)?.[1];
  if (!start?.[1] || !start[2] || !host || !rawPort) throw new Error("unit is not the 0.0.1 Pier shape");
  return {
    execPath: start[1],
    npmPath: join(dirname(start[1]), "npm"),
    entry: start[2],
    host,
    port: Number(rawPort),
    ...(pierHome ? { pierHome } : {}),
  };
}

/** A separate cgroup stops Pier, takes a consistent backup, updates the exact
 * npm installation recorded at install time, and always starts Pier again. */
export function renderUpdateUnit(options: UnitOptions): string {
  const { execPath, npmPath, entry, pierHome, shellPath } = options;
  const cli = join(dirname(entry), "cli.js");
  return `[Unit]
Description=Update Pier to the latest published version
Documentation=https://github.com/timqi/pier

[Service]
Type=oneshot
# The absolute node below answers npm's own shebang and nothing else: a
# dependency's postinstall runs as "sh -c node scripts/postinstall", which
# resolves node from PATH, and systemd's minimal PATH has no fnm/nvm node —
# the install then dies with "node: not found" with the tree half written.
${environment("PATH", pathEnv(execPath, shellPath))}
${pierHome ? `${environment("PIER_HOME", pierHome)}\n` : ""}ExecStart=systemctl --user stop ${UNIT_NAME}
ExecStart=${quote(execPath, true)} ${quote(cli, true)} backup
# npm runs under the recorded node: its shebang needs a node on PATH too.
ExecStart=${quote(execPath, true)} ${quote(npmPath, true)} install -g @timqi/pier@latest
# ExecStopPost runs on success and failure, so a failed backup or npm install
# does not leave the previously working service stopped.
ExecStopPost=systemctl --user start ${UNIT_NAME}
`;
}

/**
 * Sized as a share of the machine, not as "how much should Pier need": the
 * limit covers node, every subagent and every command a turn ran, and it
 * exists to protect the OS and sshd outside it. Written commented so the
 * operator tuning it can see what each line buys.
 */
export function renderLimits(): string {
  return `[Service]
# Soft ceiling: past this the kernel reclaims hard and lets the unit crawl
# instead of killing anything. This is the one that should bite first.
MemoryHigh=60%
# Hard ceiling: the kernel OOM-kills *inside this cgroup*, so what it leaves
# behind is for everything outside it.
MemoryMax=75%
# Swapping an agent is worse than failing it.
MemorySwapMax=0
# A runaway command an agent ran can fork as well as allocate.
TasksMax=512
# Prefer this unit's processes if the *machine* runs out anyway.
OOMScoreAdjust=200
# A child being OOM-killed must not take the service with it.
OOMPolicy=continue
`;
}

/** Runs a command, or in a test records that it would have. */
export type Exec = (argv: string[]) => boolean;

/** A command failure is printed here and propagated by its caller. Linger is
 * the only deliberately best-effort step. */
const runner = (say: (message: string) => void): Exec => (argv) => {
  try {
    execFileSync(argv[0]!, argv.slice(1), { stdio: "pipe" });
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    say(`! ${argv.join(" ")} — ${detail}`);
    return false;
  }
};

export interface InstallOptions extends UnitOptions {
  /** Rewrite a unit that is already there. */
  force: boolean;
  home?: string;
  say: (message: string) => void;
  /** Injected by tests, which must not talk to a real service manager. */
  exec?: Exec;
}

export function install(options: InstallOptions): boolean {
  const { force, home = homedir(), say, exec, ...unit } = options;
  const run = exec ?? runner(say);
  const path = unitPath(home);
  const replacing = existsSync(path);

  if (replacing && !force) {
    say(`${path} already exists — nothing written. Re-run with --force to replace it.`);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderUnit(unit), { mode: 0o644 });
  writeFileSync(updateUnitPath(home), renderUpdateUnit(unit), { mode: 0o644 });
  say(`wrote ${path}`);
  say(`wrote ${updateUnitPath(home)}`);

  const limits = limitsPath(home);
  if (existsSync(limits)) {
    say(`kept ${limits}`); // tuned by hand, by definition
  } else {
    mkdirSync(dirname(limits), { recursive: true });
    writeFileSync(limits, renderLimits(), { mode: 0o644 });
    say(`wrote ${limits}`);
  }

  if (!run(["systemctl", "--user", "daemon-reload"])) return false;
  // Without lingering, the user manager stops at logout and takes every
  // scheduled task with it. It can need a polkit prompt, hence best-effort.
  if (!run(["loginctl", "enable-linger", userInfo().username])) {
    say(`  run it yourself so Pier survives logout: loginctl enable-linger ${userInfo().username}`);
  }
  if (replacing) {
    if (!run(["systemctl", "--user", "enable", UNIT_NAME])) return false;
    if (!run(["systemctl", "--user", "restart", UNIT_NAME])) return false;
  } else if (!run(["systemctl", "--user", "enable", "--now", UNIT_NAME])) return false;
  say(`started. The first run prints a password once: journalctl --user -u pier -e`);
  return true;
}

export type UpdateStart = "started" | "not-installed" | "failed";

/**
 * Why the installed updater could not do its job, or `null` when nothing is
 * wrong. Checked while Pier is still alive, because the alternative is finding
 * out at the next restart, from a service that no longer starts.
 *
 * The absolute node and npm paths in the unit are deliberate — systemd's PATH
 * has neither — but they pin the unit to one directory of one version manager.
 * `fnm install 26 && fnm uninstall 24` leaves ExecStart naming a Node that is
 * gone; the running process survives (Linux keeps a deleted binary mapped),
 * so nothing would notice until the update, or the next boot, failed.
 */
export function updaterProblem(home = homedir()): string | null {
  if (!existsSync(unitPath(home))) return null; // not a service install; nothing to check
  const path = updateUnitPath(home);
  let unit: string;
  if (existsSync(path)) {
    try {
      unit = readFileSync(path, "utf8");
    } catch (err) {
      return `${path} cannot be read: ${String(err)}`;
    }
  } else {
    // A 0.0.1 install: startUpdate generates the updater from the main unit,
    // so a missing file is only a problem when that bridge cannot either —
    // and the generated text gets the same executable check below.
    try {
      unit = renderUpdateUnit(legacyOptions(home));
    } catch {
      return `${UPDATE_UNIT_NAME} is missing — run: pier service install --force`;
    }
  }
  // The one line that names both executables, quoted and escaped by quote().
  // Unparseable means hand-edited, which is not this function's business to
  // judge; the escaping is undone before existsSync sees a path (a `%` or `$`
  // in it would otherwise read as gone on a working updater).
  const install = unit.match(/^ExecStart="((?:\\.|[^"\r\n])+)" "((?:\\.|[^"\r\n])+)" install -g/m);
  if (!install) return null;
  const unescape = (word: string): string =>
    word.replaceAll("$$", "$").replaceAll("%%", "%").replace(/\\(.)/g, "$1");
  for (const [what, bin] of [["node", unescape(install[1]!)], ["npm", unescape(install[2]!)]] as const) {
    if (!existsSync(bin)) {
      return `the ${what} the updater would use is gone (${bin}) — a version manager removed it; run: pier service install --force`;
    }
  }
  return null;
}

function runningPierHome(home: string): string {
  const pid = Number(execFileSync(
    "systemctl",
    ["--user", "show", UNIT_NAME, "--property=MainPID", "--value"],
    { encoding: "utf8" },
  ).trim());
  if (Number.isInteger(pid) && pid >= 1) {
    const value = readFileSync(`/proc/${pid}/environ`)
      .toString()
      .split("\0")
      .find((item) => item.startsWith("PIER_HOME="))
      ?.slice("PIER_HOME=".length);
    return value || join(home, ".pier");
  }
  // Installed but stopped: the unit file records any override (quoted and
  // escaped since 0.0.2, bare in the 0.0.1 shape) — undo quote()'s escaping
  // or the drop-in would carry `%%`/`\\"` into a real path.
  const raw = readFileSync(unitPath(home), "utf8")
    .match(/^Environment="?PIER_HOME=((?:\\.|[^"\r\n])+)"?$/m)?.[1];
  const fromUnit = raw?.replaceAll("%%", "%").replace(/\\(.)/g, "$1");
  return fromUnit || join(home, ".pier");
}

/** Start the updater recorded at install time. Its tiny drop-in captures the
 * running service's effective home, including an operator override. */
export function startUpdate(options: {
  home?: string;
  say: (message: string) => void;
  exec?: Exec;
  effectiveHome?: () => string;
}): UpdateStart {
  const { home = homedir(), say } = options;
  const run = options.exec ?? runner(say);
  if (!existsSync(unitPath(home))) return "not-installed";

  try {
    if (!existsSync(updateUnitPath(home))) {
      writeFileSync(updateUnitPath(home), renderUpdateUnit(legacyOptions(home)), { mode: 0o644 });
      say(`generated a legacy updater; run "pier service install --force" after this update to record the exact npm path.`);
    }
    const runtime = updateRuntimePath(home);
    mkdirSync(dirname(runtime), { recursive: true });
    writeFileSync(runtime, `[Service]\n${environment("PIER_HOME", (options.effectiveHome ?? (() => runningPierHome(home)))())}\n`, { mode: 0o644 });
  } catch (err) {
    say(`! cannot prepare update — ${String(err)}`);
    return "failed";
  }
  if (!run(["systemctl", "--user", "daemon-reload"])) return "failed";
  if (!run(["systemctl", "--user", "start", "--no-block", UPDATE_UNIT_NAME])) return "failed";
  say(`updating in the background — follow it with: journalctl --user -u ${UPDATE_UNIT_NAME} -f`);
  say(`Pier stops, snapshots the database into db/backups/, installs, then starts again.`);
  return "started";
}

export function uninstall(
  home = homedir(),
  say: (message: string) => void = console.log,
  exec?: Exec,
): boolean {
  const run = exec ?? runner(say);
  if (!run(["systemctl", "--user", "disable", "--now", UNIT_NAME])) return false;
  for (const path of [unitPath(home), limitsPath(home), updateUnitPath(home), updateRuntimePath(home)]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    say(`removed ${path}`);
  }
  for (const dir of [dirname(limitsPath(home)), dirname(updateRuntimePath(home))]) {
    try {
      rmdirSync(dir); // non-recursive: drop-ins the operator added are not ours to delete
    } catch {
      if (existsSync(dir)) say(`kept ${dir} — it has files Pier did not write`);
    }
  }
  const ok = run(["systemctl", "--user", "daemon-reload"]);
  // Left alone on purpose: the database, the boards, and linger — none of them
  // are this command's to decide about.
  say(`$PIER_HOME is untouched; linger is still enabled.`);
  return ok;
}
