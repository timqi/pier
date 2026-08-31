// The binaries Pier manages for itself: which ones exist, how they stay
// current, and the one directory they sit on ahead of the machine's own.
//
// Pier writes no downloader. `ubix` (github:timqi/ubix) is a declarative
// installer that already knows how to find the right release asset for a
// platform, so the only thing fetched here is ubix itself; everything after is
// a generated config file plus `ubix upgrade --all`. The tool-specific part is
// data (MANAGED below) — the next tool is a table row, not a code path.
//
// Instance-layer, and nothing above it: node stdlib, paths.ts, log.ts, db.ts
// (the sync lock is a row, not a file) and `core/types.ts` type-only, for the
// one shape the Console draws a switch from. It knows nothing about tasks,
// sessions or the web — tools-task.ts owns the task that calls it, because a
// module that scheduled itself would be two modules.

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

/** Where the ubix build Pier bootstraps comes from. The API, not a fixed
 *  download URL: the asset name carries the release tag, so the tag has to be
 *  asked for before anything can be fetched. */
const UBIX_LATEST = "https://api.github.com/repos/timqi/ubix/releases/latest";

/** One binary Pier will install and keep current on request. */
export interface ManagedTool {
  /** What it is to the person switching it on: an extension the agent gains,
   *  or a command the agent can run. `rtk` is an extension that happens to
   *  ship as a binary — it is listed with the extensions and installed like a
   *  tool, which is the whole reason the catalog has one shape. */
  kind: "extension" | "tool";
  name: string;
  /** One line, shown beside the switch that turns it on. */
  summary: string;
  /** The body of this tool's `[tools.<name>]` block — `spec = "…"` and
   *  whatever else ubix's ToolConfig takes. Pier owns the header and writes
   *  the body underneath it verbatim: which keys exist is ubix's vocabulary to
   *  know, not Pier's, and a wrong type is rejected by ubix with an error that
   *  already reaches the run output. Pier guards the *structure* only
   *  (`normalizeCustomTools`). */
  toml: string;
  /** Run after every install and every upgrade, from the tool's own binary:
   *  a tool that has to register something with Pi does it here, and doing it
   *  on every sync is also how that registration stays current. */
  provision?: readonly string[];
  /** Run *before* the binary is removed — undoing what `provision` did takes
   *  the tool that did it. */
  deprovision?: readonly string[];
  /** True only for a row built from an operator's own block. */
  custom?: boolean;
}

/** The catalog. Data, not code: a new tool is a row, not a branch anywhere in
 *  this file — only `rtk` has provisioning, and only because it registers
 *  something with Pi. */
export const MANAGED: readonly ManagedTool[] = [
  {
    kind: "extension",
    name: "rtk",
    toml: `spec = "github:rtk-ai/rtk"`,
    summary:
      "Compresses long bash output before it reaches the model. Ships as a " +
      "command, and installs its own Pi extension into Pier's agent dir — " +
      "refreshed on every update.",
    // Write-if-changed inside rtk, so re-running it after an upgrade is the
    // extension-update path and costs nothing when nothing moved.
    provision: ["init", "-g", "--agent", "pi"],
    deprovision: ["init", "--uninstall", "--agent", "pi", "--global"],
  },
  {
    kind: "tool",
    name: "rg",
    // `exe`, because ubi looks for files named after the *project* and
    // ripgrep ships `rg`: without it the install fails with "could not find
    // any files matching [ripgrep*]". Found by installing it for real.
    toml: `spec = "github:BurntSushi/ripgrep"\nexe = "rg"`,
    summary: "ripgrep: searches a tree by content, fast enough to be the default.",
  },
  {
    kind: "tool",
    name: "fd",
    toml: `spec = "github:sharkdp/fd"`,
    summary: "Finds files by name, respecting .gitignore — what `find` should feel like.",
  },
  {
    kind: "tool",
    name: "wt",
    toml: `spec = "github:max-sixty/worktrunk"\nexe = "wt"`,
    summary: "worktrunk: git worktrees as one command — branch, switch, merge, clean up.",
  },
  {
    kind: "tool",
    name: "jq",
    // No `exe` and no `rename`: jq publishes bare per-platform binaries
    // (`jq-linux-amd64`, not an archive), and ubi installs one of those under
    // the tool's own name — observed landing as `bin/jq`, with `jq --version`
    // answering jq-1.8.2. Archive-versus-binary is exactly what bit rg and wt,
    // so what was seen is written down rather than assumed.
    toml: `spec = "github:jqlang/jq"`,
    summary: "Slices, filters and reshapes JSON on the command line.",
  },
];

/** A tool the operator added by writing a block of their own. */
export interface CustomTool {
  name: string;
  toml: string;
}

/** A binary's name on disk, so what goes on the PATH is predictable. No dot:
 *  `[tools.a.b]` is a different table than the one Pier means to write. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
/** Every one is a binary on every PATH; a list this long is already a smell. */
const MAX_CUSTOM = 16;
/** A tool's block is a handful of keys. Past this it is a config file, and a
 *  textarea in a settings pane is the wrong place to keep one. Generous on
 *  purpose: a templated `url:` tool carries two ~200-character URLs. */
const MAX_BODY = 2000;

/** The `spec = "…"` a block must carry, for the boundary check and for the
 *  one line the Console shows about a tool it has not installed yet. */
export function specOf(toml: string): string | null {
  // Multiline strings are skipped, not scanned: a `spec = "…"` inside one is
  // text, not a key, and reading it as the spec would let a block with no real
  // spec past the boundary check below.
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

/** What a custom entry must be, said once so both the route and the stored
 *  row are checked by the same rule. */
export const CUSTOM_TOOL_RULES =
  `each custom tool needs a name (letters, digits, _ and -, ≤32 characters, not a built-in or "ubix")` +
  ` and a block body with a spec line — spec = "github:owner/repo", plus any ubix keys it needs.` +
  ` Pier writes the [tools.<name>] header itself: a line opening a section of its own is refused, so are` +
  ` control characters and a body over ${String(MAX_BODY)} characters; at most ${String(MAX_CUSTOM)} tools`;

/**
 * Boundary check, rejecting rather than repairing.
 *
 * The body is the operator's — which keys ubix's ToolConfig takes is ubix's
 * vocabulary, and a wrong type is ubix's error to report, in the run output
 * where it already lands. What Pier guards is the *structure* of the file it
 * generates: nothing may open a section, because a body that could write
 * `[settings]` could point `install_dir` anywhere, and one that could write
 * `[tools.rg]` could redefine a tool the operator never touched. A name Pier
 * already manages is refused for the same reason — two rows installing into
 * one filename is a switch whose meaning depends on which ran last.
 *
 * `{name, spec}` from an older Pier is read as the body it stood for: those
 * rows were written by this code, and orphaning them would silently drop a
 * tool the operator is still using.
 */
export function normalizeCustomTools(
  raw: unknown,
  /** Names this instance already answers to that this file cannot see — the
   *  bundled extensions live behind the Pi SDK, so main.ts hands them in. */
  reserved: readonly string[] = [],
): CustomTool[] | null {
  // Case-insensitively: two names differing only in case are one filename on a
  // case-insensitive filesystem, and one switch whose meaning depends on which
  // ran last.
  const taken = new Set(
    [...MANAGED.map((tool) => tool.name), ...reserved, "ubix"].map((name) => name.toLowerCase()),
  );
  if (!Array.isArray(raw) || raw.length > MAX_CUSTOM) return null;
  const tools: CustomTool[] = [];
  for (const item of raw) {
    const given = record(item);
    if (!given) return null;
    const { name, toml, spec } = given;
    if (typeof name !== "string") return null;
    const cleanName = name.trim();
    if (!TOOL_NAME.test(cleanName)) return null;
    if (taken.has(cleanName.toLowerCase())) return null;
    if (tools.some((tool) => tool.name.toLowerCase() === cleanName.toLowerCase())) return null;
    // The migration: a stored `{name, spec}` is the block it always meant.
    const body = typeof toml === "string"
      ? toml.trim()
      : typeof spec === "string" && spec.trim()
      ? `spec = ${tomlString(spec.trim())}`
      : null;
    if (body === null || !body || body.length > MAX_BODY) return null;
    // A section header would take the rest of the file with it.
    if (body.split("\n").some((line) => line.trimStart().startsWith("["))) return null;
    // Tabs and newlines are the only control characters a TOML body needs.
    // Character by character rather than by regex class, so the rule reads as
    // what it is and no linter has to guess whether the escapes were meant.
    if ([...body].some((ch) => (ch < " " && ch !== "\n" && ch !== "\t") || ch === "\u007f")) return null;
    if (!specOf(body)) return null;
    tools.push({ name: cleanName, toml: body });
  }
  return tools;
}

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

/** What one sync converges on, read inside the lock (`sync`). A getter rather
 *  than a value, and structural rather than the settings type, because
 *  settings.ts imports this file and not the other way round. */
export interface EnabledTools {
  tools: readonly string[];
  customTools: readonly CustomTool[];
}

/** `stale` is heartbeat age, never how long the work has taken; `wait` is what
 *  a waiter gives a live holder before giving up with a reason. */
const LOCK_TIMING = { heartbeatMs: 5_000, staleMs: 30_000, waitMs: 20 * 60_000, pollMs: 200 };

/**
 * One tools sync at a time on this machine, whichever process asked.
 *
 * The contract:
 * - *Ownership* is one row and a random token. Every write to that row —
 *   release, takeover, refresh — matches on the token, so no party can undo
 *   another's.
 * - *Staleness* is heartbeat age. A holder that stops beating can be taken
 *   over; how long its work has been running never enters into it.
 * - *A heartbeat cannot prove a holder is dead*, so a holder does not assume
 *   it is still the holder: it passes a fence before every step that changes
 *   anything, and a sync that was taken over fails saying so rather than
 *   writing beside its successor.
 * - No transaction is held for the length of a sync: acquire, refresh, fence
 *   and release are each their own.
 *
 * What the fence does *not* guarantee, deliberately. It bounds the overlap to
 * one already-started step — a holder stopped between its fence and that
 * step's own writes, or an `execFile` child that outlives its stopped parent,
 * still finishes that step. Closing it would take a kernel lock every child
 * inherits, which is a native dependency (AGENTS.md 8) or `flock(1)`, which
 * macOS does not ship. It is not paid for, because the floor underneath is
 * already a kernel lock: ubix takes an exclusive advisory flock on its own
 * state file and Pier passes `--wait`, so two overlapping syncs cannot corrupt
 * what ubix records — the worst case is a redundant install, or a config.toml
 * written from a stale settings snapshot, which the next sync converges.
 */
export class SyncLock {
  readonly #db: DatabaseSync;
  readonly #timing: typeof LOCK_TIMING;

  constructor(db: DatabaseSync, timing: Partial<typeof LOCK_TIMING> = {}) {
    this.#db = db;
    this.#timing = { ...LOCK_TIMING, ...timing };
  }

  /** Run `work` with the lock held, waiting for whoever has it. `work` is
   *  handed the fence and must call it before every step that changes
   *  anything outside this process. */
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
    // Unref'd: a beating heart is not a reason for the process to stay up.
    const beat = setInterval(() => this.#refresh(token), this.#timing.heartbeatMs);
    beat.unref();
    try {
      return await work(() => this.#fence(token));
    } finally {
      clearInterval(beat);
      this.#db.prepare("DELETE FROM tools_sync_lock WHERE token = ?").run(token);
    }
  }

  /** Take the lock, or take it over from a holder that stopped beating — both
   *  in one immediate transaction, so two waiters cannot both win. */
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

  /** Still ours? The authority is the row, asked now — not the heartbeat's own
   *  bookkeeping, which a stopped process does not get to run either. */
  #fence(token: string): void {
    const row = this.#db.prepare("SELECT token FROM tools_sync_lock").get() as { token: string } | undefined;
    if (row?.token !== token) {
      throw new Error(
        "this sync lost its lock — another tools sync took it over while this one was stopped, so it went no further",
      );
    }
  }

  /** Say we are alive. A refresh that changes nothing is the first sign of a
   *  takeover; the fence is what acts on it, at the next step. */
  #refresh(token: string): void {
    const beat = this.#db.prepare("UPDATE tools_sync_lock SET heartbeat_at = ? WHERE token = ?").run(Date.now(), token);
    if (!beat.changes) log.warn("this tools sync no longer holds the lock — it stops at its next step");
  }
}

/** What one sync request became, for the surface that asked for it.
 *  `waiting`: a sync was already running, and this request rides the run that
 *  follows it — not a failure, and not "nothing happened" either. */
export type SyncRequest = "started" | "waiting";

/**
 * One attempt to run the task, as whatever owns the task reports it. There is
 * always something to wait for: "refused, and nothing is in flight" is not a
 * state a caller can act on — it would loop with nothing to loop on — so the
 * type cannot spell it, and the one place that could produce it (a run that
 * finished between the refusal and the lookup) resolves it before answering.
 */
export type SyncAttempt =
  | { ran: "started"; settled: Promise<void> }
  | { ran: "overlapped"; settled: Promise<void> };

/**
 * Converge, don't race.
 *
 * Every switch is its own request and every request wants the *current* set
 * installed, but the task layer refuses an overlapping run (`skipped`). Three
 * switches flipped in one second therefore produced one run that had read the
 * set as it stood halfway through and two runs that did nothing at all — the
 * Console showed four tools on and the machine had two, with nothing anywhere
 * saying so.
 *
 * So a request that lands on a running sync is *remembered*, not queued: one
 * bit, so a click storm cannot grow a backlog, and the moment the run settles
 * exactly one more run goes — reading the set as it is by then. That run can
 * be overlapped in turn and the bit set again; it terminates because every
 * follow-up starts strictly after the request that asked for it.
 */
export function coalescedSync(
  /** Start one run now, and say what to wait for. Structural, so this file
   *  still knows nothing about tasks/. */
  run: () => SyncAttempt,
  onFailure: (err: unknown) => void,
): () => SyncRequest {
  let chain: Promise<void> | null = null;
  let pending = false;

  const drive = async (): Promise<void> => {
    do {
      // Cleared before the run, not after: a request arriving while this one is
      // in flight must set it again and earn its own follow-up.
      pending = false;
      const { ran, settled } = run();
      await settled;
      // Refused as an overlap: nothing of ours has run yet, so go again once
      // whatever was in flight is done.
      if (ran === "overlapped") pending = true;
    } while (pending);
  };

  return () => {
    if (chain) {
      pending = true;
      return "waiting";
    }
    let finish!: () => void;
    // Assigned before `drive` is called: a drive that never awaits would
    // otherwise finish before this variable existed, and every later request
    // would wait forever on a chain nobody is driving.
    chain = new Promise<void>((resolve) => (finish = resolve));
    void drive().catch(onFailure).finally(() => {
      chain = null;
      pending = false;
      finish();
    });
    return "started";
  };
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

/** The `--json` document shape Pier was written against. ubix bumps this on
 *  any breaking change to the fields read below. */
const UBIX_SCHEMA = 1;

/**
 * Every byte of ubix JSON Pier ever reads, parsed and validated here and
 * nowhere else — one function, so a field ubix renames is a one-function fix
 * rather than a hunt through the callers.
 *
 * Both documents are `{schema_version, tools: [...]}`; the entries differ, so
 * one shape carries both and the fields the other command does not send stay
 * null.
 *
 * Everything that is not exactly what it should be throws, including a schema
 * version this does not know. The alternative was tried and is worse: a field
 * that fails to parse would become `null`, an installed tool would be drawn as
 * absent, and the switches and the machine would disagree with nothing saying
 * so (§5b). A caller that cannot read ubix reports that it cannot; it never
 * reports "no tools".
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
    throw new Error(
      `ubix --json is schema ${JSON.stringify(top.schema_version)}, and Pier reads ${String(UBIX_SCHEMA)}` +
        ` — refusing to guess what its fields mean now`,
    );
  }
  return top.tools.map((value): UbixToolState => {
    const entry = record(value);
    if (!entry) throw new Error(`ubix --json entry is not an object: ${JSON.stringify(value).slice(0, 120)}`);
    const where = typeof entry.name === "string" ? entry.name : JSON.stringify(value).slice(0, 80);
    /** A string, an explicit null, or absent. Anything else is a field that
     *  moved, and guessing `null` for it is how "installed" becomes "gone". */
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
      // A failure with no words is still a failure: without this it reads as a
      // tool that is fine, which is the one thing this parser may never say.
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

/** Pier only ever writes two TOML strings itself — the install dir and the
 *  spec a legacy `{name, spec}` row is migrated into. A tool's own body is the
 *  operator's text and is written verbatim. */
const tomlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The ubix config Pier owns, generated from the enabled set. Never the
 * operator's `~/.config/ubix/config.toml`: Pier rewrites this file on every
 * sync, and doing that to a file a human maintains would delete their tools.
 */
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
  // Pier owns the headers; the body under each one is written exactly as it
  // was given. A `{version}` placeholder or a 200-character URL is the
  // operator's business and must survive the round trip untouched.
  for (const tool of tools) lines.push("", `[tools.${tool.name}]`, tool.toml.trim());
  return `${lines.join("\n")}\n`;
}

/** ubix's own words for "I do not have that flag" — clap's message for an
 *  unknown argument, and ubix's own refusal on a command that takes no JSON.
 *  Nothing else counts as too old. */
const refusesJson = (stderr: string): boolean =>
  /unexpected argument\s+'?--json|unrecognized (?:option|argument)\s+'?--json|`--json` is not supported/i
    .test(stderr);

/** The ubix in `bin/` is older than the `--json` Pier reads. Pier put it
 *  there, so this is Pier's to fix (`sync` re-bootstraps), not an errand for
 *  the operator. */
class UbixTooOld extends Error {}

/** The rows an enabled set names: Pier's catalog plus the operator's blocks.
 *  A name in neither is not an error — the setting is shape-only, so a row a
 *  future release drops must not stop the sync of everything else. */
function rows(custom: readonly CustomTool[]): ManagedTool[] {
  return [...MANAGED, ...custom.map((tool): ManagedTool => ({ kind: "tool", summary: "", custom: true, ...tool }))];
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

/**
 * The managed-tools operation surface. One object rather than free functions
 * so the two seams it stands on — subprocesses and the network — are injected
 * once and can be replaced wholesale in a test.
 */
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
    // Opened on the first sync, never in the constructor: `status()` and the
    // Console's catalog need no database, and neither does a process that only
    // reads what is installed.
    this.#db = options.db ?? pierDb;
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

  /**
   * Converge on what is switched on: uninstall what left the set (letting each
   * tool undo its own footprint first), rewrite the config, upgrade everything,
   * then provision. Returns what happened per tool; whole-run failures throw,
   * because there is nothing per-tool to say about them.
   *
   * The set is *read here*, inside the lock, rather than handed in: ubix reads
   * the config file before it takes its own state lock, so a hand-typed `pier
   * tools sync` overlapping the managed run could write its config after the
   * other had written one and before ubix read either — the older snapshot
   * winning, both exiting 0, and nothing anywhere saying the machine is not
   * what the switches say.
   *
   * `fence` is called before every step that changes anything a second sync
   * could also be changing — the config file, ubix's own state, a tool's
   * footprint. Holding the lock is not proof of holding it *still*: a process
   * paused long enough to look dead is taken over and then resumes, and the
   * fence is what stops it — by failing the sync with that sentence rather
   * than letting it write on top of the sync that replaced it. What that
   * leaves open, and why it is left open, is on `SyncLock`.
   */
  async sync(read: () => EnabledTools): Promise<ToolSyncReport> {
    this.#lock ??= new SyncLock(this.#db());
    return this.#lock.run(async (fence) => {
      const { tools, customTools } = read();
      return this.#converge(tools, customTools, fence);
    });
  }

  async #converge(
    enabled: readonly string[],
    custom: readonly CustomTool[],
    fence: () => void,
  ): Promise<ToolSyncReport> {
    const all = rows(custom);
    const wanted = all.filter((tool) => enabled.includes(tool.name));
    // Nothing on and nothing installed: no config to write, no ubix to fetch.
    // A first boot must not reach the network to find out it has no work.
    if (!wanted.length && !existsSync(this.ubixPath)) {
      return { entries: [], failed: false, summary: "no tools switched on" };
    }
    fence();
    const ubix = await this.bootstrapUbix();
    const env = this.#env();
    const entries: ToolSyncEntry[] = [];

    // ubix prunes what its config no longer declares (`--prune` below), but it
    // cannot know that rtk has to uninstall its own Pi extension *before* its
    // binary goes — so the listing survives for exactly that: find the tools
    // leaving the set that have something of their own to undo, and let them.
    const kept: ManagedTool[] = [];
    for (const state of await this.#listing(ubix, env)) {
      const leaving = all.find((tool) => tool.name === state.name);
      if (!leaving?.deprovision || wanted.some((tool) => tool.name === state.name)) continue;
      fence(); // a tool's own uninstall is a change to the machine
      const error = await this.#provision(env, leaving, leaving.deprovision);
      if (error) {
        // Removing it now would orphan what the deprovision failed to remove,
        // with nothing left able to remove it. It stays declared, stays
        // installed, and the next run tries again.
        kept.push(leaving);
        entries.push({ name: leaving.name, action: "kept", version: null, error });
      }
    }

    fence();
    this.#writeConfig([...wanted, ...kept]);

    // `--prune` is the removal: anything in ubix's state that this config no
    // longer declares is uninstalled by ubix, which knows per source how.
    // `--wait` on the state lock: a hand-typed `pier tools sync` overlapping
    // the managed run should converge behind it, not fail on the lock. Bounded
    // by the subprocess timeout, like everything else here.
    fence();
    const states = await this.#states(ubix, env, ["upgrade", "--all", "--prune", "--wait", "--json"]);
    for (const state of states) {
      // One line per tool: a kept one has already said why it stayed.
      if (wanted.some((tool) => tool.name === state.name)) continue;
      if (entries.some((entry) => entry.name === state.name)) continue;
      // A tool that left the set: ubix says what it did with it, and a failure
      // to remove is as much a failure as one to install.
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

  /**
   * The enabled set merged with what ubix says is on disk. Never throws: this
   * answers a Console page, and a page that 500s says less than a row saying
   * why its version is unknown (§5b).
   */
  async status(enabled: readonly string[], custom: readonly CustomTool[] = []): Promise<CatalogEntry[]> {
    const base = rows(custom).map((tool): CatalogEntry => ({
      source: "binary",
      kind: tool.kind,
      name: tool.name,
      summary: tool.summary,
      enabled: enabled.includes(tool.name),
      binary: { spec: specOf(tool.toml) ?? "", installed: false, version: null, path: null, error: null },
      ...(tool.custom ? { custom: true } : {}),
    }));
    // No ubix yet is not a failure — it is the state of an instance that has
    // never switched a tool on.
    if (!existsSync(this.ubixPath)) return base;
    let states: UbixToolState[];
    try {
      states = await this.#states(this.ubixPath, this.#env(), ["list", "--json"]);
    } catch (err) {
      // The page says why it cannot answer rather than answering wrongly: a
      // row drawn as "not installed" because a read failed is the lie §5b is
      // about.
      const error = err instanceof Error ? err.message : String(err);
      return base.map((entry) => withBinary(entry, { error }));
    }
    return base.map((entry) => {
      const state = states.find((s) => s.name === entry.name);
      if (!state) return entry;
      // State says installed, disk says otherwise: broken, and drawing that as
      // ready is how an operator finds out from a failed turn instead.
      const gone = state.installed === true && state.exists === false;
      // Installed, and not where Pier's PATH points: `npm:` lands in fnm's
      // node prefix and `pixi:` in its own, under the package's binary name.
      // The install worked and the promise did not, which is a sentence the
      // row has to say rather than a path an operator has to notice.
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

  #writeConfig(tools: readonly CustomTool[]): void {
    mkdirSync(this.#configDir, { recursive: true });
    mkdirSync(join(this.#root, "state"), { recursive: true });
    // Temp plus rename: ubix reads this file, and half a config is a config
    // that declares half the tools.
    const path = join(this.#configDir, "config.toml");
    writeFileSync(`${path}.writing`, ubixConfigToml(tools, this.bin));
    renameSync(`${path}.writing`, path);
  }

  /**
   * One ubix call and the document it owes us.
   *
   * A non-zero exit is *not* a reason to skip the parse: under `--json` a tool
   * that failed lands in the document as `action: "failed"` with its error and
   * the run still exits non-zero, so the report says which tool it was. But the
   * two have to agree: an exit code with no failed entry anywhere is a failure
   * this file cannot attribute, and passing it on as a clean report is the one
   * thing it may never do. No document at all is the third case — an ubix
   * release that predates `--json` — and that is said in one sentence rather
   * than by scraping the human output it printed instead.
   */
  async #states(ubix: string, env: NodeJS.ProcessEnv, args: readonly string[]): Promise<UbixToolState[]> {
    const result = await this.#exec(ubix, args, env);
    let states: UbixToolState[];
    try {
      states = parseUbixJson(result.stdout);
    } catch (err) {
      const failure = failedRun(`ubix ${args.join(" ")}`, result);
      // Only the flag being unknown means "too old". Everything else — a
      // malformed body in someone's block, a locked state file, a full disk —
      // is that failure, reported as itself: re-bootstrapping ubix over a
      // config error would fix nothing and say something false.
      if (result.code !== 0 && refusesJson(result.stderr)) throw new UbixTooOld(failure);
      throw new Error(result.code === 0 ? String(err) : `${failure} (${String(err)})`);
    }
    // Something failed and the report names nothing that did: the two disagree,
    // and believing the document is how a failed run is read as a machine that
    // is fine.
    if (result.code !== 0 && !states.some((state) => state.action === "failed")) {
      throw new Error(`${failedRun(`ubix ${args.join(" ")}`, result)} — and its report names no failure`);
    }
    return states;
  }

  /** The declared tools, and the one place a too-old ubix is repaired rather
   *  than reported: Pier put that binary in `bin/`, so replacing it is Pier's
   *  job, not an errand for whoever flipped a switch. */
  async #listing(ubix: string, env: NodeJS.ProcessEnv): Promise<UbixToolState[]> {
    try {
      return await this.#states(ubix, env, ["list", "--json"]);
    } catch (err) {
      if (!(err instanceof UbixTooOld)) throw err;
      log.warn(`the ubix in ${this.bin} is too old for --json — replacing it`);
      return this.#states(await this.bootstrapUbix(true), env, ["list", "--json"]);
    }
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

/** One catalog entry with its binary block updated. Everything this file makes
 *  is a `source: "binary"` entry; the bundled half of the catalog comes from
 *  extensions/ and never passes through here. */
const withBinary = (entry: CatalogEntry, patch: Partial<CatalogBinary>): CatalogEntry =>
  entry.source === "binary" ? { ...entry, binary: { ...entry.binary, ...patch } } : entry;

/** What a failed child said, in one line — the same shape wherever one fails,
 *  and never empty: an exit code with no words is not a report. */
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
