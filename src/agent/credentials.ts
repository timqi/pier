// Provider credentials — what Pi kept in <agentDir>/auth.json — at rest in
// pier.db, sealed by Secrets. Implements pi-ai's CredentialStore contract
// structurally (shapes mirrored below, no SDK import: only pi.ts names SDK
// modules), so ModelRuntime reads through here and an OAuth refresh writes
// the rotated token back through here instead of a file.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../log.js";
import type { Secrets } from "../secrets.js";
import { defaultAgentDir } from "./config.js";

const log = logger("credentials");

/** Envelope from secrets.ts. A value that matches was sealed by us; anything
 *  else is legacy plaintext, still honored and re-sealed on the next write. */
const SEALED = /^v1:[0-9a-f]{8}:/;

/** Mirror of pi-ai's Credential — the one shape an auth.json entry had. */
export type ProviderCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | ({ type: "oauth"; refresh: string; access: string; expires: number } & Record<string, unknown>);

export interface ProviderCredentialInfo {
  providerId: string;
  type: ProviderCredential["type"];
}

interface OperationOptions {
  signal?: AbortSignal;
}

export class CredentialStore {
  #imported = false;
  /** Writes run one at a time: pi-ai refreshes OAuth tokens inside modify()
   *  and relies on it being a serialized read-modify-write. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: Secrets,
    private readonly agentDir: string = defaultAgentDir(),
  ) {}

  /** Locked Secrets must fail a session open loudly, with the reason — not
   *  surface later as "provider is not configured". Called by pi.ts before
   *  every open; encrypt() throws the `secrets locked: ...` error we want. */
  assertUnlocked(): void {
    if (this.secrets.state === "locked") this.secrets.encrypt("");
  }

  async read(
    providerId: string,
    options?: OperationOptions,
  ): Promise<ProviderCredential | undefined> {
    options?.signal?.throwIfAborted();
    this.#ensureImported();
    return this.#get(providerId);
  }

  async list(options?: OperationOptions): Promise<readonly ProviderCredentialInfo[]> {
    options?.signal?.throwIfAborted();
    this.#ensureImported();
    const rows = this.db.prepare("SELECT key, value FROM credentials").all() as {
      key: string;
      value: string;
    }[];
    return rows.map((row) => ({ providerId: row.key, type: this.#parse(row.value).type }));
  }

  async modify(
    providerId: string,
    fn: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
    options?: OperationOptions,
  ): Promise<ProviderCredential | undefined> {
    return this.#serialized(options, async () => {
      const next = await fn(this.#get(providerId));
      options?.signal?.throwIfAborted();
      if (next === undefined) return this.#get(providerId);
      this.#put(providerId, next);
      return next;
    });
  }

  async delete(providerId: string, options?: OperationOptions): Promise<void> {
    return this.#serialized(options, async () => {
      this.db.prepare("DELETE FROM credentials WHERE key = ?").run(providerId);
    });
  }

  #serialized<T>(options: OperationOptions | undefined, run: () => Promise<T>): Promise<T> {
    const op = this.#chain.then(
      () => {
        options?.signal?.throwIfAborted();
        this.#ensureImported();
        return run();
      },
      // The chain only sequences; a predecessor's failure is its caller's news.
      () => {
        options?.signal?.throwIfAborted();
        this.#ensureImported();
        return run();
      },
    );
    this.#chain = op.catch(() => {});
    return op;
  }

  #get(providerId: string): ProviderCredential | undefined {
    const row = this.db.prepare("SELECT value FROM credentials WHERE key = ?").get(providerId) as
      | { value: string }
      | undefined;
    return row ? this.#parse(row.value) : undefined;
  }

  #parse(value: string): ProviderCredential {
    const plain = SEALED.test(value) ? this.secrets.decrypt(value) : value;
    return JSON.parse(plain) as ProviderCredential;
  }

  #put(providerId: string, credential: ProviderCredential): void {
    this.db
      .prepare(
        "INSERT INTO credentials(key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(providerId, this.secrets.encrypt(JSON.stringify(credential)));
  }

  /** One-time move of <agentDir>/auth.json into the database. Lazy because
   *  sealing needs an unlocked Secrets; retried until it succeeds (the flag is
   *  set only then, and #put is an idempotent upsert). The file is renamed,
   *  never deleted: auth.json.imported is the operator's receipt and way back. */
  #ensureImported(): void {
    if (this.#imported) return;
    const path = join(this.agentDir, "auth.json");
    if (!existsSync(path)) {
      this.#imported = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${path} exists but is not valid JSON — fix or move it: ${String(err)}`, {
        cause: err,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} exists but is not an object — fix or move it`);
    }
    const entries = Object.entries(parsed as Record<string, ProviderCredential>);
    for (const [providerId, credential] of entries) this.#put(providerId, credential);
    renameSync(path, `${path}.imported`);
    this.#imported = true;
    log.info(`imported ${entries.length} provider credential(s) from ${path}, renamed to auth.json.imported`);
  }
}
