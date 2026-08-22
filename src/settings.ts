// Instance settings: the facts about *this* Pier that are neither a credential
// nor per-session. Today there is one — the URL it is reached at from outside,
// which nothing in the process can discover for itself: a request's Host header
// is whatever a proxy chose to pass on, and an agent writing a board has no
// request at all.
//
// A key-value table, so the next setting is not the next table and not a third
// kind of storage. It used to be a JSON file, justified by "the agent reads it
// too" — the agent is told the URL in its system prompt (core/reply.ts), and
// nothing outside this process ever opened that file.

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "./db.js";

export interface Settings {
  /** Origin (plus path prefix, if Pier is mounted under one) with no trailing
   *  slash — `https://pier.example.com`. Empty when nobody has said. */
  publicUrl: string;
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

export class SettingsStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  get(): Settings {
    return { publicUrl: this.#value("publicUrl") ?? "" };
  }

  /** Store an already-normalized value — validation belongs at the boundary
   *  that received it, so this never has to guess what the caller meant. */
  setPublicUrl(publicUrl: string): Settings {
    this.#db.prepare(`
      INSERT INTO settings(key, value) VALUES ('publicUrl', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(publicUrl);
    return this.get();
  }

  #value(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
