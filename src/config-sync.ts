// One serialized configuration subscriber, shared by Settings and the hourly
// task. The source is the authority: what it publishes replaces the local copy
// of every field the document carries, and a source on another schema version
// pauses the subscription rather than being merged. Fetched over HTTPS only,
// redirects followed while they stay HTTPS, JSON capped at 1 MiB so a hostile
// or broken source cannot exhaust memory.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentConfigSnapshot, AgentConfigSync } from "./agent/types.js";
import { transact } from "./db.js";
import { logger } from "./log.js";
import { parseModelMenu, type ModelMenuEntry, type SettingsStore } from "./settings.js";
import type { ConfigSyncStatus } from "./web/types.js";

const log = logger("config-sync");

export const CONFIG_SYNC_BYTES = 1024 * 1024;
/** Bumped by any change to the document's shape — a menu row's fields, the
 *  snapshot's, the envelope's. A subscriber applies its own version and
 *  nothing else: no field-level compatibility, the older instance upgrades. */
export const CONFIG_SCHEMA_VERSION = 2;
const MAX_REDIRECTS = 5;

class SchemaMismatch extends Error {
  constructor(published: unknown) {
    super(`Source publishes configuration schema ${typeof published === "number" ? `v${String(published)}` : "of an unknown version"}; `
      + `this Pier reads v${String(CONFIG_SCHEMA_VERSION)} — upgrade the older instance, then resume the subscription`);
  }
}

export function configSourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("A valid HTTPS source URL is required"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || raw.length > 4096) {
    throw new Error("Source must be HTTPS, without credentials or a fragment");
  }
  return url;
}

export async function downloadConfig(raw: string, signal: AbortSignal): Promise<string> {
  let url = configSourceUrl(raw);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", redirect: "manual", signal, headers: { accept: "application/json" } });
    } catch {
      throw new Error(signal.aborted ? "Configuration download timed out or was cancelled" : "Could not connect to source");
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error("Source redirected too many times");
      try { url = configSourceUrl(new URL(location, url).href); }
      catch { throw new Error("Source redirected to a location that is not HTTPS"); }
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Error(res.status === 404 || res.status === 410
        ? "Source link was revoked or does not exist"
        : `Source returned HTTP ${String(res.status)}`);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      throw new Error("Source did not return JSON");
    }
    return read(res, signal);
  }
}

async function read(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof Error && err.message === "Configuration exceeds 1 MiB") throw err;
    throw new Error(signal.aborted ? "Configuration download timed out or was cancelled" : "Configuration download failed");
  }
  return Buffer.concat(chunks).toString("utf8");
}
const KEY = "configSync";
interface Contents { agent: AgentConfigSnapshot; modelMenu: ModelMenuEntry[] }
interface Document extends Contents { schemaVersion: typeof CONFIG_SCHEMA_VERSION; instanceId: string }
interface State {
  instanceId: string;
  token: string | null;
  url: string;
  enabled: boolean;
  lastChecked: number | null;
  lastApplied: number | null;
  error: string | null;
  needsReload: boolean;
}

// Object order is not a change; array order (model menu priority) is.
export function configJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, "en"))) : entry);
}

export class ConfigSync {
  #state: State;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    db: DatabaseSync;
    settings: SettingsStore;
    config: AgentConfigSync;
    normalizeAgent: (raw: unknown) => AgentConfigSnapshot;
    reload: () => Promise<unknown>;
    download?: (url: string, signal: AbortSignal) => Promise<string>;
  }) {
    const row = deps.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    // Field by field: a row an older Pier wrote carries keys this one no longer keeps.
    const stored = row ? JSON.parse(row.value) as Partial<State> : {};
    this.#state = {
      instanceId: stored.instanceId ?? randomUUID(), token: stored.token ?? null, url: stored.url ?? "",
      enabled: stored.enabled ?? false, lastChecked: stored.lastChecked ?? null, lastApplied: stored.lastApplied ?? null,
      error: stored.error ?? null, needsReload: stored.needsReload ?? false,
    };
    if (!row) this.#save();
  }

  #save(patch: Partial<State> = {}): void {
    const next = { ...this.#state, ...patch };
    this.deps.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(KEY, JSON.stringify(next));
    this.#state = next;
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  status(): ConfigSyncStatus {
    const state = this.#state;
    return {
      publishedPath: state.token ? `/config-sync/${state.token}` : null,
      sourceUrl: state.url, enabled: state.enabled,
      lastChecked: state.lastChecked, lastApplied: state.lastApplied,
      error: state.error, needsReload: state.needsReload,
    };
  }

  async #local(): Promise<Contents> {
    return { agent: await this.deps.config.exportSnapshot(), modelMenu: this.deps.settings.get().modelMenu };
  }

  publish(): Promise<ConfigSyncStatus> {
    return this.#exclusive(async () => {
      if (this.#state.enabled) throw new Error("Pause the configuration subscription before publishing a link");
      await this.#local();
      this.#save({ token: randomBytes(32).toString("hex") });
      return this.status();
    });
  }

  revoke(): Promise<ConfigSyncStatus> {
    return this.#exclusive(async () => {
      this.#save({ token: null }); return this.status();
    });
  }

  async published(token: string): Promise<string | null> {
    const expected = this.#state.token;
    if (!expected || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
    const local = await this.#local();
    if (this.#state.token !== expected) return null;
    const document: Document = { schemaVersion: CONFIG_SCHEMA_VERSION, instanceId: this.#state.instanceId, ...local };
    const body = configJson(document);
    if (Buffer.byteLength(body) > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
    return body;
  }

  #parse(raw: string): Contents {
    if (Buffer.byteLength(raw) > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Source returned malformed JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration document");
    const object = value as Record<string, unknown>;
    if (object.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new SchemaMismatch(object.schemaVersion);
    if (Object.keys(object).some((key) => !["schemaVersion", "instanceId", "agent", "modelMenu"].includes(key))) {
      throw new Error("Unexpected configuration fields");
    }
    if (typeof object.instanceId !== "string" || !object.instanceId || object.instanceId.length > 100) throw new Error("Invalid source instance ID");
    if (object.instanceId === this.#state.instanceId) throw new Error("An instance cannot subscribe to itself");
    const modelMenu = parseModelMenu(object.modelMenu);
    if (typeof modelMenu === "string") throw new Error(`Invalid model menu: ${modelMenu}`);
    return { agent: this.deps.normalizeAgent(object.agent), modelMenu };
  }

  subscribe(url: string): Promise<string> {
    return this.#exclusive(async () => {
      if (this.#state.token) throw new Error("Revoke the sharing link before enabling a configuration subscription");
      return this.#sync(url);
    });
  }

  pause(): Promise<ConfigSyncStatus> {
    return this.#exclusive(async () => {
      this.#save({ enabled: false }); return this.status();
    });
  }

  sync(signal?: AbortSignal): Promise<string> {
    return this.#exclusive(() => this.#state.enabled
      ? this.#sync(this.#state.url, signal)
      : Promise.resolve("Configuration subscription is paused"));
  }

  async #sync(rawUrl: string, signal?: AbortSignal): Promise<string> {
    try {
      const url = configSourceUrl(rawUrl).href;
      const timeout = AbortSignal.timeout(15_000);
      const response = await (this.deps.download ?? downloadConfig)(url, signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      const next = this.#parse(response);
      let changed = false;
      const previous = structuredClone(this.#state);
      const commit = (filesChanged: boolean): void => transact(this.deps.db, () => {
        signal?.throwIfAborted();
        const menuChanged = configJson(next.modelMenu) !== configJson(this.deps.settings.get().modelMenu);
        changed = filesChanged || menuChanged;
        if (menuChanged) this.deps.settings.setModelMenu(next.modelMenu);
        this.#save({
          url, enabled: true, lastChecked: Date.now(),
          lastApplied: changed ? Date.now() : previous.lastApplied,
          needsReload: changed || previous.needsReload, error: null,
        });
      });
      try {
        await this.deps.config.applySnapshot(next.agent, commit);
      } catch (err) {
        this.#state = previous;
        throw err;
      }
      if (this.#state.needsReload) {
        try { await this.deps.reload(); }
        catch (cause) { throw new Error("Configuration saved, but reload failed; retry synchronization", { cause }); }
        this.#save({ needsReload: false });
      }
      return changed ? "Configuration applied; reload completed" : "Configuration unchanged";
    } catch (err) {
      const error = err instanceof Error ? err.message : "Configuration sync failed";
      // The message is the operator's; the cause, when there is one, is the log's.
      log.error(error, err instanceof Error ? err.cause : err);
      // A version gap is not retried hourly: the fix is an upgrade, and the
      // notice stands until the operator resumes.
      this.#save({ lastChecked: Date.now(), error, ...(err instanceof SchemaMismatch ? { enabled: false } : {}) });
      throw new Error(error);
    }
  }
}
