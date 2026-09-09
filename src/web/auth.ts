// The boundary in front of every HTTP surface: one shared password, generated
// before the listener opens and printed once. The cookie is "<id>.<token>" and
// the database keeps only the token's SHA-256, one row per browser: a copy of
// pier.db cannot be turned into a session, and one browser can be signed out
// alone. A cookie, not a bearer header, because EventSource sends no headers.

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { pierDb, statements, transact } from "../db.js";
import { readCapped } from "../core/inbox.js";
import { logger } from "../log.js";

const log = logger("auth");

const COOKIE = "pier_session";
/** Sliding: a stolen cookie is dead a week after its last use. */
const TTL_MS = 7 * 24 * 60 * 60_000;
/** Absolute, so daily use cannot slide one cookie forever: every browser
 *  re-authenticates a quarter after it signed in. */
const MAX_AGE_MS = 90 * 24 * 60 * 60_000;
/** One `seen_at` write per browser per five minutes instead of one per request. */
const TOUCH_MS = 5 * 60_000;
/** Not an id any row can have. */
export const ALL = "*";

/** The token is never in here. */
export interface Device {
  id: string;
  createdAt: number;
  seenAt: number;
  ip: string;
  agent: string;
}
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
/** Distinct throttle buckets retained at once; the last is shared overflow. */
const MAX_FAILURE_CLIENTS = 1024;
const OVERFLOW_CLIENT = "\0overflow";
/** The floor under which the throttle above stops being enough. */
const MIN_LENGTH = 10;
/** A password and a path fit; a stranger may not ask for more parsing than that. */
const MAX_LOGIN_BODY = 4096;
// scrypt at Node's defaults (N=16384): ~50ms per attempt, which is the point.
const KEY_BYTES = 32;

/** No 0/O, 1/l/I, so it survives being typed off a terminal into a phone; 15
 *  of 31 symbols is ~74 bits. `randomInt` rejection-samples — `% 31` on a byte
 *  would favour the first eight symbols. */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = Array.from({ length: 15 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
}

/** Generation happens in the constructor: "no password" is not a state Pier
 *  may ever serve in. */
export class AuthStore {
  readonly #db: DatabaseSync;
  readonly #sql: (sql: string) => StatementSync;
  readonly #revokeListeners = new Set<(id: string) => void>();

  constructor(db: DatabaseSync = pierDb(), print: (message: string) => void = (m) => log.info(m)) {
    this.#db = db;
    this.#sql = statements(db);

    let row = this.#row();
    if (!row) {
      const password = generatePassword();
      const salt = randomBytes(16).toString("hex");
      row = { salt, hash: hash(password, salt), createdAt: Date.now() };
      // Also the forgotten-password path ("DELETE FROM auth"): browsers signed
      // in under the old one must not walk through it.
      transact(this.#db, () => {
        this.#sql("INSERT INTO auth(id, salt, hash, created_at) VALUES (1, ?, ?, ?)")
          .run(salt, hash(password, salt), Date.now());
        this.#dropSessions();
      });
      print(
        `\nthis instance had no password, so one was generated:\n\n    ${password}\n\n` +
          `only its hash is stored — it is not printed again. ` +
          `Lost it? "DELETE FROM auth" in the database, then restart.\n`,
      );
    }
    // A session that expired while Pier was down must not keep notifying a phone.
    this.sweep();
  }

  #row(): { salt: string; hash: string; createdAt: number } | undefined {
    return this.#sql("SELECT salt, hash, created_at AS createdAt FROM auth WHERE id = 1")
      .get() as { salt: string; hash: string; createdAt: number } | undefined;
  }

  /** Private: callers must also tell the listeners; `revoke(ALL)` is that pair. */
  #dropSessions(): void {
    this.#sql("DELETE FROM web_sessions").run();
  }

  /** Deleted, not merely refused: a push subscription hangs off the row. */
  sweep(): void {
    const now = Date.now();
    const swept = this.#sql(
      "DELETE FROM web_sessions WHERE seen_at <= ? OR created_at <= ? RETURNING id",
    ).all(now - TTL_MS, now - MAX_AGE_MS) as unknown as { id: string }[];
    for (const row of swept) this.#revoked(row.id);
    if (swept.length) log.info(`swept ${String(swept.length)} expired session(s)`);
  }

  verify(password: string): boolean {
    const row = this.#row();
    return row ? sameSecret(hash(password, row.salt), row.hash) : false;
  }

  /** Every session goes too, the caller's included: a password is changed
   *  because the old one may be known. Listeners hear it after the commit. */
  setPassword(password: string): void {
    const salt = randomBytes(16).toString("hex");
    transact(this.#db, () => {
      this.#sql("UPDATE auth SET salt = ?, hash = ?, created_at = ? WHERE id = 1")
        .run(salt, hash(password, salt), Date.now());
      this.#dropSessions();
    });
    this.#revoked(ALL);
  }

  open(ip: string, agent: string): string {
    const now = Date.now();
    this.sweep();
    // The id names the row; the 256-bit token is the only part that resists guessing.
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    this.#sql(
      "INSERT INTO web_sessions(id, token_hash, created_at, seen_at, ip, agent)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, digest(token), now, now, ip, agent.slice(0, 200));
    return `${id}.${token}`;
  }

  /** `renewed` is the cue to resend the cookie with a new Max-Age: the window
   *  must slide on both sides or the browser drops a cookie the database honours. */
  check(cookie: string | undefined): { id: string; renewed: boolean } | undefined {
    const [id, token] = (cookie ?? "").split(".");
    if (!id || !token) return undefined;
    const row = this.#sql(
      "SELECT token_hash AS tokenHash, seen_at AS seenAt, created_at AS createdAt" +
        " FROM web_sessions WHERE id = ?",
    ).get(id) as { tokenHash: string; seenAt: number; createdAt: number } | undefined;
    const now = Date.now();
    // Deleted here, not left for the next sweep: a session nobody may use must
    // stop being a device Pier notifies at the same moment.
    if (!row) return undefined;
    if (now - row.seenAt >= TTL_MS || now - row.createdAt >= MAX_AGE_MS) {
      this.revoke(id);
      return undefined;
    }
    if (!sameSecret(digest(token), row.tokenHash)) return undefined;
    if (now - row.seenAt < TOUCH_MS) return { id, renewed: false };
    this.#sql("UPDATE web_sessions SET seen_at = ? WHERE id = ?").run(now, id);
    return { id, renewed: true };
  }

  /** Listeners hear the same id: a revoked cookie must also close what it opened. */
  revoke(id: string): void {
    if (id === ALL) this.#dropSessions();
    else this.#sql("DELETE FROM web_sessions WHERE id = ?").run(id);
    this.#revoked(id);
  }

  list(): Device[] {
    return this.#sql(
      "SELECT id, created_at AS createdAt, seen_at AS seenAt, ip, agent" +
        " FROM web_sessions WHERE seen_at > ? ORDER BY seen_at DESC",
    ).all(Date.now() - TTL_MS) as unknown as Device[];
  }

  /** A long-lived authenticated surface (SSE) closes itself when its cookie is revoked. */
  onRevoke(listener: (id: string) => void): void {
    this.#revokeListeners.add(listener);
  }

  /** The row is already gone; a surface that never hears stays open on a dead session. */
  #revoked(id: string): void {
    for (const listener of this.#revokeListeners) {
      try {
        listener(id);
      } catch (err) {
        log.error(`a revocation listener failed for session ${id}`, err);
      }
    }
  }
}

const hash = (password: string, salt: string): string =>
  scryptSync(password, salt, KEY_BYTES).toString("hex");

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The login form and `/p/*` — published boards and their stylesheet — are the
 *  single exempt prefix docs/architecture.md reserves; `/boards/*` stays behind. */
function isPublic(method: string, path: string): boolean {
  if (path === "/login") return method === "GET" || method === "HEAD" || method === "POST";
  if (method !== "GET" && method !== "HEAD") return false;
  return path.startsWith("/p/");
}

/** Constant-time equality that also hides length: both sides are digested. */
function sameSecret(a: string, b: string): boolean {
  const bytes = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(bytes(a), bytes(b));
}

/** `//evil.example` is protocol-relative and browsers normalize `/\evil.example`
 *  to it — and they strip whitespace and control characters from a Location
 *  first, which turns `/<TAB>/evil.example` into one as well. Only a plain
 *  path survives; anything else is an open redirect. */
const safeNext = (raw: unknown): string =>
  typeof raw === "string" && /^\/(?![/\\])\S*$/.test(raw) &&
    ![...raw].some((ch) => ch <= "\u001f" || ch === "\u007f")
    ? raw
    : "/";

// In memory: the window is minutes, and the point is to make guessing slow.
// Fresh identities spill into one overflow bucket once the cap is reached.
const failures = new Map<string, { count: number; resetAt: number }>();

const loopback = (address: string): boolean =>
  address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

function remoteOf(c: Context): string | undefined {
  const env = c.env as
    | { incoming?: unknown; server?: { incoming?: unknown } }
    | undefined;
  return env?.incoming || env?.server?.incoming
    ? getConnInfo(c).remote.address
    : undefined;
}

/** A forwarded address is trusted only from a local reverse proxy, and only
 *  the rightmost hop, which that proxy appended. */
function clientOf(c: Context): string {
  const remote = remoteOf(c);
  if (remote && !loopback(remote)) return remote;
  return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || remote || "local";
}

function failureClient(client: string): string {
  if (failures.has(client) || failures.size < MAX_FAILURE_CLIENTS - 1) return client;
  return OVERFLOW_CLIENT;
}

function throttled(client: string): boolean {
  const now = Date.now();
  for (const [id, entry] of failures) if (entry.resetAt <= now) failures.delete(id);
  return (failures.get(failureClient(client))?.count ?? 0) >= MAX_FAILURES;
}

function noteFailure(client: string): void {
  client = failureClient(client);
  const entry = failures.get(client);
  if (entry && entry.resetAt > Date.now()) entry.count += 1;
  else failures.set(client, { count: 1, resetAt: Date.now() + WINDOW_MS });
}

/** Hosts, not schemes: TLS commonly terminates at the reverse proxy. */
function originMatches(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // curl and other non-browser clients
  try {
    const parsed = new URL(origin);
    const external = new URL(`${parsed.protocol}//${host ?? ""}`);
    return parsed.origin === origin && external.origin === parsed.origin &&
      external.pathname === "/" && !external.search && !external.hash;
  } catch {
    return false;
  }
}

function sameOrigin(c: Context): boolean {
  const remote = remoteOf(c);
  const forwarded = remote && loopback(remote)
    ? c.req.header("x-forwarded-host")?.split(",").at(-1)?.trim()
    : undefined;
  return originMatches(
    c.req.header("origin"),
    forwarded || c.req.header("host") || new URL(c.req.url).host,
  );
}

/** The boundary already verified the token; exported so a push subscription
 *  names its browser the same way. */
export const sessionIdOf = (c: Context): string => (getCookie(c, COOKIE) ?? "").split(".")[0] ?? "";

export function requireAuth(store: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    // Public responses too: the login form must not be frameable either, and a
    // served file must not be sniffed into a type its content-type denies.
    c.header("x-frame-options", "DENY");
    c.header("x-content-type-options", "nosniff");
    if (isPublic(c.req.method, c.req.path)) return next();
    const cookie = getCookie(c, COOKIE);
    const session = store.check(cookie);
    const unsafe = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (session && unsafe && !sameOrigin(c)) {
      log.warn(`blocked ${c.req.method} ${c.req.path} from origin ${c.req.header("origin")}`);
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (session) {
      if (session.renewed && cookie) setSessionCookie(c, cookie);
      await next();
      // Cookie-authenticated content must not become public in a shared proxy.
      if (!c.res.headers.has("cache-control")) {
        c.header("cache-control", c.req.path.startsWith("/api/") ? "private, no-store" : "private");
      }
      return;
    }
    // An API caller gets a status it can act on; a navigation gets the form.
    if (c.req.path.startsWith("/api/") || unsafe) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  };
}

export function registerAuthRoutes(app: Hono, store: AuthStore): void {
  app.get("/login", (c) => c.html(loginPage(safeNext(c.req.query("next")))));

  app.post("/login", async (c) => {
    const client = clientOf(c);
    // Before the body is touched: parsing is work, and this is the one write a
    // stranger may reach. The remembered destination is a casualty of that.
    if (throttled(client)) {
      // A burst here is the only warning an operator gets that the port is being knocked on.
      log.warn(`login throttled for ${client}`);
      return c.html(loginPage("/", "Too many attempts. Wait a few minutes."), 429);
    }
    if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return c.text("expected the sign-in form", 400);
    }
    // The read is the bound, not `content-length`: a chunked request declares
    // no length, and a parser handed the whole stream is the work being denied.
    let body: Uint8Array;
    try {
      body = await readCapped(c.req.raw.body, MAX_LOGIN_BODY);
    } catch (err) {
      log.warn(`sign-in body refused from ${client}: ${String(err)}`);
      return c.text("sign-in body too large", 413);
    }
    const form = new URLSearchParams(new TextDecoder().decode(body));
    const next = safeNext(form.get("next"));
    if (!store.verify(form.get("password") ?? "")) {
      noteFailure(client);
      log.warn(`wrong password from ${client}`);
      return c.html(loginPage(next, "Wrong password."), 401);
    }
    failures.delete(client);
    log.info(`login from ${client}`);
    // Replaces this browser's session rather than adding one. Verified first:
    // the id in an unverified cookie is a string the caller chose, and `ALL` is
    // one of them.
    const previous = store.check(getCookie(c, COOKIE));
    if (previous) store.revoke(previous.id);
    setSessionCookie(c, store.open(client, c.req.header("user-agent") ?? ""));
    return c.redirect(next);
  });

  // Re-authenticates: the boundary requires a live cookie, and knowing a
  // password is not permission to call APIs.
  app.post("/api/password", async (c) => {
    const client = clientOf(c);
    const body = (await c.req.json().catch(() => null)) as
      | { current?: unknown; next?: unknown }
      | null;
    const current = typeof body?.current === "string" ? body.current : "";
    const next = typeof body?.next === "string" ? body.next : "";
    if (throttled(client)) return c.json({ error: "Too many attempts. Wait a few minutes." }, 429);
    if (!store.verify(current)) {
      noteFailure(client);
      return c.json({ error: "Wrong current password." }, 403);
    }
    if (next.length < MIN_LENGTH) {
      return c.json({ error: `Use at least ${MIN_LENGTH} characters.` }, 400);
    }
    failures.delete(client);
    store.setPassword(next);
    // The rotation dropped this caller's row too; clear the dead cookie.
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Not /api/sessions: that is the agent's sessions, and one vocabulary for
  // two unrelated things is how the wrong one gets ended.
  app.get("/api/devices", (c) => {
    const current = sessionIdOf(c);
    return c.json(store.list().map((d) => ({ ...d, current: d.id === current })));
  });

  app.post("/api/devices/:id/signout", (c) => {
    const id = c.req.param("id");
    // Signing everyone out is the password change, which also invalidates
    // the password they know.
    if (id === ALL) return c.json({ error: "not a session id" }, 400);
    store.revoke(id);
    log.info(`signed out session ${id}`);
    if (id === sessionIdOf(c)) deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // The row is deleted, not just the cookie cleared, so a copy of that cookie is dead too.
  app.post("/logout", (c) => {
    store.revoke(sessionIdOf(c));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
}

function setSessionCookie(c: Context, value: string): void {
  setCookie(c, COOKIE, value, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    // A Secure cookie on plain http is dropped, locking out loopback and SSH
    // tunnels. The forwarded scheme counts only from a local proxy: anywhere
    // else a stranger wrote the header.
    secure: new URL(c.req.url).protocol === "https:" ||
      (c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim() === "https" &&
        loopback(remoteOf(c) ?? "")),
    maxAge: TTL_MS / 1000,
  });
}

/** Self-contained: it links nothing the boundary would refuse to serve. */
function loginPage(next: string, error?: string): string {
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#fafafa" />
<title>Pier</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; height: 100dvh; display: grid; place-items: center; background: #fafafa;
    color: #262626; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif }
  form { display: grid; gap: .75rem; width: min(20rem, 88vw) }
  h1 { margin: 0; font-size: 1rem; font-weight: 600; letter-spacing: .01em }
  input { padding: .5rem .625rem; font-size: 1rem; color: inherit; background: #fff;
    border: 1px solid #d4d4d4; border-radius: .5rem }
  input:focus { outline: 2px solid #a3a3a3; outline-offset: -1px }
  button { padding: .5rem; font: inherit; font-weight: 500; color: #fafafa; background: #262626;
    border: 0; border-radius: .5rem; cursor: pointer }
  p { margin: 0; font-size: .8125rem; color: #dc2626 }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Pier</h1>
    ${error ? `<p>${attr(error)}</p>` : ""}
    <input type="password" name="password" placeholder="Password" autocomplete="current-password"
      autofocus required />
    <input type="hidden" name="next" value="${attr(next)}" />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>
`;
}
