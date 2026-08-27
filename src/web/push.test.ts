import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { openDb } from "../db.js";
import { PushStore, type PushPayload, registerPushRoutes } from "./push.js";

/** A subscription in the shape the Push API hands over: real P-256 point, real
 *  16-byte secret, so nothing downstream has to be told to skip validation.
 *  The private half stays here, so a test can read what was actually sent. */
function fakeSubscription(endpoint = "https://push.example.net/s/1") {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    label: "a browser",
    ua,
  };
}

/** What the service worker does with the bytes: RFC 8291 in reverse. */
function decryptPush(body: Uint8Array, sub: ReturnType<typeof fakeSubscription>): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const asPublic = buf.subarray(21, 21 + buf.readUInt8(20));
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    Buffer.from(sub.keys.p256dh, "base64url"),
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync(
    "sha256",
    sub.ua.computeSecret(asPublic),
    Buffer.from(sub.keys.auth, "base64url"),
    keyInfo,
    32,
  ));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const sealed = buf.subarray(21 + asPublic.length);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2); // padding delimiter
  return plain.subarray(0, -1).toString();
}

function setup(settleMs = 0, title = "pier") {
  const db = openDb(":memory:");
  const hub = new EventHub();
  const store = new PushStore(db);
  const unread = vi.fn(() => true);
  const channelOf = vi.fn((_id: string): string | undefined => "web");
  const app = new Hono();
  registerPushRoutes(app, {
    store,
    hub,
    unread,
    channelOf,
    summary: async () => ({ title, cwd: "/tmp/pier" }),
    publicUrl: () => "https://pier.example.com",
    settleMs,
  });
  const sent: { url: string; body: Uint8Array }[] = [];
  const status = { code: 201, body: "" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: init.body as Uint8Array });
    return new Response(status.body, { status: status.code });
  }));
  return { app, hub, store, unread, channelOf, sent, status };
}

afterEach(() => vi.unstubAllGlobals());

describe("PushStore", () => {
  it("mints one VAPID identity and keeps it", () => {
    const store = new PushStore(openDb(":memory:"));
    const first = store.identity();
    expect(first.publicKey).toHaveLength(87); // 65 raw octets, base64url
    expect(store.identity()).toEqual(first);
  });

  it("upserts by endpoint and caps how many devices it keeps", () => {
    const store = new PushStore(openDb(":memory:"));
    const sub = fakeSubscription();
    store.save({ endpoint: sub.endpoint, ...sub.keys }, "phone");
    store.save({ endpoint: sub.endpoint, ...sub.keys }, "phone, renamed");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.label).toBe("phone, renamed");
    for (let i = 0; i < 25; i++) {
      const s = fakeSubscription(`https://push.example.net/s/${String(i)}`);
      store.save({ endpoint: s.endpoint, ...s.keys }, `device ${String(i)}`);
    }
    expect(store.list().length).toBeLessThanOrEqual(20);
  });
});

describe("push routes", () => {
  it("hands a browser the key it subscribes with", async () => {
    const { app, store } = setup();
    const res = await app.request("/api/push");
    expect(await res.json()).toEqual({ publicKey: store.identity().publicKey });
  });

  it("accepts a subscription and forgets it on request", async () => {
    const { app, store } = setup();
    const sub = fakeSubscription();
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub),
    });
    expect(res.status).toBe(201);
    expect(store.list()).toHaveLength(1);
    await app.request("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(store.list()).toHaveLength(0);
  });

  it("rejects anything that is not a Push API subscription", async () => {
    const { app, store } = setup();
    const bad = [
      { endpoint: "http://push.example.net/s/1", keys: fakeSubscription().keys },
      { endpoint: "https://push.example.net/s/1", keys: { p256dh: "short", auth: "short" } },
      { endpoint: "https://push.example.net/s/1" },
      {},
    ];
    for (const body of bad) {
      const res = await app.request("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(store.list()).toHaveLength(0);
  });

  it("says so instead of pretending to send when nothing is subscribed", async () => {
    const { app } = setup();
    const res = await app.request("/api/push/test", { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("the finished-turn trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const subscribe = async (app: Hono) => {
    const sub = fakeSubscription();
    await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub),
    });
    return sub;
  };

  /** streaming → turn-end → idle, the transition every surface reads. */
  const finishTurn = (hub: EventHub, text = "all done") => {
    hub.emitWorkspace({ type: "session-state", sessionId: "s1", state: "streaming" });
    hub.emit("s1", { type: "turn-end", text });
    hub.emitWorkspace({ type: "session-state", sessionId: "s1", state: "idle" });
  };

  it("notifies every device once the turn is still unread", async () => {
    const { app, hub, sent } = setup(6_000);
    await subscribe(app);
    finishTurn(hub);
    expect(sent).toHaveLength(0); // not before the settle window
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://push.example.net/s/1");
    expect(sent[0]?.body.byteLength).toBeGreaterThan(86);
  });

  it("stays quiet for a turn that was already delivered to a chat", async () => {
    // Slack, Telegram and Lark carry the answer themselves; a push would be
    // the same reply a second time, on the same phone.
    const { app, hub, sent, channelOf } = setup(6_000);
    await subscribe(app);
    channelOf.mockReturnValue("slack");
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("stays quiet when a client reported the turn as seen", async () => {
    const { app, hub, sent, unread } = setup(6_000);
    await subscribe(app);
    unread.mockReturnValue(false);
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("ignores a session that was already idle when it was first seen", async () => {
    const { app, hub, sent } = setup(6_000);
    await subscribe(app);
    hub.emitWorkspace({ type: "session-state", sessionId: "s1", state: "idle" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("stops watching a session once its turn ended", async () => {
    const { app, hub } = setup(6_000);
    await subscribe(app);
    finishTurn(hub);
    // A watched session's ring buffer is never released (core/hub.ts), so the
    // subscription must not outlive the turn it was opened for.
    expect(hub.hasSubscribers("s1")).toBe(false);
  });

  it("drops a subscription the push service says is gone, and only then", async () => {
    const { app, hub, store, status } = setup(6_000);
    await subscribe(app);
    status.code = 500;
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(store.list()).toHaveLength(1);
    status.code = 410;
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(store.list()).toHaveLength(0);
  });

  it("carries a payload the subscribed browser can decrypt", async () => {
    // End to end through the real encryption: what the browser gets is what
    // the trigger built, not a shape only this test believes in.
    const { app, hub, sent } = setup(6_000);
    const sub = await subscribe(app);
    finishTurn(hub, "```js\ncode\n```\n  the   answer  ");
    await vi.advanceTimersByTimeAsync(6_000);
    const payload = JSON.parse(decryptPush(sent[0]!.body, sub)) as PushPayload;
    expect(payload).toEqual({
      title: "pier",
      body: "… the answer",
      url: "/#/session/s1",
      tag: "s1",
    });
  });

  it("names the session without the speaker header its title carries", async () => {
    // The header is the model's (core/identity.ts). Left on, every session
    // opened from the workbench announces itself on a lock screen as
    // "[operator<web> 12:01]" and the notification says nothing at all.
    const { app, hub, sent } = setup(6_000, "[operator<web> 12:01]\nfix the parser");
    const sub = await subscribe(app);
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    const payload = JSON.parse(decryptPush(sent[0]!.body, sub)) as PushPayload;
    expect(payload.title).toBe("fix the parser");
  });

  it("still says something when the turn ended with no text", async () => {
    const { app, hub, sent } = setup(6_000);
    const sub = await subscribe(app);
    finishTurn(hub, "");
    await vi.advanceTimersByTimeAsync(6_000);
    const payload = JSON.parse(decryptPush(sent[0]!.body, sub)) as PushPayload;
    expect(payload.body).toBe("Turn finished.");
  });
});
