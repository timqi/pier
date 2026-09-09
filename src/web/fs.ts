// Every path the Console reaches on disk resolves here. The boundary is the
// Console password, not a path: an owner past it picks any cwd, so anything
// this process can read is already reachable. `root` confines a *listing*, with
// realpath on both ends so neither `..` nor a symlink steps outside. Only mkdir
// writes, and only a name.

import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { logger } from "../log.js";
import { guarded } from "./route.js";

const log = logger("web");

/** The reader's patience, so one ceiling for a preview and an attachment. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Everything else is sniffed for text; bytes we can't vouch for download
 *  instead of rendering, which is how a file starts executing. */
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

/** The containment check, and the only way a path becomes one this reads. */
export async function scoped(root: string | undefined, path = ""): Promise<string> {
  if (!root || !isAbsolute(root)) throw new Error("not a directory this can read");
  const real = await realpath(root);
  if (!(await stat(real)).isDirectory()) throw new Error("not a directory this can read");
  const target = await realpath(resolve(real, path));
  if (target !== real && !target.startsWith(real + sep)) throw new Error("path escapes root");
  return target;
}

/** `download` forces the attachment disposition on a file otherwise shown inline. */
export function fileHeaders(file: string, bytes: Buffer, download = false): Record<string, string> {
  const ext = extname(file).toLowerCase();
  const known = RENDERABLE[ext];
  const text = !known && !bytes.subarray(0, 8192).includes(0);
  // A tab navigated straight at an SVG runs the script inside it, same
  // origin, past the password; an <img> ignores the disposition anyway.
  const inline = !download && (text || (known !== undefined && ext !== ".svg"));
  return {
    "content-type": known ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream"),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
  };
}

export function registerFsRoutes(app: Hono): void {
  // The Files view walks a project (`root` confines it); the cwd pickers walk
  // from anywhere. Never contents, and never `.git`.
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

  guarded(app, "GET", "/api/fs/file", 404, async (c) => {
    const file = await scoped(c.req.query("root"), c.req.query("path"));
    const handle = await open(file);
    let streaming = false;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("not a file");
      if (info.size > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
      // `no-cache` keeps the answer conditional, so an edited file is never
      // shown from a browser cache.
      const tag = `"${info.size.toString(16)}-${info.mtime.getTime().toString(16)}"`;
      const validators = {
        etag: tag,
        "last-modified": info.mtime.toUTCString(),
        "cache-control": "private, no-cache",
      };
      if (c.req.header("if-none-match") === tag) return c.body(null, 304, validators);
      // The same open file, so a replacement cannot make the headers describe
      // different bytes.
      const head = Buffer.alloc(Math.min(8192, info.size));
      await handle.read(head, 0, head.length, 0);
      const bytes = handle.createReadStream({ start: 0 });
      streaming = true;
      // Past the headers a failure can only truncate the body (§5b).
      bytes.on("error", (err) => log.warn(`serving ${file} stopped mid-stream`, err));
      return c.body(Readable.toWeb(bytes) as ReadableStream, 200, {
        ...fileHeaders(file, head),
        ...validators,
      });
    } finally {
      if (!streaming) await handle.close();
    }
  });

  // A name, never a path: traversal is rejected, not normalized.
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
