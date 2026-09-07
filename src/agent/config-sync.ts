// Credential-blind projection of the portable agent configuration.

import type { AgentConfigSnapshot, SyncModelDefinition } from "../core/types.js";

const MODEL_KEYS = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "api"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

type RecordValue = Record<string, unknown>;
type Providers = Record<string, RecordValue>;

function record(value: unknown, where: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${where} must be an object`);
  }
  return value as RecordValue;
}

function only(value: RecordValue, keys: readonly string[], where: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${where} contains unsupported fields`);
  }
}

function modelDefinition(value: unknown): SyncModelDefinition {
  const model = record(value, "model");
  only(model, MODEL_KEYS, "model");
  if (typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim()) {
    throw new Error("model id must be a non-empty trimmed string");
  }
  if (model.name !== undefined && (typeof model.name !== "string" || !model.name.length)) throw new Error("model name must be a non-empty string");
  if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
    throw new Error("model reasoning must be a boolean");
  }
  if (model.api !== undefined && (typeof model.api !== "string" || !/^[a-z][a-z0-9-]*$/.test(model.api))) {
    throw new Error("model api must be a protocol name");
  }
  if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length ||
      model.input.some((input) => input !== "text" && input !== "image") ||
      new Set(model.input).size !== model.input.length)) {
    throw new Error("model input must contain text or image without duplicates");
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (model[key] !== undefined && (typeof model[key] !== "number" || !Number.isSafeInteger(model[key]) || model[key] <= 0)) {
      throw new Error(`model ${key} must be a positive integer`);
    }
  }
  if (model.cost !== undefined) {
    const cost = record(model.cost, "model cost");
    only(cost, COST_KEYS, "model cost");
    for (const key of COST_KEYS) {
      if (typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || cost[key] < 0) {
        throw new Error(`model cost ${key} must be a non-negative finite number`);
      }
    }
  }
  return structuredClone(model) as unknown as SyncModelDefinition;
}

/** Strict import boundary: unknown fields are rejected, never treated as masked secrets. */
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
  const providers = Object.fromEntries(Object.entries(record(snapshot.providers, "snapshot providers")).map(([id, value]) => {
    if (id.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || ["constructor", "prototype"].includes(id)) {
      throw new Error("invalid snapshot provider id");
    }
    const provider = record(value, "snapshot provider");
    only(provider, ["models"], "snapshot provider");
    if (!Array.isArray(provider.models)) throw new Error("snapshot provider models must be an array");
    const models = provider.models.map(modelDefinition);
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("duplicate model ids");
    return [id, { models }];
  }));
  return { files: { "SYSTEM.md": files["SYSTEM.md"] as string | null, "AGENTS.md": files["AGENTS.md"] as string | null }, providers };
}

/** Project disk metadata before validation, so no nested transport object can escape. */
export function snapshotProviders(providers: Providers = {}): AgentConfigSnapshot["providers"] {
  return Object.fromEntries(Object.entries(providers).flatMap(([id, provider]) => {
    if (provider.models === undefined) return [];
    if (!Array.isArray(provider.models)) throw new Error("models.json models must be an array");
    const models = provider.models.map((value) => {
      const source = record(value, "models.json model");
      const model = Object.fromEntries(MODEL_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
      if (source.cost !== undefined) {
        const cost = record(source.cost, "models.json model cost");
        model.cost = Object.fromEntries(COST_KEYS.flatMap((key) => cost[key] === undefined ? [] : [[key, cost[key]]]));
      }
      return modelDefinition(model);
    });
    return [[id, { models }]];
  }));
}

/** Replace only portable fields, retaining excluded fields for matching local model ids. */
export function mergeSnapshotProviders(local: Providers = {}, incoming: AgentConfigSnapshot["providers"]): Providers {
  const providers = structuredClone(local);
  for (const [id, provider] of Object.entries(providers)) {
    if (!Object.hasOwn(incoming, id)) {
      delete provider.models;
    }
  }
  for (const [id, { models }] of Object.entries(incoming)) {
    if (!Object.hasOwn(local, id)) {
      throw new Error(`provider ${id} must be configured locally before importing models`);
    }
    const provider = providers[id]!;
    if (provider.models !== undefined && !Array.isArray(provider.models)) throw new Error("models.json models must be an array");
    const existing = new Map((provider.models as unknown[] | undefined ?? []).map((value) => {
      const model = record(value, "models.json model");
      return [model.id, model];
    }));
    provider.models = models.map((model) => {
      const retained = { ...existing.get(model.id) };
      for (const key of MODEL_KEYS) delete retained[key];
      return { ...retained, ...model };
    });
  }
  return providers;
}
