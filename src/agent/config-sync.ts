// Credential-blind projection of the portable agent configuration.

import type { AgentConfigSnapshot, SyncProvider } from "../core/types.js";

/** Never leaves the instance, at any depth of a models.json provider: the
 *  credentials, and the endpoint they authenticate against — a sharing link is
 *  public. Every other field is metadata Pi's own schema already validates, so
 *  it travels as-is instead of through a field list chasing Pi's versions. */
const PRIVATE_KEYS = ["apiKey", "headers", "baseUrl"];
/** The catalog is the part of a provider sync owns outright: absent on the
 *  source means deleted here, while a field the source never states stays. */
const CATALOG_KEYS = ["models", "modelOverrides"];
/** Dropped strings shorter than this ("", "Bearer") collide with legitimate
 *  metadata; a credential or an endpoint does not. */
const SECRET_CHARS = 8;

type RecordValue = Record<string, unknown>;
type Providers = Record<string, RecordValue>;
type OnPrivate = (key: string, value: unknown) => void;

const asRecord = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

function record(value: unknown, where: string): RecordValue {
  const plain = asRecord(value);
  if (!plain || ![Object.prototype, null].includes(Object.getPrototypeOf(plain))) {
    throw new Error(`${where} must be an object`);
  }
  return plain;
}

function only(value: RecordValue, keys: readonly string[], where: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${where} contains unsupported fields`);
  }
}

/** Every string in a JSON value, so one containment test covers the whole
 *  projection however deeply Pi nests a future field. */
function strings(value: unknown, found: string[] = []): string[] {
  const nested = asRecord(value);
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, found);
  else if (nested) for (const entry of Object.values(nested)) strings(entry, found);
  return found;
}

/** Deep copy of JSON-only data; the private fields are dropped and handed to
 *  `onPrivate` — collected on the way out, refused on the way in. */
function project(value: unknown, where: string, onPrivate: OnPrivate): unknown {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => project(entry, where, onPrivate));
  return Object.fromEntries(Object.entries(record(value, where)).flatMap(([key, entry]) => {
    if (PRIVATE_KEYS.includes(key)) { onPrivate(key, entry); return []; }
    return [[key, project(entry, `${where} ${key}`, onPrivate)]];
  }));
}

/** The shape both sides must agree on: a provider id that cannot address
 *  anything but its own record, and a catalog addressable by model id. */
function portable(id: string, value: unknown, onPrivate: OnPrivate): SyncProvider {
  if (id.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || ["constructor", "prototype"].includes(id)) {
    throw new Error("invalid snapshot provider id");
  }
  const provider = record(project(value, `provider ${id}`, onPrivate), `provider ${id}`);
  const models = provider.models ?? [];
  if (!Array.isArray(models)) throw new Error("models must be an array");
  const ids = models.map((model) => record(model, "model").id);
  if (ids.some((modelId) => typeof modelId !== "string" || !modelId.trim() || modelId !== modelId.trim())) {
    throw new Error("model id must be a non-empty trimmed string");
  }
  if (new Set(ids).size !== ids.length) throw new Error("duplicate model ids");
  const overrides = provider.modelOverrides ?? {};
  for (const [overrideId, override] of Object.entries(record(overrides, "modelOverrides"))) {
    record(override, `modelOverrides ${overrideId}`);
  }
  return provider;
}

/** Project disk metadata before validation, then fail closed if anything the
 *  projection removed still appears in it: a deny list cannot foresee the field
 *  Pi adds next, but it can refuse to publish a value it just dropped. */
export function snapshotProviders(providers: Providers = {}): AgentConfigSnapshot["providers"] {
  const dropped: string[] = [];
  const shared = Object.fromEntries(Object.entries(providers).flatMap(([id, provider]) => {
    const value = portable(id, provider, (_key, entry) => {
      dropped.push(...strings(entry).filter((secret) => secret.length >= SECRET_CHARS));
    });
    return Object.keys(value).length ? [[id, value]] : [];
  }));
  const exported = strings(shared);
  if (dropped.some((secret) => exported.some((value) => value.includes(secret)))) {
    throw new Error("models.json repeats a credential or endpoint in a shared field; remove it before sharing");
  }
  return shared;
}

/** Strict import boundary: a source that states a private field is refused,
 *  never trusted as a mask over the local one. */
export function normalizeAgentSnapshot(raw: unknown): AgentConfigSnapshot {
  const snapshot = record(raw, "agent snapshot");
  only(snapshot, ["files", "providers"], "agent snapshot");
  const files = record(snapshot.files, "snapshot files");
  only(files, ["SYSTEM.md", "AGENTS.md"], "snapshot files");
  for (const name of ["SYSTEM.md", "AGENTS.md"] as const) {
    if (files[name] !== null && typeof files[name] !== "string") {
      throw new Error(`${name} must be a string or null`);
    }
  }
  const providers = Object.fromEntries(Object.entries(record(snapshot.providers, "snapshot providers"))
    .map(([id, provider]) => [id, portable(id, provider, (key) => {
      throw new Error(`snapshot provider must not carry ${key}`);
    })]));
  return {
    files: { "SYSTEM.md": files["SYSTEM.md"] as string | null, "AGENTS.md": files["AGENTS.md"] as string | null },
    providers,
  };
}

/** A model or override arrives whole; only the local private fields survive it. */
function withLocalPrivate(incoming: RecordValue, local: RecordValue | undefined): RecordValue {
  const merged = { ...incoming };
  for (const key of PRIVATE_KEYS) if (local && Object.hasOwn(local, key)) merged[key] = local[key];
  return merged;
}

const modelsById = (models: unknown): Map<unknown, RecordValue> =>
  new Map((Array.isArray(models) ? models : []).flatMap((model) => {
    const value = asRecord(model);
    return value ? [[value.id, value] as const] : [];
  }));

/** The source sets what it states and replaces the catalog; credentials and
 *  endpoints stay local, matched by provider, model id and override id. */
export function mergeSnapshotProviders(local: Providers = {}, incoming: AgentConfigSnapshot["providers"]): Providers {
  for (const id of Object.keys(incoming)) {
    if (!Object.hasOwn(local, id)) throw new Error(`provider ${id} must be configured locally before importing models`);
  }
  return Object.fromEntries(Object.entries(local).map(([id, provider]) => {
    const current = record(provider, "models.json provider");
    const source = incoming[id];
    if (!source) return [id, Object.fromEntries(Object.entries(current).filter(([key]) => !CATALOG_KEYS.includes(key)))];
    // The catalog shapes are the ones normalizeAgentSnapshot already proved.
    const merged: RecordValue = { ...current, ...structuredClone(source) };
    for (const key of CATALOG_KEYS) if (!Object.hasOwn(source, key)) delete merged[key];
    if (merged.models !== undefined) {
      const previous = modelsById(current.models);
      merged.models = (merged.models as RecordValue[]).map((model) => withLocalPrivate(model, previous.get(model.id)));
    }
    if (merged.modelOverrides !== undefined) {
      const previous = asRecord(current.modelOverrides) ?? {};
      merged.modelOverrides = Object.fromEntries(Object.entries(merged.modelOverrides as Record<string, RecordValue>)
        .map(([key, override]) => [key, withLocalPrivate(override, asRecord(previous[key]))]));
    }
    return [id, merged];
  }));
}
