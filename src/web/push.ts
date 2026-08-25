// Notifications for the workbench that is not on screen: which browsers asked
// to be told, and the one rule that decides a push — a turn that finished and
// that nobody looked at. The wire format is webpush.ts.
//
// The rule is deliberately the same one the sidebar's unread dot uses, read a
// few seconds late: a client with that session visible acks immediately, so
// "still unread when the dust settled" is precisely "nobody saw it". One rule,
// one place — a second notion of attention would drift from the dot within a
// release.

import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import type { EventHub } from "../core/hub.js";
import { pierDb } from "../db.js";
import { logger } from "../log.js";
import {
  generateVapidKeys,
  type PushTarget,
  sendPush,
  type VapidKeys,
} from "./webpush.js";

const log = logger("push");

/** Devices kept at once. A browser mints a new subscription whenever the old
 *  one expires, so the table grows by itself; the oldest rows are the ones
 *  already dead. */
const MAX_SUBSCRIPTIONS = 20;
/** How long a finished turn waits for a client to say it was seen. Long enough
 *  to cross a heartbeat and a slow phone, short enough to still be a
 *  notification about something that just happened. */
const SETTLE_MS = 6_000;
const MAX_BODY_CHARS = 160;

export interface PushSubscriptionRow extends PushTarget {
  /** The browser that subscribed, as it described itself — the only way to
   *  tell two rows apart in the Console. */
  label: string;
  createdAt: number;
}

/** Subscriptions and the instance's VAPID identity. Both are per-instance
 *  facts nobody edits by hand, so they live beside every other one. */
export class PushStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.#db = db;
  }

  /** The key pair every push is signed with, minted on first use. Losing it
   *  would invalidate every subscription made with it, so it is created once
   *  and never rotated on its own. */
  identity(): VapidKeys {
    const row = this.#db
      .prepare("SELECT public_key AS publicKey, private_key AS privateKey FROM push_identity WHERE id = 1")
      .get() as VapidKeys | undefined;
    if (row) return row;
    const keys = generateVapidKeys();
    this.#db
      .prepare("INSERT INTO push_identity(id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)")
      .run(keys.publicKey, keys.privateKey, Date.now());
    log.info("minted this instance's VAPID key pair");
    return keys;
  }

  list(): PushSubscriptionRow[] {
    return this.#db
      .prepare(
        `SELECT endpoint, p256dh, auth, label, created_at AS createdAt
         FROM push_subscriptions ORDER BY created_at DESC`,
      )
      .all() as unknown as PushSubscriptionRow[];
  }

  /** Upsert: a browser re-posts the same subscription on every load, which is
   *  what repairs a row this instance lost. */
  save(target: PushTarget, label: string): void {
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions(endpoint, p256dh, auth, label, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
      )
      .run(target.endpoint, target.p256dh, target.auth, label, Date.now());
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

/** What a service worker is handed. Kept small on purpose: a push service need
 *  not carry more than 4 kB, and everything else is one fetch away. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a click lands — the session's own route. */
  url: string;
  /** Replaces an earlier notification about the same session. */
  tag: string;
}

export interface PushDeps {
  store: PushStore;
  hub: EventHub;
  /** Still unread = nobody acked it = nobody was looking. */
  unread(sessionId: string): boolean;
  /** Which conversation the session is answering (`web`, `slack`, `task`, …),
   *  or nothing when it answers none. A turn Pier already delivered to a chat
   *  is not notified about again. */
  channelOf(sessionId: string): string | undefined;
  /** What to call the session in the notification's title. */
  name(sessionId: string): string;
  /** This Pier's public URL, for the VAPID `sub` claim (a push service wants
   *  a way to contact whoever is sending) and for nothing else. */
  publicUrl(): string;
  /** Test seam — the settle delay is the whole policy, so a test must own it. */
  settleMs?: number;
}

/** One line of what the agent said, for a notification shade. */
const preview = (text: string): string => {
  const line = text.replace(/```[\s\S]*?```/g, "…").replace(/\s+/g, " ").trim();
  return line.length > MAX_BODY_CHARS ? `${line.slice(0, MAX_BODY_CHARS - 1)}…` : line;
};

/** A subscription is only accepted in the exact shape the Push API produces;
 *  a half-valid one would fail later, inside a background send nobody watches. */
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
  const { store, hub, unread, channelOf, name, publicUrl, settleMs = SETTLE_MS } = deps;

  /** Who a push service should complain to. It has to be a mailto: or https:
   *  URL or Apple rejects the token outright, so an instance that never had
   *  its public URL set still needs an answer. */
  const subject = (): string => {
    const url = publicUrl();
    return url.startsWith("https://") ? url : "mailto:pier@localhost";
  };

  /** Send to every device, and prune the ones the service says are gone. A
   *  failure is logged with what the service said — a notification that never
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
      // 404/410 is the push service saying this subscription is dead for good
      // — the only status that may cost a row.
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
  // A session is watched only while it streams: the ring buffer of a session
  // nobody watches is released on eviction (core/hub.ts), and a permanent
  // subscriber would keep every one of them alive.

  /** Per streaming session: stop watching, and hand back what the turn said.
   *  The text lives in the watcher's own closure, so it cannot outlive the
   *  subscription that collected it. */
  const watching = new Map<string, () => string>();

  hub.subscribeWorkspace((e) => {
    if (e.type !== "session-state") return;
    if (e.state === "streaming") {
      if (watching.has(e.sessionId)) return;
      let text = "";
      const stop = hub.subscribe(e.sessionId, (ev) => {
        if (ev.type === "turn-end") text = ev.text;
      });
      watching.set(e.sessionId, () => {
        stop();
        return text;
      });
      return;
    }
    // No start witnessed → a session that booted idle, not a finished turn.
    const finish = watching.get(e.sessionId);
    if (!finish) return;
    watching.delete(e.sessionId);
    const text = finish();
    // The workbench's own sessions only. A turn that came from Slack, Telegram
    // or Lark was already delivered to the chat it came from — the person has
    // it, and their phone buzzing twice for one answer is what a notification
    // budget gets spent on. Read now, not in the timer: this is the state that
    // produced the turn.
    // Every outcome says which one it was: a push that was never sent and one
    // that arrived look identical from here otherwise, and "why did my phone
    // stay quiet" is the only question this feature is ever asked (§5b).
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
      void deliver({
        title: name(e.sessionId),
        body: preview(text) || "Turn finished.",
        url: `/#/session/${encodeURIComponent(e.sessionId)}`,
        tag: e.sessionId,
      }).catch((err: unknown) => log.error("delivering a push failed", err));
    }, settleMs);
    // A pending notification must never hold a shutting-down process open.
    timer.unref?.();
  });

  // --- routes ---------------------------------------------------------------------

  // The key a browser subscribes with. Public by nature — it is what a push
  // service checks our signature against.
  app.get("/api/push", (c) => c.json({ publicKey: store.identity().publicKey }));

  app.post("/api/push/subscribe", async (c) => {
    const body = await c.req.json().catch(() => null);
    const target = parseTarget(body);
    if (!target) return c.json({ error: "not a push subscription" }, 400);
    const label = String((body as { label?: unknown }).label ?? "a browser").slice(0, 80);
    store.save(target, label);
    log.info(`subscribed ${label}`);
    return c.json({ ok: true }, 201);
  });

  app.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    if (typeof endpoint !== "string") return c.json({ error: "endpoint required" }, 400);
    return c.json({ removed: store.remove(endpoint) });
  });

  // "Did that actually work?" — the only way to answer it on a phone, where a
  // permission granted to the wrong context looks exactly like a granted one.
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
