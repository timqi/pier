// Layer-1 secret encryption: the credentials Pier must read by itself
// (channel tokens, provider API keys, OAuth tokens) are stored as ciphertext
// and pass through here. Two keys, standard envelope: a KEK from
// `~/.pier/master.key` wraps a DEK, and only the DEK touches data — so
// rotating the KEK rewrites one file and zero data rows. The KEK is either a
// `vt://` record (decrypted through vt, one approval per process start) or a
// raw key in the file (the no-vt fallback — same at-rest level as the
// plaintext files it replaces, and the mode is the operator's explicit
// choice, never a silent downgrade).
//
// Both keys live in `master.key` (JSON: kek, wrapped dek, dek id), not the
// database: rotation is then a single atomic rename, with no crash window
// where the file holds the new KEK and the database a DEK wrapped by the old
// one. Layer 2 — secrets needing per-use approval — never passes through
// here: those stay `vt://` strings Pier cannot read, and the agent runs vt
// itself.

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { logger } from "./log.js";
import { pierPath } from "./paths.js";

const log = logger("secrets");

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce

/** The vt CLI surface Secrets needs; injectable so tests never spawn it. */
export interface VtClient {
  /** `vt read <record>` — plaintext (our base64 KEK) after approval. */
  read(record: string): Promise<string>;
  /** `vt create` — plaintext on stdin, the `vt://` record back. */
  create(plaintext: string): Promise<string>;
}

export type SecretsMode = "vt" | "file";

/** What master.key holds. `kek` is a `vt://` record or the raw key, base64;
 *  `dek` is the data key wrapped by the KEK; `dekId` names it in envelopes. */
interface KeyFile {
  kek: string;
  dek: string;
  dekId: string;
}

export class Secrets {
  #dek?: Buffer;
  #kek?: Buffer;
  #file?: KeyFile;
  /** Why decrypt is refused right now — "" once unlocked. */
  #lockedReason = "unlock() has not run";

  constructor(
    private readonly path: string = pierPath("master.key"),
    private readonly vt: VtClient = vtCli,
  ) {}

  get state(): "locked" | "unlocked" {
    return this.#dek ? "unlocked" : "locked";
  }

  get mode(): SecretsMode | undefined {
    return this.#file ? (this.#file.kek.startsWith("vt://") ? "vt" : "file") : undefined;
  }

  /**
   * Load master.key — created on first boot, file mode, so an unattended
   * start needs no ceremony; vt mode is entered later via rotate. Throws on a
   * failed vt approval or a corrupt file, and remembers why: the process must
   * keep serving (web is how the operator unlocks or repairs), but every
   * refused decrypt names the reason instead of pretending to be empty.
   */
  async unlock(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch {
        this.#file = this.#create();
        log.info(`created ${this.path} (file mode)`);
        raw = readFileSync(this.path, "utf8");
      }
      const file = JSON.parse(raw) as KeyFile;
      if (!file.kek || !file.dek || !file.dekId) throw new Error(`${this.path} is malformed`);
      this.#kek = file.kek.startsWith("vt://")
        ? Buffer.from(await this.vt.read(file.kek), "base64")
        : Buffer.from(file.kek, "base64");
      if (this.#kek.length !== KEY_BYTES) throw new Error(`${this.path} KEK is not ${KEY_BYTES} bytes`);
      this.#dek = open(this.#kek, file.dek, `kek:${file.dekId}`);
      this.#file = file;
      this.#lockedReason = "";
      log.info(`secrets unlocked (${this.mode} mode, dek ${file.dekId})`);
    } catch (err) {
      this.#lockedReason = String(err);
      throw err;
    }
  }

  encrypt(plaintext: string): string {
    const { dek, file } = this.#unlocked();
    return `v1:${file.dekId}:${seal(dek, plaintext, `v1:${file.dekId}`)}`;
  }

  decrypt(blob: string): string {
    const { dek, file } = this.#unlocked();
    const [v, dekId, ...rest] = blob.split(":");
    if (v !== "v1" || rest.length !== 3) throw new Error("not a v1 secret envelope");
    if (dekId !== file.dekId) throw new Error(`sealed by unknown key ${dekId}, have ${file.dekId}`);
    return open(dek, rest.join(":"), `v1:${dekId}`).toString("utf8");
  }

  /**
   * New KEK, same DEK: every stored envelope stays valid. `mode` switches how
   * the new KEK is protected (entering vt mode runs `vt create`, one
   * approval); omitted, the current mode is kept. The rewrapped file lands by
   * atomic rename — a crash leaves either the old working file or the new one.
   */
  async rotateKek(mode: SecretsMode = this.mode ?? "file"): Promise<void> {
    const { file } = this.#unlocked();
    const kek = randomBytes(KEY_BYTES);
    const next: KeyFile = {
      kek: mode === "vt" ? await this.vt.create(kek.toString("base64")) : kek.toString("base64"),
      dek: seal(kek, this.#dek!, `kek:${file.dekId}`),
      dekId: file.dekId,
    };
    if (mode === "vt" && !next.kek.startsWith("vt://")) {
      throw new Error("vt create did not return a vt:// record");
    }
    this.#write(next);
    this.#kek = kek;
    this.#file = next;
    log.info(`KEK rotated (${mode} mode, dek ${file.dekId} unchanged)`);
  }

  /** First boot: random KEK and DEK, file mode. */
  #create(): KeyFile {
    const kek = randomBytes(KEY_BYTES);
    const dekId = randomBytes(4).toString("hex");
    const file: KeyFile = {
      kek: kek.toString("base64"),
      dek: seal(kek, randomBytes(KEY_BYTES), `kek:${dekId}`),
      dekId,
    };
    this.#write(file);
    return file;
  }

  #write(file: KeyFile): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // mode above is masked by umask; this is not
    renameSync(tmp, this.path);
  }

  #unlocked(): { dek: Buffer; file: KeyFile } {
    if (!this.#dek || !this.#file) throw new Error(`secrets locked: ${this.#lockedReason}`);
    return { dek: this.#dek, file: this.#file };
  }
}

/** AES-256-GCM, `iv:ct:tag` base64. `aad` binds ciphertext to its role, so an
 *  envelope pasted into another slot fails closed instead of decrypting. */
function seal(key: Buffer, plaintext: string | Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString("base64")).join(":");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [iv, ct, tag] = sealed.split(":").map((part) => Buffer.from(part, "base64"));
  if (!iv || !ct || !tag) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** The real vt CLI. Absent binary or denied approval both surface as the
 *  spawn/exit error — unlock() records it and the operator reads it. */
export const vtCli: VtClient = {
  read: (record) => run("vt", ["read", record]),
  create: async (plaintext) => {
    const out = await run("vt", ["create"], plaintext);
    const record = out.match(/vt:\/\/\S+/)?.[0];
    if (!record) throw new Error("vt create printed no vt:// record");
    return record;
  },
};

function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out.trim());
      else reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.trim() || out.trim()}`));
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}
