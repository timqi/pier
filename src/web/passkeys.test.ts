import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { SettingsStore } from "../settings.js";
import { UpdateCheck } from "../update.js";
import { AuthStore, registerAuthRoutes, requireAuth } from "./auth.js";
import { registerInstanceRoutes, type SecretsControl } from "./instance.js";
import { decodeCbor, PasskeyStore, registerPasskeyRoutes } from "./passkeys.js";

const RP = "pier.example.com";
const ORIGIN = `https://${RP}`;

// --- a tiny CBOR encoder, enough to write what an authenticator writes ---------------

type Item = number | Uint8Array | string | Item[] | Map<number | string, Item>;

function head(major: number, arg: number): Buffer {
  if (arg < 24) return Buffer.from([(major << 5) | arg]);
  if (arg < 0x100) return Buffer.from([(major << 5) | 24, arg]);
  if (arg < 0x10000) return Buffer.from([(major << 5) | 25, arg >> 8, arg & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(arg, 1);
  return out;
}

function encode(item: Item): Buffer {
  if (typeof item === "number") return item >= 0 ? head(0, item) : head(1, -1 - item);
  if (item instanceof Uint8Array) return Buffer.concat([head(2, item.length), item]);
  if (typeof item === "string") {
    const bytes = Buffer.from(item, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Array.isArray(item)) return Buffer.concat([head(4, item.length), ...item.map(encode)]);
  return Buffer.concat([head(5, item.size), ...[...item].flatMap(([k, v]) => [encode(k), encode(v)])]);
}

// --- a fake platform authenticator ------------------------------------------------

const sha256 = (data: string | Uint8Array): Buffer => createHash("sha256").update(data).digest();
const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");

class Authenticator {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly credentialId = randomBytes(16);
  counter = 0;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  coseKey(): Map<number, Item> {
    const jwk = this.publicKey.export({ format: "jwk" });
    return new Map<number, Item>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
  }

  authData(rpId: string, flags: number, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, this.credentialId, encode(this.coseKey()));
    }
    return Buffer.concat(parts);
  }

  clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What `navigator.credentials.create()` yields, already JSON-shaped. */
  attest(challenge: string, opts: { origin?: string; rpId?: string; label?: string } = {}): Record<string, unknown> {
    const attestationObject = encode(
      new Map<string, Item>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(opts.rpId ?? RP, 0x41, true)],
      ]),
    );
    return {
      id: this.id,
      type: "public-key",
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", challenge, opts.origin ?? ORIGIN)),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "hybrid"],
      },
    };
  }

  /** What `navigator.credentials.get()` yields. The counter advances unless pinned. */
  assert(
    challenge: string,
    opts: { origin?: string; rpId?: string; counter?: number; flags?: number; tamper?: boolean; next?: string } = {},
  ): Record<string, unknown> {
    this.counter = opts.counter ?? this.counter + 1;
    const authenticatorData = this.authData(opts.rpId ?? RP, opts.flags ?? 0x01, false);
    const clientDataJSON = this.clientData("webauthn.get", challenge, opts.origin ?? ORIGIN);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    if (opts.tamper) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0x01;
    return {
      id: this.id,
      type: "public-key",
      ...(opts.next !== undefined ? { next: opts.next } : {}),
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
    };
  }
}

// --- the app, wired like main.ts -------------------------------------------------

const fakeSecrets: SecretsControl = {
  state: "unlocked",
  mode: "file",
  lockedReason: "",
  unlock: () => Promise.resolve(),
  rotateKek: () => Promise.resolve(),
  doctor: () => Promise.resolve(""),
};

function setup(publicUrl = ORIGIN) {
  const db = openDb(":memory:");
  let printed = "";
  const auth = new AuthStore(db, (m) => {
    printed = m;
  });
  const password = printed.match(/[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}/)?.[0] ?? "";
  const settings = new SettingsStore(db);
  settings.setPublicUrl(publicUrl);
  const passkeys = new PasskeyStore(db);
  const app = new Hono();
  app.use("*", requireAuth(auth));
  registerAuthRoutes(app, auth, () => passkeys.any());
  registerPasskeyRoutes(app, { store: passkeys, auth, publicUrl: () => settings.get().publicUrl });
  registerInstanceRoutes(app, {
    settings,
    updates: new UpdateCheck("0.0.1", () => Promise.resolve("0.0.1")),
    secrets: fakeSecrets,
    passkeys,
  });
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return { app, auth, password, settings, passkeys, db };
}

/** Log in from a client id nothing else shares, so the throttle stays local. */
const client = () => crypto.randomUUID();

async function passwordLogin(app: Hono, password: string): Promise<Response> {
  return app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": client() },
    body: new URLSearchParams({ password, next: "/app/" }),
  });
}

const cookieOf = (res: Response): string => res.headers.get("set-cookie")?.split(";")[0] ?? "";

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

interface Listing {
  enabled: boolean;
  reason?: string;
  passkeys: { id: string; label: string; createdAt: number; lastUsedAt: number | null; transports: string[] }[];
}

/** The whole registration ceremony from a signed-in browser. */
async function registerWith(app: Hono, cookie: string, authenticator: Authenticator, label?: string): Promise<Response> {
  const options = await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } });
  expect(options.status).toBe(200);
  const { challenge } = (await options.json()) as { challenge: string };
  return app.request("/api/passkeys/register/verify", json(authenticator.attest(challenge, { label }), { cookie }));
}

/** Password sign-in first: the only way in before the first passkey. */
async function registered(app: Hono, password: string, authenticator = new Authenticator(), label?: string) {
  const cookie = cookieOf(await passwordLogin(app, password));
  return { cookie, verify: await registerWith(app, cookie, authenticator, label), authenticator };
}

async function loginOptions(app: Hono, from = client()): Promise<{ challenge: string; res: Response }> {
  const res = await app.request("/api/passkeys/login/options", { method: "POST", headers: { "x-forwarded-for": from } });
  const body = (await res.clone().json()) as { challenge?: string };
  return { challenge: body.challenge ?? "", res };
}

describe("availability", () => {
  it("offers nothing without an https public URL, and says why", async () => {
    const { app, password } = setup("");
    const cookie = cookieOf(await passwordLogin(app, password));
    const listing = (await (await app.request("/api/passkeys", { headers: { cookie } })).json()) as Listing;
    expect(listing.enabled).toBe(false);
    expect(listing.reason).toMatch(/https public URL/);
    expect(listing.passkeys).toEqual([]);

    const options = await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } });
    expect(options.status).toBe(409);
    expect(((await options.json()) as { error: string }).error).toBe(listing.reason);

    const verify = await app.request("/api/passkeys/register/verify", json({}, { cookie }));
    expect(verify.status).toBe(409);
  });

  it("refuses an http public URL too", async () => {
    const { app, password } = setup("http://pier.example.com");
    const cookie = cookieOf(await passwordLogin(app, password));
    expect((await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } })).status).toBe(409);
  });
});

describe("registration", () => {
  it("hands out creation options bound to the public URL's host", async () => {
    const { app, password } = setup();
    const cookie = cookieOf(await passwordLogin(app, password));
    const res = await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } });
    const options = (await res.json()) as Record<string, unknown>;
    expect(options.rp).toEqual({ id: RP, name: "Pier" });
    expect(Buffer.from(options.challenge as string, "base64url")).toHaveLength(32);
    const user = options.user as { id: string };
    expect(Buffer.from(user.id, "base64url")).toHaveLength(16);
    expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toEqual({ residentKey: "preferred", userVerification: "preferred" });
    expect(options.excludeCredentials).toEqual([]);

    // The user handle is minted once.
    const again = (await (await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } })).json()) as { user: { id: string } };
    expect(again.user.id).toBe(user.id);
  });

  it("stores a none attestation and lists it without key material", async () => {
    const { app, password, passkeys } = setup();
    const { verify, cookie, authenticator } = await registered(app, password, new Authenticator(), "MacBook");
    expect(verify.status).toBe(201);
    const listing = (await verify.json()) as Listing;
    expect(listing.enabled).toBe(true);
    expect(listing.passkeys).toHaveLength(1);
    expect(listing.passkeys[0]).toMatchObject({ id: authenticator.id, label: "MacBook", lastUsedAt: null, transports: ["internal", "hybrid"] });
    // Nothing from the key reaches the browser.
    const jwk = authenticator.publicKey.export({ format: "jwk" });
    expect(JSON.stringify(listing)).not.toContain(jwk.x);
    expect(JSON.stringify(await (await app.request("/api/passkeys", { headers: { cookie } })).json())).not.toContain(jwk.x);
    expect(passkeys.credential(authenticator.id)?.publicKey).toContain(jwk.x);

    // The next registration excludes what is already there.
    const options = (await (await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } })).json()) as {
      excludeCredentials: { id: string; transports: string[] }[];
    };
    expect(options.excludeCredentials).toEqual([{ type: "public-key", id: authenticator.id, transports: ["internal", "hybrid"] }]);
  });

  it("defaults and caps the label", async () => {
    const { app, password } = setup();
    const a = await registered(app, password);
    expect(((await a.verify.json()) as Listing).passkeys[0]?.label).toBe("a passkey");
    const b = await registerWith(app, a.cookie, new Authenticator(), "x".repeat(100));
    expect(((await b.json()) as Listing).passkeys[1]?.label).toHaveLength(80);
  });

  it("refuses a wrong origin, a wrong RP, a reused challenge and a stranger's body", async () => {
    const { app, password } = setup();
    const cookie = cookieOf(await passwordLogin(app, password));
    const authenticator = new Authenticator();
    const challengeOf = async () =>
      ((await (await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } })).json()) as { challenge: string }).challenge;

    const wrongOrigin = await app.request(
      "/api/passkeys/register/verify",
      json(authenticator.attest(await challengeOf(), { origin: "https://evil.example" }), { cookie }),
    );
    expect(wrongOrigin.status).toBe(400);
    expect(((await wrongOrigin.json()) as { error: string }).error).toMatch(/origin/);

    const wrongRp = await app.request(
      "/api/passkeys/register/verify",
      json(authenticator.attest(await challengeOf(), { rpId: "other.example" }), { cookie }),
    );
    expect(wrongRp.status).toBe(400);
    expect(((await wrongRp.json()) as { error: string }).error).toMatch(/rpIdHash/);

    const challenge = await challengeOf();
    expect((await app.request("/api/passkeys/register/verify", json(authenticator.attest(challenge), { cookie }))).status).toBe(201);
    const reused = await app.request("/api/passkeys/register/verify", json(new Authenticator().attest(challenge), { cookie }));
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as { error: string }).error).toMatch(/challenge/);

    // Without a cookie the boundary answers, not the ceremony.
    expect((await app.request("/api/passkeys/register/verify", json(authenticator.attest("x")))).status).toBe(401);
    expect((await app.request("/api/passkeys/register/verify", { method: "POST", headers: { cookie }, body: "not json" })).status).toBe(400);
  });
});

describe("password while a passkey exists", () => {
  it("is refused at both doors, and back after the last passkey goes", async () => {
    const { app, password, authenticator } = { ...setup(), authenticator: new Authenticator() };
    const { cookie } = await registered(app, password, authenticator);

    const form = await app.request("/login");
    const html = await form.text();
    expect(html).toContain("Sign in with a passkey");
    expect(html).not.toContain('type="password"');

    const refused = await passwordLogin(app, password);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Password sign-in is off while a passkey is registered.");
    expect(refused.headers.get("set-cookie")).toBeNull();

    const change = await app.request("/api/password", json({ current: password, next: "another-long-one" }, { cookie }));
    expect(change.status).toBe(403);

    const removed = await app.request(`/api/passkeys/${authenticator.id}`, { method: "DELETE", headers: { cookie } });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Listing).passkeys).toEqual([]);
    expect((await app.request(`/api/passkeys/${authenticator.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);

    expect(await (await app.request("/login")).text()).toContain('type="password"');
    expect((await passwordLogin(app, password)).status).toBe(302);
  });
});

describe("passkey login", () => {
  it("has no options to give before a passkey exists", async () => {
    const { app } = setup();
    const { res } = await loginOptions(app);
    expect(res.status).toBe(409);
  });

  it("opens a session on a good assertion and follows `next`", async () => {
    const { app, password, auth } = setup();
    const { authenticator } = await registered(app, password);

    const { challenge, res } = await loginOptions(app);
    expect(res.status).toBe(200);
    const options = (await res.json()) as Record<string, unknown>;
    expect(options.rpId).toBe(RP);
    expect(options.userVerification).toBe("preferred");
    expect(options.allowCredentials).toEqual([{ type: "public-key", id: authenticator.id, transports: ["internal", "hybrid"] }]);

    const from = client();
    const verify = await app.request(
      "/api/passkeys/login/verify",
      json(authenticator.assert(challenge, { next: "/app/#/settings" }), { "x-forwarded-for": from }),
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ next: "/app/#/settings" });
    const cookie = cookieOf(verify);
    expect(cookie).toMatch(/^pier_session=/);
    expect(verify.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await app.request("/api/ping", { headers: { cookie } })).status).toBe(200);
    expect(auth.list()).toHaveLength(2); // the password session that registered, and this one

    const listing = (await (await app.request("/api/passkeys", { headers: { cookie } })).json()) as Listing;
    expect(listing.passkeys[0]?.lastUsedAt).not.toBeNull();

    // A bad `next` is not followed off-site.
    const { challenge: second } = await loginOptions(app);
    const open = await app.request("/api/passkeys/login/verify", json(authenticator.assert(second, { next: "//evil.example" })));
    expect(await open.json()).toEqual({ next: "/app/" });
  });

  it("refuses a wrong origin, a reused challenge, a bad signature, a missing presence flag and a regressed counter", async () => {
    const { app, password } = setup();
    const { authenticator, cookie } = await registered(app, password);
    const attempt = async (body: Record<string, unknown>) => {
      const res = await app.request("/api/passkeys/login/verify", json(body, { "x-forwarded-for": client() }));
      return { status: res.status, error: ((await res.json()) as { error?: string }).error, cookie: res.headers.get("set-cookie") };
    };

    const wrongOrigin = await attempt(authenticator.assert((await loginOptions(app)).challenge, { origin: "https://evil.example" }));
    expect(wrongOrigin).toMatchObject({ status: 400, cookie: null });
    expect(wrongOrigin.error).toMatch(/origin/);

    const { challenge } = await loginOptions(app);
    expect((await attempt(authenticator.assert(challenge))).status).toBe(200);
    const reused = await attempt(authenticator.assert(challenge));
    expect(reused.status).toBe(400);
    expect(reused.error).toMatch(/challenge/);

    const tampered = await attempt(authenticator.assert((await loginOptions(app)).challenge, { tamper: true }));
    expect(tampered).toMatchObject({ status: 401, cookie: null });
    expect(tampered.error).toMatch(/signature/);

    const absent = await attempt(authenticator.assert((await loginOptions(app)).challenge, { flags: 0x00 }));
    expect(absent.status).toBe(400);
    expect(absent.error).toMatch(/presence/);

    // A registration challenge is not a login challenge.
    const create = (await (await app.request("/api/passkeys/register/options", { method: "POST", headers: { cookie } })).json()) as { challenge: string };
    expect((await attempt(authenticator.assert(create.challenge))).status).toBe(400);

    // The counter last accepted was 2 (one good login above): equal or lower is a clone.
    const stuck = await attempt(authenticator.assert((await loginOptions(app)).challenge, { counter: 2 }));
    expect(stuck).toMatchObject({ status: 401, cookie: null });
    expect(stuck.error).toMatch(/counter/);
    const back = await attempt(authenticator.assert((await loginOptions(app)).challenge, { counter: 1 }));
    expect(back.status).toBe(401);
    // An authenticator that does not count (always 0) stays welcome.
    expect((await attempt(authenticator.assert((await loginOptions(app)).challenge, { counter: 0 }))).status).toBe(200);
    expect((await attempt(authenticator.assert((await loginOptions(app)).challenge, { counter: 9 }))).status).toBe(200);

    const stranger = await attempt({ id: "nope", response: {} });
    expect(stranger.status).toBe(401);
  });

  it("shares the password's throttle", async () => {
    const { app, password } = setup();
    const { authenticator } = await registered(app, password);
    const from = client();
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/passkeys/login/verify", json(authenticator.assert("bogus"), { "x-forwarded-for": from }));
      expect(res.status).toBe(400);
    }
    expect((await loginOptions(app, from)).res.status).toBe(429);
    const { challenge } = await loginOptions(app);
    expect((await app.request("/api/passkeys/login/verify", json(authenticator.assert(challenge), { "x-forwarded-for": from }))).status).toBe(429);
    // Another address is unaffected.
    expect((await app.request("/api/passkeys/login/verify", json(authenticator.assert((await loginOptions(app)).challenge), { "x-forwarded-for": client() }))).status).toBe(200);
  });
});

describe("the public URL guard", () => {
  it("refuses to move the host or drop https while a passkey exists", async () => {
    const { app, password, settings, authenticator } = { ...setup(), authenticator: new Authenticator() };
    const { cookie } = await registered(app, password, authenticator);
    const put = (publicUrl: string) =>
      app.request("/api/settings", { ...json({ publicUrl }, { cookie }), method: "PUT" });

    const moved = await put("https://other.example.com");
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as { error: string }).error).toBe(`passkeys are bound to ${RP}; remove them first`);
    expect((await put("http://pier.example.com")).status).toBe(400);
    expect((await put("")).status).toBe(400);
    expect(settings.get().publicUrl).toBe(ORIGIN);

    // Same host, another path: nothing the credential is bound to changes.
    expect((await put("https://pier.example.com/pier")).status).toBe(200);
    expect(settings.get().publicUrl).toBe("https://pier.example.com/pier");

    await app.request(`/api/passkeys/${authenticator.id}`, { method: "DELETE", headers: { cookie } });
    expect((await put("https://other.example.com")).status).toBe(200);
  });
});

describe("decodeCbor", () => {
  it("reads the subset an attestation uses and refuses the rest", () => {
    const value = decodeCbor(encode(new Map<number | string, Item>([[1, 2], [3, -7], ["fmt", "none"], [-2, Buffer.from([1, 2, 3])], [4, ["a", 1000, 70000]]]))).value as Map<number | string, Item>;
    expect(value.get(1)).toBe(2);
    expect(value.get(3)).toBe(-7);
    expect(value.get("fmt")).toBe("none");
    expect(Buffer.from(value.get(-2) as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(value.get(4)).toEqual(["a", 1000, 70000]);

    expect(() => decodeCbor(Buffer.from([0x9f, 0x01, 0xff]))).toThrow(/length/); // indefinite array
    expect(() => decodeCbor(Buffer.from([0xf9, 0x3c, 0x00]))).toThrow(/major type/); // float
    expect(() => decodeCbor(Buffer.from([0xc0, 0x01]))).toThrow(/major type/); // tag
    expect(() => decodeCbor(Buffer.from([0x42, 0x01]))).toThrow(/truncated/); // 2-byte string, 1 byte given
    expect(() => decodeCbor(encode(new Map<number | string, Item>([[1, 1]])).fill(0xa1, 0, 1).subarray(0, 1))).toThrow(/truncated/);
  });
});
