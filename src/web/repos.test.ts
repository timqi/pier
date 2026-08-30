// What the rail groups by. Against real worktrees of a real repository in a
// temp directory — the whole point is that two sibling checkouts of one repo
// report the same identity, and no fake of `git` can be evidence of that.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoIndex } from "./repos.js";

let root: string;

const git = (at: string, ...args: string[]): string =>
  execFileSync("git", ["-C", at, "-c", "user.email=t@t", "-c", "user.name=t", ...args]).toString();

/** `get` never waits, so a test does what the browser does: look again. */
const settled = async <T>(read: () => T): Promise<T> => {
  for (let i = 0; i < 50 && read() === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  return read();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pier-repos-"));
  // `-b`, because the default branch name is the machine's to configure and CI
  // is not this machine: an unnamed `init` gave `master` there and `main` here.
  git(root, "init", "-q", "-b", "main", "main");
  git(join(root, "main"), "commit", "-q", "--allow-empty", "-m", "first");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repository identity", () => {
  it("gives every worktree of one repository the same key, and its own branch", async () => {
    const main = join(root, "main");
    git(main, "worktree", "add", "-q", join(root, "feature"), "-b", "feature");
    const index = new RepoIndex();

    const one = await settled(() => index.get(main));
    const two = await settled(() => index.get(join(root, "feature")));
    expect(one?.repo).toBe(join(main, ".git"));
    expect(two?.repo).toBe(one?.repo);
    expect([one?.branch, two?.branch]).toEqual(["main", "feature"]);
  });

  it("answers nothing for a directory that is not a checkout, without asking twice", async () => {
    const probe = vi.fn(async () => null);
    const index = new RepoIndex(() => {}, probe);
    expect(index.get(root)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(index.get(root)).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });

  it("reports a detached head as a checkout with no branch", async () => {
    const main = join(root, "main");
    git(main, "checkout", "-q", "--detach");
    const index = new RepoIndex();
    expect(await settled(() => index.get(main))).toEqual({ repo: join(main, ".git") });
  });

  // The first read of a directory answers before git does, so the surface that
  // rendered one project per directory has to be told to look again — and only
  // then, or a rail that fetches on every change would never stop.
  it("announces an answer that changed the grouping, and only that", async () => {
    const changed = vi.fn();
    const index = new RepoIndex(changed, async () => ({ repo: "/r/.git", branch: "main" }));
    expect(index.get("/r")).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(index.get("/r")).toEqual({ repo: "/r/.git", branch: "main" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("keeps answering while a probe fails, instead of retrying it on every read", async () => {
    const probe = vi.fn(() => Promise.reject(new Error("git: exploded")));
    const index = new RepoIndex(() => {}, probe);
    index.get("/r");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    index.get("/r");
    expect(probe).toHaveBeenCalledOnce();
  });
});
