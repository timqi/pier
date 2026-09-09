// Layer-1 secret encryption for the credentials Pier must read by itself.
// Standard envelope: a KEK from `master.key` (a `vt://` record, or a raw key in
// file mode — the operator's explicit choice) wraps a DEK, and only the DEK
// touches data, so rotating the KEK rewrites one file and zero rows. Both keys
// live in that one file so rotation is a single atomic rename. Layer 2
// (per-use approval) never passes here: the agent runs vt itself.

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
  /** `vt doctor` — read-only; values are reported as lengths, never plaintext. */
  doctor(): Promise<string>;
}

export type SecretsMode = "vt" | "file";

/** What master.key holds. `kek` is a `vt://` record or the raw key, base64;
 *  `dek` is the data key wrapped by the KEK; `dekId` names it in envelopes. */
interface KeyFile {
  kek: string;
  dek: string;
  dekId: string;
}

/** Anything not matching predates sealing: honored as plaintext, and re-sealed
 *  by whichever store owns the row. */
export const isSealed = (blob: string): boolean => /^v1:[0-9a-f]{8}:/.test(blob);

export class Secrets {
  #dek?: Buffer;
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

  get lockedReason(): string {
    return this.#lockedReason;
  }

  /** Created on first boot in file mode, so an unattended start needs no
   *  ceremony. Throws and remembers why: the process must keep serving (web is
   *  how the operator repairs), and every refused decrypt names the reason. */
  async unlock(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch (err) {
        // Only ENOENT is first boot: any other error falling through to
        // #create() would rename a fresh key over the existing one.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        this.#file = this.#create();
        log.info(`created ${this.path} (file mode)`);
        raw = readFileSync(this.path, "utf8");
      }
      const file = JSON.parse(raw) as KeyFile;
      if (!file.kek || !file.dek || !file.dekId) throw new Error(`${this.path} is malformed`);
      const kek = file.kek.startsWith("vt://")
        ? Buffer.from(await this.vt.read(file.kek), "base64")
        : Buffer.from(file.kek, "base64");
      if (kek.length !== KEY_BYTES) throw new Error(`${this.path} KEK is not ${KEY_BYTES} bytes`);
      this.#dek = open(kek, file.dek, `kek:${file.dekId}`);
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

  /** New KEK, same DEK: every stored envelope stays valid. Omitted `mode`
   *  keeps the current one. */
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
    this.#file = next;
    log.info(`KEK rotated (${mode} mode, dek ${file.dekId} unchanged)`);
  }

  /** Read-only, safe while locked; vt's own report is the repair instruction. */
  doctor(): Promise<string> {
    return this.vt.doctor();
  }

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

const vtCli: VtClient = {
  read: (record) => run("vt", ["read", record]),
  create: async (plaintext) => {
    const out = await run("vt", ["create"], plaintext);
    const record = out.match(/vt:\/\/\S+/)?.[0];
    if (!record) throw new Error("vt create printed no vt:// record");
    return record;
  },
  // doctor probes over the network; a hung probe would hang the Console.
  doctor: () => run("vt", ["doctor"], undefined, 15_000),
};

function run(cmd: string, args: string[], stdin?: string, timeoutMs?: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolvePromise(out.trim());
      const how = signal ? `timed out after ${timeoutMs}ms (${signal})` : `exited ${code}`;
      reject(new Error(`${cmd} ${args[0]} ${how}: ${err.trim() || out.trim()}`));
    });
    child.stdin.on("error", reject); // EPIPE if vt exits before reading
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}
