import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  coalescedSync,
  type Exec,
  type ExecResult,
  MANAGED,
  ManagedTools,
  normalizeCustomTools,
  parseUbixJson,
  specOf,
  type SyncAttempt,
  SyncLock,
  ubixAsset,
  ubixConfigToml,
} from "./tools.js";

// --- fixtures: the documents ubix actually emits (ubix src/report.rs) --------

const LIST_JSON = JSON.stringify({
  schema_version: 1,
  install_dir: "/abs/bin",
  tools: [
    {
      name: "rtk",
      spec: "github:rtk-ai/rtk",
      source: "github",
      locator: "rtk-ai/rtk",
      installed: true,
      installed_version: "v0.20.0",
      install_paths: ["/abs/bin/rtk"],
      exists: true,
      missing_paths: [],
      tag: null,
      version: null,
      installed_at: "2026-07-02T08:45:00Z",
      updated_at: "2026-07-02T08:45:00Z",
    },
    {
      name: "fd",
      spec: "github:sharkdp/fd",
      source: "github",
      locator: null,
      installed: true,
      installed_version: null,
      install_paths: ["/abs/bin/fd"],
      exists: false,
      missing_paths: ["/abs/bin/fd"],
      tag: "v10.2.0",
      version: null,
      installed_at: null,
      updated_at: null,
    },
    {
      name: "wt",
      spec: "github:timqi/worktrunk",
      source: "github",
      locator: null,
      installed: false,
      installed_version: null,
      install_paths: [],
      exists: false,
      missing_paths: [],
      tag: null,
      version: null,
      installed_at: null,
      updated_at: null,
    },
  ],
});

const upgradeJson = (...tools: unknown[]): string =>
  JSON.stringify({
    schema_version: 1,
    dry_run: false,
    tools,
    summary: { total: tools.length, changed: 1, failed: 0, by_action: { upgraded: 1 } },
  });

const upgraded = {
  name: "rtk",
  action: "upgraded",
  from_version: "v0.20.0",
  to_version: "v0.23.5",
  reason: null,
  error: null,
};

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

/** The operator's real claude block: a templated `url:` source, placeholders,
 *  two ~200-character URLs, and two keys Pier has no business knowing. */
const CLAUDE_BODY = [
  `spec = "url:https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/{os}-{arch}/claude"`,
  `exe = "claude"`,
  `url_musl = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/{os}-{arch}-musl/claude"`,
  `version_source = "github:anthropics/claude-code"`,
].join("\n");

describe("parseUbixJson", () => {
  it("reads a list document", () => {
    const [rtk, fd, wt] = parseUbixJson(LIST_JSON);
    expect(rtk).toEqual({
      name: "rtk",
      version: "v0.20.0",
      path: "/abs/bin/rtk",
      installed: true,
      exists: true,
      missingPaths: [],
      action: null,
      to: null,
      error: null,
    });
    // Recorded as installed, gone from disk: both facts survive, so the
    // Console can tell broken from ready.
    expect(fd).toMatchObject({
      installed: true,
      exists: false,
      missingPaths: ["/abs/bin/fd"],
      version: null,
    });
    expect(wt).toMatchObject({ installed: false, exists: false, path: null });
  });

  it("reads an upgrade document, including a per-tool failure", () => {
    const states = parseUbixJson(upgradeJson(upgraded, {
      name: "fd",
      action: "failed",
      from_version: null,
      to_version: null,
      reason: null,
      error: "download failed: 404",
    }));
    expect(states[0]).toMatchObject({ action: "upgraded", to: "v0.23.5", version: "v0.23.5" });
    expect(states[1]).toMatchObject({ action: "failed", error: "download failed: 404" });
    // The fields the other command sends are absent, not invented.
    expect(states[0]?.installed).toBeNull();
  });

  it("never reads a failure as a tool that is fine, however little ubix said", () => {
    // `action: "failed"` with no error at all: the one thing this parser may
    // not answer is null.
    const [fd] = parseUbixJson(upgradeJson({ name: "fd", action: "failed", error: null }));
    expect(fd?.error).toBe("ubix reported it failed and said no more");
  });

  it("refuses a document it does not understand instead of reporting no tools", () => {
    const doc = (tools: unknown[], schema: unknown = 1) => JSON.stringify({ schema_version: schema, tools });
    expect(() => parseUbixJson("ubix 1.0\nusage: ...")).toThrow(/did not answer with JSON/);
    expect(() => parseUbixJson(JSON.stringify({ schema_version: 1 }))).toThrow(/no tools array/);
    expect(() => parseUbixJson(doc([{ action: "installed" }]))).toThrow(/no name/);
    // A schema Pier was not written against: refused, because the alternative
    // is reading fields that may have moved and drawing installed tools as
    // absent with nothing saying so.
    expect(() => parseUbixJson(doc([], 2))).toThrow(/schema 2, and Pier reads 1/);
    expect(() => parseUbixJson(doc([]))).not.toThrow();
    // A field that is there and is the wrong type is the same failure, not a
    // null to carry on with.
    expect(() => parseUbixJson(doc([{ name: "rg", installed: "yes" }]))).toThrow(/rg\.installed is not a boolean/);
    expect(() => parseUbixJson(doc([{ name: "rg", installed_version: 42 }]))).toThrow(/installed_version is not a string/);
    expect(() => parseUbixJson(doc([{ name: "rg", install_paths: ["/a", 7] }]))).toThrow(/install_paths is not a list/);
  });
});

describe("the ubix config Pier owns", () => {
  it("declares the tools it was handed and where they install, and nothing else", () => {
    const toml = ubixConfigToml([{ name: "rtk", toml: `spec = "github:rtk-ai/rtk"` }], "/home/t/.pier/tools/bin");
    expect(toml).toContain(`install_dir = "/home/t/.pier/tools/bin"`);
    expect(toml).toContain("[tools.rtk]");
    expect(toml).toContain(`spec = "github:rtk-ai/rtk"`);
    expect(ubixConfigToml([], "/bin")).not.toContain("[tools.");
  });

  it("names the executable when the archive does not name it after the project", () => {
    // Verified against the real thing: without this, ripgrep's install fails
    // with "could not find any files matching [ripgrep*]".
    const rg = MANAGED.find((tool) => tool.name === "rg");
    expect(rg?.toml).toContain(`exe = "rg"`);
    expect(ubixConfigToml([rg!], "/bin")).toContain(`exe = "rg"`);
    // jq needs none: it publishes bare per-platform binaries and ubi installs
    // one under the tool's own name (observed: bin/jq, jq-1.8.2).
    expect(MANAGED.find((tool) => tool.name === "jq")?.toml).not.toContain("exe");
  });

  it("writes an operator's own block verbatim under the header Pier owns", () => {
    // The case the free-form body exists for: a templated `url:` tool with
    // placeholders and two long URLs, and keys (url_musl, version_source)
    // Pier has no business knowing about.
    const [claude] = normalizeCustomTools([{ name: "claude", toml: CLAUDE_BODY }]) ?? [];
    expect(claude?.toml).toBe(CLAUDE_BODY);
    const config = ubixConfigToml([claude!], "/home/t/.pier/tools/bin");
    expect(config).toContain(`[tools.claude]\n${CLAUDE_BODY}\n`);
    // Not touched, not re-wrapped, not escaped a second time.
    for (const line of CLAUDE_BODY.split("\n")) expect(config).toContain(line);
    // The line the real install turned out to need — an inline table, which
    // the structural guard allows because it opens no section. No whitelist of
    // Pier's would have had `arch_replace` in it; that is the point.
    const withArch = `${CLAUDE_BODY}\narch_replace = { amd64 = "x64", arm64 = "arm64" }`;
    expect(normalizeCustomTools([{ name: "claude", toml: withArch }])?.[0]?.toml).toBe(withArch);
  });
});

describe("a tool the operator declares", () => {
  it("takes a name and a block, and keeps the block exactly as written", () => {
    expect(normalizeCustomTools([{ name: " eza ", toml: ` spec = "github:eza-community/eza" ` }]))
      .toEqual([{ name: "eza", toml: `spec = "github:eza-community/eza"` }]);
    const multi = `spec = "github:astral-sh/uv"\nexes = ["uv", "uvx"]\ntag = "0.9.7"`;
    expect(normalizeCustomTools([{ name: "uv", toml: multi }])?.[0]?.toml).toBe(multi);
    expect(normalizeCustomTools([])).toEqual([]);
  });

  it("reads a row an older Pier stored as {name, spec} as the block it meant", () => {
    // Orphaning those would silently drop a tool the operator is still using.
    expect(normalizeCustomTools([{ name: "eza", spec: "github:eza-community/eza" }]))
      .toEqual([{ name: "eza", toml: `spec = "github:eza-community/eza"` }]);
  });

  it("refuses rather than half-storing anything that would rewrite the file", () => {
    for (const bad of [
      "not a list",
      [{ name: "eza" }],
      [{ name: "eza", toml: 42 }],
      // No spec: a block ubix cannot install anything from.
      [{ name: "eza", toml: `exe = "eza"` }],
      [{ name: "eza", toml: `spec = ""` }],
      [{ name: "eza", toml: "   " }],
      // A section of its own — install_dir anywhere, or another tool redefined.
      [{ name: "eza", toml: `spec = "github:x/y"\n[settings]\ninstall_dir = "/usr/bin"` }],
      [{ name: "eza", toml: `spec = "github:x/y"\n  [tools.rg]\nspec = "github:evil/rg"` }],
      [{ name: "eza", toml: `[settings]` }],
      // Control characters, and a body that is really a config file.
      [{ name: "eza", toml: `spec = "github:x/y"\u0000` }],
      [{ name: "eza", toml: `spec = "github:x/y"\r\nexe = "eza"` }],
      [{ name: "eza", toml: `spec = "github:x/y"\n${"# padding\n".repeat(300)}` }],
      // Names Pier already owns, and a name a filesystem would not like.
      [{ name: "rtk", toml: `spec = "github:x/y"` }],
      [{ name: "jq", toml: `spec = "github:x/y"` }],
      [{ name: "ubix", toml: `spec = "github:x/y"` }],
      [{ name: "../rm", toml: `spec = "github:x/y"` }],
      [{ name: "", toml: `spec = "github:x/y"` }],
      [{ name: "a".repeat(33), toml: `spec = "github:x/y"` }],
      // Two rows installing into the same filename.
      [{ name: "eza", toml: `spec = "github:x/y"` }, { name: "eza", toml: `spec = "github:a/b"` }],
      Array.from({ length: 17 }, (_, i) => ({ name: `t${String(i)}`, toml: `spec = "github:x/y"` })),
    ]) {
      expect(normalizeCustomTools(bad)).toBeNull();
    }
  });

  it("finds the spec line the Console shows, and only a real one", () => {
    expect(specOf(CLAUDE_BODY)).toContain("url:https://storage.googleapis.com/");
    expect(specOf(`exe = "x"\nspec = 'github:a/b'`)).toBe("github:a/b");
    expect(specOf(`# spec = "github:a/b"`)).toBeNull();
    expect(specOf(`exe = "x"`)).toBeNull();
  });
});

describe("the release asset for this machine", () => {
  it("maps platform and arch onto ubix's asset names", () => {
    expect(ubixAsset("v20260819-8b7fb71", "linux", "x64")).toBe("ubix-linux-amd64-v20260819-8b7fb71.tar.gz");
    expect(ubixAsset("v1", "linux", "arm64")).toBe("ubix-linux-arm64-v1.tar.gz");
    expect(ubixAsset("v1", "darwin", "arm64")).toBe("ubix-darwin-arm64-v1.tar.gz");
  });

  it("says so rather than guessing where there is no build", () => {
    expect(() => ubixAsset("v1", "win32", "x64")).toThrow(/no build for win32\/x64/);
    expect(() => ubixAsset("v1", "linux", "s390x")).toThrow(/no build for linux\/s390x/);
  });
});

// --- the operation surface, with both seams replaced -------------------------

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A rig with a bin/ that already holds ubix (and optionally the tools), so
 *  nothing here ever fetches or spawns anything. */
function rig(
  options: { answer?: (call: Call) => ExecResult | undefined; installed?: string[]; fetch?: typeof fetch } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pier-tools-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  for (const name of ["ubix", ...(options.installed ?? [])]) {
    writeFileSync(join(root, "bin", name), "#!/bin/sh\n");
  }
  const calls: Call[] = [];
  const exec: Exec = (file, args, env) => {
    const call = { file, args: [...args], env };
    calls.push(call);
    return Promise.resolve(options.answer?.(call) ?? ok(upgradeJson()));
  };
  // Its own database, like its own directory: one lock per machine, and a test
  // is a machine of its own.
  const db = openDb(":memory:");
  return {
    root,
    calls,
    db,
    tools: new ManagedTools({
      root,
      exec,
      db: () => db,
      fetch: options.fetch ?? (() => Promise.reject(new Error("the network is not open in tests"))),
    }),
    /** Every command line, in order — the assertions below are about order. */
    lines: () => calls.map((c) => `${c.file.split("/").pop() ?? ""} ${c.args.join(" ")}`),
  };
}

/** The switched-on set a sync reads when its turn comes. */
const on = (...tools: string[]) => () => ({ tools, customTools: [] });

describe("ManagedTools.sync", () => {
  it("does nothing at all when nothing is on and nothing is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-tools-empty-"));
    const tools = new ManagedTools({
      root,
      db: () => openDb(":memory:"),
      exec: () => Promise.reject(new Error("nothing may be spawned")),
      fetch: () => Promise.reject(new Error("nothing may be fetched")),
    });
    expect(await tools.sync(on())).toEqual({ entries: [], failed: false, summary: "no tools switched on" });
  });

  it("writes the config, upgrades, then provisions from the tool's own binary", async () => {
    const r = rig({
      installed: ["rtk"],
      answer: (call) =>
        call.args[0] === "list" ? ok(JSON.stringify({ schema_version: 1, tools: [] })) : ok(upgradeJson(upgraded)),
    });
    const report = await r.tools.sync(on("rtk"));
    expect(report.failed).toBe(false);
    expect(report.entries).toEqual([{ name: "rtk", action: "upgraded", version: "v0.23.5", error: null }]);
    expect(report.summary).toBe("rtk: upgraded v0.23.5");
    expect(r.lines()).toEqual([
      "ubix list --json",
      "ubix upgrade --all --prune --wait --json",
      "rtk init -g --agent pi",
    ]);
    // Pier's own config, never the operator's ~/.config/ubix.
    expect(readFileSync(join(r.root, "config", "config.toml"), "utf8")).toContain("[tools.rtk]");
    const [, upgrade] = r.calls;
    expect(upgrade?.env.UBIX_CONFIG_DIR).toBe(join(r.root, "config"));
    expect(upgrade?.env.UBIX_DATA_DIR).toBe(join(r.root, "state"));
    // The provision runs with an agent dir, always — rtk writes its Pi
    // extension there, and inheriting nothing would send it to ~/.pi.
    expect(r.calls[2]?.env.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(existsSync(join(r.calls[2]?.env.PI_CODING_AGENT_DIR ?? "", "extensions"))).toBe(true);
  });

  it("lets a tool uninstall its own footprint before the binary is removed", async () => {
    const r = rig({
      installed: ["rtk"],
      answer: (call) => (call.args[0] === "list" ? ok(LIST_JSON) : ok(upgradeJson())),
    });
    await r.tools.sync(on());
    // The listing survives for one reason: rtk has to uninstall its own Pi
    // extension *before* its binary goes, and ubix cannot know that. Removing
    // the rest is ubix's own `--prune`, which knows per source how.
    expect(r.lines()).toEqual([
      "ubix list --json",
      "rtk init --uninstall --agent pi --global",
      "ubix upgrade --all --prune --wait --json",
    ]);
    // Nothing is declared any more, so prune takes all three.
    expect(readFileSync(join(r.root, "config", "config.toml"), "utf8")).not.toContain("[tools.");
    // The config that follows no longer declares it.
    expect(readFileSync(join(r.root, "config", "config.toml"), "utf8")).not.toContain("[tools.rtk]");
  });

  it("reports a tool ubix failed on, and still parses the report on a non-zero exit", async () => {
    const r = rig({
      installed: ["rtk"],
      answer: (call) =>
        call.args[0] === "list" ? ok(JSON.stringify({ schema_version: 1, tools: [] })) : {
          code: 1,
          stdout: upgradeJson({
            name: "rtk",
            action: "failed",
            from_version: null,
            to_version: null,
            reason: null,
            error: "no asset for linux-amd64",
          }),
          stderr: "1 tool(s) failed",
        },
    });
    const report = await r.tools.sync(on("rtk"));
    expect(report.failed).toBe(true);
    expect(report.summary).toBe("rtk: FAILED — no asset for linux-amd64");
    // A failed install is not provisioned on top of.
    expect(r.lines()).not.toContain("rtk init -g --agent pi");
  });

  it("reports a provision that failed, with what the tool said", async () => {
    const r = rig({
      installed: ["rtk"],
      answer: (call) => {
        if (call.args[0] === "list") return ok(JSON.stringify({ schema_version: 1, tools: [] }));
        if (call.args[0] === "upgrade") return ok(upgradeJson(upgraded));
        return { code: 3, stdout: "", stderr: "unknown agent: pi" };
      },
    });
    const report = await r.tools.sync(on("rtk"));
    expect(report.failed).toBe(true);
    expect(report.summary).toContain("rtk init -g --agent pi exited 3: unknown agent: pi");
  });

  it("keeps a tool ubix knows about when its own uninstall failed", async () => {
    // Removing it now would orphan rtk's Pi extension with nothing left able
    // to remove it — so it stays declared and the next run tries again.
    const r = rig({
      installed: ["rtk"],
      answer: (call) => {
        if (call.args[0] === "list") return ok(LIST_JSON);
        if (call.args[0] === "upgrade") return ok(upgradeJson());
        return { code: 2, stdout: "", stderr: "rtk: cannot write the agent dir" };
      },
    });
    const report = await r.tools.sync(on());
    expect(report.failed).toBe(true);
    expect(report.summary).toContain("rtk: FAILED");
    // Still declared, so `--prune` leaves the binary alone.
    expect(readFileSync(join(r.root, "config", "config.toml"), "utf8")).toContain("[tools.rtk]");
  });

  it("replaces an ubix too old for --json rather than sending the operator to do it", async () => {
    // Pier put that binary in bin/; a version of it Pier cannot read is Pier's
    // to fix. (The replacement itself needs the network, which tests refuse —
    // what is asserted is that it was attempted, not that it landed.)
    let fetched = 0;
    const r = rig({
      answer: () => ({ code: 1, stdout: "", stderr: "error: unexpected argument '--json' found" }),
      fetch: () => {
        fetched++;
        return Promise.reject(new Error("the network is not open in tests"));
      },
    });
    await expect(r.tools.sync(on("rtk"))).rejects.toThrow(/network/);
    expect(fetched).toBe(1);
  });
});

describe("two syncs at once", () => {
  const EMPTY_LIST = JSON.stringify({ schema_version: 1, tools: [] });
  const config = (root: string): string => readFileSync(join(root, "config", "config.toml"), "utf8");

  it("serializes them across processes, so nobody rewrites the config ubix is reading", async () => {
    // The real race: ubix reads the config file *before* it takes its own
    // state lock, so a hand-typed `pier tools sync` overlapping the managed
    // run could replace the config under it and win with the older set, both
    // exiting 0.
    const root = mkdtempSync(join(tmpdir(), "pier-tools-lock-"));
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "ubix"), "#!/bin/sh\n");
    /** What the config said each time an upgrade was launched. */
    const seen: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const exec: Exec = (_file, args) => {
      if (args[0] === "list") return Promise.resolve(ok(EMPTY_LIST));
      seen.push(config(root));
      // The first run stays in flight until the test lets it go.
      return seen.length === 1 ? held.then(() => ok(upgradeJson())) : Promise.resolve(ok(upgradeJson()));
    };
    // Two instances on one machine: separate connections to one database, which
    // is what two processes have.
    const dbPath = join(root, "pier.db");
    const options = { root, exec, fetch: () => Promise.reject(new Error("the network is not open in tests")) };
    const first = new ManagedTools({ ...options, db: () => openDb(dbPath) }).sync(on("rg"));
    while (!seen.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = new ManagedTools({ ...options, db: () => openDb(dbPath) }).sync(on("fd"));

    // Long enough that an unserialized second sync would have written its
    // config and launched its own ubix by now.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen).toHaveLength(1);
    // What the first run's ubix reads while it runs is still the first run's.
    expect(config(root)).toContain("[tools.rg]");
    expect(config(root)).not.toContain("[tools.fd]");

    release();
    await first;
    await second;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("[tools.fd]");
    expect(seen[1]).not.toContain("[tools.rg]");
    // Nothing left holding it.
    expect(openDb(dbPath).prepare("SELECT count(*) AS n FROM tools_sync_lock").get()).toEqual({ n: 0 });
  });
});

/**
 * The lock itself, against real processes.
 *
 * It is in the database rather than in a lock file because a file protocol has
 * to invent mutual exclusion badly: the version this replaced declared a live
 * 30-minute install dead at 20, trusted a pid a dead holder's number could be
 * reused for, let two waiters each unlink what the other had just created, and
 * let a finished holder delete its successor's lock.
 */
describe("the sync lock", () => {
  const tsx = import.meta.resolve("tsx");
  const toolsUrl = new URL("./tools.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;

  /** A rig with a database on disk and a log every party appends to. */
  function machine() {
    const dir = mkdtempSync(join(tmpdir(), "pier-lock-"));
    const dbPath = join(dir, "pier.db");
    const log = join(dir, "turns.log");
    writeFileSync(log, "");
    const mark = (what: string, who: string): void => {
      writeFileSync(log, `${readFileSync(log, "utf8")}${what} ${who} ${String(Date.now())}\n`);
    };
    return {
      dir,
      dbPath,
      log,
      mark,
      db: () => openDb(dbPath),
      /** in/out pairs, in the order they were written. */
      turns: (): { what: string; who: string }[] =>
        readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
          const [what = "", who = ""] = line.split(" ");
          return { what, who };
        }),
      /** One node process that takes the lock, says so, holds, and lets go.
       *  `holdMs: 0` means "hold it until killed". */
      child: (who: string, holdMs: number) =>
        spawn(process.execPath, [
          "--import",
          tsx,
          "--input-type=module",
          "-e",
          `
          import { appendFileSync } from "node:fs";
          import { SyncLock } from ${JSON.stringify(toolsUrl)};
          import { openDb } from ${JSON.stringify(dbUrl)};
          const mark = (what) => appendFileSync(process.env.LOCK_LOG, what + " " + process.env.WHO + " " + Date.now() + "\\n");
          const hold = Number(process.env.HOLD_MS);
          await new SyncLock(openDb(process.env.LOCK_DB), { heartbeatMs: 50, staleMs: 3_000, pollMs: 20 })
            .run(async () => {
              mark("in");
              await new Promise((resolve) => setTimeout(resolve, hold || 60_000));
              mark("out");
            });
          `,
        ], {
          env: { ...process.env, PIER_LOG: "silent", LOCK_DB: dbPath, LOCK_LOG: log, WHO: who, HOLD_MS: String(holdMs) },
          stdio: ["ignore", "ignore", "pipe"],
        }),
      /** A holder that works in fenced steps, the way a sync does: it asks the
       *  lock whether it is still the holder before each one. */
      stepper: (who: string) =>
        spawn(process.execPath, [
          "--import",
          tsx,
          "--input-type=module",
          "-e",
          `
          import { appendFileSync } from "node:fs";
          import { SyncLock } from ${JSON.stringify(toolsUrl)};
          import { openDb } from ${JSON.stringify(dbUrl)};
          const mark = (what) => appendFileSync(process.env.LOCK_LOG, what + " " + process.env.WHO + " " + Date.now() + "\\n");
          await new SyncLock(openDb(process.env.LOCK_DB), { heartbeatMs: 50, staleMs: 3_000, pollMs: 20 })
            .run(async (fence) => {
              mark("in");
              for (const step of ["one", "two", "three"]) {
                await new Promise((resolve) => setTimeout(resolve, 80));
                fence();
                mark(step);
              }
              mark("out");
            });
          `,
        ], {
          env: { ...process.env, PIER_LOG: "silent", LOCK_DB: dbPath, LOCK_LOG: log, WHO: who },
          stdio: ["ignore", "ignore", "pipe"],
        }),
    };
  }

  /** Wait for a line the child writes, so nothing here sleeps on a guess. */
  const until = async (test: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the lock test to get somewhere");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Nobody was inside while somebody else was. */
  const neverOverlapped = (turns: { what: string; who: string }[]): boolean => {
    let inside: string | null = null;
    for (const turn of turns) {
      if (turn.what === "in") {
        if (inside) return false;
        inside = turn.who;
      } else inside = null;
    }
    return true;
  };

  it("makes two processes take turns", async () => {
    const m = machine();
    const a = m.child("a", 400);
    const b = m.child("b", 400);
    const codes = await Promise.all([a, b].map((child) =>
      new Promise<number | null>((resolve) => child.once("close", resolve))
    ));
    expect(codes).toEqual([0, 0]);
    const turns = m.turns();
    expect(turns).toHaveLength(4);
    expect(neverOverlapped(turns)).toBe(true);
    expect(new Set(turns.map((t) => t.who))).toEqual(new Set(["a", "b"]));
  });

  it("takes over from a holder that died, without ever trusting a pid", async () => {
    // A killed holder writes no release. Identity is a random token, so the
    // number the operating system hands the *next* process cannot make a dead
    // holder look alive: what says it is alive is the heartbeat, nothing else.
    const m = machine();
    const dead = m.child("dead", 0);
    await until(() => m.turns().some((t) => t.what === "in"));
    const before = m.db().prepare("SELECT token FROM tools_sync_lock").get() as { token: string };
    dead.kill("SIGKILL"); // a pid this test started, and only that one
    await new Promise((resolve) => dead.once("close", resolve));

    const mine = new SyncLock(m.db(), { heartbeatMs: 50, staleMs: 400, pollMs: 20 });
    const started = Date.now();
    await mine.run(async () => {
      // Only once the dead holder's heartbeat aged out — never on the strength
      // of "its process is gone", which no other machine can even ask.
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      const now = m.db().prepare("SELECT token FROM tools_sync_lock").get() as { token: string };
      expect(now.token).not.toBe(before.token);
    });
    expect(m.db().prepare("SELECT count(*) AS n FROM tools_sync_lock").get()).toEqual({ n: 0 });
  });

  it("keeps the lock through work that outlives the stale window", async () => {
    // The hole this closes: a legitimate 30-minute install was declared stale
    // at 20 minutes and stolen. Staleness is heartbeat age, not runtime, so a
    // holder that keeps beating keeps its lock however long the work takes.
    const m = machine();
    const timing = { heartbeatMs: 20, staleMs: 300, pollMs: 10 };
    const order: string[] = [];
    const long = new SyncLock(m.db(), timing).run(async () => {
      order.push("long in");
      await new Promise((resolve) => setTimeout(resolve, 900)); // three stale windows
      order.push("long out");
    });
    await until(() => order.length === 1);
    await new SyncLock(m.db(), timing).run(async () => order.push("waiter in"));
    await long;
    expect(order).toEqual(["long in", "long out", "waiter in"]);
  });

  it("lets exactly one of two waiters in at a time, and never deletes the other's row", async () => {
    // Both holes at once: two waiters that each unlink what the other created,
    // and an old holder whose cleanup takes its successor's lock with it.
    const m = machine();
    const timing = { heartbeatMs: 20, staleMs: 1_000, pollMs: 5 };
    const hold = async (who: string): Promise<void> => {
      await new SyncLock(m.db(), timing).run(async () => {
        m.mark("in", who);
        await new Promise((resolve) => setTimeout(resolve, 120));
        m.mark("out", who);
      });
    };
    const first = hold("first");
    await until(() => m.turns().length === 1);
    await Promise.all([first, hold("second"), hold("third")]);
    const turns = m.turns();
    expect(turns).toHaveLength(6);
    expect(neverOverlapped(turns)).toBe(true);
    expect(m.db().prepare("SELECT count(*) AS n FROM tools_sync_lock").get()).toEqual({ n: 0 });
  });

  it("stops a holder that was taken over while it could not notice", async () => {
    // The hole a heartbeat cannot close: SIGSTOP long enough to look dead,
    // taken over, SIGCONT — and the old holder carried on writing next to the
    // new one. A heartbeat cannot prove a holder is dead, so the holder does
    // not get to assume it is still the holder: it asks the row before every
    // step. What it can still have done is bounded by one step — the one whose
    // fence had already passed when the takeover happened.
    const m = machine();
    const child = m.stepper("stopped");
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    await until(() => m.turns().some((t) => t.what === "in"));
    child.kill("SIGSTOP"); // a pid this test started — paused, so it beats no more

    let held = false;
    const taker = new SyncLock(m.db(), { heartbeatMs: 20, staleMs: 200, pollMs: 10 }).run(async () => {
      held = true;
      m.mark("in", "taker");
      await new Promise((resolve) => setTimeout(resolve, 400));
      m.mark("out", "taker");
    });
    await until(() => held);
    child.kill("SIGCONT");
    const code = await new Promise((resolve) => child.once("close", resolve));
    await taker;

    // It failed, and it said why — an outcome, not a line in a log under work
    // that carried on.
    expect(code).not.toBe(0);
    expect(stderr).toContain("lost its lock");
    // And it did nothing after the takeover: no step of its own follows the
    // taker's own "in".
    const turns = m.turns();
    const after = turns.slice(turns.findIndex((t) => t.who === "taker"));
    expect(after.some((t) => t.who === "stopped")).toBe(false);
    expect(turns.filter((t) => t.who === "stopped")).toEqual([{ what: "in", who: "stopped" }]);
  });

  it("releases only its own row, so a finished holder cannot free its successor", () => {
    // The release is scoped to the token that wrote the row: a holder that was
    // taken over deletes nothing on its way out.
    const m = machine();
    const db = m.db();
    const successor = "the-successor";
    db.prepare("INSERT INTO tools_sync_lock (id, token, heartbeat_at) VALUES (1, ?, ?)").run(successor, Date.now());
    // What a finished, superseded holder does on its way out.
    db.prepare("DELETE FROM tools_sync_lock WHERE token = ?").run("the-holder-that-was-taken-over");
    expect(db.prepare("SELECT token FROM tools_sync_lock").get()).toEqual({ token: successor });
  });
});

describe("ManagedTools.status", () => {
  it("has no error and no versions before anything is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-tools-status-"));
    const tools = new ManagedTools({ root, exec: () => Promise.reject(new Error("no ubix yet")) });
    const entries = await tools.status(["rtk"]);
    expect(entries.map((e) => e.name)).toEqual(MANAGED.map((t) => t.name));
    expect(entries[0]).toEqual({
      source: "binary",
      kind: "extension",
      name: "rtk",
      summary: expect.any(String),
      enabled: true,
      binary: { spec: "github:rtk-ai/rtk", installed: false, version: null, path: null, error: null },
    });
  });

  it("shows a tool the state records and the disk lost as broken, not ready", async () => {
    const r = rig({
      answer: () =>
        ok(JSON.stringify({
          schema_version: 1,
          tools: [{
            name: "rtk",
            spec: "github:rtk-ai/rtk",
            source: "github",
            locator: null,
            installed: true,
            installed_version: "v0.23.5",
            install_paths: ["/abs/bin/rtk"],
            exists: false,
            missing_paths: ["/abs/bin/rtk"],
            tag: null,
            version: null,
            installed_at: null,
            updated_at: null,
          }],
        })),
    });
    const [rtk] = await r.tools.status(["rtk"]);
    expect(rtk?.source === "binary" && rtk.binary).toMatchObject({ installed: false, error: "installed but missing on disk: /abs/bin/rtk" });
  });

  it("says when a tool installed somewhere Pier's PATH does not point", async () => {
    // What `npm:` really does: the binary lands in fnm's node prefix under the
    // package's own name. The install worked; Pier's "first on the PATH"
    // promise did not, and the row is where that has to be said.
    const r = rig({
      answer: () =>
        ok(JSON.stringify({
          schema_version: 1,
          tools: [{
            name: "cc",
            spec: "npm:@anthropic-ai/claude-code",
            source: "npm",
            locator: null,
            installed: true,
            installed_version: "latest",
            install_paths: ["/home/t/.local/share/fnm/aliases/default/bin/claude"],
            exists: true,
            missing_paths: [],
            tag: null,
            version: null,
            installed_at: null,
            updated_at: null,
          }],
        })),
    });
    const custom = [{ name: "cc", toml: `spec = "npm:@anthropic-ai/claude-code"` }];
    const cc = (await r.tools.status(["cc"], custom)).find((e) => e.name === "cc");
    const binary = cc?.source === "binary" ? cc.binary : null;
    expect(binary).toMatchObject({ installed: true, path: "/home/t/.local/share/fnm/aliases/default/bin/claude" });
    expect(binary?.error).toContain("installed outside Pier's bin");
  });

  it("answers with the reason rather than throwing when ubix cannot be read", async () => {
    const r = rig({ answer: () => ({ code: 1, stdout: "", stderr: "state.toml is locked" }) });
    const [rtk] = await r.tools.status([]);
    expect(rtk?.source === "binary" && rtk.binary.error).toMatch(/state\.toml is locked/);
    expect(rtk?.enabled).toBe(false);
  });
});

describe("three switches flipped while a sync is running", () => {
  /** A stand-in for tasks/: one run at a time, an overlapping request is
   *  refused exactly as `tasks/runs.ts` refuses it, and a run reads the
   *  enabled set at the moment it starts. */
  function fakeTasks() {
    const started: string[][] = [];
    const skipped: string[] = [];
    let enabled = ["rtk"];
    let settle: (() => void) | null = null;
    const run = (): SyncAttempt => {
      if (settle) {
        // The overlap guard: the run is recorded as skipped and the caller
        // is handed the run that is actually in flight.
        skipped.push("overlap");
        return { ran: "overlapped", settled: inFlight };
      }
      started.push([...enabled]);
      inFlight = new Promise<void>((resolve) => (settle = resolve));
      return { ran: "started", settled: inFlight };
    };
    let inFlight = Promise.resolve();
    return {
      run,
      started,
      skipped,
      flip: (name: string) => enabled.push(name),
      finish: () => {
        const resolve = settle;
        settle = null;
        resolve?.();
        // Let the coalescer's follow-up start before the test looks.
        return Promise.resolve().then(() => Promise.resolve()).then(() => undefined);
      },
    };
  }

  it("coalesces them into exactly one follow-up run, with the final set", async () => {
    const rig = fakeTasks();
    const failures: unknown[] = [];
    const sync = coalescedSync(rig.run, (err) => failures.push(err));

    // rtk goes on and its sync starts running.
    expect(sync()).toBe("started");
    expect(rig.started).toEqual([["rtk"]]);

    // Three more switches, each its own request, all while that run is busy.
    for (const name of ["rg", "fd", "wt"]) {
      rig.flip(name);
      expect(sync()).toBe("waiting");
    }
    // Nothing has been started behind its back, and nothing is queued per click.
    expect(rig.started).toHaveLength(1);

    await rig.finish();
    // Exactly one follow-up — not three — and it read the set as it is now.
    expect(rig.started).toEqual([["rtk"], ["rtk", "rg", "fd", "wt"]]);
    await rig.finish();
    expect(rig.started).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it("keeps trying when the task layer refuses its run as an overlap", async () => {
    // The other half of the race: the run in flight is somebody else's (the
    // cron, or the boot), so ours is refused outright. Dropping it is what
    // left the config missing two tools.
    let release = (): void => {};
    const busy = new Promise<void>((resolve) => (release = resolve));
    const started: number[] = [];
    let refuse = true;
    const sync = coalescedSync((): SyncAttempt => {
      if (refuse) return { ran: "overlapped", settled: busy };
      started.push(Date.now());
      return { ran: "started", settled: Promise.resolve() };
    }, (err) => expect.unreachable(String(err)));

    expect(sync()).toBe("started");
    expect(started).toEqual([]);
    refuse = false;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The refused request was not dropped: it ran once the other run settled.
    expect(started).toHaveLength(1);
  });

  it("reports a failure instead of swallowing it, and takes requests again", async () => {
    const failures: unknown[] = [];
    let fail = true;
    const sync = coalescedSync((): SyncAttempt => {
      if (fail) throw new Error("no tools update task to run");
      return { ran: "started", settled: Promise.resolve() };
    }, (err) => failures.push(err));
    sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(failures[0])).toContain("no tools update task");
    fail = false;
    expect(sync()).toBe("started");
  });
});
