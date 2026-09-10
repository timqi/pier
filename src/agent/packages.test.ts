import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageError, type AgentCustomTool, type Package } from "../core/types.js";
import { openDb } from "../db.js";
import { SettingsStore } from "../settings.js";
import { PiConfigStore } from "./config.js";
import { kindOf, PiPackageStore, pinnedRef } from "./packages.js";

let agentDir: string;
let home: string;
let skills: string;
let pkgDir: string;
let config: PiConfigStore;
let settings: SettingsStore;
let store: PiPackageStore;
const previousHome = process.env.HOME;

const tmp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `pier-${name}-`)));
const file = (path: string, content = ""): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};
const skill = (dir: string, name: string): string => {
  const path = join(dir, name, "SKILL.md");
  file(path, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  return path;
};
const settingsJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
const writeSettings = (value: unknown): void => file(join(agentDir, "settings.json"), JSON.stringify(value));
const row = (packages: Package[], source: string): Package => {
  const found = packages.find((p) => p.source === source);
  if (!found) throw new Error(`no row ${source} in ${packages.map((p) => p.source).join(", ")}`);
  return found;
};

beforeEach(() => {
  agentDir = tmp("agent");
  home = tmp("home");
  skills = tmp("skills");
  pkgDir = tmp("pkg");
  // Pi auto-discovers ~/.agents/skills; the test must never see the real one.
  process.env.HOME = home;
  config = new PiConfigStore(agentDir);
  skill(skills, "pier-slack");
  skill(skills, "pier-help");
  file(join(pkgDir, "extensions", "a.ts"), "export default () => {}");
  file(join(pkgDir, "extensions", "b.ts"), "export default () => {}");
  skill(join(pkgDir, "skills"), "s");
  file(join(pkgDir, "package.json"), JSON.stringify({ name: "pkg", version: "2.3.4" }));
  file(join(agentDir, "extensions", "mine.ts"), "export default () => {}");
  file(join(agentDir, "extensions", "rtk.ts"), "export default () => {}");
  skill(join(agentDir, "skills"), "x");
  const slack: AgentCustomTool = {
    name: "slack", label: "Slack", description: "", parameters: {}, execute: async () => null,
    skill: "pier-slack", available: () => false,
  };
  settings = new SettingsStore(openDb(":memory:"));
  settings.setExtensions(["web"]);
  store = new PiPackageStore(config, { version: "0.1.2", settings, tools: [slack] }, [skills], agentDir);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("source syntax", () => {
  it("names the kind and the pin the way Pi parses them", () => {
    expect(kindOf("npm:@scope/pkg@1.2.3")).toBe("npm");
    expect(kindOf("git:github.com/u/r@v1")).toBe("git");
    expect(kindOf("https://github.com/u/r")).toBe("git");
    expect(kindOf("../pkg")).toBe("path");
    expect(pinnedRef("npm:@scope/pkg@1.2.3")).toBe("1.2.3");
    expect(pinnedRef("npm:@scope/pkg")).toBeNull();
    expect(pinnedRef("git:git@github.com:u/r")).toBeNull();
    expect(pinnedRef("git:git@github.com:u/r@v1")).toBe("v1");
  });
});

describe("the registry", () => {
  it("lists pier, local and each configured package with their switch state", async () => {
    writeSettings({ packages: [pkgDir, { source: "npm:absent" }], extensions: ["-extensions/mine.ts"] });
    const { packages, busy, checkedAt } = await store.list();
    expect(busy).toBeNull();
    expect(checkedAt).toBeNull();
    expect(packages.map((p) => [p.source, p.kind, p.scope])).toEqual([
      ["pier", "pier", "global"], ["local", "local", "global"], [pkgDir, "path", "global"], ["npm:absent", "npm", "global"],
    ]);

    const pierRow = row(packages, "pier");
    expect(pierRow.version).toBe("0.1.2");
    expect(pierRow.resources).toEqual([
      { kind: "extension", name: "web", path: "<inline:web>", enabled: true, state: null },
      { kind: "skill", name: "pier-help", path: join(skills, "pier-help", "SKILL.md"), enabled: true, state: null },
      { kind: "skill", name: "pier-slack", path: join(skills, "pier-slack", "SKILL.md"), enabled: true, state: "follows Channels → agent tool" },
    ]);

    const local = row(packages, "local");
    expect(local.installedPath).toBe(agentDir);
    expect(local.resources).toEqual([
      { kind: "extension", name: "mine", path: join(agentDir, "extensions", "mine.ts"), enabled: false, state: null },
      // rtk init's file: a local row like any other, its switch the rtk tool's.
      { kind: "extension", name: "rtk", path: join(agentDir, "extensions", "rtk.ts"), enabled: true, state: "installed by the rtk tool", locked: true },
      { kind: "skill", name: "x", path: join(agentDir, "skills", "x", "SKILL.md"), enabled: true, state: null },
    ]);

    const pkg = row(packages, pkgDir);
    expect(pkg.version).toBe("2.3.4");
    expect(pkg.installedPath).toBe(pkgDir);
    expect(pkg.updateAvailable).toBe(false);
    expect(pkg.resources.map((r) => [r.kind, r.name, r.enabled])).toEqual([
      ["extension", "a", true], ["extension", "b", true], ["skill", "s", true],
    ]);

    // Configured, never installed: a row with nothing in it, not a missing row.
    const absent = row(packages, "npm:absent");
    expect(absent).toMatchObject({ installedPath: null, version: null, resources: [] });
  });

  it("follows a symlinked skill like Pi does", async () => {
    const elsewhere = tmp("linked");
    skill(elsewhere, "linked");
    symlinkSync(join(elsewhere, "linked"), join(agentDir, "skills", "linked"));
    const local = row((await store.list()).packages, "local");
    expect(local.resources.map((r) => r.name)).toContain("linked");
  });

  it("refuses to read a settings.json that is not JSON", async () => {
    file(join(agentDir, "settings.json"), "{ nope");
    await expect(store.list()).rejects.toMatchObject({ reason: "invalid" });
  });
});

describe("switches", () => {
  it("writes pier switches to the pier.db lists", async () => {
    const web = await store.setEnabled({ source: "pier", kind: "extension", path: "<inline:web>", enabled: false });
    expect(web.enabled).toBe(false);
    expect(settings.get().extensions).toEqual([]);
    const help = await store.setEnabled({ source: "pier", kind: "skill", path: join(skills, "pier-help", "SKILL.md"), enabled: false });
    expect(help.enabled).toBe(false);
    expect(settings.get().skillsOff).toEqual(["pier-help"]);
    await store.setEnabled({ source: "pier", kind: "skill", path: join(skills, "pier-help", "SKILL.md"), enabled: true });
    expect(settings.get().skillsOff).toEqual([]);
    // Nothing of the above is settings.json's business.
    expect(settingsJson).toThrow();
  });

  it("refuses to flip rtk.ts: a settings.json pattern would fight the rtk tool's install", async () => {
    await expect(store.setEnabled({ source: "local", kind: "extension", path: join(agentDir, "extensions", "rtk.ts"), enabled: false }))
      .rejects.toMatchObject({ reason: "refused" });
    expect(settingsJson).toThrow();
  });

  it("writes a local switch as a top-level pattern and a package switch as its filter", async () => {
    writeSettings({ packages: [pkgDir], defaultProvider: "anthropic", defaultModel: "m" });
    const mine = join(agentDir, "extensions", "mine.ts");
    expect((await store.setEnabled({ source: "local", kind: "extension", path: mine, enabled: false })).enabled).toBe(false);
    expect(settingsJson().extensions).toEqual(["-extensions/mine.ts"]);
    expect((await store.setEnabled({ source: "local", kind: "extension", path: mine, enabled: true })).enabled).toBe(true);
    expect(settingsJson().extensions).toEqual(["+extensions/mine.ts"]);

    const b = join(pkgDir, "extensions", "b.ts");
    expect((await store.setEnabled({ source: pkgDir, kind: "extension", path: b, enabled: false })).enabled).toBe(false);
    expect(settingsJson().packages).toEqual([{ source: pkgDir, extensions: ["-extensions/b.ts"] }]);
    const s = join(pkgDir, "skills", "s", "SKILL.md");
    expect((await store.setEnabled({ source: pkgDir, kind: "skill", path: s, enabled: false })).enabled).toBe(false);
    expect(settingsJson().packages).toEqual([{ source: pkgDir, extensions: ["-extensions/b.ts"], skills: ["-skills/s/SKILL.md"] }]);
    // Pi's merge-write touched its keys and left Pier's defaults alone.
    expect(settingsJson()).toMatchObject({ defaultProvider: "anthropic", defaultModel: "m" });
  });

  it("writes a project's own switches and its overrides of global resources to .pi/settings.json", async () => {
    const cwd = tmp("proj");
    writeSettings({ packages: [pkgDir] });
    file(join(cwd, ".pi", "extensions", "proj.ts"), "export default () => {}");
    // Listed by the project itself, relative to .pi/ — Pi's base for a project's own entries.
    file(join(cwd, "ext", "p.ts"), "export default () => {}");
    file(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["../ext/p.ts"] }));
    const { packages } = await store.list(cwd);
    expect(packages.map((p) => [p.source, p.scope])).toEqual([
      ["pier", "global"], ["local", "global"], [pkgDir, "global"], ["local", "project"],
    ]);
    const proj = join(cwd, ".pi", "extensions", "proj.ts");
    await store.setEnabled({ source: "local", kind: "extension", path: proj, enabled: false, cwd });
    await store.setEnabled({ source: "local", kind: "extension", path: join(cwd, "ext", "p.ts"), enabled: false, cwd });
    const a = join(pkgDir, "extensions", "a.ts");
    await store.setEnabled({ source: pkgDir, kind: "extension", path: a, enabled: false, cwd });
    const mine = join(agentDir, "extensions", "mine.ts");
    const off = await store.setEnabled({ source: "local", kind: "extension", path: mine, enabled: false, cwd });
    expect(off.enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({
      extensions: [mine, "../ext/p.ts", "-extensions/proj.ts", "-../ext/p.ts", `-${mine}`],
      // Pi's delta entry names a local package from .pi/, where it resolves it.
      packages: [{ source: relative(join(cwd, ".pi"), pkgDir), autoload: false, extensions: ["-extensions/a.ts"] }],
    });
    expect(settingsJson()).toEqual({ packages: [pkgDir] });
    // An overridden global resource is the project's row now (Pi: first scope wins).
    const after = await store.list(cwd);
    expect(row(after.packages, "local").resources.map((r) => r.name)).toEqual(["rtk", "x"]);
    expect(after.packages.find((p) => p.source === "local" && p.scope === "project")?.resources.map((r) => [r.name, r.enabled]))
      .toEqual([["mine", false], ["p", false], ["proj", false]]);
    // Pi's delta: the project's row holds the overridden resource, the global row the rest.
    expect(after.packages.find((p) => p.scope === "project" && p.kind === "path")?.resources.map((r) => [r.name, r.enabled]))
      .toEqual([["a", false]]);
    expect(row(after.packages, pkgDir).resources.map((r) => r.name)).toEqual(["b", "s"]);
    // Global still reads the global answer.
    expect(row((await store.list()).packages, "local").resources.find((r) => r.name === "mine")?.enabled).toBe(true);
  });

  it("names a resource it does not have", async () => {
    await expect(store.setEnabled({ source: "nope", kind: "extension", path: "/x", enabled: true }))
      .rejects.toMatchObject({ reason: "missing" });
    await expect(store.setEnabled({ source: "local", kind: "skill", path: "/x", enabled: true }))
      .rejects.toMatchObject({ reason: "missing" });
  });
});

describe("install, remove, update", () => {
  it("installs a local path into the global scope and answers its row", async () => {
    await config.writeDefaults({ defaultModel: { provider: "anthropic", id: "m" }, defaultThinkingLevel: null });
    const pkg = await store.install(pkgDir);
    expect(pkg.source).toBe(relative(agentDir, pkgDir));
    expect(pkg.resources.map((r) => r.name)).toEqual(["a", "b", "s"]);
    // Both writers' keys survive each other.
    expect(settingsJson()).toEqual({ defaultProvider: "anthropic", defaultModel: "m", packages: [relative(agentDir, pkgDir)] });
    await expect(store.install(pkgDir)).rejects.toMatchObject({ reason: "refused" });
    await store.remove(relative(agentDir, pkgDir));
    expect(settingsJson().packages).toEqual([]);
    await expect(store.remove(relative(agentDir, pkgDir))).rejects.toMatchObject({ reason: "missing" });
  });

  it("refuses what makes no sense before touching anything", async () => {
    await expect(store.install("")).rejects.toMatchObject({ reason: "invalid" });
    await expect(store.install(join(agentDir, "nowhere"))).rejects.toMatchObject({ reason: "invalid" });
    for (const builtin of ["pier", "local"]) {
      await expect(store.install(builtin)).rejects.toMatchObject({ reason: "refused" });
      await expect(store.remove(builtin)).rejects.toMatchObject({ reason: "refused" });
      await expect(store.update(builtin)).rejects.toMatchObject({ reason: "refused" });
    }
    writeSettings({ packages: [pkgDir, "npm:pinned@1.0.0"] });
    await expect(store.update("npm:unknown")).rejects.toMatchObject({ reason: "missing" });
    await expect(store.update(pkgDir)).rejects.toMatchObject({ reason: "refused" });
    await expect(store.update("npm:pinned@1.0.0")).rejects.toMatchObject({ reason: "refused" });
    // Nothing movable: the update-all is a no-op with an empty answer, not a failure.
    expect(await store.update()).toEqual([]);
  });

  it("runs one operation at a time, inside the config write queue", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Holding the queue holds the install too: it cannot start before writeDefaults ends.
    const defaults = config.withWrite(async () => { await held; });
    const install = store.install(pkgDir);
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.list()).busy).toBe(pkgDir);
    await expect(store.install(pkgDir)).rejects.toMatchObject({ reason: "busy" });
    await expect(store.remove(pkgDir)).rejects.toMatchObject({ reason: "busy" });
    await expect(store.update()).rejects.toMatchObject({ reason: "busy" });
    expect(settingsJson).toThrow();
    release();
    await defaults;
    await install;
    expect(settingsJson().packages).toEqual([relative(agentDir, pkgDir)]);
    expect((await store.list()).busy).toBeNull();
  });

  it("surfaces the seam's reason as a PackageError, Pi's own failure as unreachable", async () => {
    await expect(store.remove("npm:none")).rejects.toBeInstanceOf(PackageError);
    // A git clone of nowhere: Pi's error, not this file's, and the row is not written.
    await expect(store.install("git:localhost/nobody/nothing")).rejects.toMatchObject({ reason: "unreachable" });
    expect(settingsJson).toThrow();
  });
});

describe("the update check", () => {
  it("stamps checkedAt and answers the list, with nothing to ask when no package is npm or git", async () => {
    writeSettings({ packages: [pkgDir] });
    const before = Date.now();
    const { checkedAt, packages } = await store.checkUpdates();
    expect(Date.parse(checkedAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(row(packages, pkgDir).updateAvailable).toBe(false);
    expect((await store.list()).checkedAt).toBe(checkedAt);
  });
});
