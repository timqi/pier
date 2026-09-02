// Every path the Console reaches on disk resolves here: the browse/read/mkdir
// routes, the session attachments server.ts serves, and the pty's cwd all ask
// the same question, and asked it four different ways until this file existed.
//
// A `root` is any directory the process can read — sessions work in worktrees
// and siblings of their cwd, and an owner already past the Console password
// can reach those paths anyway. What is confined is `path`: it resolves under
// the `root` it was asked with, realpath on both ends, so neither `..` nor a
// symlink steps outside and a listing can never widen itself. Only mkdir
// writes, and only a name.

import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { guarded } from "./route.js";

/** What a browser is asked to hold at once — the same ceiling for a preview
 *  and for an attachment, because it is the reader's patience, not the route's. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Types a browser may render as themselves. Everything else is sniffed for
 *  text, and bytes we can't vouch for download instead of rendering — that is
 *  how a file starts executing. */
const RENDERABLE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** The containment check, and the only way a path becomes a path this reads:
 *  `root` must be an absolute directory, and the returned target is `path`
 *  resolved inside it. Throws — the route wrapper turns that into the answer. */
export async function scoped(root: string | undefined, path = ""): Promise<string> {
  if (!root || !isAbsolute(root)) throw new Error("not a directory this can read");
  const real = await realpath(root);
  if (!(await stat(real)).isDirectory()) throw new Error("not a directory this can read");
  const target = await realpath(resolve(real, path));
  if (target !== real && !target.startsWith(real + sep)) throw new Error("path escapes root");
  return target;
}

/** The same containment against several roots, for the caller that has more
 *  than one: a session's attachments come from its own cwd or from the inbox
 *  its inbound files landed in. null rather than a throw, because to that
 *  caller "outside every root", "not a file" and "gone" are one answer. */
export async function scopedFile(roots: string[], path: string): Promise<string | null> {
  for (const root of roots) {
    try {
      const file = await scoped(root, path);
      if ((await stat(file)).isFile()) return file;
    } catch {
      /* outside this root, unreadable, or gone — try the next */
    }
  }
  return null;
}

/** How bytes leave: the type they may be served as, and whether a browser may
 *  render them in place. `download` forces the attachment disposition — the
 *  chat's Download button, on a file it would otherwise show inline. */
export function fileHeaders(file: string, bytes: Buffer, download = false): Record<string, string> {
  const ext = extname(file).toLowerCase();
  const known = RENDERABLE[ext];
  const text = !known && !bytes.subarray(0, 8192).includes(0);
  // An <img> renders its source whatever the disposition says, but a tab
  // navigated straight at an SVG runs the script inside it — same origin, past
  // the password. So an SVG keeps its type and loses only its own tab.
  const inline = !download && (text || (known !== undefined && ext !== ".svg"));
  return {
    "content-type": known ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream"),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
  };
}

export function registerFsRoutes(app: Hono): void {
  // One listing behind both trees: the Files view walks a project (`root`,
  // which confines it and is the floor `parent` stops at), the cwd pickers
  // walk from anywhere (no root, starting at home). Names and which are
  // directories — never contents, and never `.git`, which is plumbing. What to
  // leave out of the answer is the caller's business: one tree shows folders
  // only, the other shows files too.
  guarded(app, "GET", "/api/fs/ls", 404, async (c) => {
    c.header("cache-control", "no-store");
    const asked = c.req.query("path");
    const root = c.req.query("root");
    const top = root ? await scoped(root) : null;
    const dir = top ? await scoped(top, asked) : await scoped(asked || homedir());
    const up = dirname(dir);
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.name !== ".git" && (e.isDirectory() || e.isFile()))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return c.json({ path: dir, parent: dir === top || up === dir ? null : up, entries });
  });

  // File bytes, read-only: the Files view's previews and whole-file reads.
  guarded(app, "GET", "/api/fs/file", 404, async (c) => {
    const file = await scoped(c.req.query("root"), c.req.query("path"));
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    const bytes = await readFile(file);
    return c.body(bytes, 200, { ...fileHeaders(file, bytes), "cache-control": "no-store" });
  });

  // Create a folder while picking one — a new project usually needs a new
  // directory. A name, never a path: traversal is rejected, not normalized.
  guarded(app, "POST", "/api/fs/mkdir", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parent = typeof body?.path === "string" ? body.path : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!isAbsolute(parent)) return c.json({ error: "absolute path required" }, 400);
    if (!name || name.length > 64 || /[/\\]|^\.\.?$/.test(name)) {
      return c.json({ error: "invalid folder name" }, 400);
    }
    const path = resolve(parent, name);
    await mkdir(path); // no recursive: the parent must already exist
    return c.json({ path });
  });
}
