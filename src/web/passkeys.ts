// Passkeys (WebAuthn) beside the password: the store, the CBOR and COSE parsing
// an attestation needs, the challenge ledger and the routes. Attestation is not
// verified — the operator registers their own authenticator from a page they
// are already signed into, so the ceremony proves possession, not provenance.
// While one passkey exists the password is off (auth.ts asks `any()` live).

import { createHash, createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { readCapped } from "../core/inbox.js";
import { pierDb, statements } from "../db.js";
import { logger } from "../log.js";
import {
  type AuthStore,
  clientOf,
  noteFailure,
  openSession,
  safeNext,
  throttled,
} from "./auth.js";

const log = logger("passkeys");

const CHALLENGE_TTL_MS = 5 * 60_000;
/** Outstanding challenges kept; past it the oldest goes, so a stranger
 *  hammering the login options cannot grow the map. */
const MAX_CHALLENGES = 100;
/** A `none` attestation is ~200 bytes; a packed one with a cert chain a few KB. */
const MAX_BODY = 64 * 1024;
const MAX_LABEL = 80;
const DEFAULT_LABEL = "a passkey";
/** The WebAuthn user handle, one operator: minted once, kept in `settings`. */
const USER_ID_KEY = "passkeyUserId";
/** COSE algorithms offered and accepted: ES256 and RS256, what every platform
 *  authenticator and security key speaks. */
const ES256 = -7;
const RS256 = -257;
const FLAG_UP = 0x01;
const FLAG_AT = 0x40;

/** What the browser may see: never the public key. */
export interface Passkey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
}

interface Row {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string;
}

/** Reads the table live on every call — no cache — so `DELETE FROM passkeys`
 *  in sqlite3 re-enables the password without a restart. */
export class PasskeyStore {
  readonly #sql: (sql: string) => StatementSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#sql = statements(db);
  }

  list(): Passkey[] {
    const rows = this.#sql(
      "SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, transports" +
        " FROM passkeys ORDER BY created_at",
    ).all() as unknown as Row[];
    return rows.map((row) => ({ ...row, transports: JSON.parse(row.transports) as string[] }));
  }

  any(): boolean {
    return this.#sql("SELECT 1 FROM passkeys LIMIT 1").get() !== undefined;
  }

  add(id: string, publicKey: string, transports: string[], label: string): void {
    this.#sql(
      "INSERT INTO passkeys(id, public_key, sign_count, transports, label, created_at) VALUES (?, ?, 0, ?, ?, ?)",
    ).run(id, publicKey, JSON.stringify(transports), label, Date.now());
  }

  remove(id: string): boolean {
    return this.#sql("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
  }

  credential(id: string): { publicKey: string; signCount: number; label: string } | undefined {
    return this.#sql("SELECT public_key AS publicKey, sign_count AS signCount, label FROM passkeys WHERE id = ?")
      .get(id) as { publicKey: string; signCount: number; label: string } | undefined;
  }

  used(id: string, signCount: number): void {
    this.#sql("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, Date.now(), id);
  }

  userId(): Buffer {
    const row = this.#sql("SELECT value FROM settings WHERE key = ?").get(USER_ID_KEY) as { value: string } | undefined;
    if (row) return Buffer.from(row.value, "base64url");
    const id = randomBytes(16);
    this.#sql("INSERT INTO settings(key, value) VALUES (?, ?)").run(USER_ID_KEY, id.toString("base64url"));
    return id;
  }
}

/** A request refused for what it carried, distinct from a fault. */
class Refusal extends Error {
  constructor(message: string, readonly status: 400 | 401 | 409 | 413) {
    super(message);
  }
}

// --- the relying party ----------------------------------------------------------

/** The browser binds a credential to the RP ID and refuses any other host, so
 *  only an https public URL can name one; a passkey on a tunnel would be a
 *  lockout the moment the address changed. */
export function relyingParty(publicUrl: string): { rpId: string; origin: string } | { reason: string } {
  if (!publicUrl.startsWith("https://")) {
    return { reason: "passkeys need an https public URL (Settings → Instance)" };
  }
  const url = new URL(publicUrl);
  return { rpId: url.hostname, origin: url.origin };
}

// --- challenges -----------------------------------------------------------------

const challenges = new Map<string, { kind: "create" | "get"; expires: number }>();

function issueChallenge(kind: "create" | "get"): string {
  const now = Date.now();
  for (const [key, entry] of challenges) if (entry.expires <= now) challenges.delete(key);
  // Insertion order is age: the first key is the oldest.
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value as string);
  const challenge = randomBytes(32).toString("base64url");
  challenges.set(challenge, { kind, expires: now + CHALLENGE_TTL_MS });
  return challenge;
}

/** Single use: deleted whether or not it was still valid. */
function consumeChallenge(challenge: string, kind: "create" | "get"): boolean {
  const entry = challenges.get(challenge);
  challenges.delete(challenge);
  return entry !== undefined && entry.kind === kind && entry.expires > Date.now();
}

// --- CBOR and COSE --------------------------------------------------------------

type Cbor = number | Uint8Array | string | Cbor[] | Map<number | string, Cbor>;

/** The subset an attestationObject and a COSE key are written in: integers,
 *  byte and text strings, arrays and maps with integer or text keys.
 *  Anything else — tags, floats, indefinite lengths — is refused. */
export function decodeCbor(buf: Uint8Array, offset = 0): { value: Cbor; end: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const need = (at: number, n: number): void => {
    if (at + n > buf.length) throw new Refusal("truncated CBOR", 400);
  };
  const head = (at: number): { major: number; arg: number; next: number } => {
    need(at, 1);
    const major = buf[at]! >> 5;
    const info = buf[at]! & 0x1f;
    if (info < 24) return { major, arg: info, next: at + 1 };
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) throw new Refusal("unsupported CBOR length", 400);
    need(at + 1, size);
    const arg = size === 1
      ? buf[at + 1]!
      : size === 2
      ? view.getUint16(at + 1)
      : size === 4
      ? view.getUint32(at + 1)
      : Number(view.getBigUint64(at + 1));
    if (!Number.isSafeInteger(arg)) throw new Refusal("CBOR integer out of range", 400);
    return { major, arg, next: at + 1 + size };
  };
  const item = (at: number): { value: Cbor; end: number } => {
    const { major, arg, next } = head(at);
    switch (major) {
      case 0:
        return { value: arg, end: next };
      case 1:
        return { value: -1 - arg, end: next };
      case 2:
      case 3: {
        need(next, arg);
        const bytes = buf.subarray(next, next + arg);
        return { value: major === 2 ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes), end: next + arg };
      }
      case 4: {
        const list: Cbor[] = [];
        let cursor = next;
        for (let i = 0; i < arg; i++) {
          const entry = item(cursor);
          list.push(entry.value);
          cursor = entry.end;
        }
        return { value: list, end: cursor };
      }
      case 5: {
        const map = new Map<number | string, Cbor>();
        let cursor = next;
        for (let i = 0; i < arg; i++) {
          const key = item(cursor);
          if (typeof key.value !== "number" && typeof key.value !== "string") {
            throw new Refusal("CBOR map key is not an integer or text", 400);
          }
          const value = item(key.end);
          map.set(key.value, value.value);
          cursor = value.end;
        }
        return { value: map, end: cursor };
      }
      default:
        throw new Refusal(`unsupported CBOR major type ${String(major)}`, 400);
    }
  };
  return item(offset);
}

const asMap = (value: Cbor | undefined, what: string): Map<number | string, Cbor> => {
  if (!(value instanceof Map)) throw new Refusal(`${what} is not a CBOR map`, 400);
  return value;
};
const asBytes = (value: Cbor | undefined, what: string): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Refusal(`${what} is not a byte string`, 400);
  return value;
};

/** COSE_Key → JWK, EC2 P-256 (ES256) or RSA (RS256). `createPublicKey`
 *  validates the point / modulus; the JWK is what the store keeps. */
export function coseToJwk(key: Map<number | string, Cbor>): JsonWebKey {
  const kty = key.get(1);
  const alg = key.get(3);
  const b64 = (label: number, what: string): string => Buffer.from(asBytes(key.get(label), what)).toString("base64url");
  let jwk: JsonWebKey;
  if (kty === 2 && alg === ES256) {
    if (key.get(-1) !== 1) throw new Refusal("ES256 key is not on P-256", 400);
    jwk = { kty: "EC", crv: "P-256", x: b64(-2, "x"), y: b64(-3, "y") };
  } else if (kty === 3 && alg === RS256) {
    jwk = { kty: "RSA", n: b64(-1, "n"), e: b64(-2, "e") };
  } else {
    throw new Refusal(`unsupported key type ${String(kty)} / algorithm ${String(alg)}`, 400);
  }
  try {
    createPublicKey({ key: jwk, format: "jwk" });
  } catch (err) {
    throw new Refusal(`public key rejected: ${String(err)}`, 400);
  }
  return jwk;
}

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Map<number | string, Cbor>;
}

/** rpIdHash(32) flags(1) signCount(4) [aaguid(16) idLen(2) id COSE_Key] [extensions]. */
export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new Refusal("authenticator data too short", 400);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parsed: AuthData = { rpIdHash: data.subarray(0, 32), flags: data[32]!, signCount: view.getUint32(33) };
  if (parsed.flags & FLAG_AT) {
    if (data.length < 55) throw new Refusal("attested credential data too short", 400);
    const idLength = view.getUint16(53);
    if (data.length < 55 + idLength) throw new Refusal("credential id truncated", 400);
    parsed.credentialId = data.subarray(55, 55 + idLength);
    parsed.publicKey = asMap(decodeCbor(data, 55 + idLength).value, "credential public key");
  }
  return parsed;
}

// --- the ceremony's common checks -----------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function bytesOf(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !BASE64URL.test(value)) throw new Refusal(`${what} must be base64url`, 400);
  return Buffer.from(value, "base64url");
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

/** Type, single-use challenge and origin: the three facts the browser signed
 *  on the operator's behalf. Consumes the challenge whatever the outcome. */
function checkClientData(raw: Uint8Array, type: "webauthn.create" | "webauthn.get", origin: string): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(raw)) as typeof data;
  } catch {
    throw new Refusal("clientDataJSON is not JSON", 400);
  }
  if (data.type !== type) throw new Refusal(`clientDataJSON type is not ${type}`, 400);
  const kind = type === "webauthn.create" ? "create" : "get";
  if (typeof data.challenge !== "string" || !consumeChallenge(data.challenge, kind)) {
    throw new Refusal("challenge unknown, expired or already used", 400);
  }
  if (data.origin !== origin) throw new Refusal(`origin ${String(data.origin)} is not ${origin}`, 400);
}

function checkRpIdHash(authData: AuthData, rpId: string): void {
  if (!sha256(rpId).equals(authData.rpIdHash)) throw new Refusal("rpIdHash does not match the public URL's host", 400);
  if (!(authData.flags & FLAG_UP)) throw new Refusal("user presence flag not set", 400);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let raw: Uint8Array;
  try {
    raw = await readCapped(c.req.raw.body, MAX_BODY);
  } catch (err) {
    throw new Refusal(`body refused: ${String(err)}`, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Refusal("expected a JSON body", 400);
  }
  if (typeof body !== "object" || body === null) throw new Refusal("expected a JSON object", 400);
  return body as Record<string, unknown>;
}

const responseOf = (body: Record<string, unknown>): Record<string, unknown> =>
  typeof body.response === "object" && body.response !== null ? body.response as Record<string, unknown> : {};

// --- routes ---------------------------------------------------------------------

export function registerPasskeyRoutes(
  app: Hono,
  deps: { store: PasskeyStore; auth: AuthStore; publicUrl: () => string },
): void {
  const { store, auth, publicUrl } = deps;
  const listing = () => {
    const rp = relyingParty(publicUrl());
    return { enabled: "rpId" in rp, ...("reason" in rp ? { reason: rp.reason } : {}), passkeys: store.list() };
  };
  const refused = (c: Context, err: unknown): Response => {
    if (err instanceof Refusal) return c.json({ error: err.message }, err.status);
    throw err;
  };
  const rpOrRefuse = (): { rpId: string; origin: string } => {
    const rp = relyingParty(publicUrl());
    if ("reason" in rp) throw new Refusal(rp.reason, 409);
    return rp;
  };

  app.get("/api/passkeys", (c) => c.json(listing()));

  app.post("/api/passkeys/register/options", (c) => {
    try {
      const { rpId } = rpOrRefuse();
      return c.json({
        rp: { id: rpId, name: "Pier" },
        user: { id: store.userId().toString("base64url"), name: `operator@${rpId}`, displayName: "Pier operator" },
        challenge: issueChallenge("create"),
        pubKeyCredParams: [{ type: "public-key", alg: ES256 }, { type: "public-key", alg: RS256 }],
        timeout: CHALLENGE_TTL_MS,
        excludeCredentials: store.list().map(({ id, transports }) => ({ type: "public-key", id, transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        attestation: "none",
      });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/passkeys/register/verify", async (c) => {
    try {
      const { rpId, origin } = rpOrRefuse();
      const body = await readJson(c);
      const response = responseOf(body);
      checkClientData(bytesOf(response.clientDataJSON, "clientDataJSON"), "webauthn.create", origin);
      const attestation = asMap(decodeCbor(bytesOf(response.attestationObject, "attestationObject")).value, "attestationObject");
      // attStmt is ignored whatever `fmt` says: nothing here verifies provenance.
      const authData = parseAuthData(asBytes(attestation.get("authData"), "authData"));
      checkRpIdHash(authData, rpId);
      if (!authData.credentialId || !authData.publicKey) throw new Refusal("no attested credential", 400);
      const id = Buffer.from(authData.credentialId).toString("base64url");
      if (body.id !== id) throw new Refusal("credential id does not match the attested one", 400);
      const jwk = coseToJwk(authData.publicKey);
      const transports = Array.isArray(response.transports) ? response.transports : [];
      if (transports.length > 8 || !transports.every((t) => typeof t === "string" && t.length <= 32)) {
        throw new Refusal("transports must be a short list of names", 400);
      }
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, MAX_LABEL) : DEFAULT_LABEL;
      if (store.credential(id)) throw new Refusal("this passkey is already registered", 409);
      store.add(id, JSON.stringify(jwk), transports as string[], label);
      log.info(`passkey registered: ${label} (${id.slice(0, 8)}…) — password sign-in is now off`);
      return c.json(listing(), 201);
    } catch (err) {
      return refused(c, err);
    }
  });

  app.delete("/api/passkeys/:id", (c) => {
    const id = c.req.param("id");
    if (!store.remove(id)) return c.json({ error: "no such passkey" }, 404);
    log.info(`passkey removed (${id.slice(0, 8)}…)${store.any() ? "" : " — password sign-in is back on"}`);
    return c.json(listing());
  });

  // Unauthenticated, so both share the password's throttle (auth.ts).
  app.post("/api/passkeys/login/options", (c) => {
    const client = clientOf(c);
    if (throttled(client)) return c.json({ error: "Too many attempts. Wait a few minutes." }, 429);
    try {
      const { rpId } = rpOrRefuse();
      const passkeys = store.list();
      if (!passkeys.length) throw new Refusal("no passkey is registered", 409);
      return c.json({
        challenge: issueChallenge("get"),
        rpId,
        allowCredentials: passkeys.map(({ id, transports }) => ({ type: "public-key", id, transports })),
        userVerification: "preferred",
        timeout: CHALLENGE_TTL_MS,
      });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/passkeys/login/verify", async (c) => {
    const client = clientOf(c);
    if (throttled(client)) {
      log.warn(`passkey login throttled for ${client}`);
      return c.json({ error: "Too many attempts. Wait a few minutes." }, 429);
    }
    try {
      const { rpId, origin } = rpOrRefuse();
      const body = await readJson(c);
      const response = responseOf(body);
      const id = typeof body.id === "string" ? body.id : "";
      const stored = store.credential(id);
      if (!stored) throw new Refusal("unknown passkey", 401);
      const clientData = bytesOf(response.clientDataJSON, "clientDataJSON");
      checkClientData(clientData, "webauthn.get", origin);
      const authDataBytes = bytesOf(response.authenticatorData, "authenticatorData");
      const authData = parseAuthData(authDataBytes);
      checkRpIdHash(authData, rpId);
      let key: KeyObject;
      try {
        key = createPublicKey({ key: JSON.parse(stored.publicKey) as JsonWebKey, format: "jwk" });
      } catch (err) {
        // A stored key that no longer loads is a database fault, not the caller's.
        log.error(`stored passkey ${id.slice(0, 8)}… has an unreadable public key`, err);
        throw new Refusal("stored passkey is unreadable — remove it", 401);
      }
      const signed = Buffer.concat([authDataBytes, sha256(clientData)]);
      if (!verifySignature("sha256", signed, key, bytesOf(response.signature, "signature"))) {
        throw new Refusal("signature does not verify", 401);
      }
      // A counter that went backwards means two authenticators hold this key.
      if (authData.signCount > 0 && authData.signCount <= stored.signCount) {
        log.error(
          `passkey ${stored.label} (${id.slice(0, 8)}…) presented sign count ${String(authData.signCount)} ≤ stored ${String(stored.signCount)} — cloned authenticator?`,
        );
        throw new Refusal("sign counter did not advance — refusing this passkey", 401);
      }
      store.used(id, authData.signCount);
      log.info(`passkey login from ${client}: ${stored.label}`);
      openSession(c, auth, client);
      return c.json({ next: safeNext(body.next) });
    } catch (err) {
      if (err instanceof Refusal) {
        noteFailure(client);
        log.warn(`passkey login refused for ${client}: ${err.message}`);
      }
      return refused(c, err);
    }
  });
}

/** For instance.ts: the host every stored passkey is bound to, or null. */
export const boundHost = (store: PasskeyStore, publicUrl: string): string | null => {
  if (!store.any()) return null;
  const rp = relyingParty(publicUrl);
  return "rpId" in rp ? rp.rpId : null;
};
