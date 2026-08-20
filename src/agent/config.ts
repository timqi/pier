// Pi configuration on disk, behind the ConfigStore seam. Knows Pi's directory
// conventions (~/.pi/agent globally; <cwd>/AGENTS.md and <cwd>/.pi per
// project) but not the Pi SDK — pure filesystem, unit-testable in a tmp dir.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  ConfigResource,
  ConfigResourceKind,
  ConfigScope,
  ConfigStore,
} from "../core/types.js";

const GLOBAL_FILES = ["SYSTEM.md", "AGENTS.md", "settings.json", "models.json"];
const PROJECT_FILES = ["AGENTS.md"];
const RESOURCE_DEPTH = 3; // extensions/skills nest at most a couple of levels

/** Same resolution Pi uses (see its config.js getAgentDir). */
export const defaultAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Stable mask: recomputable at write time, so "unchanged" is detectable. */
const maskKey = (key: string): string =>
  key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "•••";

interface ModelsJson {
  providers?: Record<string, { apiKey?: unknown } & Record<string, unknown>>;
}

export class PiConfigStore implements ConfigStore {
  constructor(private readonly agentDir: string = defaultAgentDir()) {}

  /** Whitelist is the security boundary — nothing outside it is reachable. */
  private fileNames(scope: ConfigScope): string[] {
    return scope.kind === "global" ? GLOBAL_FILES : PROJECT_FILES;
  }

  private filePath(scope: ConfigScope, name: string): string {
    if (!this.fileNames(scope).includes(name)) {
      throw new Error(`not an editable config file: ${name}`);
    }
    return scope.kind === "global" ? join(this.agentDir, name) : join(scope.cwd, name);
  }

  private resourceRoot(scope: ConfigScope, kind: ConfigResourceKind): string {
    return scope.kind === "global"
      ? join(this.agentDir, kind)
      : join(scope.cwd, ".pi", kind);
  }

  async listFiles(scope: ConfigScope): Promise<{ name: string; exists: boolean }[]> {
    return Promise.all(
      this.fileNames(scope).map(async (name) => ({
        name,
        exists: await fs.access(this.filePath(scope, name)).then(() => true, () => false),
      })),
    );
  }

  async readFile(scope: ConfigScope, name: string): Promise<string> {
    const raw = await fs.readFile(this.filePath(scope, name), "utf8").catch(() => "");
    return name === "models.json" ? maskModels(raw) : raw;
  }

  async writeFile(scope: ConfigScope, name: string, content: string): Promise<void> {
    const path = this.filePath(scope, name);
    const data =
      name === "models.json"
        ? unmaskModels(content, await fs.readFile(path, "utf8").catch(() => ""))
        : content;
    await fs.mkdir(scope.kind === "global" ? this.agentDir : scope.cwd, { recursive: true });
    await fs.writeFile(path, data);
  }

  async listResources(scope: ConfigScope): Promise<Record<ConfigResourceKind, ConfigResource[]>> {
    return {
      extensions: await listDir(this.resourceRoot(scope, "extensions")),
      skills: await listDir(this.resourceRoot(scope, "skills")),
    };
  }

  async readResource(scope: ConfigScope, kind: ConfigResourceKind, name: string): Promise<string> {
    const root = this.resourceRoot(scope, kind);
    const path = resolve(root, name);
    // Containment check — the listing is relative paths, reject anything else.
    if (!path.startsWith(root + sep)) throw new Error(`invalid resource path: ${name}`);
    return fs.readFile(path, "utf8");
  }
}

/**
 * Relative paths of all files under root, bounded depth, sorted; [] if absent.
 * Symlinks are followed (skills and extensions are routinely linked in from a
 * checkout elsewhere) and everything reached through one is flagged, so the UI
 * can say where it really came from. The depth bound is also the cycle guard.
 */
async function listDir(
  root: string,
  prefix = "",
  depth = RESOURCE_DEPTH,
  linked = false,
): Promise<ConfigResource[]> {
  if (depth === 0) return [];
  const entries = await fs.readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const out: ConfigResource[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const link = linked || e.isSymbolicLink();
    // A Dirent for a symlink is neither file nor directory — stat through it.
    const target = e.isSymbolicLink()
      ? await fs.stat(join(root, rel)).catch(() => null) // dangling link → skip
      : e;
    if (target?.isDirectory()) out.push(...(await listDir(root, rel, depth - 1, link)));
    else if (target?.isFile()) out.push({ name: rel, link });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * models.json carries provider API keys — the UI must never see them. A file
 * that fails to parse is passed through untouched: the user needs to see the
 * broken content to repair it, and the keys in it are their own.
 */
function maskModels(raw: string): string {
  const parsed = parseModels(raw);
  if (!parsed) return raw;
  for (const p of Object.values(parsed.providers ?? {})) {
    if (typeof p.apiKey === "string" && p.apiKey) p.apiKey = maskKey(p.apiKey);
  }
  return JSON.stringify(parsed, null, 2);
}

/** Restore stored keys wherever the incoming value is still the mask. */
function unmaskModels(content: string, currentRaw: string): string {
  const incoming = parseModels(content);
  if (!incoming) throw new Error("models.json must be valid JSON");
  const current = parseModels(currentRaw);
  for (const [name, p] of Object.entries(incoming.providers ?? {})) {
    const stored = current?.providers?.[name]?.apiKey;
    if (
      typeof p.apiKey === "string" &&
      typeof stored === "string" &&
      p.apiKey === maskKey(stored)
    ) {
      p.apiKey = stored;
    }
  }
  return JSON.stringify(incoming, null, 2);
}

function parseModels(raw: string): ModelsJson | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ModelsJson) : null;
  } catch {
    return null;
  }
}
