import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { registerExplorerRoutes } from "./explorer.js";

// A real repo in a temp dir: the routes are a thin shell around git, so the
// test exercises the actual seam (argument building, refs) — not a mock git.
// Path containment is web/fs.test.ts's; here it is only checked to be applied.
let root: string;
let app: Hono;

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args]).toString();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pier-explorer-")));
  git("init", "-b", "main");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "a.ts"), "const x = 1;\n");
  writeFileSync(join(root, "sub", "b.md"), "# b\n");
  git("add", "-A");
  git("commit", "-m", "one");
  writeFileSync(join(root, "a.ts"), "const x = 2;\n");
  git("commit", "-am", "two");
  git("tag", "v1");
  writeFileSync(join(root, "a.ts"), "const x = 3;\n"); // uncommitted

  app = new Hono();
  registerExplorerRoutes(app);
});

const get = (ep: string, params: Record<string, string>) =>
  app.request(`/api/explorer/${ep}?${new URLSearchParams({ root, ...params })}`);

describe("explorer routes", () => {
  it("answers only for a root it can resolve", async () => {
    expect((await app.request("/api/explorer/git?root=relative/dir")).status).toBe(404);
    expect((await app.request(`/api/explorer/diff?root=${encodeURIComponent(join(root, "a.ts"))}&base=HEAD`)).status).toBe(404);
  });

  it("reports branch, refs and recent commits", async () => {
    const info = (await (await get("git", {})).json()) as {
      branch: string; refs: { name: string; subject: string }[]; commits: { hash: string; subject: string; body: string }[];
    };
    expect(info.branch).toBe("main");
    expect(info.refs).toEqual([{ name: "main", subject: "two" }, { name: "v1", subject: "two" }]);
    expect(info.commits.map((c) => c.subject)).toEqual(["two", "one"]);
    expect(info.commits.every((c) => c.body === "")).toBe(true);
    const first = info.commits[0]! as unknown as { author: string; at: number };
    expect(first.author).toBe("t");
    expect(first.at).toBeGreaterThan(1_000_000_000_000); // epoch ms, not seconds
  });

  // The folder menu is built from this: a worktree with no session in it is
  // still a place the same repository is checked out.
  it("lists every checkout of the repository, branch by branch", async () => {
    const side = join(root, "..", `${basename(root)}.side`);
    git("worktree", "add", "-q", side, "-b", "side");
    try {
      const info = (await (await get("git", {})).json()) as {
        worktrees: { path: string; branch?: string }[];
      };
      expect(info.worktrees).toEqual([
        { path: realpathSync(root), branch: "main" },
        { path: realpathSync(side), branch: "side" },
      ]);
    } finally {
      git("worktree", "remove", "--force", side);
    }
  });

  it("diffs ref↔ref and ref↔worktree, list then per-file", async () => {
    const between = (await (await get("diff", { base: "v1~1", head: "v1" })).json()) as {
      files: { status: string; path: string }[];
    };
    expect(between.files).toEqual([{ status: "M", path: "a.ts", add: 1, del: 1 }]);
    const worktree = (await (await get("diff", { base: "HEAD" })).json()) as { files: unknown[] };
    expect(worktree.files).toEqual([{ status: "M", path: "a.ts", add: 1, del: 1 }]);
    const { diff } = (await (await get("diff", { base: "v1~1", head: "v1", file: "a.ts" })).json()) as { diff: string };
    expect(diff).toContain("-const x = 1;");
    expect(diff).toContain("+const x = 2;");
  });

  it("widens diff context on request — the whole-file inline view", async () => {
    writeFileSync(join(root, "long.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    git("add", "long.txt");
    git("commit", "-m", "long");
    writeFileSync(join(root, "long.txt"), "a\nb\nc\nd\ne\nf\ng\nH\n");
    const narrow = (await (await get("diff", { base: "HEAD", file: "long.txt" })).json()) as { diff: string };
    expect(narrow.diff).not.toContain("\n a\n"); // default context misses the top
    const full = (await (await get("diff", { base: "HEAD", file: "long.txt", context: "99999" })).json()) as { diff: string };
    expect(full.diff).toContain("\n a\n"); // full context carries the whole file
    expect(full.diff).toContain("+H");
  });

  it("rejects refs that could read as options", async () => {
    expect((await get("diff", { base: "--output=/tmp/x" })).status).toBe(400);
    expect((await get("diff", { base: "HEAD", head: "-v" })).status).toBe(400);
  });
});
