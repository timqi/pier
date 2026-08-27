import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { registerExplorerRoutes } from "./explorer.js";

// A real repo in a temp dir: the routes are a thin shell around git, so the
// test exercises the actual seam (argument building, scoping) — not a mock git.
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
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x50, 0x00, 0x01]));

  app = new Hono();
  registerExplorerRoutes(app);
});

const get = (ep: string, params: Record<string, string>) =>
  app.request(`/api/explorer/${ep}?${new URLSearchParams({ root, ...params })}`);

describe("explorer routes", () => {
  it("lists entries dirs-first and hides .git", async () => {
    const res = await get("ls", {});
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { name: string; dir: boolean }[] };
    expect(entries.map((e) => e.name)).toEqual(["sub", "a.ts", "bin.dat"]);
  });

  it("takes any readable directory as root — worktrees are not session cwds", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pier-explorer-other-")));
    writeFileSync(join(other, "c.txt"), "c\n");
    const res = await app.request(`/api/explorer/ls?root=${encodeURIComponent(other)}`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { name: string; dir: boolean }[] };
    expect(entries).toEqual([{ name: "c.txt", dir: false }]);
  });

  it("refuses relative roots, non-directories and paths escaping the root", async () => {
    expect((await app.request("/api/explorer/ls?root=relative/dir")).status).toBe(404);
    expect((await app.request(`/api/explorer/ls?root=${encodeURIComponent(join(root, "a.ts"))}`)).status).toBe(404);
    expect((await get("ls", { path: "../" })).status).toBe(404);
    expect((await get("file", { path: "../../etc/passwd" })).status).toBe(404);
  });

  it("serves text inline and unknown bytes as a download", async () => {
    const text = await get("file", { path: "a.ts" });
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe("const x = 3;\n");
    const bin = await get("file", { path: "bin.dat" });
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toContain("attachment");
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
