// Every path the Console reaches on disk resolves here. The boundary is the
// Console password, not a path: an owner past it picks any cwd, so anything
// this process can read is already reachable. `root` confines a *listing*, with
// realpath on both ends so neither `..` nor a symlink steps outside. Only mkdir
// writes, and only a name.

import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
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
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** A player reads these by Range, so their size costs the reader nothing. */
const streamed = (file: string): boolean => /^(audio|video)\//.test(RENDERABLE[extname(file).toLowerCase()] ?? "");

/** One `bytes=` range of a `size`-byte file, inclusive; null serves it whole
 *  (no header, a multi-range, a malformed one), "unsatisfiable" is a 416. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]); // a suffix: the last n bytes
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (m[2] && Number(m[2]) < start) return null;
  return start >= size ? "unsatisfiable" : { start, end };
}

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

/** One file, conditional and by Range. The ceiling holds only for what a page
 *  holds whole: media is read by Range, a `download` goes to disk. The default
 *  `no-cache` keeps the answer conditional, so an edited file is never shown
 *  from a browser cache. */
export async function serveFile(
  c: Context,
  file: string,
  download = false,
  cacheControl = "private, no-cache",
): Promise<Response> {
  const handle = await open(file);
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return c.json({ error: "no such file" }, 404);
    if (info.size > MAX_FILE_BYTES && !download && !streamed(file)) return c.json({ error: "file too large" }, 413);
    const tag = `"${info.size.toString(16)}-${info.mtime.getTime().toString(16)}"`;
    const validators = {
      etag: tag,
      "last-modified": info.mtime.toUTCString(),
      "cache-control": cacheControl,
      "accept-ranges": "bytes",
    };
    if (c.req.header("if-none-match") === tag) return c.body(null, 304, validators);
    // A range of a file edited since the player's first read would splice two
    // versions; a stale If-Range gets the whole new file instead.
    const ifRange = c.req.header("if-range");
    const range = ifRange && ifRange !== tag ? null : byteRange(c.req.header("range"), info.size);
    if (range === "unsatisfiable") {
      return c.body(null, 416, { ...validators, "content-range": `bytes */${info.size}` });
    }
    // The same open file, so a replacement cannot make the headers describe
    // different bytes.
    const head = Buffer.alloc(Math.min(8192, info.size));
    await handle.read(head, 0, head.length, 0);
    const bytes = handle.createReadStream(range ?? { start: 0 });
    streaming = true;
    // Past the headers a failure can only truncate the body (§5).
    bytes.on("error", (err) => log.warn(`serving ${file} stopped mid-stream`, err));
    const headers = { ...fileHeaders(file, head, download), ...validators };
    if (!range) {
      return c.body(Readable.toWeb(bytes) as ReadableStream, 200, { ...headers, "content-length": String(info.size) });
    }
    return c.body(Readable.toWeb(bytes) as ReadableStream, 206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
      "content-length": String(range.end - range.start + 1),
    });
  } finally {
    if (!streaming) await handle.close();
  }
}

export function registerFsRoutes(app: Hono): void {
  // The Files dialog walks a project (`root` confines it); the cwd pickers walk
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
    // The Files viewer frames a PDF; every other route stays DENY (auth.ts).
    // On every answer, a 304 included: its headers replace the cached ones.
    c.header("x-frame-options", "SAMEORIGIN");
    const file = await scoped(c.req.query("root"), c.req.query("path"));
    return serveFile(c, file, c.req.query("download") === "1");
  });

  // Which of these absolute paths exist, file or folder: a reply's file
  // reference is drawn only when it opens something. A path stat cannot reach
  // (missing, unreadable) is the answer `false`, not a failure.
  guarded(app, "POST", "/api/fs/exists", 400, async (c) => {
    const body = await c.req.json().catch(() => null);
    const paths: unknown = body?.paths;
    if (!Array.isArray(paths) || paths.length > 1000 || !paths.every((p) => typeof p === "string")) {
      return c.json({ error: "paths required" }, 400);
    }
    const exists = await Promise.all(
      paths.map((p: string) => (isAbsolute(p) ? stat(p).then(() => true, () => false) : false)),
    );
    return c.json({ exists });
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
