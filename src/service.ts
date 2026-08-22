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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export interface UnitOptions {
  /** The node that is running us, by absolute path. */
  execPath: string;
  /** Absolute path of the entry point systemd should start. */
  entry: string;
  host: string;
  port: number;
  /** `$PIER_HOME`, or empty to leave Pier its own default. */
  pierHome?: string;
}

export function renderUnit({ execPath, entry, host, port, pierHome }: UnitOptions): string {
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
ExecStart=${execPath} ${entry}
Environment=NODE_ENV=production
# Loopback by default. Put a reverse proxy in front before widening this —
# whoever reaches this port can drive an agent that runs a shell.
Environment=HOST=${host}
Environment=PORT=${port}
${pierHome ? `# Where the database, the boards and the password hash live.\nEnvironment=PIER_HOME=${pierHome}\n` : ""}Restart=always
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

/**
 * The updater is a second unit because it must not be a child of the service it
 * restarts: `systemctl --user restart pier` kills everything in pier.service's
 * cgroup, so an update spawned by Pier itself would die between "unpacked" and
 * "restarted" — the one outcome worse than not updating. Started from its own
 * cgroup, it survives restarting its parent.
 */
export function renderUpdateUnit(execPath: string): string {
  const npm = join(dirname(execPath), "npm");
  return `[Unit]
Description=Update Pier to the latest published version
Documentation=https://github.com/timqi/pier

[Service]
Type=oneshot
# The npm beside the node that is running Pier, so a version manager's
# installation is the one updated.
ExecStart=${npm} install -g @timqi/pier@latest
# Its own cgroup, so restarting pier.service does not kill this.
ExecStartPost=systemctl --user restart ${UNIT_NAME}
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

/** Best-effort: a step that fails says so and the rest still runs, because a
 *  half-installed service the operator knows about beats a stack trace. */
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

export function install(options: InstallOptions): void {
  const { force, home = homedir(), say, exec, ...unit } = options;
  const run = exec ?? runner(say);
  const path = unitPath(home);

  if (existsSync(path) && !force) {
    say(`${path} already exists — nothing written. Re-run with --force to replace it.`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderUnit(unit), { mode: 0o644 });
  say(`wrote ${path}`);

  const limits = limitsPath(home);
  if (existsSync(limits)) {
    say(`kept ${limits}`); // tuned by hand, by definition
  } else {
    mkdirSync(dirname(limits), { recursive: true });
    writeFileSync(limits, renderLimits(), { mode: 0o644 });
    say(`wrote ${limits}`);
  }

  run(["systemctl", "--user", "daemon-reload"]);
  // Without lingering, the user manager stops at logout and takes every
  // scheduled task with it. It can need a polkit prompt, hence best-effort.
  if (!run(["loginctl", "enable-linger", userInfo().username])) {
    say(`  run it yourself so Pier survives logout: loginctl enable-linger ${userInfo().username}`);
  }
  if (run(["systemctl", "--user", "enable", "--now", UNIT_NAME])) {
    say(`started. The first run prints a password once: journalctl --user -u pier -e`);
  }
}

/**
 * Update in place: write the oneshot unit and start it. Returns false when
 * there is no service to update, which is the caller's cue to say so — an
 * update that silently did nothing is worse than a refusal.
 */
export function startUpdate(options: {
  execPath: string;
  home?: string;
  say: (message: string) => void;
  exec?: Exec;
}): boolean {
  const { execPath, home = homedir(), say } = options;
  const run = options.exec ?? runner(say);
  if (!existsSync(unitPath(home))) return false;

  writeFileSync(updateUnitPath(home), renderUpdateUnit(execPath), { mode: 0o644 });
  run(["systemctl", "--user", "daemon-reload"]);
  if (!run(["systemctl", "--user", "start", "--no-block", UPDATE_UNIT_NAME])) return true;
  say(`updating in the background — follow it with: journalctl --user -u ${UPDATE_UNIT_NAME} -f`);
  say(`Pier restarts itself when the install lands; sessions resume, a turn in flight does not.`);
  return true;
}

export function uninstall(
  home = homedir(),
  say: (message: string) => void = console.log,
  exec?: Exec,
): void {
  const run = exec ?? runner(say);
  run(["systemctl", "--user", "disable", "--now", UNIT_NAME]);
  for (const path of [unitPath(home), limitsPath(home), updateUnitPath(home)]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    say(`removed ${path}`);
  }
  rmSync(dirname(limitsPath(home)), { force: true, recursive: true });
  run(["systemctl", "--user", "daemon-reload"]);
  // Left alone on purpose: the database, the boards, and linger — none of them
  // are this command's to decide about.
  say(`$PIER_HOME is untouched; linger is still enabled.`);
}
