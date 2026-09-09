// Instance settings: the facts about *this* Pier that are neither a credential
// nor per-session. A key-value table, so the next setting is not the next table.

import type { DatabaseSync } from "node:sqlite";
import { isThinkingLevel, type ModelRef, type ThinkingLevel } from "./core/types.js";
import { pierDb, transact } from "./db.js";
import { logger } from "./log.js";
import { normalizeCustomTools, type CustomTool } from "./tools.js";

const log = logger("settings");

/** One operator-pinned model: what to reach for, and one line of why. */
export interface ModelMenuEntry {
  provider: string;
  id: string;
  /** Advice, not a lock — but never absent: a pin with no level is a third
   *  state every picker would need a fallback for. */
  thinking: ThinkingLevel;
  /** Intent, not documentation — "hardest reasoning", "cheap bulk". */
  note?: string;
}

export interface Settings {
  /** Origin plus path prefix, no trailing slash; nothing in the process can
   *  discover it (a Host header is whatever a proxy passed on). Empty when unset. */
  publicUrl: string;
  /** Pinned models with one line of intent each; empty falls back to the catalog. */
  modelMenu: ModelMenuEntry[];
  /** Names a session after its first exchange. Unset: the title is the first
   *  prompt and no call is made. */
  titleModel?: ModelRef;
  /** Off by default: replacing your own code is the operator's decision. */
  autoUpdate: boolean;
  /** Bundled extensions switched on (src/extensions); an unknown name is simply not found. */
  extensions: string[];
  /** Managed CLI tools switched on (src/tools.ts). */
  tools: string[];
  /** Beside the enabled set, not inside it: a tool switched off must not lose its spec. */
  customTools: CustomTool[];
}

/** `""` clears it, `null` rejects it: a mistyped host quietly turned into a URL
 *  produces board links that 404 for the person they were sent to. */
export function normalizePublicUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Rejecting rather than repairing: a "fixed" entry would advertise a model the
 *  operator never picked. Notes are capped; every session pays for their tokens. */
export function normalizeModelMenu(raw: unknown): ModelMenuEntry[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null;
  const menu: ModelMenuEntry[] = [];
  for (const item of raw) {
    const ref = normalizeModelRef(item);
    if (!ref) return null;
    const { thinking, note } = item as Record<string, unknown>;
    // Repaired, not rejected: rows stored before the level was required have
    // none, and dropping the menu over it would lose the pins.
    const level = thinking === undefined ? "medium" : thinking;
    if (!isThinkingLevel(level)) return null;
    if (note !== undefined && typeof note !== "string") return null;
    const cleaned = note?.trim().slice(0, 200);
    menu.push({
      ...ref,
      thinking: level,
      ...(cleaned ? { note: cleaned } : {}),
    });
  }
  return menu;
}

/** Existence is not checked: the catalog is the agent's, and a model that went
 *  away is reported by the call that fails. */
export function normalizeModelRef(raw: unknown): ModelRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { provider, id } = raw as Record<string, unknown>;
  if (typeof provider !== "string" || !provider.trim()) return null;
  if (typeof id !== "string" || !id.trim()) return null;
  return { provider: provider.trim(), id: id.trim() };
}

/** Shape only: the catalog is code behind the Pi SDK, and an unknown name is
 *  ignored there, so a downgrade cannot lose a setting it cannot explain. */
export function normalizeExtensions(raw: unknown): string[] | null {
  return normalizeNames(raw);
}

/** Shape only, for the same reason: tools.ts owns the catalog. */
export function normalizeTools(raw: unknown): string[] | null {
  return normalizeNames(raw);
}

function normalizeNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null;
  const names = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (!name || name.length > 64) return null;
    names.add(name);
  }
  return [...names];
}

export class SettingsStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  get(): Settings {
    const titleModel = this.#json("titleModel", normalizeModelRef, "a {provider, id}");
    return {
      publicUrl: this.#value("publicUrl") ?? "",
      modelMenu: this.#json("modelMenu", normalizeModelMenu, "a valid menu") ?? [],
      ...(titleModel ? { titleModel } : {}),
      autoUpdate: this.#value("autoUpdate") === "1",
      extensions: this.#json("extensions", normalizeExtensions, "a list of names") ?? [],
      tools: this.#json("tools", normalizeTools, "a list of names") ?? [],
      // `"drop"`: a row the bundled catalog has since taken is redundant, not malformed.
      customTools: this.#json(
        "customTools",
        (raw) => normalizeCustomTools(raw, [], "drop"),
        "a list of {name, spec}",
      ) ?? [],
    };
  }

  /** A malformed row is named, not silently served as the empty value (§5). */
  #json<T>(key: string, normalize: (raw: unknown) => T | null, expected: string): T | null {
    const raw = this.#value(key);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`settings.${key} is not JSON — ignoring it`);
      return null;
    }
    const value = normalize(parsed);
    if (value === null) log.warn(`settings.${key} is not ${expected} — ignoring it`);
    return value;
  }

  /** Setters take already-normalized values: validation belongs at the boundary. */
  setPublicUrl(publicUrl: string): Settings {
    this.#set("publicUrl", publicUrl);
    return this.get();
  }

  setModelMenu(menu: ModelMenuEntry[]): Settings {
    this.#set("modelMenu", JSON.stringify(menu));
    return this.get();
  }

  /** null switches auto-titling off. */
  setTitleModel(ref: ModelRef | null): Settings {
    this.#set("titleModel", ref ? JSON.stringify(ref) : "");
    return this.get();
  }

  setAutoUpdate(on: boolean): Settings {
    this.#set("autoUpdate", on ? "1" : "0");
    return this.get();
  }

  setExtensions(names: string[]): Settings {
    this.#set("extensions", JSON.stringify(names));
    return this.get();
  }

  setTools(names: string[]): Settings {
    this.#set("tools", JSON.stringify(names));
    return this.get();
  }

  setCustomTools(tools: CustomTool[]): Settings {
    this.#set("customTools", JSON.stringify(tools));
    return this.get();
  }

  /** A request that declares a tool and switches it on must not store one
   *  without the other. */
  transact<T>(work: () => T): T {
    return transact(this.#db, work);
  }

  #set(key: string, value: string): void {
    this.#db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  #value(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
