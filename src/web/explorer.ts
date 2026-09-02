// What git knows about a project directory, for the Console's Files view: the
// refs, commits and worktrees its pickers offer, and the diffs it tones into a
// file. Every route here runs git and nothing else — reading the directory and
// the files themselves is web/fs.ts, which also owns the scoping both share.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hono } from "hono";
import { scoped } from "./fs.js";
import { guarded } from "./route.js";

const run = promisify(execFile);

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** A ref never starts with `-`: execFile blocks the shell, this blocks the
 *  argument parser (`--output=…` is a write). Git validates the rest. */
const REF_RE = /^[^-\s][^\s]*$/;

/** git in `root`, output capped — a diff is display data, not an archive. */
const git = async (root: string, ...args: string[]): Promise<string> =>
  (await run("git", ["-C", root, ...args], { maxBuffer: MAX_DIFF_BYTES })).stdout;

export function registerExplorerRoutes(app: Hono): void {
  // Git refs for the diff pickers: current branch, branches+tags, recent
  // commits. Not a repo → { branch: null }, which the UI renders as "no git".
  guarded(app, "GET", "/api/explorer/git", 404, async (c) => {
    c.header("cache-control", "no-store");
    const root = await scoped(c.req.query("root"));
    let branch: string | null;
    try {
      branch = (await git(root, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    } catch {
      // not a repo, or no commits yet
      return c.json({ branch: null, refs: [], commits: [], worktrees: [] });
    }
    // Three reads of the same repository, none of which is an argument to
    // another: one wait, not three. The rev-parse above stays alone — it is
    // the guard that decides whether these three are asked at all.
    const [worktreeList, refList, commitLog] = await Promise.all([
      git(root, "worktree", "list", "--porcelain"),
      git(root, "for-each-ref", "--format=%(refname:short)\t%(subject)", "refs/heads", "refs/tags"),
      // Unit/record separators, because a body is multi-line by nature.
      git(root, "log", "-20", "--format=%h\u001f%at\u001f%an\u001f%ae\u001f%s\u001f%b\u001e"),
    ]);
    // Every checkout of this repository, from git rather than from the
    // sessions that happen to live in one: a worktree created ten seconds ago
    // has no session in it yet, and that is exactly when its files are worth
    // opening. Detached heads have no `branch` line, so the path stands alone.
    const worktrees = worktreeList
      .split("\n\n")
      .map((block) => {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        const on = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
        return path ? { path, ...(on ? { branch: on } : {}) } : null;
      })
      .filter((w): w is { path: string; branch?: string } => w !== null);
    const refs = refList
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { name: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    const commits = commitLog
      .split("\u001e")
      .map((r) => r.trimStart())
      .filter(Boolean)
      .map((r) => {
        const [hash = "", at = "", author = "", email = "", subject = "", body = ""] = r.split("\u001f");
        return { hash, at: Number(at) * 1000, author, email, subject, body: body.trim() };
      });
    return c.json({ branch, refs, commits, worktrees });
  });

  // One endpoint, two shapes: without `file` the changed-file list
  // (name-status), with it that file's unified diff. `head` empty or absent
  // means the working tree.
  guarded(app, "GET", "/api/explorer/diff", 404, async (c) => {
    c.header("cache-control", "no-store");
    const root = await scoped(c.req.query("root"));
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
