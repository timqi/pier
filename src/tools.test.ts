import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type Exec,
  type ExecResult,
  ManagedTools,
  parseUbixJson,
  toolsTaskDraft,
  toolsTaskPlan,
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
  it("declares the enabled tools and where they install, and nothing else", () => {
    const toml = ubixConfigToml(["rtk"], "/home/t/.pier/tools/bin");
    expect(toml).toContain(`install_dir = "/home/t/.pier/tools/bin"`);
    expect(toml).toContain("[tools.rtk]");
    expect(toml).toContain(`spec = "github:rtk-ai/rtk"`);
    // A name nobody manages cannot smuggle a section in.
    expect(ubixConfigToml(["nope"], "/bin")).not.toContain("[tools.");
    expect(ubixConfigToml([], "/bin")).not.toContain("[tools.");
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

  it("runs the recorded node against the recorded CLI, quoted", () => {
    const draft = toolsTaskDraft("/opt/node 24/bin/node", "/opt/pier/cli.js", "/home/t/.pier", "Europe/Berlin");
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
    expect(r.lines()).toEqual([
      "ubix list --json",
      "rtk init --uninstall --agent pi --global",
      "ubix remove rtk --force",
      "ubix upgrade --all --json",
    ]);
    expect(report.entries).toEqual([{ name: "rtk", action: "removed", version: null, error: null }]);
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
    expect(await tools.status(["rtk"])).toEqual([
      expect.objectContaining({ name: "rtk", enabled: true, installed: false, version: null, error: null }),
    ]);
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
    expect(rtk).toMatchObject({ installed: false, error: "installed but missing on disk: /abs/bin/rtk" });
  });

  it("answers with the reason rather than throwing when ubix cannot be read", async () => {
    const r = rig({ answer: () => ({ code: 1, stdout: "", stderr: "state.toml is locked" }) });
    const [rtk] = await r.tools.status([]);
    expect(rtk?.error).toMatch(/state\.toml is locked/);
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
    expect(rtk).toMatchObject({ enabled: true, installed: false, error: "ubix is busy — an install or update is running" });
  });
});
