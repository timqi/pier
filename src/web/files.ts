// Filesystem-facing routes: scoped Pi config editing, directory browsing for
// the cwd pickers, and session attachments. Split from server.ts, which keeps
// the session/queue/SSE routes; `guarded` lives here because both halves wrap
// their route bodies with it.

import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { Context, Env, Hono } from "hono";
import type { AgentFactory, ConfigScope, ConfigStore } from "../core/types.js";

// Content types for the attachment route. Anything unlisted downloads as
// bytes — guessing a type we can't vouch for is how a file starts executing.
const FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Register a route whose body may throw: the error becomes the JSON shape
 *  the UI expects, with the status the route owns. Takes the literal path so
 *  `c.req.param()` keeps its typed keys. */
export function guarded<P extends string>(
  app: Hono,
  method: "GET" | "POST" | "PUT",
  path: P,
  status: 400 | 404,
  fn: (c: Context<Env, P>) => Promise<Response>,
): void {
  app.on(method, path, async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      return c.json({ error: String(err) }, status);
    }
  });
}

export interface FileRouteDeps {
  factory: AgentFactory;
  config: ConfigStore;
  /** cwd of a session Pi hasn't persisted yet (server.ts's nascent map). */
  nascentCwd: (id: string) => string | undefined;
}

export function registerFileRoutes(app: Hono, { factory, config, nascentCwd }: FileRouteDeps): void {
  // Scope comes from the client as "global" or a project cwd; only cwds Pi
  // already knows (the session list) are accepted — never an arbitrary path.
  const parseScope = async (raw: string | undefined): Promise<ConfigScope | null> => {
    if (!raw || raw === "global") return { kind: "global" };
    const known = await factory.list();
    return known.some((s) => s.cwd === raw) ? { kind: "project", cwd: raw } : null;
  };

  app.get("/api/config", async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    return c.json({
      // Where this scope's files live on disk — the UI labels "Global" with it.
      dir: scope.kind === "global" ? config.globalDir : scope.cwd,
      files: await config.listFiles(scope),
      resources: await config.listResources(scope),
    });
  });

  guarded(app, "GET", "/api/config/files/:name", 400, async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    return c.json({ content: await config.readFile(scope, c.req.param("name")) });
  });

  guarded(app, "PUT", "/api/config/files/:name", 400, async (c) => {
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.content !== "string" || typeof body?.expected !== "string") {
      return c.json({ error: "content and expected content required" }, 400);
    }
    const name = c.req.param("name");
    await config.writeFile(scope, name, body.content, body.expected);
    return c.json({ ok: true, content: await config.readFile(scope, name) });
  });

  // Resource names may contain slashes — query params, not path params.
  guarded(app, "GET", "/api/config/resource", 400, async (c) => {
    c.header("cache-control", "no-store");
    const scope = await parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "unknown scope" }, 400);
    const kind = c.req.query("kind");
    const name = c.req.query("name");
    if ((kind !== "extensions" && kind !== "skills") || !name) {
      return c.json({ error: "kind and name required" }, 400);
    }
    return c.json({ content: await config.readResource(scope, kind, name) });
  });

  /** Real path of a file a session may expose: inside its cwd, nothing else. */
  const resolveFile = async (id: string, raw: string): Promise<string | null> => {
    const cwd = nascentCwd(id) ?? (await factory.list()).find((s) => s.id === id)?.cwd;
    if (!cwd || !isAbsolute(raw)) return null;
    try {
      // realpath both ends, so neither `..` nor a symlink can step outside.
      const root = await realpath(cwd);
      const target = await realpath(resolve(root, raw));
      if (target !== root && !target.startsWith(root + sep)) return null;
      return (await stat(target)).isFile() ? target : null;
    } catch {
      return null; // missing, unreadable, or not a file
    }
  };

  // Agent attachments: the agent links a file it produced (`file:///abs/path`)
  // and the client fetches the bytes here — read-only, and only from within
  // the session's own working directory.
  app.get("/api/sessions/:id/files", async (c) => {
    const raw = c.req.query("path");
    if (!raw) return c.json({ error: "path required" }, 400);
    const file = await resolveFile(c.req.param("id"), raw);
    if (!file) return c.json({ error: "no such file" }, 404);
    const { size } = await stat(file);
    if (size > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    const name = basename(file);
    // Unknown extension → octet-stream: never let the browser guess a type we
    // can't vouch for (that is how an attachment starts executing).
    const type = FILE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
    return c.body(await readFile(file), 200, {
      "content-type": type,
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, max-age=60",
    });
  });

  // Directory browsing for the working-directory picker (new session, IM chat
  // config). Names only, never contents — the file route above stays the only
  // way to read bytes, and it is scoped to a session's own cwd.
  app.get("/api/fs/dirs", async (c) => {
    const raw = c.req.query("path");
    const path = raw ? resolve(raw) : homedir();
    if (!isAbsolute(path)) return c.json({ error: "absolute path required" }, 400);
    let entries: string[] = [];
    try {
      const dir = await readdir(path, { withFileTypes: true });
      entries = dir
        // Dotfiles are noise in a project picker; a hidden cwd can still be
        // typed by hand.
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return c.json({ error: "cannot read directory" }, 404);
    }
    const parent = dirname(path);
    return c.json({ path, parent: parent === path ? null : parent, entries });
  });

  // Create a folder while picking one — a new project usually needs a new
  // directory. A name, never a path: traversal is rejected, not normalized.
  guarded(app, "POST", "/api/fs/dirs", 400, async (c) => {
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
