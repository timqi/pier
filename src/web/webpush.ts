// The Web Push wire format, and only that: RFC 8291 message encryption
// (ECDH P-256 → HKDF → one aes128gcm record) and RFC 8292 VAPID
// authorization. Who is notified, and why, is push.ts.
//
// Written on node:crypto instead of pulled in: the whole format is one ECDH,
// two HKDFs, one AES-GCM record and a JWT, and every step of it has a
// published test vector (webpush.test.ts runs the RFC's). A dependency here
// would be new transitive code inside the process that holds the operator's
// provider keys, buying ~120 lines (principle 8).

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

/** A subscription as the browser hands it over: where to POST, and the two
 *  keys the receiving service worker will decrypt with. */
export interface PushTarget {
  endpoint: string;
  /** UA public key, uncompressed P-256 point, base64url (65 bytes). */
  p256dh: string;
  /** UA authentication secret, base64url (16 bytes). */
  auth: string;
}

/** The instance's VAPID identity — a P-256 key pair, base64url. The public
 *  half is also what a browser subscribes with, so it is not a secret. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** RFC 8291 §4: one record, and a push service need not accept more than 4096
 *  octets of body. Header (86) + padding (1) + GCM tag (16) leaves this. */
export const MAX_PUSH_PLAINTEXT = 3993;
const RECORD_SIZE = 4096;
/** VAPID token lifetime. Apple refuses anything past 24h; half a day is well
 *  inside every push service's limit and still outlives a slow retry. */
const TOKEN_TTL_S = 12 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");

/** A P-256 scalar is 32 octets; OpenSSL hands back the minimal encoding, so a
 *  key with a zero high byte is one octet short of what JWK accepts. */
const pad32 = (b: Buffer): Buffer =>
  b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64(ecdh.getPublicKey()),
    privateKey: b64(pad32(ecdh.getPrivateKey())),
  };
}

/**
 * Encrypt one push message for `target` (RFC 8291 §3.4, RFC 8188 header).
 *
 * `salt` and `serverKey` are injectable for exactly one reason: the RFC's
 * worked example is the only way to prove this implementation is right, and it
 * fixes both. Nothing else may pass them — a reused salt is a broken cipher.
 */
export function encryptPush(
  plaintext: string | Buffer,
  target: PushTarget,
  { salt = randomBytes(16), serverKey }: { salt?: Buffer; serverKey?: Buffer } = {},
): Buffer {
  const body = Buffer.from(plaintext);
  if (body.length > MAX_PUSH_PLAINTEXT) {
    throw new Error(`push payload is ${String(body.length)} bytes, over ${String(MAX_PUSH_PLAINTEXT)}`);
  }
  const uaPublic = unb64(target.p256dh);
  const ecdh = createECDH("prime256v1");
  // computeSecret() rejects a point that is not on the curve, which is the
  // validation RFC 8291 §7 asks for before a private key touches it.
  if (serverKey) ecdh.setPrivateKey(serverKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, unb64(target.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 is the padding delimiter of the last (here: only) record.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([body, Buffer.of(2)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** The `Authorization` a push service checks before it accepts anything: a
 *  short-lived ES256 JWT bound to the service's own origin, plus the public
 *  key the subscription was created with (RFC 8292 §3). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const token = [
    b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }))),
    b64(Buffer.from(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + TOKEN_TTL_S,
      sub: subject,
    }))),
  ].join(".");
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64(pub.subarray(1, 33)),
      y: b64(pub.subarray(33, 65)),
      d: b64(pad32(unb64(keys.privateKey))),
    },
  });
  // JOSE wants the raw r||s pair; node's default for EC keys is DER.
  const signature = sign("sha256", Buffer.from(token), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${token}.${b64(signature)}, k=${keys.publicKey}`;
}

/** What the push service said. `status: 0` is "the request never got an
 *  answer" — kept distinct from a rejection so a caller never prunes a
 *  subscription because the network was down. */
export interface PushResult {
  status: number;
  error?: string;
}

/** POST one encrypted message. Never throws: every outcome is a result the
 *  caller can log or act on. */
export async function sendPush(
  target: PushTarget,
  payload: string,
  keys: VapidKeys,
  subject: string,
  ttlSeconds = 4 * 60 * 60,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPush(payload, target);
  } catch (err) {
    return { status: 0, error: `encrypting failed: ${String(err)}` };
  }
  try {
    const res = await fetchImpl(target.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(target.endpoint, keys, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(ttlSeconds),
        urgency: "normal",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { status: res.status };
    // The service's own sentence is the only thing that explains a 400 from
    // Apple or a 403 from FCM; without it the operator sees a bare number.
    const said = (await res.text().catch(() => "")).slice(0, 200);
    return { status: res.status, error: said || res.statusText };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}
