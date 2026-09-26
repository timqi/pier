// The Pi-config seams the Console asks agent/ for, declared by the side that
// answers them. Imports no SDK and no node:* — web/ui bundles it type-only —
// so any area may import it; keep it implementable over RPC.

import type { ModelRef, ThinkingLevel } from "../core/types.js";

/** Where agent configuration lives: Pi's global dir or a project checkout. */
export type ConfigScope = { kind: "global" } | { kind: "project"; cwd: string };

/** One whitelisted agent file. `readonly` marks the file Pier itself writes:
 *  the Console shows it and offers no editor. */
export interface ConfigFile {
  name: string;
  exists: boolean;
  readonly: boolean;
}

/** The two settings.json keys that are a deployment decision rather than a
 *  machine one: the model a new session starts on when its caller names none,
 *  and its reasoning effort. `null` is "Pi's own default". */
export interface AgentDefaults {
  defaultModel: ModelRef | null;
  defaultThinkingLevel: ThinkingLevel | null;
}

/** What a switch that installs something knows about the thing on disk. */
export interface CatalogBinary {
  /** The `spec = "…"` line of its ubix block. */
  spec: string;
  /** Installed *and* present on disk. A binary the installer records and the
   *  filesystem no longer has is broken, and says so in `error`. */
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Why the state above is not what it should be, when it is not. */
  error: string | null;
}

/**
 * One command-line tool the Console can switch on, installed by ubix into
 * Pier's own bin (src/tools.ts). Its switch is an instance setting, not a file.
 */
export interface CatalogEntry {
  name: string;
  summary: string;
  enabled: boolean;
  binary: CatalogBinary;
  /** A block the operator wrote themselves, and may remove again. */
  custom?: boolean;
}

/**
 * Console ↔ agent-config seam: whitelisted file editing. Changes apply to
 * sessions created afterwards — Pi reads these files at session start, never
 * mid-run.
 */
export interface ConfigStore {
  /** The scope's files (fixed whitelist; missing files included). */
  listFiles(scope: ConfigScope): Promise<ConfigFile[]>;
  /** Whitelisted file content, "" if absent. Secrets arrive masked. */
  readFile(scope: ConfigScope, name: string): Promise<string>;
  /** Compare-and-write when `expected` is present; unchanged masks restore
   *  stored secrets. Refused for a `readonly` file. */
  writeFile(scope: ConfigScope, name: string, content: string, expected?: string): Promise<void>;
  /** The global settings.json defaults; the model pair is written whole or not
   *  at all, and every other key in the file is left as it is. */
  readDefaults(): Promise<AgentDefaults>;
  writeDefaults(defaults: AgentDefaults): Promise<void>;
  /** Absolute path of the global scope's directory — the UI shows where
   *  "Global" actually lives, which moves with PIER_HOME. */
  readonly globalDir: string;
}

/** `pier` is the built-in package (bundled extensions, Pier's own skills);
 *  `local` is the agent dir's own `extensions/` and `skills/`; the rest are
 *  Pi's three source syntaxes. */
export type PackageKind = "pier" | "local" | "npm" | "git" | "path";
export type PackageScope = "global" | "project";
export type PackageResourceKind = "extension" | "skill";

/** One extension or skill a package provides, with its one switch. */
export interface PackageResource {
  kind: PackageResourceKind;
  name: string;
  /** The file Pi loads; `<inline:name>` for a bundled extension, which is no file. */
  path: string;
  /** What the switch says. What the runtime did with it is `state`. */
  enabled: boolean;
  /** The one line a row shows instead of a plain switch reading (`installed
   *  by the rtk tool`, `not loaded — <why>`), or null. */
  state: string | null;
  /** The switch is another surface's (rtk.ts: the rtk tool's, under Tools);
   *  drawn disabled, `state` names whose. */
  locked?: boolean;
}

/** One row of the registry: a source and what it provides. */
export interface Package {
  source: string;
  kind: PackageKind;
  scope: PackageScope;
  version: string | null;
  /** null: configured but not on disk (`pier` and `local` always are). */
  installedPath: string | null;
  updateAvailable: boolean;
  resources: PackageResource[];
}

export interface PackageRegistry {
  packages: Package[];
  /** When updates were last checked; null before the first check. */
  checkedAt: string | null;
  /** The source an install, remove or update is running for; null when idle. */
  busy: string | null;
}

/** One switch: the resource is named by its package and path, as `list` gave them. */
export interface PackageSwitch {
  source: string;
  kind: PackageResourceKind;
  path: string;
  enabled: boolean;
  /** Write the override into this project's `.pi/settings.json` instead of the global file. */
  cwd?: string;
}

/** `busy`: another operation runs. `refused`: the operation makes no sense for
 *  this source (a built-in, a pinned version). `missing`: no such package or
 *  resource. `invalid`: the request or settings.json cannot be read as asked.
 *  `unreachable`: a registry or remote did not answer, or npm, git or Pi's
 *  manifest refused the install, remove or update. */
export type PackageErrorReason = "busy" | "refused" | "missing" | "invalid" | "unreachable";

export class PackageError extends Error {
  constructor(readonly reason: PackageErrorReason, message: string) {
    super(message);
  }
}

/**
 * Console ↔ Pi's package registry: one list of everything a session loads, and
 * the operations that change it. Install, remove and update work the global
 * scope only, one at a time; a project (`cwd`) is a view plus its switches.
 * Changes reach sessions opened afterwards. Must stay implementable over RPC.
 */
export interface PackageStore {
  /** Every package with its resources; with `cwd`, the project scope's rows too. */
  list(cwd?: string): Promise<PackageRegistry>;
  /** Install into the global scope and record it; resolves with the new row. */
  install(source: string): Promise<Package>;
  remove(source: string): Promise<void>;
  /** One source, or every unpinned npm/git package when none is named; the rows touched. */
  update(source?: string): Promise<Package[]>;
  /** Flip one resource; answers the resource as `list` would now show it. */
  setEnabled(change: PackageSwitch): Promise<PackageResource>;
  /** Ask registries and remotes now; the answer is cached for `list`. */
  checkUpdates(): Promise<PackageRegistry>;
}

export type ProviderAuthType = "api_key" | "oauth";
// Wire-protocol names, not SDK types — but they are pi-ai's spellings, and a
// non-Pi backend is bound to them by this seam.
const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ProviderApi = typeof PROVIDER_APIS[number];
export const isProviderApi = (value: unknown): value is ProviderApi =>
  typeof value === "string" && (PROVIDER_APIS as readonly string[]).includes(value);

/** How far a model's reasoning goes. Every reasoning model offers up to
 *  "high"; the two levels above it exist only for a model whose catalog entry
 *  says so, which is the one thing a Console-defined model could not say. */
export const MODEL_EFFORTS = ["high", "xhigh", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** What a surface may declare about one model of a custom provider. */
export interface ModelCapability {
  id: string;
  reasoning: boolean;
  /** Absent = up to "high", the level every reasoning model has. */
  effort?: ModelEffort;
}

export type ProviderSetup =
  | { kind: "builtin"; id: string; endpoint?: string }
  | {
      kind: "custom";
      id: string;
      name?: string;
      endpoint: string;
      api: ProviderApi;
      models: ModelCapability[];
    };

/** The rules of the ProviderSetup seam, in one place: agent/ enforces them on
 *  write and web/ pre-checks them at its HTTP boundary. Throws the message the
 *  surface shows. */
export function validateProviderSetup(input: ProviderSetup): void {
  if (input.id.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) {
    throw new Error("invalid provider id");
  }
  if (input.endpoint) {
    if (input.endpoint.length > 2048 || input.endpoint !== input.endpoint.trim()) {
      throw new Error("invalid endpoint");
    }
    validateEndpoint(input.endpoint);
  }
  if (input.kind === "builtin") return;
  if (!input.endpoint) throw new Error("custom provider endpoint required");
  if (input.name && (input.name.length > 200 || input.name !== input.name.trim())) {
    throw new Error("invalid provider name");
  }
  if (!isProviderApi(input.api)) throw new Error("unsupported provider API");
  if (!input.models.length || input.models.length > 100) throw new Error("1-100 models required");
  const ids = input.models.map((model) => model.id);
  if (ids.some((id) => !id || id.length > 200 || id !== id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("model ids must be non-empty, trimmed and unique");
  }
  // An effort ceiling on a model that does not reason would be written into
  // the catalog and never offered — a setting that lies about itself.
  if (input.models.some((model) => model.effort !== undefined && !model.reasoning)) {
    throw new Error("effort requires reasoning");
  }
  if (input.models.some((model) => model.effort !== undefined && !MODEL_EFFORTS.includes(model.effort))) {
    throw new Error("unsupported model effort");
  }
}

export function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("endpoint must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("endpoint must be an http(s) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint must not contain credentials, query or fragment");
  }
}

export type ProviderAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
);

export type ProviderAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface ProviderInfo {
  id: string;
  name: string;
  builtin: boolean;
  methods: { type: ProviderAuthType; name: string; subscription?: boolean }[];
  configured: boolean;
  source?: string;
  stored?: ProviderAuthType;
  endpoint?: string;
  api?: ProviderApi;
  models?: ModelCapability[];
}

/**
 * What one probe of a provider answers. Deliberately not part of
 * `ProviderInfo` and stored nowhere: `configured` means a credential exists,
 * this means the endpoint, the credential and a model id actually work
 * together — and that is a fact about a moment, not a state.
 *
 * `request` and `response` are the probe's whole point: a refusal is only
 * useful next to what provoked it, and a proxy in the path can change either.
 * Both are verbatim and both are shown.
 */
export interface ProviderCheck {
  ok: boolean;
  model: string;
  ms: number;
  /** The request body as the provider received it, "" if none was sent. */
  request: string;
  /** The answer's text when there was one, otherwise the refusal verbatim. */
  response: string;
}

/** The slice of a Pi model `websearch/` reads; structural, so Pi's
 *  `ModelRegistry` is handed in as is and the area imports no SDK. */
export interface RegistryModel {
  id: string;
  provider: string;
  api: string;
  baseUrl?: string;
  headers?: unknown;
  maxTokens?: number;
}

export type RequestAuth =
  | { ok: true; apiKey?: string; headers?: unknown; baseUrl?: string }
  | { ok: false; error: string };

/** What `pier web` searches with: the instance's model auth, and the caller's
 *  active model as a candidate when it is on the backend's API. */
export interface WebContext {
  modelRegistry: {
    getAll(): readonly RegistryModel[];
    hasConfiguredAuth(model: RegistryModel): boolean;
    getApiKeyAndHeaders(model: RegistryModel): Promise<RequestAuth>;
  };
  model?: RegistryModel;
}

/** websearch/ ↔ Pi auth seam for `pier web`: the instance's model auth as
 *  `websearch/` reads it, the caller's active model included when given. */
export interface WebAuth {
  webContext(active?: ModelRef): Promise<WebContext>;
}

/** Console ↔ Pi provider seam: structural setup plus provider-owned auth flows. */
export interface ProviderManager {
  providers(): Promise<ProviderInfo[]>;
  setup(input: ProviderSetup): Promise<void>;
  /** One real request against the provider, on the model the operator picked
   *  — nothing here chooses one, because a probe that answers about a model
   *  nobody named answers nothing. Answers rather than throws: "it does not
   *  work, and here is what it said" is the result, not an exception. */
  check(providerId: string, modelId: string): Promise<ProviderCheck>;
  /** Returns a compare-and-restore action until the caller commits setup. */
  login(
    providerId: string,
    type: ProviderAuthType,
    interaction: {
      signal: AbortSignal;
      prompt(prompt: ProviderAuthPrompt): Promise<string>;
      notify(event: ProviderAuthEvent): void;
    },
  ): Promise<() => Promise<void>>;
  logout(providerId: string): Promise<void>;
}

/** One models.json provider with its credentials and endpoints removed; the
 * remaining metadata is Pi's to validate, so this seam does not restate it. */
export type SyncProvider = Record<string, unknown>;

export interface AgentConfigSnapshot {
  files: { "SYSTEM.md": string | null; "AGENTS.md": string | null };
  providers: Record<string, SyncProvider>;
  /** The model a session starts on when its caller names none — the one field
   *  of Pi's settings.json that is a deployment decision rather than a machine
   *  one. `null` is "the source has no default"; absent is a source that
   *  predates the field, and the local default stands. */
  defaultModel?: ModelRef | null;
  /** The reasoning effort such a session starts on — the same deployment
   *  decision, one settings.json field over; `null` and absent read as they
   *  do for defaultModel. */
  defaultThinkingLevel?: ThinkingLevel | null;
}

/** Global portable config only; apply holds the config write lock through commit. */
export interface AgentConfigSync {
  exportSnapshot(): Promise<AgentConfigSnapshot>;
  /** Restores files if a write or commit throws; commit receives whether files changed. */
  applySnapshot(snapshot: AgentConfigSnapshot, commit?: (changed: boolean) => void): Promise<void>;
}
