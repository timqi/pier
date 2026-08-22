// The boundary in front of every HTTP surface: one shared password.
//
// Single-account on purpose. Pier has one workspace, so there is nobody to
// tell apart — an internet-facing deployment needs a *boundary*, not
// identities. Multiple people using it share the page, and share the password.
//
// Nothing to configure before first run: the store generates a password on an
// empty database, keeps only its scrypt hash, and prints the plaintext once to
// the log. There is no window where the port is open and unclaimed — the
// password exists before the listener does — and no env var for an operator to
// get wrong. Forgot it? Delete the row and restart; a new one is printed.
//
// The cookie is a signed expiry, not a stored session id: an HMAC keyed by the
// stored hash. No session table, no pruning — and changing the password
// changes the key, so every cookie already out there dies with it. That is the
// whole revocation story a single-user system needs. A cookie (not a bearer
// header) because the workbench lives on SSE, and EventSource sends no headers.

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { pierDb } from "../db.js";
import { logger } from "../log.js";

const log = logger("auth");

const COOKIE = "pier_session";
const TTL_MS = 90 * 24 * 60 * 60_000;
/** Failed attempts one client may make before it has to wait out the window. */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
/** Distinct throttle buckets retained at once; the last is shared overflow. */
const MAX_FAILURE_CLIENTS = 1024;
const OVERFLOW_CLIENT = "\0overflow";
/** Shortest password a human may choose. The generated one is longer; this is
 *  the floor under which the throttle above stops being enough. */
const MIN_LENGTH = 10;
// scrypt at Node's defaults (N=16384): ~50ms per attempt, which is the point.
const KEY_BYTES = 32;

/**
 * Human-readable and unambiguous: no 0/O, 1/l/I, so it survives being read off
 * a terminal and typed into a phone. 15 characters from a 31-symbol alphabet is
 * ~74 bits — this is the only thing between the internet and a shell.
 *
 * `randomInt` rejection-samples. Folding a random byte with `% 31` would have
 * quietly favoured the first eight symbols, which is the kind of bias nothing
 * ever reports.
 */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = Array.from({ length: 15 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
}

/**
 * The stored credential: one row, one password, hashed.
 *
 * Generation happens in the constructor because "no password" is not a state
 * Pier may ever serve in — a boot that cannot print the password it just made
 * should fail at boot, not open a door.
 */
export class AuthStore {
  readonly #db: DatabaseSync;
  /** HMAC key for cookies: the hash, so rotating the password expires them. */
  #key: string;

  constructor(db: DatabaseSync = pierDb(), print: (message: string) => void = (m) => log.info(m)) {
    this.#db = db;

    let row = this.#row();
    if (!row) {
      const password = generatePassword();
      const salt = randomBytes(16).toString("hex");
      row = { salt, hash: hash(password, salt), createdAt: Date.now() };
      this.#db
        .prepare("INSERT INTO auth(id, salt, hash, created_at) VALUES (1, ?, ?, ?)")
        .run(row.salt, row.hash, row.createdAt);
      print(
        `\nthis instance had no password, so one was generated:\n\n    ${password}\n\n` +
          `only its hash is stored — it is not printed again. ` +
          `Lost it? "DELETE FROM auth" in the database, then restart.\n`,
      );
    }
    this.#key = row.hash;
  }

  #row(): { salt: string; hash: string; createdAt: number } | undefined {
    return this.#db
      .prepare("SELECT salt, hash, created_at AS createdAt FROM auth WHERE id = 1")
      .get() as { salt: string; hash: string; createdAt: number } | undefined;
  }

  /** Whether this is the password, compared in constant time. */
  verify(password: string): boolean {
    const row = this.#row();
    return row ? sameSecret(hash(password, row.salt), row.hash) : false;
  }

  /**
   * Replace the password, salt and all.
   *
   * The new hash becomes the cookie key, so every cookie signed with the old
   * one — every other browser, and the caller's own — stops verifying. That is
   * the point: a password is changed because the old one may be known.
   */
  setPassword(password: string): void {
    const salt = randomBytes(16).toString("hex");
    const next = hash(password, salt);
    this.#db
      .prepare("UPDATE auth SET salt = ?, hash = ?, created_at = ? WHERE id = 1")
      .run(salt, next, Date.now());
    this.#key = next;
  }

  /** Cookie signing key. Never the password: that is not stored anywhere. */
  get cookieKey(): string {
    return this.#key;
  }

}

const hash = (password: string, salt: string): string =>
  scryptSync(password, salt, KEY_BYTES).toString("hex");

/**
 * What a logged-out visitor must still reach: the login form, published
 * boards, and the stylesheet those boards link — a published board rendering
 * unstyled for the person it was published to is the same bug as not serving
 * it. `/boards/*` stays behind the boundary; `/p/*` is the published mirror,
 * the single exempt prefix `docs/architecture.md` reserved for this.
 */
function isPublic(method: string, path: string): boolean {
  if (path === "/login") return method === "GET" || method === "HEAD" || method === "POST";
  if (method !== "GET" && method !== "HEAD") return false;
  return path.startsWith("/p/") || path === "/boards/_assets/pier.css";
}

const sign = (secret: string, expiresAt: number): string =>
  createHmac("sha256", secret).update(String(expiresAt)).digest("base64url");

/** Constant-time equality that also hides length: both sides are digested. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function valid(secret: string, cookie: string | undefined): boolean {
  const [exp, sig] = (cookie ?? "").split(".");
  const expiresAt = Number(exp);
  if (!sig || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  return sameSecret(sig, sign(secret, expiresAt));
}

/**
 * Only a same-origin path may be returned to after login. `//evil.example` is a
 * protocol-relative URL rather than a path, and browsers normalize a backslash
 * to a slash, so `/\evil.example` is the same trick spelled differently — both
 * are what a `startsWith("/")` check alone hands an open redirect to.
 */
const safeNext = (raw: unknown): string =>
  typeof raw === "string" && /^\/(?![/\\])/.test(raw) ? raw : "/";

// Failed logins per client, in memory: a restart clearing them is fine, since
// the window is minutes and the point is to make guessing slow, not to keep
// books. Expired entries are pruned, and fresh identities spill into one
// overflow bucket once the fixed map cap is reached.
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

/** Trust a forwarded address only from a local reverse proxy. The rightmost
 * hop is the address that proxy appended, not one the client put at the front. */
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

/** Browsers name the source of unsafe requests. Compare hosts rather than
 * schemes because TLS commonly terminates at the reverse proxy. */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true; // curl and other non-browser clients
  try {
    const parsed = new URL(origin);
    const remote = remoteOf(c);
    const forwarded = remote && loopback(remote)
      ? c.req.header("x-forwarded-host")?.split(",").at(-1)?.trim()
      : undefined;
    const host = forwarded || c.req.header("host") || new URL(c.req.url).host;
    const external = new URL(`${parsed.protocol}//${host}`);
    return parsed.origin === origin && external.origin === parsed.origin &&
      external.pathname === "/" && !external.search && !external.hash;
  } catch {
    return false;
  }
}

/** Every route, in one place — no per-route opt-in to forget on the next one. */
export function requireAuth(store: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    if (isPublic(c.req.method, c.req.path)) return next();
    const authenticated = valid(store.cookieKey, getCookie(c, COOKIE));
    const unsafe = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (authenticated && unsafe && !sameOrigin(c)) {
      log.warn(`blocked ${c.req.method} ${c.req.path} from origin ${c.req.header("origin")}`);
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (authenticated) {
      await next();
      // Cookie-authenticated content must not become public in a shared proxy.
      if (!c.res.headers.has("cache-control")) {
        c.header("cache-control", c.req.path.startsWith("/api/") ? "private, no-store" : "private");
      }
      c.header("x-frame-options", "DENY");
      return;
    }
    // An API caller gets a status it can act on; a navigation gets the form.
    // Anything non-GET is a client call too — never a link worth redirecting.
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
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    if (throttled(client)) {
      // The one surface strangers can reach: a burst here is the only warning
      // an operator gets that the port is being knocked on.
      log.warn(`login throttled for ${client}`);
      return c.html(loginPage(next, "Too many attempts. Wait a few minutes."), 429);
    }
    if (!store.verify(typeof form.password === "string" ? form.password : "")) {
      noteFailure(client);
      log.warn(`wrong password from ${client}`);
      return c.html(loginPage(next, "Wrong password."), 401);
    }
    failures.delete(client);
    log.info(`login from ${client}`);
    issueCookie(c, store);
    return c.redirect(next);
  });

  // Re-authenticate before rotating the credential. The global boundary also
  // requires a live cookie; knowing a password is not permission to call APIs.
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
    // The rotation just killed this caller's cookie too; re-issue rather than
    // bounce the person who is holding the new password to the login form.
    issueCookie(c, store);
    return c.json({ ok: true });
  });
}

/** The signed-in cookie, set the same way by login and by a password change. */
function issueCookie(c: Context, store: AuthStore): void {
  const expiresAt = Date.now() + TTL_MS;
  setCookie(c, COOKIE, `${expiresAt}.${sign(store.cookieKey, expiresAt)}`, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    // Set only over TLS: a Secure cookie on plain http is dropped, which
    // would lock out the loopback and SSH-tunnel setups.
    secure: c.req.header("x-forwarded-proto") === "https" ||
      new URL(c.req.url).protocol === "https:",
    maxAge: TTL_MS / 1000,
  });
}

/**
 * Self-contained HTML: the login page must render before the workbench bundle
 * is reachable, so it links nothing the boundary would refuse to serve.
 */
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
