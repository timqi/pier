// The package registry behind the PackageStore seam: Pi's DefaultPackageManager
// and SettingsManager, the second and last SDK-importing file in agent/. pi.ts
// opens sessions; this file changes what they open with. No Pi type may appear
// in an exported signature.

import { existsSync, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type PackageSource,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import {
  PackageError,
  type Package,
  type PackageKind,
  type PackageRegistry,
  type PackageResource,
  type PackageResourceKind,
  type PackageStore,
  type PackageSwitch,
} from "../core/types.js";
import { logger } from "../log.js";
import type { SettingsStore } from "../settings.js";
import { defaultAgentDir, type PiConfigStore } from "./config.js";

const log = logger("packages");

/** Set by how long a released fix may sit unnoticed, like update.ts. */
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const KINDS = { extensions: "extension", skills: "skill" } as const;
type ArrayKey = keyof typeof KINDS;
/** Written by `rtk init -g --agent pi` (the rtk block's `post_install` hook): a `local` file whose
 *  switch is the rtk tool's, so a settings.json pattern would fight the tool. */
const RTK_FILE = join("extensions", "rtk.ts");
const RTK_STATE = "installed by the rtk tool";

/** The built-in `pier` package: its switches are pier.db lists, none of it settings.json. */
export interface PierPackage {
  version: string;
  settings: Pick<SettingsStore, "get" | "setSkillsOff">;
}

export const kindOf = (source: string): PackageKind =>
  source.startsWith("npm:") ? "npm" : /^(git:|(https?|ssh|git):\/\/)/.test(source) ? "git" : "path";

/** A trailing `@ref` on an npm or git source; the leading `@` of a scope is not one. */
export const pinnedRef = (source: string): string | null => {
  const at = source.lastIndexOf("@");
  const ref = at > 0 ? source.slice(at + 1) : "";
  return ref && !/[/:]/.test(ref) ? ref : null;
};

/** An extension is named by its file (or the directory its index sits in); a
 *  skill by its directory. Pi reads the frontmatter name at load, not here. */
const nameOf = (kind: PackageResourceKind, path: string): string => {
  const file = basename(path);
  if (kind === "skill") return file === "SKILL.md" ? basename(dirname(path)) : file.replace(/\.md$/, "");
  const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
  return stem === "index" ? basename(dirname(path)) : stem;
};

const versionFile = async (dir: string | null): Promise<string | null> => {
  if (!dir) return null;
  try {
    const { version } = JSON.parse(await fs.readFile(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    log.warn(`${dir}/package.json unreadable — no version shown`, err);
    return null;
  }
};

/** Pi's own toggle rule (its config selector): one `+path`/`-path` per resource,
 *  any earlier pattern for the same path removed first. A bare entry stays: it
 *  is what lists the file, not a pattern on it. */
const flip = (entries: readonly string[], pattern: string, enabled: boolean): string[] => [
  ...entries.filter((p) => !(/^[!+-]/.test(p) && p.slice(1) === pattern)),
  `${enabled ? "+" : "-"}${pattern}`,
];

/** What npm, git or Pi's manifest refused is the upstream's failure, answered
 *  as such (502) with Pi's own sentence; a PackageError passes through. */
const upstream = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PackageError) throw err;
    throw new PackageError("unreachable", `${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const resourceRow = (kind: PackageResourceKind, r: ResolvedResource): PackageResource => ({
  kind, name: nameOf(kind, r.path), path: r.path, enabled: r.enabled, state: null,
});

export class PiPackageStore implements PackageStore {
  #busy: string | null = null;
  #updates = new Set<string>();
  #checkedAt: string | null = null;

  constructor(
    private readonly config: Pick<PiConfigStore, "withWrite">,
    private readonly pier: PierPackage,
    /** Pier's own skill directories, the ones pi.ts loads per session. */
    private readonly skillDirs: readonly string[],
    private readonly agentDir: string = defaultAgentDir(),
  ) {}

  /** Per call, never retained: Pi's manager caches nothing Pier wants to keep,
   *  and a fresh SettingsManager reads whatever writeDefaults wrote last. */
  #open(cwd?: string): { settings: SettingsManager; manager: DefaultPackageManager } {
    // Untrusted without a cwd: the project scope of the agent dir is nothing.
    const settings = SettingsManager.create(cwd ?? this.agentDir, this.agentDir, { projectTrusted: cwd !== undefined });
    this.#raise(settings, "read");
    const manager = new DefaultPackageManager({ cwd: cwd ?? this.agentDir, agentDir: this.agentDir, settingsManager: settings });
    manager.setProgressCallback((e) => log.info(`${e.action} ${e.source}: ${e.type}${e.message ? ` — ${e.message}` : ""}`));
    return { settings, manager };
  }

  /** Pi's SettingsManager records a failed load or write and carries on (§5). */
  #raise(settings: SettingsManager, what: string): void {
    const errors = settings.drainErrors();
    if (!errors.length) return;
    const detail = errors.map((e) => `${e.path ?? e.scope}: ${e.error.message}`).join("; ");
    throw new PackageError("invalid", `settings.json could not be ${what}: ${detail}`);
  }

  async list(cwd?: string): Promise<PackageRegistry> {
    const { manager } = this.#open(cwd);
    const rtkPath = join(this.agentDir, RTK_FILE);
    const resolved = await manager.resolve(async () => "skip");
    const rows = new Map<string, Package>();
    const row = (source: string, kind: PackageKind, scope: Package["scope"], installedPath: string | null): Package => {
      const key = `${scope}\0${source}`;
      let found = rows.get(key);
      if (!found) {
        found = { source, kind, scope, version: null, installedPath, updateAvailable: false, resources: [] };
        rows.set(key, found);
      }
      return found;
    };
    row("pier", "pier", "global", null);
    row("local", "local", "global", this.agentDir);
    for (const key of Object.keys(KINDS) as ArrayKey[]) {
      for (const r of resolved[key]) {
        const own = r.metadata.origin === "top-level";
        const scope = r.metadata.scope === "project" ? "project" : "global";
        const resource = resourceRow(KINDS[key], r);
        if (r.path === rtkPath) Object.assign(resource, { state: RTK_STATE, locked: true });
        row(own ? "local" : r.metadata.source, own ? "local" : kindOf(r.metadata.source), scope, r.metadata.baseDir ?? null)
          .resources.push(resource);
      }
    }
    // Configured but unresolved (not installed, or empty): still a row.
    for (const p of manager.listConfiguredPackages()) {
      const found = row(p.source, kindOf(p.source), p.scope === "project" ? "project" : "global", p.installedPath ?? null);
      found.installedPath ??= p.installedPath ?? null;
      found.updateAvailable = this.#updates.has(p.source);
    }
    // pier, local, the global packages, then the project's rows; Pi's own order is precedence.
    const rank = (p: Package): number => p.kind === "pier" ? 0 : p.scope === "project" ? 3 : p.kind === "local" ? 1 : 2;
    const packages = [...rows.values()].sort((a, b) => rank(a) - rank(b));
    for (const pkg of packages) {
      if (pkg.kind === "pier") await this.#fillPier(pkg);
      else if (pkg.kind === "git") pkg.version = pinnedRef(pkg.source);
      else if (pkg.kind !== "local") pkg.version = await versionFile(pkg.installedPath);
    }
    return { packages, checkedAt: this.#checkedAt, busy: this.#busy };
  }

  async #fillPier(pkg: Package): Promise<void> {
    pkg.version = this.pier.version;
    const { skillsOff: off } = this.pier.settings.get();
    pkg.resources = [];
    for (const dir of this.skillDirs) {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
        const path = join(dir, entry.name, "SKILL.md");
        if (!existsSync(path)) continue;
        pkg.resources.push({ kind: "skill", name: entry.name, path, enabled: !off.includes(entry.name), state: null });
      }
    }
  }

  /** One at a time: the second Console click is told, not queued behind an npm install. */
  async #operate<T>(source: string, run: (manager: DefaultPackageManager, settings: SettingsManager) => Promise<T>): Promise<T> {
    if (this.#busy) throw new PackageError("busy", `${this.#busy} is being changed; try again when it finishes`);
    this.#busy = source;
    try {
      return await this.#write(run);
    } finally {
      this.#busy = null;
    }
  }

  /** Inside ConfigStore's queue, so writeDefaults and a session open never
   *  interleave with Pi's merge-write; flushed and checked before it ends. */
  #write<T>(run: (manager: DefaultPackageManager, settings: SettingsManager) => Promise<T>, cwd?: string): Promise<T> {
    return this.config.withWrite(async () => {
      const { manager, settings } = this.#open(cwd);
      const result = await run(manager, settings);
      await settings.flush();
      this.#raise(settings, "written");
      return result;
    });
  }

  async #row(source: string): Promise<Package> {
    const found = (await this.list()).packages.find((p) => p.source === source);
    if (!found) throw new PackageError("missing", `${source} is not a configured package`);
    return found;
  }

  /** `local` is one row per scope: the resource, not the source, picks the row. */
  async #find({ source, kind, path, cwd }: PackageSwitch): Promise<{ pkg: Package; resource: PackageResource }> {
    const owners = (await this.list(cwd)).packages.filter((p) => p.source === source);
    if (!owners.length) throw new PackageError("missing", `${source} is not a configured package`);
    for (const pkg of owners) {
      const resource = pkg.resources.find((r) => r.kind === kind && r.path === path);
      if (resource) return { pkg, resource };
    }
    throw new PackageError("missing", `${source} has no ${kind} at ${path}`);
  }

  #builtin(source: string): void {
    if (source === "pier" || source === "local") throw new PackageError("refused", `${source} is built in`);
  }

  async install(source: string): Promise<Package> {
    const spec = source.trim();
    if (!spec) throw new PackageError("invalid", "a package source is required");
    this.#builtin(spec);
    if (kindOf(spec) === "path" && !existsSync(resolve(this.agentDir, spec))) {
      throw new PackageError("invalid", `no such path: ${resolve(this.agentDir, spec)}`);
    }
    // Pi stores a local path relative to the settings file: the row is named
    // by what landed in settings.json, not by what was typed.
    const stored = await this.#operate(spec, async (manager) => {
      const sources = (): string[] => manager.listConfiguredPackages().filter((p) => p.scope === "user").map((p) => p.source);
      const before = new Set(sources());
      await upstream(`installing ${spec}`, () => manager.installAndPersist(spec));
      const added = sources().find((s) => !before.has(s));
      if (!added) throw new PackageError("refused", `${spec} is already configured`);
      return added;
    });
    return this.#row(stored);
  }

  async remove(source: string): Promise<void> {
    this.#builtin(source);
    await this.#operate(source, async (manager) => {
      if (!manager.listConfiguredPackages().some((p) => p.scope === "user" && p.source === source)) {
        throw new PackageError("missing", `${source} is not in settings.json`);
      }
      await upstream(`removing ${source}`, () => manager.removeAndPersist(source));
    });
  }

  async update(source?: string): Promise<Package[]> {
    const configured = this.#open().manager.listConfiguredPackages().filter((p) => p.scope === "user");
    const movable = (s: string): boolean => kindOf(s) !== "path" && pinnedRef(s) === null;
    if (source !== undefined) {
      this.#builtin(source);
      if (!configured.some((p) => p.source === source)) throw new PackageError("missing", `${source} is not in settings.json`);
      if (!movable(source)) throw new PackageError("refused", `${source} is pinned or local — nothing to move`);
    }
    const targets = source === undefined ? configured.map((p) => p.source).filter(movable) : [source];
    await this.#operate(source ?? "every package", (manager) => upstream(`updating ${source ?? "every package"}`, () => manager.update(source)));
    for (const s of targets) this.#updates.delete(s);
    const { packages } = await this.list();
    return packages.filter((p) => p.scope === "global" && targets.includes(p.source));
  }

  async setEnabled(change: PackageSwitch): Promise<PackageResource> {
    const { source, kind, path, enabled, cwd } = change;
    const { pkg, resource } = await this.#find(change);
    if (resource.locked) throw new PackageError("refused", `${resource.name} is ${resource.state} — its switch is under Tools`);
    if (pkg.kind === "pier") {
      this.pier.settings.setSkillsOff(withName(this.pier.settings.get().skillsOff, resource.name, !enabled));
    } else {
      const key: ArrayKey = kind === "extension" ? "extensions" : "skills";
      await this.#write(async (manager, settings) => {
        // Re-resolved under the lock: the pattern is relative to the base Pi
        // resolved it from, which is the only base its filter will match.
        const r = (await manager.resolve(async () => "skip"))[key].find((it) => it.path === path);
        if (!r) throw new PackageError("missing", `${path} is not loaded from ${source}`);
        const project = cwd !== undefined;
        const inherited = project && r.metadata.scope !== "project";
        const scoped = project ? settings.getProjectSettings() : settings.getGlobalSettings();
        const projectDir = join(cwd ?? this.agentDir, ".pi");
        if (r.metadata.origin === "top-level") {
          // A global resource switched for one project is named by its absolute path there.
          const pattern = inherited ? path : relative(r.metadata.baseDir ?? (project ? projectDir : this.agentDir), path);
          const next = flip(scoped[key] ?? [], pattern, enabled);
          if (inherited && !next.includes(path)) next.unshift(path);
          if (project) settings[key === "extensions" ? "setProjectExtensionPaths" : "setProjectSkillPaths"](next);
          else settings[key === "extensions" ? "setExtensionPaths" : "setSkillPaths"](next);
        } else {
          const pattern = relative(r.metadata.baseDir ?? dirname(path), path);
          const packages = [...(scoped.packages ?? [])];
          let at = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === source);
          // A global package overridden for one project: Pi's delta entry, a
          // local path re-based on .pi/ because that is where Pi resolves it from.
          if (at === -1 && inherited) {
            const own = kindOf(source) === "path" ? relative(projectDir, resolve(this.agentDir, source)) || "." : source;
            at = packages.push({ source: own, autoload: false }) - 1;
          }
          if (at === -1) throw new PackageError("missing", `${source} is not in settings.json`);
          const entry = packages[at]!;
          const filtered: Exclude<PackageSource, string> = typeof entry === "string" ? { source: entry } : { ...entry };
          filtered[key] = flip(filtered[key] ?? [], pattern, enabled);
          packages[at] = filtered;
          if (project) settings.setProjectPackages(packages);
          else settings.setPackages(packages);
        }
      }, cwd);
    }
    // By path, not source: an override moves the resource to the project's row.
    const after = (await this.list(cwd)).packages.flatMap((p) => p.resources).find((r) => r.kind === kind && r.path === path);
    if (!after) throw new PackageError("missing", `${path} is no longer loaded`);
    return after;
  }

  async checkUpdates(): Promise<PackageRegistry> {
    const { manager } = this.#open();
    const found = await upstream("update check", () => manager.checkForAvailableUpdates());
    this.#updates = new Set(found.filter((u) => u.scope === "user").map((u) => u.source));
    this.#checkedAt = new Date().toISOString();
    if (this.#updates.size) log.info(`package updates available: ${[...this.#updates].join(", ")}`);
    return this.list();
  }

  /** At boot and daily, like update.ts; the answer waits in `list` for the next
   *  Console open. Returns its own stop. */
  watchUpdates(everyMs = CHECK_EVERY_MS): () => void {
    const tick = (): void => {
      void this.checkUpdates().catch((err: unknown) => log.warn(String(err)));
    };
    tick();
    const timer = setInterval(tick, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

const withName = (names: string[], name: string, on: boolean): string[] =>
  on ? [...new Set([...names, name])] : names.filter((n) => n !== name);
