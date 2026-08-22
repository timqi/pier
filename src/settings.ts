// Instance settings: the facts about *this* Pier that are neither a credential
// nor per-session — the public URL (nothing in the process can discover it:
// a Host header is whatever a proxy passed on) and the operator's model menu.
//
// A key-value table, so the next setting is not the next table and not a third
// kind of storage. It used to be a JSON file, justified by "the agent reads it
// too" — the agent is told the URL in its system prompt (core/reply.ts), and
// nothing outside this process ever opened that file.

import type { DatabaseSync } from "node:sqlite";
import { isThinkingLevel, type ThinkingLevel } from "./core/types.js";
import { pierDb } from "./db.js";
import { logger } from "./log.js";

const log = logger("settings");

/** One operator-pinned model: what to reach for, and one line of why. */
export interface ModelMenuEntry {
  provider: string;
  id: string;
  /** The reasoning level this pin is usually run at — advice, not a lock. */
  thinking?: ThinkingLevel;
  /** Intent, not documentation — "hardest reasoning", "cheap bulk". */
  note?: string;
}

export interface Settings {
  /** Origin (plus path prefix, if Pier is mounted under one) with no trailing
   *  slash — `https://pier.example.com`. Empty when nobody has said. */
  publicUrl: string;
  /** The deployment's model advice — pinned models with one line of intent
   *  each. Empty means "no advice": consumers fall back to the catalog. */
  modelMenu: ModelMenuEntry[];
}

/**
 * `""` clears it, `null` rejects it. Rejecting rather than repairing: a
 * mistyped host quietly turned into a URL produces board links that 404 for
 * the person they were sent to, and the sender never finds out.
 */
export function normalizePublicUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "";
  let url: URL;
  try {
    // Scheme-less input is the common way to type a host, and https is the
    // only guess worth making for something on the internet.
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Boundary check for a menu, rejecting rather than repairing (same contract as
 * `normalizePublicUrl`): a silently "fixed" entry would advertise a model the
 * operator never picked. Notes are capped — they are one line of intent, and
 * every session that asks for the menu pays for their tokens.
 */
export function normalizeModelMenu(raw: unknown): ModelMenuEntry[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null;
  const menu: ModelMenuEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { provider, id, thinking, note } = item as Record<string, unknown>;
    if (typeof provider !== "string" || !provider.trim()) return null;
    if (typeof id !== "string" || !id.trim()) return null;
    if (thinking !== undefined && !isThinkingLevel(thinking)) return null;
    if (note !== undefined && typeof note !== "string") return null;
    const cleaned = note?.trim().slice(0, 200);
    menu.push({
      provider: provider.trim(),
      id: id.trim(),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(cleaned ? { note: cleaned } : {}),
    });
  }
  return menu;
}

export class SettingsStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  get(): Settings {
    return { publicUrl: this.#value("publicUrl") ?? "", modelMenu: this.#menu() };
  }

  #menu(): ModelMenuEntry[] {
    const raw = this.#value("modelMenu");
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Only a hand-edited row can get here; named, not silently served as [].
      log.warn("settings.modelMenu is not JSON — ignoring it");
      return [];
    }
    const menu = normalizeModelMenu(parsed);
    if (!menu) {
      log.warn("settings.modelMenu is not a valid menu — ignoring it");
      return [];
    }
    return menu;
  }

  /** Store an already-normalized value — validation belongs at the boundary
   *  that received it, so this never has to guess what the caller meant. */
  setPublicUrl(publicUrl: string): Settings {
    this.#set("publicUrl", publicUrl);
    return this.get();
  }

  /** Same contract: hand this `normalizeModelMenu`'s output, not raw input. */
  setModelMenu(menu: ModelMenuEntry[]): Settings {
    this.#set("modelMenu", JSON.stringify(menu));
    return this.get();
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
