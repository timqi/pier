// Boards: static pages an agent writes under $PIER_HOME/boards, never
// registered (docs/design/05-boards.md). Only <board>/site is reachable
// over HTTP, so a board leaks nothing about how it was made. Bytes are served
// on one password-free prefix, `/b/*` (a signed prefix the boundary mints),
// stylesheet included, and run sandboxed; a public board is a copy of `site/`
// on Cloudflare Pages (publish.ts), never served from here.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { logger } from "../log.js";
import { pierPath } from "../paths.js";

export const defaultBoardsDir = (): string => pierPath("boards");
/** The one stylesheet every board links, at `/b/_assets/pier.css` here and
 *  the same path in a Pages snapshot. */
export const PIER_CSS = new URL("./pier.css", import.meta.url);

/** Deleted boards keep their bytes under `<slug>.deleted-<ts>`, which this
 *  pattern refuses on every route — one rename is the whole delete path. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DELETED = /^([a-z0-9][a-z0-9-]{0,63})\.deleted-\d+$/;

/** `public` is the intent, `url` the fact: only `pier boards publish` writes
 *  `url`/`publishedAt`, and having a `url` means being in the live snapshot.
 *  `withdrawnAt`: when a publish took the board down; until a week after it,
 *  each publish redirects its paths away from Pages' stale edge copies. */
interface BoardManifest {
  title: string;
  description: string;
  public: boolean;
  url?: string;
  publishedAt?: string;
  withdrawnAt?: string;
}

/** One row of `GET /api/boards`. `deleted`: a `<slug>.deleted-<ts>` directory
 *  whose board is still on Pages, listed until a publish takes it down. */
interface BoardSummary extends BoardManifest {
  slug: string;
  updatedAt: string;
  deleted?: true;
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
// on any board, published or not, and the sandbox also removes forms, frames
// and subresource requests; popups stay, unsandboxed, so `target=_blank` links
// open an ordinary tab. What that costs is the session cookie — an
// opaque-origin document sends none with its own assets — which is why a
// board is never served on a cookie-authorized URL (docs/design/05-boards.md).
const CSP =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; " +
  "default-src 'self'; img-src 'self' data:; " +
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
  return sameSecret(sign(board, expires), view.slice(cut + 1));
}

/** Malformed boards are reported once, not on every request. */
const warned = new Set<string>();

/** The one place a slug becomes a path, so it is validated here (`../../etc`,
 *  NUL). Extra keys survive a write. `deleted` admits a `<slug>.deleted-<ts>`
 *  name: the publish path must find the boards it still has to take down. */
export async function readManifest(
  dir: string,
  slug: string,
  deleted = false,
): Promise<(BoardManifest & Record<string, unknown>) | null> {
  if (!(deleted ? DELETED : SLUG).test(slug)) return null;
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
  const { url, publishedAt, withdrawnAt, ...rest } = m;
  return {
    ...rest,
    title: typeof m.title === "string" && m.title ? m.title : slug,
    description: typeof m.description === "string" ? m.description : "",
    public: m.public === true,
    ...(typeof url === "string" && url ? { url } : {}),
    ...(typeof publishedAt === "string" && publishedAt ? { publishedAt } : {}),
    ...(typeof withdrawnAt === "string" && withdrawnAt ? { withdrawnAt } : {}),
  };
}

export const writeManifest = (dir: string, slug: string, manifest: BoardManifest & Record<string, unknown>): Promise<void> =>
  writeFile(join(dir, slug, "board.json"), `${JSON.stringify(manifest, null, 2)}\n`);

/** Freshness is the site's mtime, not a manifest field — the filesystem
 *  already knows, and an agent rewriting a page cannot forget to say so. */
async function updatedAt(dir: string, slug: string): Promise<string> {
  const info =
    (await stat(join(dir, slug, "site")).catch(() => null)) ??
    (await stat(join(dir, slug)).catch(() => null));
  return (info?.mtime ?? new Date()).toISOString();
}

/** Every board directory, live and deleted, with its manifest: the publish
 *  path and the Console's list read the same scan. */
export async function scanBoards(dir: string): Promise<{ name: string; slug: string; deleted: boolean; manifest: BoardManifest & Record<string, unknown> }[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && (SLUG.test(e.name) || DELETED.test(e.name)))
      .map((e) => e.name);
  } catch (err) {
    // No directory is no boards yet; anything else hides every board at once.
    if ((err as { code?: string }).code !== "ENOENT") logger("boards").warn(`cannot scan ${dir}`, err);
    return [];
  }
  const found = await Promise.all(names.map(async (name) => {
    const deleted = !SLUG.test(name);
    const manifest = await readManifest(dir, name, deleted);
    return manifest ? { name, slug: deleted ? DELETED.exec(name)![1]! : name, deleted, manifest } : null;
  }));
  // Name order, so the publish's report reads the same on every run.
  return found.filter((board) => board !== null).sort((a, b) => a.name.localeCompare(b.name));
}

async function listBoards(dir: string): Promise<BoardSummary[]> {
  const boards = await Promise.all((await scanBoards(dir)).map(async ({ name, slug, deleted, manifest }): Promise<BoardSummary | null> => {
    // A deleted board is only news while it is still live.
    if (deleted && !manifest.url) return null;
    const { title, description, public: isPublic, url, publishedAt } = manifest;
    return {
      slug,
      title,
      description,
      public: isPublic,
      ...(url ? { url } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(deleted ? { deleted: true as const } : {}),
      updatedAt: await updatedAt(dir, name),
    };
  }));
  // Freshest first; slug breaks ties so equal mtimes still list in a stable order.
  return boards
    .filter((board): board is BoardSummary => board !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug));
}

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

/** Digested first: the signature is a secret, and a URL's half may be any
 *  length or encoding, which a raw comparison would either leak or throw on. */
const sameSecret = (want: string, got: string): boolean => {
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
    // Nothing is cached: the prefix is revocable (sign out, expiry), and a
    // stored copy would outlive the revocation.
    "cache-control": "no-store",
    "content-security-policy": CSP,
    // The URL is the credential; an outbound link must not carry it.
    "referrer-policy": "no-referrer",
    // A sandboxed page has an opaque origin. Fonts and module scripts need CORS
    // even when their URLs are under the same board.
    "access-control-allow-origin": "*",
  };
  return c.body(await readFile(file), 200, headers);
}

export function registerBoardRoutes(app: Hono, dir: string = defaultBoardsDir()): void {
  app.get("/api/boards", async (c) => c.json(await listBoards(dir)));

  // A rename, so the undo is on disk; signed prefixes are bound to the
  // directory's inode (boardOf), so none opens a successor on the same slug.
  app.delete("/api/boards/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!(await readManifest(dir, slug))) return c.json({ error: "no such board" }, 404);
    await rename(join(dir, slug), join(dir, `${slug}.deleted-${Date.now()}`));
    return c.json({ deleted: slug });
  });

  // On the exempt prefix, not behind the cookie: a sandboxed board has an
  // opaque origin and sends no cookie with its own stylesheet. Declared before
  // the wildcards below: `_assets` is not a slug.
  app.get("/b/_assets/pier.css", async (c) => {
    return c.body(await readFile(PIER_CSS), 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "max-age=300",
    });
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
