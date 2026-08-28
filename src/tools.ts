// The binaries Pier manages for itself: which ones exist, how they stay
// current, and the one directory they sit on ahead of the machine's own.
//
// Pier writes no downloader. `ubix` (github:timqi/ubix) is a declarative
// installer that already knows how to find the right release asset for a
// platform, so the only thing fetched here is ubix itself; everything after is
// a generated config file plus `ubix upgrade --all`. The tool-specific part is
// data (MANAGED below) — the next tool is a table row, not a code path.
//
// An instance-layer leaf: node stdlib, paths.ts and log.ts only. It knows
// nothing about tasks, sessions or the web — the daily update task is *shape
// and rule* here (`toolsTaskDraft`, `toolsTaskPlan`, both pure data), and
// main.ts is what calls tasks/ with them, because a leaf that scheduled itself
// would be two modules.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ManagedToolInfo } from "./core/types.js";
import { logger } from "./log.js";
import { pierPath, resolveAgentDir } from "./paths.js";

const log = logger("tools");

/** Where the ubix build Pier bootstraps comes from. The API, not a fixed
 *  download URL: the asset name carries the release tag, so the tag has to be
 *  asked for before anything can be fetched. */
const UBIX_LATEST = "https://api.github.com/repos/timqi/ubix/releases/latest";

/** How long a Console read of the installed state may take before it answers
 *  "busy" instead (see `status`). */
const STATUS_CAP_MS = 3000;

/** One binary Pier will install and keep current on request. */
export interface ManagedTool {
  name: string;
  /** A ubix spec — `github:owner/repo`, `pypi:name`, … */
  spec: string;
  /** One line, shown beside the switch that turns it on. */
  summary: string;
  /** Run after every install and every upgrade, from the tool's own binary:
   *  a tool that has to register something with Pi does it here, and doing it
   *  on every sync is also how that registration stays current. */
  provision?: readonly string[];
  /** Run *before* the binary is removed — undoing what `provision` did takes
   *  the tool that did it. */
  deprovision?: readonly string[];
}

/** The catalog. Data, not code: rg / fd / wt are rows nobody has written yet,
 *  and adding one must not need a new branch anywhere in this file. */
export const MANAGED: readonly ManagedTool[] = [
  {
    name: "rtk",
    spec: "github:rtk-ai/rtk",
    summary:
      "Compresses long bash output before it reaches the model. Installs its " +
      "own Pi extension into Pier's agent dir, refreshed on every update.",
    // Write-if-changed inside rtk, so re-running it after an upgrade is the
    // extension-update path and costs nothing when nothing moved.
    provision: ["init", "-g", "--agent", "pi"],
    deprovision: ["init", "--uninstall", "--agent", "pi", "--global"],
  },
];

/** `~/.pier/tools/…` — install target, generated ubix config, ubix state. */
export const toolsDir = (...parts: string[]): string => pierPath("tools", ...parts);

/** The one directory that goes on PATH: ubix installs into it, and everything
 *  Pier spawns inherits it. */
export const toolsBin = (): string => toolsDir("bin");

/**
 * First on PATH, once, at boot. First rather than last on purpose: a tool
 * switched on in the Console is Pier's copy at Pier's version, whatever the
 * machine happens to have in /usr/bin.
 */
export function prependPath(env: NodeJS.ProcessEnv = process.env, bin: string = toolsBin()): void {
  const current = env.PATH ?? "";
  if (current.split(delimiter).includes(bin)) return;
  mkdirSync(bin, { recursive: true }); // a PATH entry that does not exist is a shell's problem
  env.PATH = current ? `${bin}${delimiter}${current}` : bin;
}

/** Marks the daily update task as Pier's own, so main.ts finds the one it
 *  owns rather than one a person wrote. */
export const TOOLS_TASK_CREATOR = "tools";

/** The task, as data. A plain bash task on a plain cron: its run history is
 *  the whole tools status surface — output, failures and the last time it ran
 *  are runs a person can already read (§5b), not a second thing to build. */
export const toolsTaskDraft = (node: string, cli: string, cwd: string, timezone: string) => ({
  name: "tools: daily update",
  description: "Installs the CLI tools switched on in Settings → Agent and keeps them current.",
  trigger: { type: "cron" as const, expression: "17 4 * * *", timezone },
  // The recorded node and CLI path, quoted: a version manager changing PATH
  // months from now must not make the task unrunnable.
  action: { type: "bash" as const, script: `"${node}" "${cli}" tools sync`, cwd },
  timeoutSeconds: 1800,
});

/** What the enabled set owes the task. `flipped` is a human having just
 *  changed the set — the install then shows up as a run they can watch, where
 *  a restart is no reason to reinstall anything. */
export type ToolsTaskPlan =
  | { do: "nothing" }
  | { do: "create"; run: boolean }
  | { do: "run" }
  /** Nothing is switched on any more: one last converging run — which is what
   *  uninstalls the tools, deprovision included — and then the task goes. */
  | { do: "retire" };

export function toolsTaskPlan(
  enabled: readonly string[],
  hasTask: boolean,
  flipped: boolean,
): ToolsTaskPlan {
  if (!enabled.length) return hasTask ? { do: "retire" } : { do: "nothing" };
  if (!hasTask) return { do: "create", run: flipped };
  return flipped ? { do: "run" } : { do: "nothing" };
}

/** One subprocess, never rejecting: a tool that failed is a report, not a
 *  throw, and `code: null` is "it could not even start". Injected everywhere
 *  below so tests never spawn ubix. */
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
        // A spawn that never happened (ENOENT, EACCES) writes nothing to
        // stderr, and "exited null" alone would say nothing about why.
        stderr: failure && code === null ? `${stderr}${failure.message}` : stderr,
      });
    });
  });

/** One tool as ubix reports it — the union of what `list` and `upgrade` say,
 *  with the fields the other command does not have left null. */
export interface UbixToolState {
  name: string;
  /** `list`: the recorded installed version. `upgrade`: what it moved to. */
  version: string | null;
  /** First tracked executable path (`list` only). */
  path: string | null;
  /** `list`: a state record exists. Null on `upgrade`, which says nothing
   *  about the recorded state, only about what it just did. */
  installed: boolean | null;
  /** `list`: every tracked path is really on disk. `installed && !exists` is
   *  a tool that state says is there and the filesystem says is gone — broken,
   *  not ready, and the Console must not draw it as installed. */
  exists: boolean | null;
  /** The tracked paths that are missing right now. */
  missingPaths: string[];
  /** The pin, when the tool is pinned (`tag` or `version`). */
  pin: string | null;
  /** `upgrade` only: installed / upgraded / skipped / pinned-skip / failed /
   *  orphan / pruned / would-*, verbatim. */
  action: string | null;
  from: string | null;
  to: string | null;
  /** Human prose for a skip, when ubix gave one. */
  reason: string | null;
  /** The full failure chain when `action` is `failed`. */
  error: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const paths = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];

/** The `--json` document shape Pier was written against (ubix bumps this on
 *  any breaking change to the fields read below). */
const UBIX_SCHEMA = 1;

/**
 * Every byte of ubix JSON Pier ever reads, parsed and validated here and
 * nowhere else — one function, so a field ubix renames is a one-function fix
 * rather than a hunt through the callers.
 *
 * Both documents are `{schema_version, tools: [...]}`; the entries differ, so
 * one shape carries both and the fields the other command does not send stay
 * null. A document with no `tools` array, or an entry with no name, is a
 * schema this function no longer understands: it throws rather than reporting
 * "no tools", which would show an installed tool as missing.
 *
 * A newer `schema_version` is logged, not refused: breaking Pier on somebody
 * else's release day is worse than reading a document whose extra fields it
 * ignores — and a field that actually moved fails loudly right here anyway.
 */
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
    log.warn(`ubix --json is schema ${String(top.schema_version)}; Pier reads ${String(UBIX_SCHEMA)}`);
  }
  return top.tools.map((value): UbixToolState => {
    const entry = record(value);
    const name = entry ? text(entry.name) : null;
    if (!entry || !name) {
      throw new Error(`ubix --json entry has no name: ${JSON.stringify(value).slice(0, 120)}`);
    }
    const to = text(entry.to_version);
    return {
      name,
      version: text(entry.installed_version) ?? to,
      path: paths(entry.install_paths)[0] ?? null,
      installed: bool(entry.installed),
      exists: bool(entry.exists),
      missingPaths: paths(entry.missing_paths),
      pin: text(entry.tag) ?? text(entry.version),
      action: text(entry.action),
      from: text(entry.from_version),
      to,
      reason: text(entry.reason),
      error: text(entry.error),
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

/** TOML is only ever written here, and only for the four values below. */
const tomlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The ubix config Pier owns, generated from the enabled set. Never the
 * operator's `~/.config/ubix/config.toml`: Pier rewrites this file on every
 * sync, and doing that to a file a human maintains would delete their tools.
 */
export function ubixConfigToml(enabled: readonly string[], installDir: string): string {
  const lines = [
    "# Generated by Pier from the tools switched on in the Console.",
    "# Rewritten on every sync — your own ~/.config/ubix/config.toml is untouched.",
    "",
    "[settings]",
    `install_dir = ${tomlString(installDir)}`,
  ];
  for (const tool of MANAGED) {
    if (!enabled.includes(tool.name)) continue;
    lines.push("", `[tools.${tool.name}]`, `spec = ${tomlString(tool.spec)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Which release asset is this machine's. Pure, because the mapping is the
 *  part worth a test and the download around it is not. */
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

/** The one place a GitHub release document is read. Same contract as the ubix
 *  parser: a shape that is not understood is an error, not an empty list. */
function parseRelease(doc: unknown): { tag: string; assets: ReleaseAsset[] } {
  const value = record(doc);
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

/**
 * The managed-tools operation surface. One object rather than free functions
 * so the two seams it stands on — subprocesses and the network — are injected
 * once and can be replaced wholesale in a test.
 */
export class ManagedTools {
  readonly #exec: Exec;
  readonly #fetch: typeof fetch;
  readonly #root: string;

  constructor(options: { exec?: Exec; fetch?: typeof fetch; root?: string } = {}) {
    this.#exec = options.exec ?? spawnExec;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#root = options.root ?? toolsDir();
  }

  get bin(): string {
    return join(this.#root, "bin");
  }

  /** The ubix binary Pier manages, whether or not it is there yet. */
  get ubixPath(): string {
    return join(this.bin, "ubix");
  }

  /**
   * Put ubix in `bin/` if it is not there. Latest release → this platform's
   * asset → sha256 against the release's own `checksums.txt` → extract →
   * atomic rename. Any of those failing throws with what failed: a bootstrap
   * that quietly did nothing would show up later as "the tool never installed"
   * with no reason anywhere.
   */
  async bootstrapUbix(): Promise<string> {
    if (existsSync(this.ubixPath)) return this.ubixPath;
    const { tag, assets } = parseRelease(JSON.parse(await this.#getText(UBIX_LATEST)));
    const wanted = ubixAsset(tag, process.platform, process.arch);
    const asset = assets.find((a) => a.name === wanted);
    if (!asset) {
      throw new Error(`ubix ${tag} has no ${wanted} — it ships ${assets.map((a) => a.name).join(", ") || "nothing"}`);
    }
    const sums = assets.find((a) => a.name === "checksums.txt");
    if (!sums) throw new Error(`ubix ${tag} publishes no checksums.txt — refusing to install an unverified binary`);

    mkdirSync(this.bin, { recursive: true });
    // Under the same root as bin/, so the install below is a rename and not a
    // copy across filesystems — a half-written binary on PATH is worse than
    // none at all.
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
      // The system tar, not a dependency: unpacking one .tar.gz does not earn
      // an npm package (AGENTS.md 8).
      const untar = await this.#exec("tar", ["-xzf", tarball, "-C", staging], process.env);
      if (untar.code !== 0) throw new Error(`tar failed on ${wanted}: ${untar.stderr.trim().slice(0, 300)}`);
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

  /**
   * Converge on `enabled`: uninstall what left the set (letting each tool undo
   * its own footprint first), rewrite the config, upgrade everything, then
   * provision. Returns what happened per tool; whole-run failures throw,
   * because there is nothing per-tool to say about them.
   */
  async sync(enabled: readonly string[]): Promise<ToolSyncReport> {
    const wanted = MANAGED.filter((tool) => enabled.includes(tool.name));
    // Nothing on and nothing installed: no config to write, no ubix to fetch.
    // A first boot must not reach the network to find out it has no work.
    if (!wanted.length && !existsSync(this.ubixPath)) {
      return { entries: [], failed: false, summary: "no tools switched on" };
    }
    const ubix = await this.bootstrapUbix();
    const env = this.#env();
    const entries: ToolSyncEntry[] = [];

    // Removals first, and deprovision before the binary goes: rtk uninstalls
    // its own Pi extension, which takes rtk.
    for (const state of await this.#states(ubix, env, ["list", "--json"])) {
      const tool = MANAGED.find((t) => t.name === state.name);
      if (!tool || wanted.includes(tool)) continue;
      entries.push(await this.#uninstall(ubix, env, tool));
    }

    this.#writeConfig(enabled);

    const states = await this.#states(ubix, env, ["upgrade", "--all", "--json"]);
    for (const tool of wanted) {
      const state = states.find((s) => s.name === tool.name);
      const entry: ToolSyncEntry = {
        name: tool.name,
        action: state?.action ?? "missing",
        version: state?.to ?? state?.version ?? null,
        // A tool ubix never mentioned is not a tool that is fine.
        error: state?.error ?? (state ? null : "ubix reported nothing about it"),
      };
      if (!entry.error && tool.provision) entry.error = await this.#provision(env, tool, tool.provision);
      entries.push(entry);
    }
    const failed = entries.some((entry) => entry.error !== null);
    return { entries, failed, summary: summarize(entries) };
  }

  /**
   * The enabled set merged with what ubix says is on disk. Never throws: this
   * answers a Console page, and a page that 500s says less than a row saying
   * why its version is unknown (§5b).
   */
  async status(enabled: readonly string[]): Promise<ManagedToolInfo[]> {
    const base = MANAGED.map((tool): ManagedToolInfo => ({
      name: tool.name,
      spec: tool.spec,
      summary: tool.summary,
      enabled: enabled.includes(tool.name),
      installed: false,
      version: null,
      path: null,
      error: null,
    }));
    // No ubix yet is not a failure — it is the state of an instance that has
    // never switched a tool on.
    if (!existsSync(this.ubixPath)) return base;
    let states: UbixToolState[] | null;
    try {
      // ubix guards its state with an exclusive lock, so this read can queue
      // behind a running install for as long as a download takes — and this
      // call is on a Console page's path (principle 7). Past the cap the row
      // says what it is waiting for instead of the page waiting for it.
      states = await Promise.race([
        this.#states(this.ubixPath, this.#env(), ["list", "--json"]),
        new Promise<null>((resolve) => setTimeout(resolve, STATUS_CAP_MS, null).unref()),
      ]);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return base.map((info) => ({ ...info, error }));
    }
    if (!states) {
      return base.map((info) => ({ ...info, error: "ubix is busy — an install or update is running" }));
    }
    return base.map((info) => {
      const state = states.find((s) => s.name === info.name);
      if (!state) return info;
      // State says installed, disk says otherwise: broken, and drawing that as
      // ready is how an operator finds out from a failed turn instead.
      const gone = state.installed === true && state.exists === false;
      return {
        ...info,
        installed: state.installed === true && !gone,
        version: state.version,
        path: state.path,
        error: gone
          ? `installed but missing on disk: ${state.missingPaths.join(", ") || "tracked paths are gone"}`
          : state.error,
      };
    });
  }

  /** Pier's ubix config and state, never the operator's. `UBIX_CONFIG_DIR` /
   *  `UBIX_DATA_DIR` name the directories that hold config.toml / state.toml
   *  directly — not XDG parents, which every child ubix spawns (uv, fnm,
   *  cargo) would read too. */
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

  #writeConfig(enabled: readonly string[]): void {
    mkdirSync(this.#configDir, { recursive: true });
    mkdirSync(join(this.#root, "state"), { recursive: true });
    writeFileSync(join(this.#configDir, "config.toml"), ubixConfigToml(enabled, this.bin));
  }

  /**
   * One ubix call and the document it owes us.
   *
   * A non-zero exit is *not* a reason to skip the parse: under `--json` a tool
   * that failed lands in the document as `action: "failed"` with its error and
   * the run still exits non-zero, so the report is the truth and the exit code
   * is only the alarm. No document at all is the other case — an ubix release
   * that predates `--json` — and that is said in one sentence rather than by
   * scraping the human output it printed instead.
   */
  async #states(ubix: string, env: NodeJS.ProcessEnv, args: readonly string[]): Promise<UbixToolState[]> {
    const result = await this.#exec(ubix, args, env);
    try {
      return parseUbixJson(result.stdout);
    } catch (err) {
      if (result.code !== 0) {
        throw new Error(
          `ubix ${args.join(" ")} exited ${String(result.code)} with no JSON document — this ubix is too old for` +
            ` Pier's managed tools (they need --json and UBIX_CONFIG_DIR); install a newer ubix release.` +
            ` ubix said: ${result.stderr.trim().slice(0, 300) || String(err)}`,
        );
      }
      throw err;
    }
  }

  async #uninstall(ubix: string, env: NodeJS.ProcessEnv, tool: ManagedTool): Promise<ToolSyncEntry> {
    const error = tool.deprovision ? await this.#provision(env, tool, tool.deprovision) : null;
    const removed = await this.#exec(ubix, ["remove", tool.name, "--force"], env);
    return {
      name: tool.name,
      action: "removed",
      version: null,
      error: removed.code === 0
        ? error
        : `ubix remove exited ${String(removed.code)}: ${removed.stderr.trim().slice(0, 300)}`,
    };
  }

  /** Run a tool's own binary against its own footprint. Returns the failure
   *  text, or null. */
  async #provision(env: NodeJS.ProcessEnv, tool: ManagedTool, args: readonly string[]): Promise<string | null> {
    const exe = join(this.bin, tool.name);
    if (!existsSync(exe)) return `${tool.name} is not in ${this.bin} — ${args.join(" ")} was not run`;
    // Asserted, not assumed: main.ts exports PI_CODING_AGENT_DIR to every
    // child, but `pier tools sync` typed in a shell has no such parent, and
    // rtk would then write its extension into ~/.pi — a directory this Pier
    // never reads.
    const agentDir = resolveAgentDir(env);
    if (env.PI_CODING_AGENT_DIR !== agentDir) {
      log.info(`PI_CODING_AGENT_DIR was ${env.PI_CODING_AGENT_DIR ?? "unset"} — ${tool.name} gets ${agentDir}`);
    }
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    const result = await this.#exec(exe, args, { ...env, PI_CODING_AGENT_DIR: agentDir });
    if (result.code === 0) return null;
    return `${tool.name} ${args.join(" ")} exited ${String(result.code)}: ${result.stderr.trim().slice(0, 300)}`;
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

/** `<sha256>  <bare filename>` lines, as `sha256sum` writes them. */
function expectedSha256(checksums: string, file: string): string {
  for (const line of checksums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name?.replace(/^\*/, "") === file) return hash.toLowerCase();
  }
  throw new Error(`checksums.txt names no ${file} — refusing to install an unverified binary`);
}

/** What a person reads in the task run. One line per tool, failures included:
 *  a sync that says nothing is a sync nobody can tell from a crash. */
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
