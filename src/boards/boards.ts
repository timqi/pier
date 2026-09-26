// Boards: static pages an agent writes under $PIER_HOME/boards, never
// registered (docs/design/05-boards.md). Only <board>/site is reachable
// over HTTP, so a public board leaks nothing about how it was made. Bytes are
// served on two password-free prefixes, `/p/*` (published) and `/b/*` (a
// signed prefix the boundary mints), stylesheet included, and run sandboxed.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { logger } from "../log.js";
import { pierPath } from "../paths.js";

export const defaultBoardsDir = (): string => pierPath("boards");

/** Deleted boards keep their bytes under `<slug>.deleted-<ts>`, which this
 *  pattern refuses on every route — one rename is the whole delete path. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Without the 32 bits after the slug, `/p/` could be walked with a dictionary.
 *  Minted the first time a manifest is seen public, by whichever path did it. */
const TOKEN = /^[a-f0-9]{8}$/;
const mintToken = (): string => randomBytes(4).toString("hex");

export interface BoardManifest {
  title: string;
  description: string;
  public: boolean;
  token: string;
}

// A board ships fonts and images, so the list is wider than the attachment
// route's — but still a whitelist: an unlisted extension is not served at all.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
};

// Agent-written script, so it runs in an opaque origin: no `allow-same-origin`
// on any board, published or not, and the sandbox also removes forms, frames,
// popups and subresource requests. What that costs is the session cookie —
// an opaque-origin document sends none with its own assets — which is why a
// board is never served on a cookie-authorized URL (docs/design/05-boards.md).
const CSP =
  "sandbox allow-scripts; default-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
  "connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Long enough to read a board without a second thought, short enough that a
 *  URL left in a history or a chat log stops working the same day. */
const VIEW_TTL_MS = 8 * 60 * 60_000;
/** Process-scoped: a view prefix is a read capability for one board, and
 *  nothing may outlive the instance that vouched for it. */
let viewKey = randomBytes(32);

/** Signing out must end the boards that session opened too — the pages carry
 *  no cookie to revoke, so the key they were signed with is what goes. */
export const rotateBoardViews = (): void => {
  viewKey = randomBytes(32);
};

const sign = (board: string, expires: number, key = viewKey): string =>
  createHmac("sha256", key).update(`${board}\0${String(expires)}`).digest("base64url").slice(0, 22);

/** `<expiry in base36>-<signature>`: its own path segment, so the first hyphen
 *  is the cut and a hyphenated slug stays unambiguous. */
const mintView = (board: string, key: typeof viewKey): string => {
  const expires = Date.now() + VIEW_TTL_MS;
  return `${expires.toString(36)}-${sign(board, expires, key)}`;
};

/** What a prefix is signed for: the slug and its directory, because a delete
 *  renames the board away and frees the slug, and a prefix must not open the
 *  successor. Null when there is no such directory. */
async function boardOf(dir: string, slug: string): Promise<string | null> {
  try {
    return `${slug}\0${String((await stat(join(dir, slug))).ino)}`;
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") logger("boards").warn(`cannot stat board ${slug}`, err);
    return null;
  }
}

function validView(board: string, view: string): boolean {
  const cut = view.indexOf("-");
  if (cut < 1) return false;
  const stamp = view.slice(0, cut);
  const expires = Number.parseInt(stamp, 36);
  // Canonical only: `parseInt` stops at the first stray character, which would
  // make one signature valid under several spellings of its own prefix.
  if (!Number.isSafeInteger(expires) || expires.toString(36) !== stamp) return false;
  if (expires <= Date.now()) return false;
  return sameToken(sign(board, expires), view.slice(cut + 1));
}

/** Malformed boards are reported once, not on every request. */
const warned = new Set<string>();

/** The one place a slug becomes a path, so it is validated here (`../../etc`,
 *  NUL). Extra keys survive a write. The one write-back is minting a token for
 *  a public board that arrived without one, so the agent's own publish path has a URL. */
async function readManifest(
  dir: string,
  slug: string,
): Promise<(BoardManifest & Record<string, unknown>) | null> {
  if (!SLUG.test(slug)) return null;
  const file = join(dir, slug, "board.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    // Missing file = not a board; unparsable = a board someone broke.
    if ((err as { code?: string }).code !== "ENOENT" && !warned.has(file)) {
      warned.add(file);
      logger("boards").warn(`ignoring unreadable manifest ${file}`, err);
    }
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const manifest = {
    ...m,
    title: typeof m.title === "string" && m.title ? m.title : slug,
    description: typeof m.description === "string" ? m.description : "",
    public: m.public === true,
    token: typeof m.token === "string" && TOKEN.test(m.token) ? m.token : "",
  };
  if (manifest.public && !manifest.token) {
    manifest.token = mintToken();
    try {
      await writeManifest(dir, slug, manifest);
    } catch (err) {
      // A token that cannot be stored would differ on the next request, so the
      // board stays unreachable on /p/ rather than handing out a dead link.
      logger("boards").warn(`cannot mint a public token for ${slug}`, err);
      manifest.token = "";
    }
  }
  return manifest;
}

const writeManifest = (dir: string, slug: string, manifest: BoardManifest & Record<string, unknown>) =>
  writeFile(join(dir, slug, "board.json"), `${JSON.stringify(manifest, null, 2)}\n`);

/** Containment, not normalization: the resolved realpath must sit inside the
 *  board's own site dir or nothing is served. */
async function resolveFile(dir: string, slug: string, rest: string): Promise<string | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  if (!relative || relative.endsWith("/")) relative += "index.html";
  let root: string;
  try {
    root = await realpath(join(dir, slug, "site"));
  } catch {
    return null;
  }
  let file: string;
  try {
    file = await realpath(resolve(root, relative));
  } catch {
    return null;
  }
  if (file !== root && !file.startsWith(root + sep)) return null;
  const info = await stat(file);
  if (info.isDirectory()) return resolveFile(dir, slug, `${relative}/`);
  return info.isFile() ? file : null;
}

/** `/p/` addresses a board as `<slug>-<token>`; a slug may itself contain
 *  hyphens, so the last one is the cut. */
function publicKey(key: string): { slug: string; token: string } {
  const cut = key.lastIndexOf("-");
  return cut < 1 ? { slug: "", token: "" } : { slug: key.slice(0, cut), token: key.slice(cut + 1) };
}

/** Digested first: the token is a secret, and a URL's half may be any length
 *  or encoding, which a raw comparison would either leak or throw on. */
const sameToken = (want: string, got: string): boolean => {
  if (!want) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(want), digest(got));
};

async function serveFile(c: Context, dir: string, slug: string, rest: string) {
  const file = await resolveFile(dir, slug, rest);
  if (!file) return c.notFound();
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return c.notFound();
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    // Nothing is cached: both prefixes are revocable (unpublish, sign out,
    // expiry), and a stored copy would outlive the revocation.
    "cache-control": "no-store",
    "content-security-policy": CSP,
    // The URL is the credential on both prefixes; an outbound link must not carry it.
    "referrer-policy": "no-referrer",
    // A sandboxed page has an opaque origin. Fonts and module scripts need CORS
    // even when their URLs are under the same board.
    "access-control-allow-origin": "*",
  };
  return c.body(await readFile(file), 200, headers);
}

export function registerBoardRoutes(app: Hono, dir: string = defaultBoardsDir()): void {
  // Declared before the wildcards below: `_assets` is not a slug.
  app.get("/p/_assets/pier.css", async (c) => {
    const file = new URL("./pier.css", import.meta.url);
    return c.body(await readFile(file), 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "max-age=300",
    });
  });

  // Trailing slash matters: without it a board's relative asset paths resolve
  // against the prefix instead of the board.
  app.get("/p/:key", (c) => c.redirect(`/p/${c.req.param("key")}/`));
  app.get("/p/:key/*", async (c) => {
    const key = c.req.param("key");
    const { slug, token } = publicKey(key);
    const manifest = await readManifest(dir, slug);
    // 404, never 403: a private board's existence is not public information,
    // and a wrong token is the same non-answer as a wrong name.
    if (!manifest || !manifest.public || !sameToken(manifest.token, token)) return c.notFound();
    return serveFile(c, dir, slug, c.req.path.slice(`/p/${key}/`.length));
  });

  // The operator's link, and the one place the password is spent on a board:
  // it hands out a signed prefix instead of bytes, so the page that follows
  // needs no cookie and can be sandboxed into an opaque origin.
  const mint = async (c: Context) => {
    const slug = c.req.param("slug") ?? "";
    // The key as this request found it: a sign-out landing during the reads
    // would otherwise hand it a capability made with the key that replaced
    // the revoked one.
    const key = viewKey;
    const board = SLUG.test(slug) ? await boardOf(dir, slug) : null;
    const view = board ? mintView(board, key) : "";
    // A board that is gone says so here, rather than after a redirect.
    if (!view || !(await readManifest(dir, slug))) return c.notFound();
    const rest = c.req.path.slice(`/boards/${slug}`.length).replace(/^\//, "");
    return c.redirect(`/b/${slug}/${view}/${rest}${new URL(c.req.url).search}`);
  };
  app.get("/boards/:slug", mint);
  app.get("/boards/:slug/*", mint);

  app.get("/b/:slug/:view", (c) => c.redirect(`${c.req.path}/${new URL(c.req.url).search}`));
  app.get("/b/:slug/:view/*", async (c) => {
    const slug = c.req.param("slug");
    const view = c.req.param("view");
    const rest = c.req.path.slice(`/b/${slug}/${view}/`.length);
    if (!SLUG.test(slug)) return c.notFound();
    // Expired, forged, signed with a key that has since rotated, or for a
    // board since renamed away: send it back through the boundary, which
    // re-mints for a live session in one hop and asks a stranger for the
    // password. Existence stays unsaid either way.
    const board = await boardOf(dir, slug);
    if (!board || !validView(board, view)) {
      return c.redirect(`/boards/${slug}/${rest}${new URL(c.req.url).search}`);
    }
    if (!(await readManifest(dir, slug))) return c.notFound();
    return serveFile(c, dir, slug, rest);
  });
}
