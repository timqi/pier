import { describe, expect, it } from "vitest";
import {
  encryptPush,
  generateVapidKeys,
  MAX_PUSH_PLAINTEXT,
  sendPush,
  vapidAuthorization,
} from "./webpush.js";

// RFC 8291 §5 + Appendix A — the published worked example. Every value below
// is copied from the RFC; if this passes, the derivation is the standard one.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const target = { endpoint: "https://push.example.net/push/x", p256dh: RFC.uaPublic, auth: RFC.auth };

describe("encryptPush", () => {
  it("reproduces the RFC 8291 example byte for byte", () => {
    const body = encryptPush(RFC.plaintext, target, {
      salt: Buffer.from(RFC.salt, "base64url"),
      serverKey: Buffer.from(RFC.asPrivate, "base64url"),
    });
    expect(body.toString("base64url")).toBe(RFC.body);
  });

  it("uses a fresh ephemeral key and salt for every message", () => {
    // Same input twice: identical bytes would mean a reused salt or key pair,
    // which is the one way to break this cipher without touching it.
    // (push.test.ts decrypts a real one; here only the freshness is at stake.)
    const first = encryptPush("hello", target);
    const second = encryptPush("hello", target);
    expect(first.subarray(0, 16)).not.toEqual(second.subarray(0, 16));
    expect(first.subarray(21, 86)).not.toEqual(second.subarray(21, 86));
  });

  it("refuses a payload no push service would accept", () => {
    expect(() => encryptPush("x".repeat(MAX_PUSH_PLAINTEXT + 1), target)).toThrow(/over/);
  });

  it("refuses a public key that is not on the curve", () => {
    const bogus = { ...target, p256dh: Buffer.alloc(65, 4).toString("base64url") };
    expect(() => encryptPush("hi", bogus)).toThrow();
  });
});

describe("vapidAuthorization", () => {
  const keys = generateVapidKeys();

  it("signs an ES256 token bound to the push service's origin", () => {
    const header = vapidAuthorization(
      "https://web.push.apple.com/abc/def",
      keys,
      "https://pier.example.com",
      1_700_000_000_000,
    );
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(publicKey).toBe(keys.publicKey);
    const [head, payload, signature] = (token ?? "").split(".");
    expect(JSON.parse(Buffer.from(head ?? "", "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      aud: "https://web.push.apple.com",
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: "https://pier.example.com",
    });
    // Raw r||s, not DER — a DER signature is what every push service rejects.
    expect(Buffer.from(signature ?? "", "base64url")).toHaveLength(64);
  });
});

describe("sendPush", () => {
  const keys = generateVapidKeys();

  it("posts an encrypted body with the aes128gcm headers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendPush(target, JSON.stringify({ title: "hi" }), keys, "mailto:a@b.c", 60, fake);
    expect(result).toEqual({ status: 201 });
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.ttl).toBe("60");
    expect(headers.authorization).toMatch(/^vapid t=/);
    expect((seen!.init.body as Uint8Array).byteLength).toBeGreaterThan(86);
  });

  it("reports what the push service said instead of throwing", async () => {
    const fake = (async () => new Response("gone", { status: 410 })) as unknown as typeof fetch;
    expect(await sendPush(target, "{}", keys, "mailto:a@b.c", 60, fake))
      .toEqual({ status: 410, error: "gone" });
  });

  it("reports a request that never got an answer as status 0", async () => {
    const fake = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await sendPush(target, "{}", keys, "mailto:a@b.c", 60, fake);
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
