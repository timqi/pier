// Boards: a folder of static files an agent writes to present something at a
// stable URL. The filesystem is the source of truth — boards are derived by
// scanning $PIER_HOME/boards, never registered. See docs/design/05-boards.md.
//
// Only <board>/site is reachable over HTTP: sources, README and the manifest
// itself stay off the wire, so a public board leaks nothing about how it was
// made. `/boards/*` is authenticated; `/p/*` additionally requires the
// manifest's `public` flag and runs as sandboxed active content.

import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { logger } from "../log.js";
import { pierPath } from "../paths.js";

export const defaultBoardsDir = (): string => pierPath("boards");

/** Deleted boards keep their bytes under `<slug>.deleted-<ts>`, which this
 *  pattern excludes from every scan — one rename is the whole delete path. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface BoardManifest {
  title: string;
  description: string;
  sessions: string[];
  public: boolean;
}

export interface BoardSummary extends BoardManifest {
  slug: string;
  updatedAt: string;
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

// Board HTML is active content on the workbench origin. Scripts stay available
// for self-contained pages, but the response sandbox removes forms, frames,
// popups and network access. Public pages omit same-origin too, so their scripts
// receive an opaque origin and cannot inherit an operator's authority.
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; " +
  "worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";
const PRIVATE_CSP = `sandbox allow-scripts allow-same-origin; ${CSP}`;
const PUBLIC_CSP = `sandbox allow-scripts; ${CSP}`;

/** Malformed boards are reported once, not on every scan. */
const warned = new Set<string>();

/** The one choke point where a slug becomes a path, so the slug is validated
 *  here and nowhere else: an unvalidated `../../etc` would read outside the
 *  boards dir, and a NUL byte would throw instead of 404. Unknown fields get
 *  defaults, a broken file is skipped whole, and extra keys are the agent's
 *  business — they survive a write. */
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
  return {
    ...m,
    title: typeof m.title === "string" && m.title ? m.title : slug,
    description: typeof m.description === "string" ? m.description : "",
    sessions: Array.isArray(m.sessions) ? m.sessions.filter((s): s is string => typeof s === "string") : [],
    public: m.public === true,
  };
}

/** Freshness is the site's mtime, not a manifest field — the filesystem
 *  already knows, and an agent rewriting a page cannot forget to say so. */
async function updatedAt(dir: string, slug: string): Promise<string> {
  const info =
    (await stat(join(dir, slug, "site")).catch(() => null)) ??
    (await stat(join(dir, slug)).catch(() => null));
  return (info?.mtime ?? new Date()).toISOString();
}

export async function listBoards(dir: string): Promise<BoardSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SLUG.test(e.name))
      .map((e) => e.name);
  } catch {
    return []; // no boards yet
  }
  const boards: BoardSummary[] = [];
  for (const slug of entries.sort()) {
    const manifest = await readManifest(dir, slug);
    if (!manifest) continue;
    const { title, description, sessions, public: isPublic } = manifest;
    boards.push({ slug, title, description, sessions, public: isPublic, updatedAt: await updatedAt(dir, slug) });
  }
  return boards;
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

async function serveFile(c: Context, dir: string, slug: string, rest: string, publicOnly: boolean) {
  const manifest = await readManifest(dir, slug);
  // 404, never 403: a private board's existence is not public information.
  if (!manifest || (publicOnly && !manifest.public)) return c.notFound();
  const file = await resolveFile(dir, slug, rest);
  if (!file) return c.notFound();
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return c.notFound();
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    // Every public request rechecks the manifest, so unpublishing cannot leave
    // a shared-cache copy reachable. Private assets may stay in one browser.
    "cache-control": publicOnly || type.startsWith("text/html")
      ? "no-store"
      : "private, max-age=300",
    "content-security-policy": publicOnly ? PUBLIC_CSP : PRIVATE_CSP,
  };
  // Public sandboxed pages have an opaque origin. Fonts and module scripts need
  // CORS even when their URLs are under the same published board.
  if (publicOnly) headers["access-control-allow-origin"] = "*";
  return c.body(await readFile(file), 200, headers);
}

export function registerBoardRoutes(app: Hono, dir: string = defaultBoardsDir()): void {
  app.get("/api/boards", async (c) => c.json(await listBoards(dir)));

  // Publishing is the one decision a human owns; every other field belongs to
  // the agent that wrote the board.
  app.patch("/api/boards/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => null)) as { public?: unknown } | null;
    if (typeof body?.public !== "boolean") return c.json({ error: "public must be a boolean" }, 400);
    const manifest = await readManifest(dir, slug);
    if (!manifest) return c.json({ error: "no such board" }, 404);
    manifest.public = body.public;
    await writeFile(join(dir, slug, "board.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return c.json({ public: manifest.public });
  });

  app.delete("/api/boards/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!(await readManifest(dir, slug))) return c.json({ error: "no such board" }, 404);
    await rename(join(dir, slug), join(dir, `${slug}.deleted-${Date.now()}`));
    return c.json({ deleted: slug });
  });

  // Declared before the wildcards below: `_assets` is not a slug.
  app.get("/boards/_assets/pier.css", async (c) => {
    const file = new URL("./pier.css", import.meta.url);
    return c.body(await readFile(file), 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "max-age=300",
    });
  });

  // Trailing slash matters: without it a board's relative asset paths resolve
  // against /boards instead of the board.
  for (const prefix of ["/boards", "/p"]) {
    app.get(`${prefix}/:slug`, (c) => c.redirect(`${prefix}/${c.req.param("slug")}/`));
    app.get(`${prefix}/:slug/*`, (c) => {
      const slug = c.req.param("slug");
      const rest = c.req.path.slice(`${prefix}/${slug}/`.length);
      return serveFile(c, dir, slug, rest, prefix === "/p");
    });
  }
}
