import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  coalescedSync,
  type Exec,
  type ExecResult,
  MANAGED,
  ManagedTools,
  normalizeCustomTools,
  parseUbixJson,
  toolsTaskDraft,
  toolsTaskPlan,
  type SyncRunner,
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

describe("parseUbixJson", () => {
  it("reads a list document, pins and all", () => {
    const [rtk, fd, wt] = parseUbixJson(LIST_JSON);
    expect(rtk).toEqual({
      name: "rtk",
      version: "v0.20.0",
      path: "/abs/bin/rtk",
      installed: true,
      exists: true,
      missingPaths: [],
      pin: null,
      action: null,
      from: null,
      to: null,
      reason: null,
      error: null,
    });
    // Recorded as installed, gone from disk: both facts survive, so the
    // Console can tell broken from ready.
    expect(fd).toMatchObject({
      installed: true,
      exists: false,
      missingPaths: ["/abs/bin/fd"],
      version: null,
      pin: "v10.2.0",
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
    expect(states[0]).toMatchObject({ action: "upgraded", from: "v0.20.0", to: "v0.23.5", version: "v0.23.5" });
    expect(states[1]).toMatchObject({ action: "failed", error: "download failed: 404" });
    // The fields the other command sends are absent, not invented.
    expect(states[0]?.installed).toBeNull();
  });

  it("refuses a document it does not understand instead of reporting no tools", () => {
    expect(() => parseUbixJson("ubix 1.0\nusage: ...")).toThrow(/did not answer with JSON/);
    expect(() => parseUbixJson(JSON.stringify({ schema_version: 1 }))).toThrow(/no tools array/);
    expect(() => parseUbixJson(JSON.stringify({ tools: [{ action: "installed" }] }))).toThrow(/no name/);
  });
});

describe("the ubix config Pier owns", () => {
  it("declares the tools it was handed and where they install, and nothing else", () => {
    const toml = ubixConfigToml([{ name: "rtk", spec: "github:rtk-ai/rtk" }], "/home/t/.pier/tools/bin");
    expect(toml).toContain(`install_dir = "/home/t/.pier/tools/bin"`);
    expect(toml).toContain("[tools.rtk]");
    expect(toml).toContain(`spec = "github:rtk-ai/rtk"`);
    expect(ubixConfigToml([], "/bin")).not.toContain("[tools.");
  });

  it("names the executable when the archive does not name it after the project", () => {
    // Verified against the real thing: without this, ripgrep's install fails
    // with "could not find any files matching [ripgrep*]".
    const rg = MANAGED.find((tool) => tool.name === "rg");
    expect(rg?.exe).toBe("rg");
    expect(ubixConfigToml([rg!], "/bin")).toContain(`exe = "rg"`);
    expect(ubixConfigToml([{ name: "fd", spec: "github:sharkdp/fd" }], "/bin")).not.toContain("exe =");
  });
});

describe("a tool the operator declares", () => {
  it("takes a name and a spec that name a source ubix has", () => {
    expect(normalizeCustomTools([{ name: " eza ", spec: " github:eza-community/eza " }]))
      .toEqual([{ name: "eza", spec: "github:eza-community/eza" }]);
    expect(normalizeCustomTools([{ name: "ruff", spec: "pypi:ruff" }]))
      .toEqual([{ name: "ruff", spec: "pypi:ruff" }]);
    expect(normalizeCustomTools([])).toEqual([]);
  });

  it("refuses rather than half-storing anything that would install the wrong thing", () => {
    for (const bad of [
      "not a list",
      [{ name: "eza" }],
      [{ name: "eza", spec: 42 }],
      // A source ubix does not have, or none at all: guessing one would
      // install something nobody wrote.
      [{ name: "eza", spec: "githbu:eza-community/eza" }],
      [{ name: "eza", spec: "eza-community/eza" }],
      [{ name: "eza", spec: "github:" }],
      [{ name: "eza", spec: "github:a/b c" }],
      // Names Pier already owns, and a name a filesystem would not like.
      [{ name: "rtk", spec: "github:x/y" }],
      [{ name: "ubix", spec: "github:x/y" }],
      [{ name: "../rm", spec: "github:x/y" }],
      [{ name: "", spec: "github:x/y" }],
      [{ name: "a".repeat(33), spec: "github:x/y" }],
      // Two rows installing into the same filename.
      [{ name: "eza", spec: "github:x/y" }, { name: "eza", spec: "github:a/b" }],
      Array.from({ length: 17 }, (_, i) => ({ name: `t${String(i)}`, spec: "github:x/y" })),
    ]) {
      expect(normalizeCustomTools(bad)).toBeNull();
    }
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

describe("the daily update task", () => {
  it("exists exactly while something is switched on", () => {
    expect(toolsTaskPlan([], false, false)).toEqual({ do: "nothing" });
    expect(toolsTaskPlan([], true, true)).toEqual({ do: "retire" });
    // A boot creates the task an enabled set needs, but does not reinstall.
    expect(toolsTaskPlan(["rtk"], false, false)).toEqual({ do: "create", run: false });
    expect(toolsTaskPlan(["rtk"], false, true)).toEqual({ do: "create", run: true });
    // A flipped switch converges now; a restart does not.
    expect(toolsTaskPlan(["rtk"], true, true)).toEqual({ do: "run" });
    expect(toolsTaskPlan(["rtk"], true, false)).toEqual({ do: "nothing" });
  });

  it("runs the command it was handed, in Pier's own home", () => {
    const draft = toolsTaskDraft(`"/opt/node 24/bin/node" "/opt/pier/cli.js" tools sync`, "/home/t/.pier", "Europe/Berlin");
    expect(draft.action).toEqual({
      type: "bash",
      script: `"/opt/node 24/bin/node" "/opt/pier/cli.js" tools sync`,
      cwd: "/home/t/.pier",
    });
    expect(draft.trigger.expression.split(/\s+/)).toHaveLength(5);
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
function rig(options: { answer?: (call: Call) => ExecResult | undefined; installed?: string[] } = {}) {
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
  return {
    root,
    calls,
    tools: new ManagedTools({ root, exec, fetch: () => Promise.reject(new Error("the network is not open in tests")) }),
    /** Every command line, in order — the assertions below are about order. */
    lines: () => calls.map((c) => `${c.file.split("/").pop() ?? ""} ${c.args.join(" ")}`),
  };
}

describe("ManagedTools.sync", () => {
  it("does nothing at all when nothing is on and nothing is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-tools-empty-"));
    const tools = new ManagedTools({
      root,
      exec: () => Promise.reject(new Error("nothing may be spawned")),
      fetch: () => Promise.reject(new Error("nothing may be fetched")),
    });
    expect(await tools.sync([])).toEqual({ entries: [], failed: false, summary: "no tools switched on" });
  });

  it("writes the config, upgrades, then provisions from the tool's own binary", async () => {
    const r = rig({
      installed: ["rtk"],
      answer: (call) =>
        call.args[0] === "list" ? ok(JSON.stringify({ schema_version: 1, tools: [] })) : ok(upgradeJson(upgraded)),
    });
    const report = await r.tools.sync(["rtk"]);
    expect(report.failed).toBe(false);
    expect(report.entries).toEqual([{ name: "rtk", action: "upgraded", version: "v0.23.5", error: null }]);
    expect(report.summary).toBe("rtk: upgraded v0.23.5");
    expect(r.lines()).toEqual([
      "ubix list --json",
      "ubix upgrade --all --json",
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
    const report = await r.tools.sync([]);
    // Everything ubix still declares goes, whether or not it has a footprint
    // of its own to undo — the config is Pier's, so nothing there is a
    // stranger's.
    expect(r.lines()).toEqual([
      "ubix list --json",
      "rtk init --uninstall --agent pi --global",
      "ubix remove rtk --force",
      "ubix remove fd --force",
      "ubix remove wt --force",
      "ubix upgrade --all --json",
    ]);
    expect(report.entries[0]).toEqual({ name: "rtk", action: "removed", version: null, error: null });
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
    const report = await r.tools.sync(["rtk"]);
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
    const report = await r.tools.sync(["rtk"]);
    expect(report.failed).toBe(true);
    expect(report.summary).toContain("rtk init -g --agent pi exited 3: unknown agent: pi");
  });

  it("says an ubix too old for --json is too old, instead of scraping its output", async () => {
    const r = rig({ answer: () => ({ code: 1, stdout: "", stderr: "error: unexpected argument '--json'" }) });
    await expect(r.tools.sync(["rtk"])).rejects.toThrow(/too old for Pier's managed tools/);
  });
});

describe("ManagedTools.status", () => {
  it("has no error and no versions before anything is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-tools-status-"));
    const tools = new ManagedTools({ root, exec: () => Promise.reject(new Error("no ubix yet")) });
    const entries = await tools.status(["rtk"]);
    expect(entries.map((e) => e.name)).toEqual(MANAGED.map((t) => t.name));
    expect(entries[0]).toEqual({
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
    expect(rtk?.binary).toMatchObject({ installed: false, error: "installed but missing on disk: /abs/bin/rtk" });
  });

  it("answers with the reason rather than throwing when ubix cannot be read", async () => {
    const r = rig({ answer: () => ({ code: 1, stdout: "", stderr: "state.toml is locked" }) });
    const [rtk] = await r.tools.status([]);
    expect(rtk?.binary?.error).toMatch(/state\.toml is locked/);
    expect(rtk?.enabled).toBe(false);
  });
});

describe("a Console read while an install is running", () => {
  it("answers that ubix is busy rather than waiting out its state lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "pier-tools-busy-"));
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "ubix"), "#!/bin/sh\n");
    // ubix's state lock is exclusive: a `list` behind a running `upgrade`
    // returns when the download does, which is not a page's timescale.
    const tools = new ManagedTools({ root, exec: () => new Promise<ExecResult>(() => {}) });
    vi.useFakeTimers();
    const answering = tools.status(["rtk"]);
    await vi.advanceTimersByTimeAsync(3000);
    const [rtk] = await answering;
    vi.useRealTimers();
    expect(rtk).toMatchObject({
      enabled: true,
      binary: { installed: false, error: "ubix is busy — an install or update is running" },
    });
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
    const runner: SyncRunner = {
      run: () => {
        if (settle) {
          // The overlap guard: the run is recorded as skipped and the caller
          // is handed the run that is actually in flight.
          skipped.push("overlap");
          return { started: false, settled: inFlight };
        }
        started.push([...enabled]);
        inFlight = new Promise<void>((resolve) => (settle = resolve));
        return { started: true, settled: inFlight };
      },
    };
    let inFlight = Promise.resolve();
    return {
      runner,
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
    const sync = coalescedSync(rig.runner, (err) => failures.push(err));

    // rtk goes on and its sync starts running.
    expect(sync().state).toBe("started");
    expect(rig.started).toEqual([["rtk"]]);

    // Three more switches, each its own request, all while that run is busy.
    for (const name of ["rg", "fd", "wt"]) {
      rig.flip(name);
      expect(sync().state).toBe("waiting");
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
    const sync = coalescedSync({
      run: () => {
        if (refuse) return { started: false, settled: busy };
        started.push(Date.now());
        return { started: true, settled: Promise.resolve() };
      },
    }, (err) => expect.unreachable(String(err)));

    expect(sync().state).toBe("started");
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
    const sync = coalescedSync({
      run: () => {
        if (fail) throw new Error("no tools update task to run");
        return { started: true, settled: Promise.resolve() };
      },
    }, (err) => failures.push(err));
    sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(failures[0])).toContain("no tools update task");
    fail = false;
    expect(sync().state).toBe("started");
  });
});
