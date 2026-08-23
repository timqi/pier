// Files view backend: read-only directory listing, file bytes and git
// ref/diff queries for the Console's Files view. Every route is scoped to a
// known project cwd — the picker offers exactly those roots, and nothing
// outside one is ever listed, read or diffed.

import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Hono } from "hono";
import type { AgentFactory } from "../core/types.js";
import { guarded } from "./files.js";

const run = promisify(execFile);

// Inline-renderable binary types; text is sniffed, everything else downloads.
const BINARY_TYPES: Record<string, string> = {
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
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** A ref never starts with `-`: execFile blocks the shell, this blocks the
 *  argument parser (`--output=…` is a write). Git validates the rest. */
const REF_RE = /^[^-\s][^\s]*$/;

/** git in `root`, output capped — a diff is display data, not an archive. */
const git = async (root: string, ...args: string[]): Promise<string> =>
  (await run("git", ["-C", root, ...args], { maxBuffer: MAX_DIFF_BYTES })).stdout;

export interface ExplorerDeps {
  factory: AgentFactory;
  /** cwds of sessions Pi hasn't persisted yet (server.ts's nascent map). */
  nascentCwds: () => string[];
}

export function registerExplorerRoutes(app: Hono, { factory, nascentCwds }: ExplorerDeps): void {
  /** The scope check every route shares: `root` must be a project cwd Pi
   *  already knows, and `path` must resolve inside it (realpath both ends —
   *  neither `..` nor a symlink steps outside). Returns the real target. */
  const resolveScoped = async (root: string | undefined, path = ""): Promise<string> => {
    if (!root || !isAbsolute(root)) throw new Error("root must be a known project directory");
    const known = new Set([...(await factory.list()).map((s) => s.cwd), ...nascentCwds()]);
    if (!known.has(root)) throw new Error("root must be a known project directory");
    const real = await realpath(root);
    const target = await realpath(resolve(real, path));
    if (target !== real && !target.startsWith(real + sep)) throw new Error("path escapes root");
    return target;
  };

  // Directory listing, names only. `.git` is plumbing, not content.
  guarded(app, "GET", "/api/explorer/ls", 404, async (c) => {
    c.header("cache-control", "no-store");
    const dir = await resolveScoped(c.req.query("root"), c.req.query("path"));
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.name !== ".git" && (e.isDirectory() || e.isFile()))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return c.json({ entries });
  });

  // File bytes, read-only. Known binary types render inline; anything else is
  // sniffed — a NUL in the head means bytes we can't vouch for, so it
  // downloads instead of rendering (that is how a file starts executing).
  guarded(app, "GET", "/api/explorer/file", 404, async (c) => {
    const file = await resolveScoped(c.req.query("root"), c.req.query("path"));
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    const binary = BINARY_TYPES[extname(file).toLowerCase()];
    const text = !binary && !bytes.subarray(0, 8192).includes(0);
    return c.body(bytes, 200, {
      "content-type": binary ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream"),
      "content-disposition": `${binary || text ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
      "cache-control": "no-store",
    });
  });

  // Git refs for the diff pickers: current branch, branches+tags, recent
  // commits. Not a repo → { branch: null }, which the UI renders as "no git".
  guarded(app, "GET", "/api/explorer/git", 404, async (c) => {
    c.header("cache-control", "no-store");
    const root = await resolveScoped(c.req.query("root"));
    let branch: string | null;
    try {
      branch = (await git(root, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    } catch {
      return c.json({ branch: null, refs: [], commits: [] }); // not a repo, or no commits yet
    }
    const refs = (await git(root, "for-each-ref", "--format=%(refname:short)\t%(subject)", "refs/heads", "refs/tags"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { name: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    // Unit/record separators, because a body is multi-line by nature.
    const commits = (await git(root, "log", "-20", "--format=%h\u001f%at\u001f%an\u001f%s\u001f%b\u001e"))
      .split("\u001e")
      .map((r) => r.trimStart())
      .filter(Boolean)
      .map((r) => {
        const [hash = "", at = "", author = "", subject = "", body = ""] = r.split("\u001f");
        return { hash, at: Number(at) * 1000, author, subject, body: body.trim() };
      });
    return c.json({ branch, refs, commits });
  });

  // One endpoint, two shapes: without `file` the changed-file list
  // (name-status), with it that file's unified diff. `head` empty or absent
  // means the working tree.
  guarded(app, "GET", "/api/explorer/diff", 404, async (c) => {
    c.header("cache-control", "no-store");
    const root = await resolveScoped(c.req.query("root"));
    const base = c.req.query("base") ?? "";
    const head = c.req.query("head") ?? "";
    if (!REF_RE.test(base) || (head !== "" && !REF_RE.test(head)))
      return c.json({ error: "invalid ref" }, 400);
    const range = head ? [base, head] : [base];
    // Context radius for per-file diffs — the UI asks for a huge one to render
    // the whole file with changes toned inline, not a bare patch.
    const context = Math.min(99_999, Math.max(0, Math.trunc(Number(c.req.query("context"))) || 0));
    const file = c.req.query("file");
    if (file === undefined) {
      // name-status carries the letter, numstat the +/- counts; joined by path.
      const [nameStatus, numstat] = await Promise.all([
        git(root, "diff", "--name-status", ...range, "--"),
        git(root, "diff", "--numstat", ...range, "--"),
      ]);
      // numstat spells a rename "a/{old => new}.ts" — reduce it to the new path.
      const newPath = (p: string): string =>
        p.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/^(.*) => (.*)$/, "$2");
      const counts = new Map(
        numstat.split("\n").filter(Boolean).map((line) => {
          const [add = "", del = "", ...path] = line.split("\t");
          // "-" on both sides means binary — no line counts to report.
          return [newPath(path.join("\t")), { add: Number(add) || 0, del: Number(del) || 0 }] as const;
        }),
      );
      const files = nameStatus
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // Renames/copies are "R100\told\tnew" — show the new path.
          const [status = "", ...paths] = line.split("\t");
          const path = paths[paths.length - 1] ?? "";
          return { status: status.charAt(0), path, ...(counts.get(path) ?? { add: 0, del: 0 }) };
        });
      return c.json({ files });
    }
    // The path only reaches git behind `--`, so it is data, never an option.
    return c.json({ diff: await git(root, "diff", `-U${context || 3}`, ...range, "--", file) });
  });
}
