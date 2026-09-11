// Named secrets for `pier vault run`: the vault table and its resolution. The
// value's shape is the level — a sealed envelope is `auto`, a `vt://` record is
// `approve` — so no column can disagree with the value beside it. Plaintext is
// a parameter and a return value here, never a log line or a field.

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "./db.js";
import { logger } from "./log.js";
import { isSealed, vtCli, type Secrets, type VtClient } from "./secrets.js";

const log = logger("vault");

export type VaultLevel = "auto" | "approve";

export interface VaultEntry {
  name: string;
  level: VaultLevel;
  updatedAt: number;
}

/** `plain` is the secret itself; `record` is a `vt://` handle for `vt inject`. */
export type Resolved = Record<string, { kind: "plain" | "record"; value: string }>;

/** An env-var name, so the common case needs no mapping. */
export const isVaultName = (name: string): boolean => /^[A-Z][A-Z0-9_]{0,63}$/.test(name);

/** Named, never partial: the caller learns which name to file, and gets no
 *  values for the others. */
export class UnknownSecret extends Error {
  constructor(readonly secret: string) {
    super(`no secret named ${secret}`);
  }
}

/** Only sealed rows need the key; the reason is the operator's repair instruction. */
export class VaultLocked extends Error {
  constructor(reason: string) {
    super(`locked — ${reason}`);
  }
}

const levelOf = (value: string): VaultLevel => (isSealed(value) ? "auto" : "approve");

function check(name: string, plaintext: string): void {
  if (!isVaultName(name)) throw new Error(`${name} is not a vault name (A-Z, 0-9, _; starts with a letter)`);
  if (!plaintext) throw new Error("empty value");
}

export class Vault {
  constructor(
    private readonly secrets: Pick<Secrets, "encrypt" | "decrypt" | "state" | "lockedReason">,
    private readonly db: DatabaseSync = pierDb(),
    private readonly vt: VtClient = vtCli,
  ) {}

  list(): VaultEntry[] {
    const rows = this.db.prepare("SELECT name, value, updated_at FROM vault ORDER BY name").all() as {
      name: string;
      value: string;
      updated_at: number;
    }[];
    return rows.map((row) => ({ name: row.name, level: levelOf(row.value), updatedAt: row.updated_at }));
  }

  /** Overwrite by name is rotation: a command already running keeps the env it
   *  was given, the next `run` gets the new value. */
  async put(name: string, level: VaultLevel, plaintext: string): Promise<void> {
    if (level === "auto") return this.seal(name, plaintext);
    check(name, plaintext);
    const record = await this.vt.create(plaintext);
    if (!record.startsWith("vt://")) throw new Error("vt create did not return a vt:// record");
    this.#store(name, level, record);
  }

  /** The `auto` half of put, synchronous: a channel save runs on the message
   *  path and cannot await. */
  seal(name: string, plaintext: string): void {
    check(name, plaintext);
    this.#store(name, "auto", this.secrets.encrypt(plaintext));
  }

  #store(name: string, level: VaultLevel, value: string): void {
    this.db.prepare(`
      INSERT INTO vault(name, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(name, value, Date.now());
    log.info(`vault put ${name} (${level})`);
  }

  /** False when there was nothing to remove. */
  remove(name: string): boolean {
    const removed = this.db.prepare("DELETE FROM vault WHERE name = ?").run(name).changes > 0;
    if (removed) log.info(`vault remove ${name}`);
    return removed;
  }

  /** One of Pier's own credentials, `undefined` when unfiled — a state there,
   *  not an error. A sealed row still needs the key. */
  get(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM vault WHERE name = ?").get(name) as { value: string } | undefined;
    if (!row) return undefined;
    return isSealed(row.value) ? this.secrets.decrypt(row.value) : row.value;
  }

  /** `by` names the caller in the one log line a resolve leaves; values never
   *  appear at any level. `approve` rows resolve while locked — they need no key. */
  resolve(names: string[], by = "unknown"): Resolved {
    const select = this.db.prepare("SELECT value FROM vault WHERE name = ?");
    const rows = names.map((name) => {
      const row = select.get(name) as { value: string } | undefined;
      if (!row) throw new UnknownSecret(name);
      return [name, row.value] as const;
    });
    if (rows.some(([, value]) => isSealed(value)) && this.secrets.state === "locked") {
      throw new VaultLocked(this.secrets.lockedReason);
    }
    const resolved: Resolved = {};
    for (const [name, value] of rows) {
      resolved[name] = isSealed(value)
        ? { kind: "plain", value: this.secrets.decrypt(value) }
        : { kind: "record", value };
    }
    log.info(`vault resolve ${names.join(",")} by ${by}`);
    return resolved;
  }
}
