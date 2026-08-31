import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { openDb } from "../db.js";
import { AuthStore } from "./auth.js";

/** A signed-in browser's session id — what a subscription has to name. */
const sessionOf = (auth: AuthStore, ip = "10.0.0.1"): string =>
  auth.open(ip, "a browser").split(".")[0] ?? "";
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
  const auth = new AuthStore(db, () => {});
  // Every subscription names the browser's session, so the tests that only
  // care about delivery still have to sign one in.
  const cookie = `pier_session=${auth.open("10.0.0.9", "a browser")}`;
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
  return { app, hub, store, auth, db, cookie, unread, channelOf, sent, status };
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
    const db = openDb(":memory:");
    const store = new PushStore(db);
    const auth = new AuthStore(db, () => {});
    const [one, two] = [sessionOf(auth), sessionOf(auth)];
    const sub = fakeSubscription();
    store.save({ endpoint: sub.endpoint, ...sub.keys }, "phone", one);
    store.save({ endpoint: sub.endpoint, ...sub.keys }, "phone, renamed", two);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.label).toBe("phone, renamed");
    for (let i = 0; i < 25; i++) {
      const s = fakeSubscription(`https://push.example.net/s/${String(i)}`);
      store.save({ endpoint: s.endpoint, ...s.keys }, `device ${String(i)}`, one);
    }
    expect(store.list().length).toBeLessThanOrEqual(20);
  });

  it("refuses a subscription for a session that does not exist", () => {
    const db = openDb(":memory:");
    const store = new PushStore(db);
    new AuthStore(db, () => {});
    const sub = fakeSubscription();
    // The foreign key is the rule; nothing has to remember to check it.
    expect(() => store.save({ endpoint: sub.endpoint, ...sub.keys }, "ghost", "no-such"))
      .toThrow(/FOREIGN KEY/i);
  });
});

describe("push routes", () => {
  it("hands a browser the key it subscribes with", async () => {
    const { app, store } = setup();
    const res = await app.request("/api/push");
    expect(await res.json()).toEqual({ publicKey: store.identity().publicKey });
  });

  it("accepts a subscription and forgets it on request", async () => {
    const { app, store, cookie } = setup();
    const sub = fakeSubscription();
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
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

  it("stops notifying a browser whose session ended, however it ended", async () => {
    const { app, store, auth } = setup();
    const subscribe = async (endpoint: string, cookie: string, status = 201) => {
      const res = await app.request("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(fakeSubscription(endpoint)),
      });
      expect(res.status).toBe(status);
    };
    const mine = auth.open("10.0.0.1", "mine");
    const theirs = auth.open("10.0.0.2", "theirs");
    await subscribe("https://push.example.net/s/mine", `pier_session=${mine}`);
    await subscribe("https://push.example.net/s/theirs", `pier_session=${theirs}`);
    expect(store.list()).toHaveLength(2);

    // Signing that browser out takes its subscription with it — otherwise it
    // keeps receiving titles and reply previews it can no longer open.
    auth.revoke(auth.list().find((d) => d.ip === "10.0.0.2")?.id ?? "");
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example.net/s/mine"]);

    // A browser signed out between the boundary letting its request in and the
    // body arriving is told so, rather than handed a row nothing owns.
    await subscribe("https://push.example.net/s/theirs", `pier_session=${theirs}`, 401);

    // A password change signs out everyone, so it notifies nobody.
    auth.setPassword("a-brand-new-password");
    expect(store.list()).toHaveLength(0);
  });

  it("stops notifying a session that expired on its own", async () => {
    const { app, store, auth, db } = setup();
    const cookie = auth.open("10.0.0.3", "a browser");
    await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `pier_session=${cookie}` },
      body: JSON.stringify(fakeSubscription()),
    });
    expect(store.list()).toHaveLength(1);

    // Unused for longer than the TTL: the next look at that cookie deletes the
    // row, and the subscription goes with it. "It timed out" is not a kind of
    // gone that keeps notifying a phone.
    db.prepare("UPDATE web_sessions SET seen_at = ?").run(Date.now() - 8 * 24 * 60 * 60_000);
    expect(auth.check(cookie)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("stops notifying an expired session nobody ever comes back to", async () => {
    const { app, store, auth, db, cookie } = setup();
    await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(fakeSubscription()),
    });
    db.prepare("UPDATE web_sessions SET seen_at = ?").run(Date.now() - 8 * 24 * 60 * 60_000);

    // No request ever carries that cookie again — the boot sweep is what
    // notices, and the key takes the subscription with the row.
    auth.sweep();
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

  const subscribe = async (app: Hono, cookie: string) => {
    const sub = fakeSubscription();
    await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
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
    const { app, hub, sent, cookie } = setup(6_000);
    await subscribe(app, cookie);
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
    const { app, hub, sent, channelOf, cookie } = setup(6_000);
    await subscribe(app, cookie);
    channelOf.mockReturnValue("slack");
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("stays quiet when a client reported the turn as seen", async () => {
    const { app, hub, sent, unread, cookie } = setup(6_000);
    await subscribe(app, cookie);
    unread.mockReturnValue(false);
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("ignores a session that was already idle when it was first seen", async () => {
    const { app, hub, sent, cookie } = setup(6_000);
    await subscribe(app, cookie);
    hub.emitWorkspace({ type: "session-state", sessionId: "s1", state: "idle" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toHaveLength(0);
  });

  it("stops watching a session once its turn ended", async () => {
    const { app, hub, cookie } = setup(6_000);
    await subscribe(app, cookie);
    finishTurn(hub);
    // A watched session's ring buffer is never released (core/hub.ts), so the
    // subscription must not outlive the turn it was opened for.
    expect(hub.hasSubscribers("s1")).toBe(false);
  });

  it("drops a subscription the push service says is gone, and only then", async () => {
    const { app, hub, store, status, cookie } = setup(6_000);
    await subscribe(app, cookie);
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
    const { app, hub, sent, cookie } = setup(6_000);
    const sub = await subscribe(app, cookie);
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
    const { app, hub, sent, cookie } = setup(6_000, "[operator<web> 12:01]\nfix the parser");
    const sub = await subscribe(app, cookie);
    finishTurn(hub);
    await vi.advanceTimersByTimeAsync(6_000);
    const payload = JSON.parse(decryptPush(sent[0]!.body, sub)) as PushPayload;
    expect(payload.title).toBe("fix the parser");
  });

  it("still says something when the turn ended with no text", async () => {
    const { app, hub, sent, cookie } = setup(6_000);
    const sub = await subscribe(app, cookie);
    finishTurn(hub, "");
    await vi.advanceTimersByTimeAsync(6_000);
    const payload = JSON.parse(decryptPush(sent[0]!.body, sub)) as PushPayload;
    expect(payload.body).toBe("Turn finished.");
  });
});
