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
// The cookie is "<id>.<token>", and the database keeps the token's SHA-256 —
// one row per signed-in browser. Two things follow, and both are why this is
// not the signed expiry it used to be: a copy of pier.db cannot be turned into
// a session (there is no signing key in it to forge with), and a single
// browser can be signed out without changing the password everyone shares. A
// cookie (not a bearer header) because the workbench lives on SSE, and
// EventSource sends no headers.

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { pierDb, transact } from "../db.js";
import { logger } from "../log.js";

const log = logger("auth");

const COOKIE = "pier_session";
/** How long an idle browser stays signed in. Sliding: a session in daily use
 *  never expires, and a stolen cookie is dead a week after its last use. */
const TTL_MS = 7 * 24 * 60 * 60_000;
/** How stale `seen_at` may get before a request writes. Renewal rides on it,
 *  so this is also how coarse "last seen" is — one write per browser per five
 *  minutes instead of one per request. */
const TOUCH_MS = 5 * 60_000;
/** `revoke(ALL)` — not an id any row can have, so it cannot collide with one. */
export const ALL = "*";

/** A signed-in browser as the Console shows it. The token is never in here. */
export interface Device {
  id: string;
  createdAt: number;
  seenAt: number;
  ip: string;
  agent: string;
}
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
  readonly #revokeListeners = new Set<(id: string) => void>();

  constructor(db: DatabaseSync = pierDb(), print: (message: string) => void = (m) => log.info(m)) {
    this.#db = db;

    let row = this.#row();
    if (!row) {
      const password = generatePassword();
      const salt = randomBytes(16).toString("hex");
      row = { salt, hash: hash(password, salt), createdAt: Date.now() };
      // Recovery is "DELETE FROM auth and restart", so this branch is also how
      // a forgotten password is replaced — and the browsers signed in under the
      // old one must not walk through it. Their rows go with the credential,
      // in one transaction: half of this leaves a new password and live old
      // cookies, which is the state recovery exists to end.
      transact(this.#db, () => {
        this.#db
          .prepare("INSERT INTO auth(id, salt, hash, created_at) VALUES (1, ?, ?, ?)")
          .run(salt, hash(password, salt), Date.now());
        this.#dropSessions();
      });
      print(
        `\nthis instance had no password, so one was generated:\n\n    ${password}\n\n` +
          `only its hash is stored — it is not printed again. ` +
          `Lost it? "DELETE FROM auth" in the database, then restart.\n`,
      );
    }
    // Boot is the one moment that comes around on its own. Without it, a
    // session that expired while Pier was down would sit there notifying a
    // phone until somebody happened to sign in.
    this.sweep();
  }

  #row(): { salt: string; hash: string; createdAt: number } | undefined {
    return this.#db
      .prepare("SELECT salt, hash, created_at AS createdAt FROM auth WHERE id = 1")
      .get() as { salt: string; hash: string; createdAt: number } | undefined;
  }

  /** Every signed-in browser at once. Private: the callers that mean it also
   *  have to tell the listeners, and `revoke(ALL)` is that pair in public. */
  #dropSessions(): void {
    this.#db.prepare("DELETE FROM web_sessions").run();
  }

  /** Sessions nobody may use any more, deleted rather than merely refused: a
   *  row is what a push subscription hangs off, so "expired" has to become
   *  "gone" without waiting for the browser to come back and be told. Run at
   *  boot and whenever somebody signs in — the two moments the process has a
   *  reason to look at this table at all. */
  sweep(): void {
    const swept = this.#db
      .prepare("DELETE FROM web_sessions WHERE seen_at <= ? RETURNING id")
      .all(Date.now() - TTL_MS) as unknown as { id: string }[];
    for (const row of swept) this.#revoked(row.id);
    if (swept.length) log.info(`swept ${String(swept.length)} expired session(s)`);
  }

  /** Whether this is the password, compared in constant time. */
  verify(password: string): boolean {
    const row = this.#row();
    return row ? sameSecret(hash(password, row.salt), row.hash) : false;
  }

  /**
   * Replace the password, salt and all — and with it every session, the
   * caller's own included. That is the point: a password is changed because the
   * old one may be known, so nothing that was signed in under it stays signed
   * in. Listeners hear it after the commit, never before.
   */
  setPassword(password: string): void {
    const salt = randomBytes(16).toString("hex");
    // Credential and sessions change together or not at all — a crash between
    // the two writes is exactly the state "everyone signs in again" denies.
    transact(this.#db, () => {
      this.#db
        .prepare("UPDATE auth SET salt = ?, hash = ?, created_at = ? WHERE id = 1")
        .run(salt, hash(password, salt), Date.now());
      this.#dropSessions();
    });
    this.#revoked(ALL);
  }

  /** Sign a browser in: one row, and the cookie value that opens it. */
  open(ip: string, agent: string): string {
    const now = Date.now();
    this.sweep();
    // The id names the row and the token proves it: 72 bits is plenty for a
    // name, and the 256-bit token is the only part that has to resist guessing.
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    this.#db
      .prepare(
        "INSERT INTO web_sessions(id, token_hash, created_at, seen_at, ip, agent)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, digest(token), now, now, ip, agent.slice(0, 200));
    return `${id}.${token}`;
  }

  /**
   * The row this cookie names, if the token matches and the row is live.
   * `renewed` says the deadline just moved, which is the caller's cue to send
   * the browser a cookie with the new Max-Age — the sliding window has to slide
   * on both sides or the browser drops a cookie the database still honours.
   */
  check(cookie: string | undefined): { id: string; renewed: boolean } | undefined {
    const [id, token] = (cookie ?? "").split(".");
    if (!id || !token) return undefined;
    const row = this.#db
      .prepare("SELECT token_hash AS tokenHash, seen_at AS seenAt FROM web_sessions WHERE id = ?")
      .get(id) as { tokenHash: string; seenAt: number } | undefined;
    const now = Date.now();
    // One clock: last use is the deadline, so there is no second column that
    // can disagree with it about when this session ends. An expired row is
    // deleted here rather than left for the next login to sweep — a session
    // nobody may use must stop being a device Pier notifies at the same moment.
    if (!row) return undefined;
    if (now - row.seenAt >= TTL_MS) {
      this.revoke(id);
      return undefined;
    }
    if (!sameSecret(digest(token), row.tokenHash)) return undefined;
    if (now - row.seenAt < TOUCH_MS) return { id, renewed: false };
    this.#db.prepare("UPDATE web_sessions SET seen_at = ? WHERE id = ?").run(now, id);
    return { id, renewed: true };
  }

  /** Sign out one browser, or every one of them (`ALL`). Listeners hear the
   *  same id: a revoked cookie must also close what it opened. */
  revoke(id: string): void {
    if (id === ALL) this.#dropSessions();
    else this.#db.prepare("DELETE FROM web_sessions WHERE id = ?").run(id);
    this.#revoked(id);
  }

  /** Signed-in browsers, most recently seen first. Never the token — the list
   *  is shown to whoever is signed in, and it is not a set of credentials. */
  list(): Device[] {
    return this.#db
      .prepare("SELECT id, created_at AS createdAt, seen_at AS seenAt, ip, agent" +
        " FROM web_sessions WHERE seen_at > ? ORDER BY seen_at DESC")
      .all(Date.now() - TTL_MS) as unknown as Device[];
  }

  /** A long-lived authenticated surface closes itself when a cookie is
   *  revoked. The store and listeners share the process lifetime. */
  onRevoke(listener: (id: string) => void): void {
    this.#revokeListeners.add(listener);
  }

  /** One listener throwing must not cost the next one its notification: the
   *  row is already gone, so a surface that never hears about it stays open on
   *  a session that no longer exists. */
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

/** What the database keeps instead of the cookie's token. */
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * What a logged-out visitor must still reach: the login form, published
 * boards, and the stylesheet those boards link — a published board rendering
 * unstyled for the person it was published to is the same bug as not serving
 * it. Both live under `/p/*` (the stylesheet at `/p/_assets/pier.css`), the
 * single exempt prefix `docs/architecture.md` reserved for this, so the rule
 * is one prefix here and one prefix in anything fronting Pier; `/boards/*`
 * stays behind the boundary.
 */
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
 * schemes because TLS commonly terminates at the reverse proxy. Shared by HTTP
 * and WebSocket so the password boundary cannot disagree with itself. */
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

/** Which row this request's cookie names. The boundary already verified the
 *  token; this reads the id back off the value it accepted. Exported so a
 *  surface that belongs to one browser (its push subscription) names it the
 *  same way, rather than parsing the cookie a second way. */
export const sessionIdOf = (c: Context): string => (getCookie(c, COOKIE) ?? "").split(".")[0] ?? "";

/** The same cookie + Origin boundary for a WebSocket upgrade, where no Hono
 *  context exists before the handshake completes. The session id comes back
 *  with the verdict: a socket outlives the request that opened it, so it has
 *  to know which row signing out would close it. */
export function upgradeAuthorized(store: AuthStore, req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const session = store.check(raw);
  if (!session) return undefined;
  const remote = req.socket.remoteAddress ?? "";
  const forwardedHeader = req.headers["x-forwarded-host"];
  const forwarded = loopback(remote) && typeof forwardedHeader === "string"
    ? forwardedHeader.split(",").at(-1)?.trim()
    : undefined;
  return originMatches(req.headers.origin, forwarded || req.headers.host) ? session.id : undefined;
}

/** Every route, in one place — no per-route opt-in to forget on the next one. */
export function requireAuth(store: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    // On every response, public ones included: the login form is the one page
    // strangers reach, and it must not be frameable either.
    c.header("x-frame-options", "DENY");
    if (isPublic(c.req.method, c.req.path)) return next();
    const cookie = getCookie(c, COOKIE);
    const session = store.check(cookie);
    const unsafe = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (session && unsafe && !sameOrigin(c)) {
      log.warn(`blocked ${c.req.method} ${c.req.path} from origin ${c.req.header("origin")}`);
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (session) {
      // The database just moved the deadline; the browser is told the same, or
      // it would drop a cookie that is still good.
      if (session.renewed && cookie) setSessionCookie(c, cookie);
      await next();
      // Cookie-authenticated content must not become public in a shared proxy.
      if (!c.res.headers.has("cache-control")) {
        c.header("cache-control", c.req.path.startsWith("/api/") ? "private, no-store" : "private");
      }
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
    // Signing in again replaces this browser's session rather than adding one:
    // the cookie it is about to drop would otherwise stay valid for a week, as
    // a row nobody can recognize in the device list. Verified first — the id in
    // an unverified cookie is a string the caller chose, and `ALL` is one of
    // the strings they could choose.
    const previous = store.check(getCookie(c, COOKIE));
    if (previous) store.revoke(previous.id);
    setSessionCookie(c, store.open(client, c.req.header("user-agent") ?? ""));
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
    // The rotation drops every session row, this caller's included — a password
    // is changed because the old one may be known, and "everyone signs in
    // again" is the whole point. Clear the dead cookie; the client sends the
    // person to the login form with the password they just chose.
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Signed-in browsers, so "sign out that one" is something an operator can
  // see before doing. Not /api/sessions: that is the agent's sessions, and one
  // vocabulary for two unrelated things is how the wrong one gets ended.
  app.get("/api/devices", (c) => {
    const current = sessionIdOf(c);
    return c.json(store.list().map((d) => ({ ...d, current: d.id === current })));
  });

  // Real revocation: the row goes, and the cookie holding its token opens
  // nothing on the next request. Ending this browser's own session is the same
  // call, so the client clears the cookie it is about to stop being able to use.
  app.post("/api/devices/:id/signout", (c) => {
    const id = c.req.param("id");
    // One row per call. Signing everyone out is the password change above,
    // which is the only thing that also invalidates the password they know.
    if (id === ALL) return c.json({ error: "not a session id" }, 400);
    store.revoke(id);
    log.info(`signed out session ${id}`);
    if (id === sessionIdOf(c)) deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Signs out this browser: the row is deleted, not just the cookie cleared,
  // so a copy of that cookie taken beforehand is dead too. Behind the boundary
  // like every write — only a signed-in browser has anything to end.
  app.post("/logout", (c) => {
    store.revoke(sessionIdOf(c));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
}

/** The signed-in cookie — set at login, and again whenever the sliding window
 *  moved, which is why it takes the value rather than making one. */
function setSessionCookie(c: Context, value: string): void {
  setCookie(c, COOKIE, value, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    // Set only over TLS: a Secure cookie on plain http is dropped, which
    // would lock out the loopback and SSH-tunnel setups. The forwarded scheme
    // counts only from a local proxy — anywhere else it is a header the client
    // wrote, and a stranger must not get to decide this flag.
    secure: new URL(c.req.url).protocol === "https:" ||
      (c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim() === "https" &&
        loopback(remoteOf(c) ?? "")),
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
