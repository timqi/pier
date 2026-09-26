// Instance settings: the facts about *this* Pier that are neither a credential
// nor per-session. A key-value table, so the next setting is not the next table.

import type { DatabaseSync } from "node:sqlite";
import { isModelTier, isThinkingLevel, MODEL_TIERS, THINKING_LEVELS, type ModelRef, type ModelTier, type ThinkingLevel } from "./core/types.js";
import { pierDb, transact } from "./db.js";
import { logger } from "./log.js";
import { normalizeCustomTools, type CustomTool } from "./tools.js";

const log = logger("settings");

/** One operator-pinned model: what to reach for, and at which reasoning level. */
export interface ModelMenuEntry {
  provider: string;
  id: string;
  /** Advice, not a lock — but never absent: a pin with no level is a third
   *  state every picker would need a fallback for. */
  thinking: ThinkingLevel;
  /** The work class `pier task --model <tier>` resolves to; several pins on one
   *  tier are its fallbacks, in menu order. */
  tier?: ModelTier;
}

export interface Settings {
  /** Origin plus path prefix, no trailing slash; nothing in the process can
   *  discover it (a Host header is whatever a proxy passed on). Empty when unset. */
  publicUrl: string;
  /** Pinned models, in the operator's order; empty falls back to the catalog. */
  modelMenu: ModelMenuEntry[];
  /** Names a session after its first exchange. Unset: the title is the first
   *  prompt and no call is made. */
  titleModel?: ModelRef;
  /** Off by default: replacing your own code is the operator's decision. */
  autoUpdate: boolean;
  /** Pier's own skills switched off. An off-list: skills default on, so an
   *  upgrade's new skill is on without a write. */
  skillsOff: string[];
  /** Managed CLI tools switched on (src/tools.ts). */
  tools: string[];
  /** Beside the enabled set, not inside it: a tool switched off must not lose its spec. */
  customTools: CustomTool[];
  /** The workbench's accent, one of `ACCENTS`; `""` is the default ramp. */
  accent: string;
  /** One continuous conversation in front of a dispatcher session
   *  (docs/design/10-continuous-session.md); off is today's workbench. */
  continuous: boolean;
}

/** The presets, each with the hex of its 600 step — what the manifest and the
 *  icon paint with, since neither can read a CSS variable. The ramps
 *  themselves are style.css's; this table must name the same colours. */
export const ACCENTS: Readonly<Record<string, string>> = {
  indigo: "#0066df",
  teal: "#037f75",
  emerald: "#028355",
  amber: "#b17000",
  rose: "#c51b53",
  violet: "#7a49d3",
};
export const DEFAULT_ACCENT = "indigo";
/** The plate colour icon.svg is authored in; what the served SVG and the
 *  rendered PNGs replace with the accent's 600 step. */
export const ICON_PLATE = "#4f46e5";

/** `""` and the default's own name both mean "no override"; anything not in
 *  the table is rejected, never stored as a name the stylesheet lacks. */
export function normalizeAccent(raw: string): string | null {
  const name = raw.trim();
  if (!name || name === DEFAULT_ACCENT) return "";
  return Object.hasOwn(ACCENTS, name) ? name : null;
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
 *  operator never picked. The refusal names the row (1-based, as the Console
 *  lists them) and the field. A `note` left by an older Pier is dropped. One
 *  model may be pinned at several levels; the same model at the same level twice
 *  is refused, naming both rows. */
export function parseModelMenu(raw: unknown): ModelMenuEntry[] | string {
  if (!Array.isArray(raw)) return "modelMenu must be a list";
  if (raw.length > 32) return `modelMenu has ${String(raw.length)} rows; at most 32`;
  const menu: ModelMenuEntry[] = [];
  for (const [i, item] of raw.entries()) {
    const row = `modelMenu row ${String(i + 1)}`;
    const ref = normalizeModelRef(item);
    if (!ref) return `${row}: provider and id must be non-empty strings`;
    const { thinking, tier } = item as Record<string, unknown>;
    // Repaired, not rejected: rows stored before the level was required have
    // none, and dropping the menu over it would lose the pins.
    const level = thinking === undefined ? "medium" : thinking;
    if (!isThinkingLevel(level)) return `${row} (${ref.provider}/${ref.id}): thinking must be one of ${THINKING_LEVELS.join(", ")}`;
    if (tier !== undefined && !isModelTier(tier)) return `${row} (${ref.provider}/${ref.id}): tier must be one of ${MODEL_TIERS.join(", ")}, or none`;
    const twin = menu.findIndex((e) => e.provider === ref.provider && e.id === ref.id && e.thinking === level);
    if (twin >= 0) return `${row} (${ref.provider}/${ref.id}): already pinned at ${level} by row ${String(twin + 1)}`;
    menu.push({ ...ref, thinking: level, ...(tier !== undefined ? { tier } : {}) });
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

/** Shape only: tools.ts owns the catalog, and an unknown name is ignored
 *  there, so a downgrade cannot lose a setting it cannot explain. */
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
    const accent = normalizeAccent(this.#value("accent") ?? "");
    if (accent === null) log.warn("settings.accent is not a preset — ignoring it");
    return {
      publicUrl: this.#value("publicUrl") ?? "",
      modelMenu: this.#json("modelMenu", (raw) => {
        const menu = parseModelMenu(raw);
        return typeof menu === "string" ? null : menu;
      }, "a valid menu") ?? [],
      ...(titleModel ? { titleModel } : {}),
      autoUpdate: this.#value("autoUpdate") === "1",
      skillsOff: this.#json("skillsOff", normalizeNames, "a list of names") ?? [],
      tools: this.#json("tools", normalizeTools, "a list of names") ?? [],
      // `"drop"`: a row the bundled catalog has since taken is redundant, not malformed.
      customTools: this.#json(
        "customTools",
        (raw) => normalizeCustomTools(raw, "drop"),
        "a list of {name, toml}",
      ) ?? [],
      accent: accent ?? "",
      continuous: this.#value("continuous") === "1",
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

  setAccent(accent: string): Settings {
    this.#set("accent", accent);
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

  setContinuous(on: boolean): Settings {
    this.#set("continuous", on ? "1" : "0");
    return this.get();
  }

  setSkillsOff(names: string[]): Settings {
    this.#set("skillsOff", JSON.stringify(names));
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
