// Pi configuration on disk, behind the ConfigStore seam. Knows Pi's directory
// conventions (the Pier-managed global dir; <cwd>/AGENTS.md and <cwd>/.pi per
// project) but not the Pi SDK — pure filesystem, unit-testable in a tmp dir.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isProviderApi, validateEndpoint, validateProviderSetup } from "../core/types.js";
import { pierPath } from "../paths.js";
import type {
  ConfigResource,
  ConfigResourceKind,
  ConfigScope,
  ConfigStore,
  ProviderApi,
  ProviderSetup,
} from "../core/types.js";

const GLOBAL_FILES = ["SYSTEM.md", "AGENTS.md", "settings.json", "models.json"];
const PROJECT_FILES = ["AGENTS.md"];
const RESOURCE_DEPTH = 3; // extensions/skills nest at most a couple of levels

/** Pier owns the Pi runtime dir: config lives in the syncable `~/.pier/pi`
 * repo, not `~/.pi`. main.ts exports this as PI_CODING_AGENT_DIR so the SDK's
 * own path resolution (auth.json, sessions, bin) lands in the same place. */
export const defaultAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR ?? pierPath("pi");

/** Stable mask: mapped back by field, without exposing key fragments. */
const maskKey = (_key: string): string => "••••••••";

interface ModelsProvider extends Record<string, unknown> {
  apiKey?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  api?: unknown;
  models?: unknown;
}

interface ModelsJson extends Record<string, unknown> {
  providers?: Record<string, ModelsProvider>;
}

export interface ProviderStructure {
  name?: string;
  endpoint?: string;
  api?: ProviderApi;
  models?: { id: string; reasoning: boolean }[];
}

const missing = (err: unknown): boolean =>
  err instanceof Error && "code" in err && err.code === "ENOENT";

const readOptional = async (path: string): Promise<string> => {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if (missing(err)) return "";
    throw err;
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
};

const atomicWrite = async (path: string, data: string, mode = 0o644): Promise<void> => {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { mode });
    await fs.rename(temp, path);
  } catch (err) {
    try {
      await fs.unlink(temp);
    } catch (cleanup) {
      if (!missing(cleanup)) throw new AggregateError([err, cleanup], `failed to write ${path}`);
    }
    throw err;
  }
};

export class PiConfigStore implements ConfigStore {
  #writes: Promise<void> = Promise.resolve();

  constructor(private readonly agentDir: string = defaultAgentDir()) {}

  get globalDir(): string {
    return this.agentDir;
  }

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
        exists: await pathExists(this.filePath(scope, name)),
      })),
    );
  }

  async readFile(scope: ConfigScope, name: string): Promise<string> {
    const path = this.filePath(scope, name);
    await this.#writes;
    const raw = await readOptional(path);
    return name === "models.json" ? maskModels(raw) : raw;
  }

  async writeFile(scope: ConfigScope, name: string, content: string, expected?: string): Promise<void> {
    const path = this.filePath(scope, name);
    return this.#withWrite(async () => {
      const current = await readOptional(path);
      const visible = name === "models.json" ? maskModels(current) : current;
      if (expected !== undefined && visible !== expected) throw new Error(`${name} changed on disk; reopen it`);
      const data = name === "models.json" ? unmaskModels(content, current) : content;
      await fs.mkdir(scope.kind === "global" ? this.agentDir : scope.cwd, { recursive: true });
      await atomicWrite(path, data, name === "models.json" ? 0o600 : 0o644);
    });
  }

  async providerStructures(): Promise<Record<string, ProviderStructure>> {
    await this.#writes;
    const raw = await readOptional(join(this.agentDir, "models.json"));
    const parsed = parseModels(raw);
    const out: Record<string, ProviderStructure> = {};
    for (const [id, provider] of Object.entries(parsed?.providers ?? {})) {
      const api = isProviderApi(provider.api) ? provider.api : undefined;
      const endpoint = typeof provider.baseUrl === "string" ? provider.baseUrl : undefined;
      if (endpoint) validateEndpoint(endpoint);
      const models = Array.isArray(provider.models)
        ? provider.models.flatMap((model) => {
            if (typeof model !== "object" || model === null || typeof (model as { id?: unknown }).id !== "string") {
              return [];
            }
            return [{
              id: (model as { id: string }).id,
              reasoning: (model as { reasoning?: unknown }).reasoning === true,
            }];
          })
        : undefined;
      out[id] = {
        ...(typeof provider.name === "string" ? { name: provider.name } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(api ? { api } : {}),
        ...(models ? { models } : {}),
      };
    }
    return out;
  }

  async setupProvider(input: ProviderSetup, verify?: () => Promise<void>): Promise<void> {
    validateProviderSetup(input);
    await this.#withWrite(async () => {
      const path = join(this.agentDir, "models.json");
      const existed = await pathExists(path);
      const raw = await readOptional(path);
      const parsed = raw.trim() ? parseModels(raw) : {};
      if (!parsed) throw new Error("models.json must be valid JSON before configuring a provider");
      const providers = { ...parsed.providers };
      const current = { ...providers[input.id] };
      if (input.kind === "builtin") {
        if (input.endpoint) current.baseUrl = input.endpoint;
        else delete current.baseUrl;
      } else {
        if (input.name) current.name = input.name;
        else delete current.name;
        current.baseUrl = input.endpoint;
        current.api = input.api;
        const existingModels = Array.isArray(current.models) ? current.models : [];
        current.models = input.models.map((model) => {
          const existing = existingModels.find((candidate) =>
            typeof candidate === "object" && candidate !== null &&
            (candidate as { id?: unknown }).id === model.id
          );
          const next: Record<string, unknown> = {
            ...(existing as Record<string, unknown> | undefined), id: model.id,
          };
          if (model.reasoning) next.reasoning = true;
          else delete next.reasoning;
          return next;
        });
      }
      if (Object.keys(current).length) providers[input.id] = current;
      else delete providers[input.id];
      const candidate = `${JSON.stringify({ ...parsed, providers }, null, 2)}\n`;
      await fs.mkdir(this.agentDir, { recursive: true });
      await atomicWrite(path, candidate, 0o600);
      try {
        await verify?.();
      } catch (err) {
        // Decided outside the restore try: a concurrent edit is not a failed
        // restore, and must not be reported as one.
        if (await readOptional(path) !== candidate) {
          throw new Error(`${path} changed while provider setup was being validated`, { cause: err });
        }
        try {
          if (existed) await atomicWrite(path, raw, 0o600);
          else await fs.unlink(path);
        } catch (rollback) {
          throw new AggregateError([err, rollback], `failed to restore ${path}`);
        }
        throw err;
      }
    });
  }

  #withWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(write);
    this.#writes = result.then(() => undefined, () => undefined);
    return result;
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

/** models.json may contain legacy keys and literal headers. Only stable
 * masks cross the HTTP seam; malformed content must be repaired on disk. */
function maskModels(raw: string): string {
  if (!raw.trim()) return "";
  const parsed = parseModels(raw);
  if (!parsed) throw new Error("models.json must be valid JSON; repair it on disk");
  for (const provider of Object.values(parsed.providers ?? {})) {
    validateBaseUrl(provider);
    if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
      throw new Error("models.json apiKey must be a string");
    }
    if (provider.apiKey) provider.apiKey = maskKey(provider.apiKey);
    maskHeaders(provider);
    for (const model of modelRecords(provider)) {
      validateBaseUrl(model);
      maskHeaders(model);
    }
    for (const override of overrideRecords(provider)) maskHeaders(override);
  }
  return JSON.stringify(parsed, null, 2);
}

/** Restore stored secrets wherever the incoming value is still its mask. */
function unmaskModels(content: string, currentRaw: string): string {
  const incoming = parseModels(content);
  if (!incoming) throw new Error("models.json must be valid JSON");
  const current = parseModels(currentRaw);
  for (const [name, provider] of Object.entries(incoming.providers ?? {})) {
    validateBaseUrl(provider);
    const stored = current?.providers?.[name];
    if (provider.apiKey !== undefined) {
      if (
        typeof provider.apiKey !== "string" || typeof stored?.apiKey !== "string" ||
        provider.apiKey !== maskKey(stored.apiKey)
      ) {
        throw new Error("API keys must be configured under Providers");
      }
      provider.apiKey = stored.apiKey;
    }
    restoreHeaders(provider, stored);
    const storedModels = new Map(modelRecords(stored).flatMap((model) =>
      typeof model.id === "string" ? [[model.id, model] as const] : []
    ));
    for (const model of modelRecords(provider)) {
      validateBaseUrl(model);
      restoreHeaders(model, typeof model.id === "string" ? storedModels.get(model.id) : undefined);
    }
    const storedOverrides = asRecord(stored?.modelOverrides);
    for (const [id, override] of overrideRecords(provider, true)) {
      restoreHeaders(override, asRecord(storedOverrides?.[id]));
    }
  }
  return JSON.stringify(incoming, null, 2);
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function modelRecords(provider: ModelsProvider | undefined): Record<string, unknown>[] {
  if (provider?.models === undefined) return [];
  if (!Array.isArray(provider.models)) throw new Error("models.json models must be an array");
  return provider.models.map((model) => {
    const record = asRecord(model);
    if (!record) throw new Error("models.json models must contain objects");
    return record;
  });
}

function overrideRecords(provider: ModelsProvider, entries: true): [string, Record<string, unknown>][];
function overrideRecords(provider: ModelsProvider, entries?: false): Record<string, unknown>[];
function overrideRecords(
  provider: ModelsProvider,
  entries = false,
): Record<string, unknown>[] | [string, Record<string, unknown>][] {
  if (provider.modelOverrides === undefined) return [];
  const overrides = asRecord(provider.modelOverrides);
  if (!overrides) throw new Error("models.json modelOverrides must be an object");
  const records = Object.entries(overrides).map(([id, value]) => {
    const record = asRecord(value);
    if (!record) throw new Error("models.json modelOverrides must contain objects");
    return [id, record] as [string, Record<string, unknown>];
  });
  return entries ? records : records.map(([, record]) => record);
}

function validateBaseUrl(owner: Record<string, unknown>): void {
  if (owner.baseUrl === undefined) return;
  if (typeof owner.baseUrl !== "string") throw new Error("models.json baseUrl must be a string");
  validateEndpoint(owner.baseUrl);
}

function maskHeaders(owner: Record<string, unknown>): void {
  if (owner.headers === undefined) return;
  const headers = asRecord(owner.headers);
  if (!headers || Object.values(headers).some((value) => typeof value !== "string")) {
    throw new Error("models.json headers must contain string values");
  }
  for (const [name, value] of Object.entries(headers)) headers[name] = maskKey(value as string);
}

function restoreHeaders(
  incoming: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): void {
  if (incoming.headers === undefined) return;
  const headers = asRecord(incoming.headers);
  const stored = asRecord(current?.headers);
  if (!headers || !stored) throw new Error("Header values must be configured on disk");
  for (const [name, value] of Object.entries(headers)) {
    const original = stored[name];
    if (typeof value !== "string" || typeof original !== "string" || value !== maskKey(original)) {
      throw new Error("Header values must be configured on disk");
    }
    headers[name] = original;
  }
}

function parseModels(raw: string): ModelsJson | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const providers = (parsed as { providers?: unknown }).providers;
    if (providers !== undefined) {
      if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return null;
      if (Object.values(providers).some((provider) =>
        typeof provider !== "object" || provider === null || Array.isArray(provider)
      )) return null;
    }
    return parsed as ModelsJson;
  } catch {
    return null;
  }
}
