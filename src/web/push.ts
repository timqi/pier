// Notifications for the workbench that is not on screen. The rule is the
// sidebar's unread dot, read a few seconds late: a client with the session
// visible acks immediately, so "still unread" is precisely "nobody saw it".
// The wire format is webpush.ts.

import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import type { EventHub } from "../core/hub.js";
import { sessionLabel } from "../core/identity.js";
import { pierDb } from "../db.js";
import { logger } from "../log.js";
import { isSealed, type Secrets } from "../secrets.js";
import { sessionIdOf } from "./auth.js";
import {
  generateVapidKeys,
  type PushTarget,
  sendPush,
  type VapidKeys,
} from "./webpush.js";

const log = logger("push");

/** A browser mints a new subscription whenever the old one expires, so the
 *  table grows by itself; the oldest rows are the dead ones. */
const MAX_SUBSCRIPTIONS = 20;
/** Long enough to cross a heartbeat and a slow phone. */
const SETTLE_MS = 6_000;
const MAX_BODY_CHARS = 160;

export interface PushSubscriptionRow extends PushTarget {
  /** The only way to tell two rows apart in the Console. */
  label: string;
  createdAt: number;
}

/** SQLite's "that parent row does not exist": the session ended. */
const FOREIGN_KEY_VIOLATION = 787;
const sessionGone = (err: unknown): boolean =>
  (err as { errcode?: number }).errcode === FOREIGN_KEY_VIOLATION;

export class PushStore {
  readonly #db: DatabaseSync;

  /** Without `secrets` (tests), the private key persists as given. A locked
   *  store throws rather than serving a key it cannot read. */
  constructor(db: DatabaseSync = pierDb(), private readonly secrets?: Secrets) {
    this.#db = db;
  }

  /** Rotating it would invalidate every subscription made with it. */
  identity(): VapidKeys {
    const row = this.#db
      .prepare("SELECT public_key AS publicKey, private_key AS privateKey FROM push_identity WHERE id = 1")
      .get() as VapidKeys | undefined;
    if (row) return { ...row, privateKey: this.#unsealed(row.privateKey) };
    const keys = generateVapidKeys();
    this.#db
      .prepare("INSERT INTO push_identity(id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)")
      .run(keys.publicKey, this.#sealed(keys.privateKey), Date.now());
    log.info("minted this instance's VAPID key pair");
    return keys;
  }

  /** A key minted before sealing is honored once and sealed in place — the pair
   *  cannot be replaced without invalidating every subscription. */
  #unsealed(stored: string): string {
    if (!this.secrets) return stored;
    if (isSealed(stored)) return this.secrets.decrypt(stored);
    this.#db.prepare("UPDATE push_identity SET private_key = ? WHERE id = 1")
      .run(this.secrets.encrypt(stored));
    log.info("sealed this instance's VAPID private key");
    return stored;
  }

  #sealed(privateKey: string): string {
    return this.secrets ? this.secrets.encrypt(privateKey) : privateKey;
  }

  list(): PushSubscriptionRow[] {
    return this.#db
      .prepare(
        `SELECT endpoint, p256dh, auth, label, created_at AS createdAt
         FROM push_subscriptions ORDER BY created_at DESC`,
      )
      .all() as unknown as PushSubscriptionRow[];
  }

  /** Upsert: a browser re-posts on every load, which repairs a lost row and
   *  re-attaches one to the session signed in now. */
  save(target: PushTarget, label: string, sessionId: string): void {
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions(endpoint, p256dh, auth, label, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
           session_id = excluded.session_id`,
      )
      .run(target.endpoint, target.p256dh, target.auth, label, Date.now(), sessionId);
    this.#db
      .prepare(
        `DELETE FROM push_subscriptions WHERE endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(MAX_SUBSCRIPTIONS);
  }

  remove(endpoint: string): boolean {
    return this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint).changes > 0;
  }
}

/** A push service need not carry more than 4 kB. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Replaces an earlier notification about the same session. */
  tag: string;
}

export interface PushDeps {
  store: PushStore;
  hub: EventHub;
  unread(sessionId: string): boolean;
  /** A turn Pier already delivered to a chat is not notified about again. */
  channelOf(sessionId: string): string | undefined;
  summary(sessionId: string): Promise<{ title?: string; cwd: string } | undefined>;
  /** For the VAPID `sub` claim only. */
  publicUrl(): string;
  /** Test seam. */
  settleMs?: number;
}

const preview = (text: string): string => {
  const line = text.replace(/```[\s\S]*?```/g, "…").replace(/\s+/g, " ").trim();
  return line.length > MAX_BODY_CHARS ? `${line.slice(0, MAX_BODY_CHARS - 1)}…` : line;
};

/** A half-valid subscription would fail later, inside a send nobody watches. */
function parseTarget(body: unknown): PushTarget | null {
  const { endpoint, keys } = (body ?? {}) as { endpoint?: unknown; keys?: Record<string, unknown> };
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1000) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // 65 octets of uncompressed P-256 point, 16 of authentication secret.
  if (Buffer.from(p256dh, "base64url").length !== 65) return null;
  if (Buffer.from(auth, "base64url").length !== 16) return null;
  return { endpoint, p256dh, auth };
}

export function registerPushRoutes(app: Hono, deps: PushDeps): void {
  const { store, hub, unread, channelOf, summary, publicUrl, settleMs = SETTLE_MS } = deps;

  /** Must be a mailto: or https: URL or Apple rejects the token outright. */
  const subject = (): string => {
    const url = publicUrl();
    return url.startsWith("https://") ? url : "mailto:pier@localhost";
  };

  /** A failure is logged with what the service said: a notification that never
   *  arrives is otherwise indistinguishable from one nobody tapped. */
  async function deliver(payload: PushPayload): Promise<{ sent: number; failed: number }> {
    const targets = store.list();
    if (!targets.length) return { sent: 0, failed: 0 };
    const keys = store.identity();
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    await Promise.all(targets.map(async (target) => {
      const { status, error } = await sendPush(target, body, keys, subject());
      if (status >= 200 && status < 300) {
        sent += 1;
        log.info(`notified ${target.label}`);
        return;
      }
      failed += 1;
      // 404/410 is "dead for good", the only status that may cost a row.
      if (status === 404 || status === 410) {
        store.remove(target.endpoint);
        log.info(`dropped an expired subscription (${target.label})`);
        return;
      }
      log.warn(`push to ${target.label} failed: ${String(status)} ${error ?? ""}`.trim());
    }));
    return { sent, failed };
  }

  // --- the trigger ----------------------------------------------------------------
  // Watched only while streaming: a permanent subscriber would keep every
  // session's ring buffer alive (core/hub.ts).
  const watching = new Map<string, () => string>();

  hub.subscribeWorkspace((e) => {
    if (e.type !== "session-state") return;
    if (e.state === "streaming") {
      if (watching.has(e.sessionId)) return;
      let text = "";
      // The last turn that said something: a run ends one turn per answer, and
      // a silence after the answer would replace it with "Turn finished."
      const stop = hub.subscribe(e.sessionId, (ev) => {
        if (ev.type === "turn-end") text = ev.text || text;
      });
      watching.set(e.sessionId, () => {
        stop();
        return text;
      });
      return;
    }
    const finish = watching.get(e.sessionId);
    if (!finish) return;
    watching.delete(e.sessionId);
    const text = finish();
    // An IM turn was already delivered to its chat. Read now, not in the
    // timer: this is the state that produced the turn. Every outcome is logged:
    // "why did my phone stay quiet" is the only question this is asked (§5).
    const channel = channelOf(e.sessionId);
    if (channel !== "web") {
      log.debug(`no push for ${e.sessionId}: answering ${channel ?? "nothing"}, not the workbench`);
      return;
    }
    const timer = setTimeout(() => {
      if (!unread(e.sessionId)) {
        log.debug(`no push for ${e.sessionId}: a client reported the turn as seen`);
        return; // somebody has it on screen
      }
      // One async step before the send, so a failure in either half is reported.
      void (async () => {
        await deliver({
          title: sessionLabel(await summary(e.sessionId)),
          body: preview(text) || "Turn finished.",
          url: `/#/session/${encodeURIComponent(e.sessionId)}`,
          tag: e.sessionId,
        });
      })().catch((err: unknown) => log.error(`delivering a push for ${e.sessionId} failed`, err));
    }, settleMs);
    // A pending notification must never hold a shutting-down process open.
    timer.unref?.();
  });

  // --- routes ---------------------------------------------------------------------

  app.get("/api/push", (c) => c.json({ publicKey: store.identity().publicKey }));

  app.post("/api/push/subscribe", async (c) => {
    const body = await c.req.json().catch(() => null);
    const target = parseTarget(body);
    if (!target) return c.json({ error: "not a push subscription" }, 400);
    const label = String((body as { label?: unknown }).label ?? "a browser").slice(0, 80);
    // The foreign key can refuse: the browser was signed out while its body
    // was still arriving. Say so rather than 500.
    try {
      store.save(target, label, sessionIdOf(c));
    } catch (err) {
      // Only that: a full database answering 401 would send a signed-in browser
      // to the login form.
      if (!sessionGone(err)) throw err;
      log.warn(`subscription refused for a session that ended: ${String(err)}`);
      return c.json({ error: "session ended" }, 401);
    }
    log.info(`subscribed ${label}`);
    return c.json({ ok: true }, 201);
  });

  app.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    if (typeof endpoint !== "string") return c.json({ error: "endpoint required" }, 400);
    return c.json({ removed: store.remove(endpoint) });
  });

  // On a phone, a permission granted to the wrong context looks like a granted one.
  app.post("/api/push/test", async (c) => {
    const { sent, failed } = await deliver({
      title: "Pier",
      body: "Notifications are working.",
      url: "/",
      tag: "pier-test",
    });
    if (!sent && !failed) return c.json({ error: "no device is subscribed" }, 409);
    return c.json({ sent, failed });
  });
}
