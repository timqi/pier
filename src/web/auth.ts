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

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const COOKIE = "pier_session";
const TTL_MS = 90 * 24 * 60 * 60_000;
/** Failed attempts one client may make before it has to wait out the window. */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
// scrypt at Node's defaults (N=16384): ~50ms per attempt, which is the point.
const KEY_BYTES = 32;

// The path is duplicated from channels/db.ts rather than imported: web/ may
// depend on core/, never sideways on channels/.
export const defaultAuthDbPath = (): string =>
  join(process.env.PIER_HOME ?? join(homedir(), ".pier"), "pier.db");

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
  readonly #key: string;

  constructor(path = defaultAuthDbPath(), log: (message: string) => void = console.log) {
    // No mode on the directory: another store has already created it by the
    // time main.ts gets here, and PIER_HOME holds boards this process serves,
    // not only this secret. The file modes below are what guard the credential.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    let row = this.#row();
    if (!row) {
      const password = generatePassword();
      const salt = randomBytes(16).toString("hex");
      row = { salt, hash: hash(password, salt), createdAt: Date.now() };
      this.#db
        .prepare("INSERT INTO auth(id, salt, hash, createdAt) VALUES (1, ?, ?, ?)")
        .run(row.salt, row.hash, row.createdAt);
      log(
        `\npier: this instance had no password, so one was generated:\n\n    ${password}\n\n` +
          `pier: only its hash is stored — it is not printed again. ` +
          `Lost it? "DELETE FROM auth" in ${path}, then restart.\n`,
      );
    }
    this.#key = row.hash;

    // The database now holds a credential, so it stops being world-readable.
    // Owned by this module because this module is what made it true. After the
    // insert, not before: the row lands in the -wal sidecar first, and a 0644
    // sidecar leaks exactly what the 0600 database is hiding. SQLite gives
    // later sidecars the database's own mode, so this holds after a checkpoint.
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
  }

  #row(): { salt: string; hash: string; createdAt: number } | undefined {
    return this.#db.prepare("SELECT salt, hash, createdAt FROM auth WHERE id = 1").get() as
      | { salt: string; hash: string; createdAt: number }
      | undefined;
  }

  /** Whether this is the password, compared in constant time. */
  verify(password: string): boolean {
    const row = this.#row();
    return row ? sameSecret(hash(password, row.salt), row.hash) : false;
  }

  /** Cookie signing key. Never the password: that is not stored anywhere. */
  get cookieKey(): string {
    return this.#key;
  }

  close(): void {
    this.#db.close();
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
function isPublic(path: string): boolean {
  return (
    path === "/login" ||
    path === "/p" ||
    path.startsWith("/p/") ||
    path === "/boards/_assets/pier.css"
  );
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
// books. Bounded by pruning every expired entry on each check.
const failures = new Map<string, { count: number; resetAt: number }>();

/**
 * Behind a reverse proxy every request shares one socket address, so the
 * forwarded hop is the only thing separating two clients. It is spoofable when
 * Pier is exposed directly — that is an argument for the proxy, not against
 * the limit: a password is the thing being protected here, the counter only
 * decides how fast someone may guess.
 */
function clientOf(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function throttled(client: string): boolean {
  const now = Date.now();
  for (const [id, entry] of failures) if (entry.resetAt <= now) failures.delete(id);
  return (failures.get(client)?.count ?? 0) >= MAX_FAILURES;
}

function noteFailure(client: string): void {
  const entry = failures.get(client);
  if (entry && entry.resetAt > Date.now()) entry.count += 1;
  else failures.set(client, { count: 1, resetAt: Date.now() + WINDOW_MS });
}

/** Every route, in one place — no per-route opt-in to forget on the next one. */
export function requireAuth(store: AuthStore): MiddlewareHandler {
  return async (c, next) => {
    if (isPublic(c.req.path) || valid(store.cookieKey, getCookie(c, COOKIE))) return next();
    // An API caller gets a status it can act on; a navigation gets the form.
    // Anything non-GET is a client call too — never a link worth redirecting.
    if (c.req.path.startsWith("/api/") || c.req.method !== "GET") {
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
      return c.html(loginPage(next, "Too many attempts. Wait a few minutes."), 429);
    }
    if (!store.verify(typeof form.password === "string" ? form.password : "")) {
      noteFailure(client);
      return c.html(loginPage(next, "Wrong password."), 401);
    }
    failures.delete(client);
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
    return c.redirect(next);
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
