// The binaries Pier manages for itself, installed by `ubix` (github:timqi/ubix)
// from a generated config into one directory that goes first on PATH. The only
// thing fetched here is ubix itself; a new tool is a row in MANAGED.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CatalogBinary, CatalogEntry } from "./core/types.js";
import { pierDb, transact } from "./db.js";
import { logger } from "./log.js";
import { pierPath, resolveAgentDir } from "./paths.js";

const log = logger("tools");

/** The API, not a download URL: the asset name carries the release tag. */
const UBIX_LATEST = "https://api.github.com/repos/timqi/ubix/releases/latest";

/** One binary Pier will install and keep current on request. */
export interface ManagedTool {
  name: string;
  /** One line, shown beside the switch that turns it on. */
  summary: string;
  /** The body of this tool's `[tools.<name>]` block, written verbatim under a
   *  header Pier owns; which keys exist is ubix's vocabulary, and Pier guards
   *  the structure only (`normalizeCustomTools`). */
  toml: string;
  /** Run after every install and upgrade, from the tool's own binary — also how
   *  a registration with Pi stays current. */
  provision?: readonly string[];
  /** Run *before* the binary is removed: undoing `provision` takes the tool. */
  deprovision?: readonly string[];
  /** True only for a row built from an operator's own block. */
  custom?: boolean;
}

export const MANAGED: readonly ManagedTool[] = [
  {
    name: "rtk",
    toml: `spec = "github:rtk-ai/rtk"`,
    summary:
      "Compresses long bash output before it reaches the model. Installs its own " +
      "Pi extension (extensions/rtk.ts, listed under the local package) — " +
      "refreshed on every update.",
    // Write-if-changed inside rtk: re-running after an upgrade is the extension-update path.
    provision: ["init", "-g", "--agent", "pi"],
    deprovision: ["init", "--uninstall", "--agent", "pi", "--global"],
  },
  {
    name: "rg",
    // `exe`: ubi looks for files named after the project, and ripgrep ships `rg`.
    toml: `spec = "github:BurntSushi/ripgrep"\nexe = "rg"`,
    summary: "ripgrep: searches a tree by content, fast enough to be the default.",
  },
  {
    name: "fd",
    toml: `spec = "github:sharkdp/fd"`,
    summary: "Finds files by name, respecting .gitignore — what `find` should feel like.",
  },
  {
    name: "wt",
    toml: `spec = "github:max-sixty/worktrunk"\nexe = "wt"`,
    summary: "worktrunk: git worktrees as one command — branch, switch, merge, clean up.",
  },
  {
    name: "jq",
    // No `exe`: jq publishes bare per-platform binaries, which ubi installs
    // under the tool's own name.
    toml: `spec = "github:jqlang/jq"`,
    summary: "Slices, filters and reshapes JSON on the command line.",
  },
];

/** A tool the operator added by writing a block of their own. */
export interface CustomTool {
  name: string;
  toml: string;
}

/** No dot: `[tools.a.b]` is a different table than the one Pier means to write. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const MAX_CUSTOM = 16;
/** Generous: a templated `url:` tool carries two ~200-character URLs. */
const MAX_BODY = 2000;

/** The `spec = "…"` a block must carry. */
export function specOf(toml: string): string | null {
  // A `spec = "…"` inside a multiline string is text, not a key.
  let inside = false;
  for (const line of toml.split("\n")) {
    const fences = (line.match(/"""|'''/g) ?? []).length;
    if (inside || fences % 2 === 1) {
      inside = inside ? fences % 2 === 0 : true;
      continue;
    }
    const match = /^\s*spec\s*=\s*"([^"]+)"\s*(?:#.*)?$|^\s*spec\s*=\s*'([^']+)'\s*(?:#.*)?$/.exec(line);
    const value = (match?.[1] ?? match?.[2])?.trim();
    if (value) return value;
  }
  return null;
}

export const CUSTOM_TOOL_RULES =
  `each custom tool needs a name (letters, digits, _ and -, ≤32 characters, not a built-in or "ubix")` +
  ` and a block body with a spec line — spec = "github:owner/repo", plus any ubix keys it needs.` +
  ` Pier writes the [tools.<name>] header itself: a line opening a section of its own is refused, so are` +
  ` control characters and a body over ${String(MAX_BODY)} characters; at most ${String(MAX_CUSTOM)} tools`;

/** Boundary check, rejecting rather than repairing. Pier guards the structure
 *  of the file it generates: a body that could open `[settings]` could point
 *  `install_dir` anywhere, and a managed name twice is a switch whose meaning
 *  depends on which ran last. Key validity is ubix's to report. */
export function normalizeCustomTools(
  raw: unknown,
  /** Names this file cannot see: the bundled extensions, handed in by main.ts. */
  reserved: readonly string[] = [],
  /** `"drop"` when reading a stored row: the catalog may have grown into that
   *  name after it was written, and the bundled row installs the same binary.
   *  The declaration stays in the row for a Pier that stops bundling it. */
  managedName: "reject" | "drop" = "reject",
): CustomTool[] | null {
  // Case-insensitively: one filename on a case-insensitive filesystem.
  const taken = new Set(
    [...MANAGED.map((tool) => tool.name), ...reserved, "ubix"].map((name) => name.toLowerCase()),
  );
  if (!Array.isArray(raw) || raw.length > MAX_CUSTOM) return null;
  const tools: CustomTool[] = [];
  for (const item of raw) {
    const given = record(item);
    if (!given) return null;
    const { name, toml } = given;
    if (typeof name !== "string") return null;
    const cleanName = name.trim();
    if (!TOOL_NAME.test(cleanName)) return null;
    if (taken.has(cleanName.toLowerCase())) {
      if (managedName === "reject") return null;
      continue;
    }
    if (tools.some((tool) => tool.name.toLowerCase() === cleanName.toLowerCase())) return null;
    if (typeof toml !== "string") return null;
    const body = toml.trim();
    if (!body || body.length > MAX_BODY) return null;
    // A section header would take the rest of the file with it.
    if (body.split("\n").some((line) => line.trimStart().startsWith("["))) return null;
    // Tabs and newlines are the only control characters a TOML body needs.
    if ([...body].some((ch) => (ch < " " && ch !== "\n" && ch !== "\t") || ch === "\u007f")) return null;
    if (!specOf(body)) return null;
    tools.push({ name: cleanName, toml: body });
  }
  return tools;
}

const toolsDir = (...parts: string[]): string => pierPath("tools", ...parts);

const toolsBin = (): string => toolsDir("bin");

/** First, not last: a tool switched on in the Console is Pier's copy at Pier's
 *  version, whatever /usr/bin has. */
export function prependPath(env: NodeJS.ProcessEnv = process.env, bin: string = toolsBin()): void {
  const current = env.PATH ?? "";
  if (current.split(delimiter).includes(bin)) return;
  mkdirSync(bin, { recursive: true }); // a PATH entry that does not exist is a shell's problem
  env.PATH = current ? `${bin}${delimiter}${current}` : bin;
}

/** Structural rather than the settings type: settings.ts imports this file. */
export interface EnabledTools {
  tools: readonly string[];
  customTools: readonly CustomTool[];
}

/** Long enough that one Console page open spawns `ubix list` once, short
 *  enough that an install done outside Pier shows up while they look. */
const LIST_TTL_MS = 3_000;

/** `stale` is heartbeat age, never how long the work has taken; `wait` is what
 *  a waiter gives a live holder before giving up with a reason. */
const LOCK_TIMING = { heartbeatMs: 5_000, staleMs: 30_000, waitMs: 20 * 60_000, pollMs: 200 };

/** One tools sync at a time on this machine, whichever process asked: a row
 *  and a random token, taken over on heartbeat age, and fenced before every
 *  step because a heartbeat cannot prove a holder dead. The fence bounds
 *  overlap to one started step — closing that would need a kernel lock — and
 *  ubix's own flock on its state file (`--wait`) is the floor underneath. */
export class SyncLock {
  readonly #db: DatabaseSync;
  readonly #timing: typeof LOCK_TIMING;

  constructor(db: DatabaseSync, timing: Partial<typeof LOCK_TIMING> = {}) {
    this.#db = db;
    this.#timing = { ...LOCK_TIMING, ...timing };
  }

  /** `work` must call the fence before every step that changes anything
   *  outside this process. */
  async run<T>(work: (fence: () => void) => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + this.#timing.waitMs;
    while (!this.#acquire(token)) {
      if (Date.now() > deadline) {
        throw new Error(
          `another tools sync has held the lock for ${String(Math.round(this.#timing.waitMs / 60_000))}` +
            ` minutes — nothing was changed`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.#timing.pollMs));
    }
    const beat = setInterval(() => this.#refresh(token), this.#timing.heartbeatMs);
    beat.unref();
    try {
      return await work(() => this.#fence(token));
    } finally {
      clearInterval(beat);
      this.#db.prepare("DELETE FROM tools_sync_lock WHERE token = ?").run(token);
    }
  }

  /** One transaction, so two waiters cannot both win a takeover. */
  #acquire(token: string): boolean {
    const now = Date.now();
    const { stale, taken } = transact(this.#db, () => ({
      stale: this.#db.prepare("DELETE FROM tools_sync_lock WHERE heartbeat_at <= ?")
        .run(now - this.#timing.staleMs),
      taken: this.#db.prepare("INSERT OR IGNORE INTO tools_sync_lock (id, token, heartbeat_at) VALUES (1, ?, ?)")
        .run(token, now),
    }));
    if (stale.changes && taken.changes) log.warn("took over a tools sync lock whose holder stopped beating");
    return taken.changes === 1;
  }

  /** The authority is the row, asked now — a stopped process's heartbeat
   *  bookkeeping did not run either. */
  #fence(token: string): void {
    const row = this.#db.prepare("SELECT token FROM tools_sync_lock").get() as { token: string } | undefined;
    if (row?.token !== token) {
      throw new Error(
        "this sync lost its lock — another tools sync took it over while this one was stopped, so it went no further",
      );
    }
  }

  #refresh(token: string): void {
    const beat = this.#db.prepare("UPDATE tools_sync_lock SET heartbeat_at = ? WHERE token = ?").run(Date.now(), token);
    if (!beat.changes) log.warn("this tools sync no longer holds the lock — it stops at its next step");
  }
}

/** `waiting`: a sync was already running and this request rides the run that follows. */
export type SyncRequest = "started" | "waiting";

/** Always something to wait for: "refused, nothing in flight" would loop with
 *  nothing to loop on, so the type cannot spell it. */
export type SyncAttempt =
  | { ran: "started"; settled: Promise<void> }
  | { ran: "overlapped"; settled: Promise<void> };

/** The task layer refuses an overlapping run, so a request landing on a running
 *  sync is remembered as one bit (no backlog from a click storm) and exactly one
 *  more run follows, reading the set as it is by then. */
export function coalescedSync(
  /** Structural, so this file knows nothing about tasks/. */
  run: () => SyncAttempt,
  onFailure: (err: unknown) => void,
): () => SyncRequest {
  let chain: Promise<void> | null = null;
  let pending = false;

  const drive = async (): Promise<void> => {
    do {
      // Cleared before the run: a request arriving mid-flight earns its own follow-up.
      pending = false;
      const { ran, settled } = run();
      await settled;
      if (ran === "overlapped") pending = true;
    } while (pending);
  };

  return () => {
    if (chain) {
      pending = true;
      return "waiting";
    }
    let finish!: () => void;
    // Assigned before `drive`: one that never awaits would finish first.
    chain = new Promise<void>((resolve) => (finish = resolve));
    void drive().catch(onFailure).finally(() => {
      chain = null;
      pending = false;
      finish();
    });
    return "started";
  };
}

/** Never rejects: a failed tool is a report, and `code: null` is "could not
 *  start". Injected so tests never spawn ubix. */
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;

const spawnExec: Exec = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, [...args], { env, maxBuffer: 8 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
      const failure = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = typeof failure?.code === "number" ? failure.code : failure ? null : 0;
      resolve({
        code,
        stdout,
        // A spawn that never happened (ENOENT, EACCES) writes nothing to stderr.
        stderr: failure && code === null ? `${stderr}${failure.message}` : stderr,
      });
    });
  });

/** The union of what `list` and `upgrade` say; fields the other command does
 *  not have are null. */
export interface UbixToolState {
  name: string;
  /** `list`: the recorded installed version. `upgrade`: what it moved to. */
  version: string | null;
  /** First tracked executable path (`list` only). */
  path: string | null;
  /** `list` only: a state record exists. */
  installed: boolean | null;
  /** `list` only. `installed && !exists` is broken, not ready. */
  exists: boolean | null;
  /** The tracked paths that are missing right now. */
  missingPaths: string[];
  /** `upgrade` only: installed / upgraded / skipped / pinned-skip / failed /
   *  orphan / pruned / would-*, verbatim. */
  action: string | null;
  to: string | null;
  /** The full failure chain when `action` is `failed`. */
  error: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** ubix bumps this on any breaking change to the fields read below. */
const UBIX_SCHEMA = 1;

/** The one reader of ubix JSON. Anything not exactly as expected throws: a
 *  field parsed as `null` would draw an installed tool as absent (§5). */
export function parseUbixJson(stdout: string): UbixToolState[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`ubix --json did not answer with JSON: ${stdout.trim().slice(0, 200) || "(nothing)"}`);
  }
  const top = record(doc);
  if (!top || !Array.isArray(top.tools)) {
    throw new Error(`ubix --json has no tools array: ${stdout.trim().slice(0, 200)}`);
  }
  if (top.schema_version !== UBIX_SCHEMA) {
    throw new Error(
      `ubix --json is schema ${JSON.stringify(top.schema_version)}, and Pier reads ${String(UBIX_SCHEMA)}` +
        ` — refusing to guess what its fields mean now`,
    );
  }
  return top.tools.map((value): UbixToolState => {
    const entry = record(value);
    if (!entry) throw new Error(`ubix --json entry is not an object: ${JSON.stringify(value).slice(0, 120)}`);
    const where = typeof entry.name === "string" ? entry.name : JSON.stringify(value).slice(0, 80);
    const str = (key: string): string | null => {
      const raw = entry[key];
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string") throw new Error(`ubix --json: ${where}.${key} is not a string`);
      return raw.trim() || null;
    };
    const flag = (key: string): boolean | null => {
      const raw = entry[key];
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "boolean") throw new Error(`ubix --json: ${where}.${key} is not a boolean`);
      return raw;
    };
    const list = (key: string): string[] => {
      const raw = entry[key];
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        throw new Error(`ubix --json: ${where}.${key} is not a list of paths`);
      }
      return raw as string[];
    };
    const name = str("name");
    if (!name) throw new Error(`ubix --json entry has no name: ${JSON.stringify(value).slice(0, 120)}`);
    const to = str("to_version");
    const action = str("action");
    return {
      name,
      version: str("installed_version") ?? to,
      path: list("install_paths")[0] ?? null,
      installed: flag("installed"),
      exists: flag("exists"),
      missingPaths: list("missing_paths"),
      action,
      to,
      // A failure with no words must not read as a tool that is fine.
      error: str("error") ?? (action === "failed" ? "ubix reported it failed and said no more" : null),
    };
  });
}

/** What one tool did in one sync, and what it is now. */
export interface ToolSyncEntry {
  name: string;
  /** ubix's own word for what happened, or Pier's for what it did around it. */
  action: string;
  version: string | null;
  error: string | null;
}

export interface ToolSyncReport {
  entries: ToolSyncEntry[];
  /** True when anything at all went wrong — the CLI's exit code. */
  failed: boolean;
  /** One line per tool, for a human reading a task run. */
  summary: string;
}

const tomlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Never the operator's `~/.config/ubix/config.toml`: this file is rewritten on
 *  every sync, which on a human-maintained one would delete their tools. */
export function ubixConfigToml(
  tools: readonly Pick<ManagedTool, "name" | "toml">[],
  installDir: string,
): string {
  const lines = [
    "# Generated by Pier from the tools switched on in the Console.",
    "# Rewritten on every sync — your own ~/.config/ubix/config.toml is untouched.",
    "",
    "[settings]",
    `install_dir = ${tomlString(installDir)}`,
  ];
  // The body is the operator's and must survive the round trip untouched.
  for (const tool of tools) lines.push("", `[tools.${tool.name}]`, tool.toml.trim());
  return `${lines.join("\n")}\n`;
}

/** clap's unknown-argument message, and ubix's own refusal on a command that
 *  takes no JSON. Nothing else counts as too old. */
const refusesJson = (stderr: string): boolean =>
  /unexpected argument\s+'?--json|unrecognized (?:option|argument)\s+'?--json|`--json` is not supported/i
    .test(stderr);

/** Pier put that binary in `bin/`, so `sync` re-bootstraps rather than reports. */
class UbixTooOld extends Error {}

/** A name in neither list is not an error: a row a future release drops must
 *  not stop the sync of everything else. */
function rows(custom: readonly CustomTool[]): ManagedTool[] {
  return [...MANAGED, ...custom.map((tool): ManagedTool => ({ summary: "", custom: true, ...tool }))];
}

export function ubixAsset(tag: string, platform: string, arch: string): string {
  const os = platform === "linux" || platform === "darwin" ? platform : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !cpu) {
    throw new Error(`ubix ships no build for ${platform}/${arch} — Pier cannot manage tools on this machine`);
  }
  return `ubix-${os}-${cpu}-${tag}.tar.gz`;
}

interface ReleaseAsset {
  name: string;
  url: string;
}

/** A shape that is not understood is an error, not an empty list. */
function parseRelease(doc: unknown): { tag: string; assets: ReleaseAsset[] } {
  const value = record(doc);
  const text = (raw: unknown): string | null => (typeof raw === "string" && raw.trim() ? raw.trim() : null);
  const tag = text(value?.tag_name);
  const rawAssets = value?.assets;
  if (!tag || !Array.isArray(rawAssets)) throw new Error("the ubix release feed has no tag or assets");
  const assets: ReleaseAsset[] = [];
  for (const raw of rawAssets) {
    const asset = record(raw);
    const name = text(asset?.name);
    const url = text(asset?.browser_download_url);
    if (name && url) assets.push({ name, url });
  }
  return { tag, assets };
}

/** One object so subprocesses and the network are injected once, for tests. */
export class ManagedTools {
  readonly #exec: Exec;
  readonly #fetch: typeof fetch;
  readonly #root: string;
  #lock: SyncLock | undefined;
  readonly #db: () => DatabaseSync;

  constructor(options: { exec?: Exec; fetch?: typeof fetch; root?: string; db?: () => DatabaseSync } = {}) {
    this.#exec = options.exec ?? spawnExec;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#root = options.root ?? toolsDir();
    // Opened on the first sync: `status()` and the catalog need no database.
    this.#db = options.db ?? pierDb;
  }

  get bin(): string {
    return join(this.#root, "bin");
  }

  /** The ubix binary Pier manages, whether or not it is there yet. */
  get ubixPath(): string {
    return join(this.bin, "ubix");
  }

  /** Latest release → asset → sha256 against the release's `checksums.txt` →
   *  extract → atomic rename. Every failure throws with what failed. */
  async bootstrapUbix(replace = false): Promise<string> {
    if (existsSync(this.ubixPath) && !replace) return this.ubixPath;
    const { tag, assets } = parseRelease(JSON.parse(await this.#getText(UBIX_LATEST)));
    const wanted = ubixAsset(tag, process.platform, process.arch);
    const asset = assets.find((a) => a.name === wanted);
    if (!asset) {
      throw new Error(`ubix ${tag} has no ${wanted} — it ships ${assets.map((a) => a.name).join(", ") || "nothing"}`);
    }
    const sums = assets.find((a) => a.name === "checksums.txt");
    if (!sums) throw new Error(`ubix ${tag} publishes no checksums.txt — refusing to install an unverified binary`);

    mkdirSync(this.bin, { recursive: true });
    // Same root as bin/, so the install is a rename, never a half-written binary on PATH.
    const staging = mkdtempSync(join(this.#root, ".bootstrap-"));
    try {
      const [archive, checksums] = await Promise.all([this.#getBytes(asset.url), this.#getText(sums.url)]);
      const expected = expectedSha256(checksums, wanted);
      const actual = createHash("sha256").update(archive).digest("hex");
      if (actual !== expected) {
        throw new Error(`${wanted} checksum mismatch: expected ${expected}, got ${actual}`);
      }
      const tarball = join(staging, wanted);
      writeFileSync(tarball, archive);
      // The system tar: one .tar.gz does not earn an npm package (AGENTS.md 8).
      const untar = await this.#exec("tar", ["-xzf", tarball, "-C", staging], process.env);
      if (untar.code !== 0) throw new Error(failedRun(`tar on ${wanted}`, untar));
      const extracted = join(staging, "ubix");
      if (!existsSync(extracted)) throw new Error(`${wanted} contains no "ubix" executable`);
      chmodSync(extracted, 0o755);
      renameSync(extracted, this.ubixPath);
      log.info(`installed ubix ${tag} into ${this.bin}`);
      return this.ubixPath;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Per-tool outcomes; whole-run failures throw. The set is read inside the
   *  lock: ubix reads the config before taking its own state lock, so an
   *  overlapping sync could otherwise write an older snapshot and exit 0. */
  async sync(read: () => EnabledTools): Promise<ToolSyncReport> {
    this.#lock ??= new SyncLock(this.#db());
    return this.#lock.run(async (fence) => {
      const { tools, customTools } = read();
      // The only thing that changes what `list` answers; drop the memo both sides.
      this.#listed = undefined;
      try {
        return await this.#converge(tools, customTools, fence);
      } finally {
        this.#listed = undefined;
      }
    });
  }

  async #converge(
    enabled: readonly string[],
    custom: readonly CustomTool[],
    fence: () => void,
  ): Promise<ToolSyncReport> {
    const all = rows(custom);
    const wanted = all.filter((tool) => enabled.includes(tool.name));
    // A first boot must not reach the network to find out it has no work.
    if (!wanted.length && !existsSync(this.ubixPath)) {
      return { entries: [], failed: false, summary: "no tools switched on" };
    }
    fence();
    const ubix = await this.bootstrapUbix();
    const env = this.#env();
    const entries: ToolSyncEntry[] = [];

    // ubix cannot know that rtk must uninstall its own Pi extension *before*
    // its binary goes; tools leaving the set undo their footprint first.
    const kept: ManagedTool[] = [];
    for (const state of await this.#listing(ubix, env)) {
      const leaving = all.find((tool) => tool.name === state.name);
      if (!leaving?.deprovision || wanted.some((tool) => tool.name === state.name)) continue;
      fence(); // a tool's own uninstall is a change to the machine
      const error = await this.#provision(env, leaving, leaving.deprovision);
      if (error) {
        // Removing it now would orphan what deprovision failed to remove.
        kept.push(leaving);
        entries.push({ name: leaving.name, action: "kept", version: null, error });
      }
    }

    fence();
    this.#writeConfig([...wanted, ...kept]);

    // `--prune` removes what the config no longer declares; `--wait` lets a
    // hand-typed `pier tools sync` converge behind the managed run.
    fence();
    const states = await this.#states(ubix, env, ["upgrade", "--all", "--prune", "--wait", "--json"]);
    for (const state of states) {
      if (wanted.some((tool) => tool.name === state.name)) continue;
      if (entries.some((entry) => entry.name === state.name)) continue;
      // A failure to remove is as much a failure as one to install.
      entries.push({ name: state.name, action: state.action ?? "removed", version: null, error: state.error });
    }
    for (const tool of wanted) {
      const state = states.find((s) => s.name === tool.name);
      const entry: ToolSyncEntry = {
        name: tool.name,
        action: state?.action ?? "missing",
        version: state?.to ?? state?.version ?? null,
        // A tool ubix never mentioned is not a tool that is fine.
        error: state?.error ?? (state ? null : "ubix reported nothing about it"),
      };
      if (!entry.error && tool.provision) {
        fence();
        entry.error = await this.#provision(env, tool, tool.provision);
      }
      entries.push(entry);
    }
    const failed = entries.some((entry) => entry.error !== null);
    return { entries, failed, summary: summarize(entries) };
  }

  /** Never throws: a page that 500s says less than a row saying why its
   *  version is unknown (§5). */
  async status(enabled: readonly string[], custom: readonly CustomTool[] = []): Promise<CatalogEntry[]> {
    const base = rows(custom).map((tool): CatalogEntry => ({
      name: tool.name,
      summary: tool.summary,
      enabled: enabled.includes(tool.name),
      binary: { spec: specOf(tool.toml) ?? "", installed: false, version: null, path: null, error: null },
      ...(tool.custom ? { custom: true } : {}),
    }));
    // No ubix yet: an instance that has never switched a tool on.
    if (!existsSync(this.ubixPath)) return base;
    let states: UbixToolState[];
    try {
      states = await this.#listedTools();
    } catch (err) {
      // A row drawn as "not installed" because a read failed is the lie §5 is about.
      const error = err instanceof Error ? err.message : String(err);
      return base.map((entry) => withBinary(entry, { error }));
    }
    return base.map((entry) => {
      const state = states.find((s) => s.name === entry.name);
      if (!state) return entry;
      const gone = state.installed === true && state.exists === false;
      // `npm:` lands in fnm's node prefix and `pixi:` in its own: installed,
      // but not where Pier's PATH points, and the row has to say so.
      const elsewhere = state.path !== null && !state.path.startsWith(`${this.bin}/`);
      return withBinary(entry, {
        installed: state.installed === true && !gone,
        version: state.version,
        path: state.path,
        error: gone
          ? `installed but missing on disk: ${state.missingPaths.join(", ") || "tracked paths are gone"}`
          : state.error ??
            (elsewhere
              ? `installed outside Pier's bin (${state.path ?? ""}) — this source installs into its own runtime's` +
                ` prefix, so Pier does not put it on the PATH sessions inherit`
              : null),
      });
    });
  }

  /** The Console asks for the catalog on every settings read, several per page
   *  open. A failed read is not retained. */
  #listed?: { at: number; states: Promise<UbixToolState[]> };

  #listedTools(): Promise<UbixToolState[]> {
    const now = Date.now();
    if (this.#listed && now - this.#listed.at < LIST_TTL_MS) return this.#listed.states;
    const states = this.#states(this.ubixPath, this.#env(), ["list", "--json"]);
    void states.catch(() => {
      if (this.#listed?.states === states) this.#listed = undefined;
    });
    this.#listed = { at: now, states };
    return states;
  }

  /** `UBIX_CONFIG_DIR` / `UBIX_DATA_DIR` name the directories directly — not
   *  XDG parents, which every child ubix spawns (uv, fnm, cargo) would read too. */
  #env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UBIX_CONFIG_DIR: this.#configDir,
      UBIX_DATA_DIR: join(this.#root, "state"),
    };
    prependPath(env, this.bin);
    return env;
  }

  get #configDir(): string {
    return join(this.#root, "config");
  }

  #writeConfig(tools: readonly CustomTool[]): void {
    mkdirSync(this.#configDir, { recursive: true });
    mkdirSync(join(this.#root, "state"), { recursive: true });
    // Rename: half a config is a config that declares half the tools.
    const path = join(this.#configDir, "config.toml");
    writeFileSync(`${path}.writing`, ubixConfigToml(tools, this.bin));
    renameSync(`${path}.writing`, path);
  }

  /** A non-zero exit still parses: under `--json` a failed tool is in the
   *  document as `action: "failed"`, and the run exits non-zero. The two must
   *  agree — an exit code with no failed entry is a failure this file cannot
   *  attribute, and passing it on as clean is the one thing it may never do. */
  async #states(ubix: string, env: NodeJS.ProcessEnv, args: readonly string[]): Promise<UbixToolState[]> {
    const result = await this.#exec(ubix, args, env);
    let states: UbixToolState[];
    try {
      states = parseUbixJson(result.stdout);
    } catch (err) {
      const failure = failedRun(`ubix ${args.join(" ")}`, result);
      // Only the flag being unknown means "too old"; re-bootstrapping over a
      // config error would fix nothing and say something false.
      if (result.code !== 0 && refusesJson(result.stderr)) throw new UbixTooOld(failure);
      throw new Error(result.code === 0 ? String(err) : `${failure} (${String(err)})`);
    }
    if (result.code !== 0 && !states.some((state) => state.action === "failed")) {
      throw new Error(`${failedRun(`ubix ${args.join(" ")}`, result)} — and its report names no failure`);
    }
    return states;
  }

  /** The one place a too-old ubix is repaired rather than reported. */
  async #listing(ubix: string, env: NodeJS.ProcessEnv): Promise<UbixToolState[]> {
    try {
      return await this.#states(ubix, env, ["list", "--json"]);
    } catch (err) {
      if (!(err instanceof UbixTooOld)) throw err;
      log.warn(`the ubix in ${this.bin} is too old for --json — replacing it`);
      return this.#states(await this.bootstrapUbix(true), env, ["list", "--json"]);
    }
  }

  /** Returns the failure text, or null. */
  async #provision(env: NodeJS.ProcessEnv, tool: ManagedTool, args: readonly string[]): Promise<string | null> {
    const exe = join(this.bin, tool.name);
    if (!existsSync(exe)) return `${tool.name} is not in ${this.bin} — ${args.join(" ")} was not run`;
    // `pier tools sync` typed in a shell has no main.ts parent exporting
    // PI_CODING_AGENT_DIR; rtk would then write its extension into ~/.pi.
    const agentDir = resolveAgentDir(env);
    if (env.PI_CODING_AGENT_DIR !== agentDir) {
      log.info(`PI_CODING_AGENT_DIR was ${env.PI_CODING_AGENT_DIR ?? "unset"} — ${tool.name} gets ${agentDir}`);
    }
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    const result = await this.#exec(exe, args, { ...env, PI_CODING_AGENT_DIR: agentDir });
    return result.code === 0 ? null : failedRun(`${tool.name} ${args.join(" ")}`, result);
  }

  async #getText(url: string): Promise<string> {
    return new TextDecoder().decode(await this.#getBytes(url));
  }

  async #getBytes(url: string): Promise<Uint8Array> {
    const res = await this.#fetch(url, {
      // GitHub refuses an anonymous request with no user agent.
      headers: { "user-agent": "pier", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`GET ${url} → ${String(res.status)} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

const withBinary = (entry: CatalogEntry, patch: Partial<CatalogBinary>): CatalogEntry =>
  ({ ...entry, binary: { ...entry.binary, ...patch } });

/** Never empty: an exit code with no words is not a report. */
const failedRun = (what: string, result: ExecResult): string =>
  `${what} exited ${String(result.code)}: ${result.stderr.trim().slice(0, 300) || "(no output)"}`;

/** `<sha256>  <bare filename>` lines, as `sha256sum` writes them. */
function expectedSha256(checksums: string, file: string): string {
  for (const line of checksums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name?.replace(/^\*/, "") === file) return hash.toLowerCase();
  }
  throw new Error(`checksums.txt names no ${file} — refusing to install an unverified binary`);
}

/** One line per tool, failures included (§5). */
function summarize(entries: readonly ToolSyncEntry[]): string {
  if (!entries.length) return "no tools switched on";
  return entries
    .map((entry) =>
      entry.error
        ? `${entry.name}: FAILED — ${entry.error}`
        : `${entry.name}: ${entry.action}${entry.version ? ` ${entry.version}` : ""}`
    )
    .join("\n");
}
