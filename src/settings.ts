// Instance settings: the facts about *this* Pier that are neither a credential
// nor per-session. Today there is one — the URL it is reached at from outside,
// which nothing in the process can discover for itself: a request's Host header
// is whatever a proxy chose to pass on, and an agent writing a board has no
// request at all.
//
// A JSON file rather than a row in pier.db, because the agent is a reader too:
// the boards skill turns a slug into a link someone can click by reading this
// file. The database is 0600 and needs a SQLite client; a public hostname is
// not a secret and this needs neither.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./log.js";
import { pierPath } from "./paths.js";

export interface Settings {
  /** Origin (plus path prefix, if Pier is mounted under one) with no trailing
   *  slash — `https://pier.example.com`. Empty when nobody has said. */
  publicUrl: string;
}

const EMPTY: Settings = { publicUrl: "" };

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
  readonly #file: string;
  #settings: Settings;

  constructor(file = pierPath("settings.json")) {
    this.#file = file;
    this.#settings = load(file);
  }

  get(): Settings {
    return { ...this.#settings };
  }

  /** Store an already-normalized value — validation belongs at the boundary
   *  that received it, so this never has to guess what the caller meant. */
  setPublicUrl(publicUrl: string): Settings {
    this.#settings = { ...this.#settings, publicUrl };
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(this.#settings, null, 2)}\n`);
    return this.get();
  }
}

/** Missing file = nothing configured yet; a broken one is reported and treated
 *  as empty, never half-read. */
function load(file: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ...EMPTY };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    const { publicUrl } = parsed as Record<string, unknown>;
    return { publicUrl: typeof publicUrl === "string" ? publicUrl : "" };
  } catch (err) {
    logger("pier").warn(`ignoring unreadable settings file ${file}`, err);
    return { ...EMPTY };
  }
}
