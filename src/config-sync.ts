// One serialized configuration subscriber, shared by Settings and the hourly
// task. Only a successfully applied response advances its persistent ETag.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentConfigSnapshot, AgentConfigSync } from "./core/types.js";
import { configSourceUrl, CONFIG_SYNC_BYTES, downloadConfig, type ConfigDownload } from "./config-sync-fetch.js";
import { transact } from "./db.js";
import { logger } from "./log.js";
import { normalizeModelMenu, type ModelMenuEntry, type SettingsStore } from "./settings.js";
import type { ConfigSyncStatus } from "./web/types.js";

const log = logger("config-sync");
const KEY = "configSync";
interface Contents { agent: AgentConfigSnapshot; modelMenu: ModelMenuEntry[] }
interface Document extends Contents { schemaVersion: 1; instanceId: string }
interface State {
  instanceId: string;
  token: string | null;
  url: string;
  enabled: boolean;
  etag: string | null;
  appliedHash: string | null;
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
const hash = (value: unknown): string => createHash("sha256").update(configJson(value)).digest("hex");

export class ConfigSync {
  #state: State;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    db: DatabaseSync;
    settings: SettingsStore;
    config: AgentConfigSync;
    normalizeAgent: (raw: unknown) => AgentConfigSnapshot;
    reload: () => Promise<unknown>;
    download?: (url: string, etag: string | null, signal: AbortSignal) => Promise<ConfigDownload>;
  }) {
    const row = deps.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    this.#state = row ? JSON.parse(row.value) as State : {
      instanceId: randomUUID(), token: null, url: "", enabled: false, etag: null,
      appliedHash: null, lastChecked: null, lastApplied: null, error: null, needsReload: false,
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

  async published(token: string): Promise<{ body: string; etag: string } | null> {
    const expected = this.#state.token;
    if (!expected || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
    const local = await this.#local();
    if (this.#state.token !== expected) return null;
    const document: Document = { schemaVersion: 1, instanceId: this.#state.instanceId, ...local };
    const body = configJson(document);
    if (Buffer.byteLength(body) > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
    return { body, etag: `"${hash(document)}"` };
  }

  #parse(raw: string): Contents {
    if (Buffer.byteLength(raw) > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Source returned malformed JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration document");
    const object = value as Record<string, unknown>;
    if (object.schemaVersion !== 1) throw new Error("Unsupported configuration schema version");
    if (Object.keys(object).some((key) => !["schemaVersion", "instanceId", "agent", "modelMenu"].includes(key))) {
      throw new Error("Unexpected configuration fields");
    }
    if (typeof object.instanceId !== "string" || !object.instanceId || object.instanceId.length > 100) throw new Error("Invalid source instance ID");
    if (object.instanceId === this.#state.instanceId) throw new Error("An instance cannot subscribe to itself");
    const modelMenu = normalizeModelMenu(object.modelMenu);
    if (!modelMenu) throw new Error("Invalid model menu");
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
      const local = await this.#local();
      const etag = url === this.#state.url && hash(local) === this.#state.appliedHash ? this.#state.etag : null;
      const timeout = AbortSignal.timeout(15_000);
      const response = await (this.deps.download ?? downloadConfig)(url, etag,
        signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      if (response.status === 304 && !etag) throw new Error("Source returned 304 without a matching local configuration");
      const next = response.status === 304 ? local : this.#parse(response.body);
      let changed = false;
      const previous = structuredClone(this.#state);
      const commit = (filesChanged: boolean): void => transact(this.deps.db, () => {
        signal?.throwIfAborted();
        const menuChanged = configJson(next.modelMenu) !== configJson(this.deps.settings.get().modelMenu);
        changed = filesChanged || menuChanged;
        if (menuChanged) this.deps.settings.setModelMenu(next.modelMenu);
        this.#save({
          url, enabled: true, etag: response.status === 304 ? etag : response.etag,
          appliedHash: hash(next), lastChecked: Date.now(),
          lastApplied: changed ? Date.now() : previous.lastApplied,
          needsReload: changed || previous.needsReload, error: null,
        });
      });
      try {
        // Reconcile under the file lock even on 304: local edits may have
        // completed while the conditional download was in flight.
        await this.deps.config.applySnapshot(next.agent, commit);
      } catch (err) {
        this.#state = previous;
        throw err;
      }
      if (this.#state.needsReload) {
        try { await this.deps.reload(); }
        catch { throw new Error("Configuration saved, but reload failed; retry synchronization"); }
        this.#save({ needsReload: false });
      }
      return changed ? "Configuration applied; reload completed" : `Configuration unchanged (${response.status})`;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Configuration sync failed";
      log.error(error);
      this.#save({ lastChecked: Date.now(), error });
      throw new Error(error);
    }
  }
}
