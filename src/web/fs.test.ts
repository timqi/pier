import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { registerFsRoutes } from "./fs.js";

// The one place a path from the browser becomes a path on disk: what it lets
// through, and what it refuses, is the whole point of the module.
let root: string;
let outside: string;
let app: Hono;

type Entry = { name: string; dir: boolean };
type Listing = { path: string; parent: string | null; entries: Entry[] };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pier-fs-")));
  mkdirSync(join(root, "sub"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "a.ts"), "const x = 1;\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x50, 0x00, 0x01]));
  writeFileSync(join(root, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  outside = realpathSync(mkdtempSync(join(tmpdir(), "pier-fs-outside-")));
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));

  app = new Hono();
  registerFsRoutes(app);
});

const ls = (params: Record<string, string>) =>
  app.request(`/api/fs/ls?${new URLSearchParams(params)}`);
const file = (params: Record<string, string>) =>
  app.request(`/api/fs/file?${new URLSearchParams(params)}`);

describe("fs routes", () => {
  it("lists entries dirs-first, hides .git, and keeps dotfiles for the caller to drop", async () => {
    const res = await ls({ root });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Listing;
    // A symlink is neither a file nor a directory to readdir, so it is not
    // offered — following one is a decision the file route makes, once.
    expect(list.entries.map((e) => e.name)).toEqual([
      ".hidden", "sub", "a.ts", "bin.dat", "logo.svg",
    ]);
    expect(list.entries[1]).toEqual({ name: "sub", dir: true });
    // A scoped walk may not offer a way out of its own scope.
    expect(list.parent).toBeNull();
    expect(((await (await ls({ root, path: "sub" })).json()) as Listing).parent).toBe(root);
  });

  it("browses unscoped for the cwd pickers, defaulting to $HOME", async () => {
    const list = (await (await ls({ path: root })).json()) as Listing;
    expect(list).toEqual({
      path: root,
      parent: dirname(root),
      entries: expect.arrayContaining([{ name: "sub", dir: true }]) as Entry[],
    });
    expect((await (await ls({})).json() as Listing).path).toBe(realpathSync(homedir()));
    expect((await ls({ path: "/no/such/dir" })).status).toBe(404);
    expect((await ls({ path: "relative/dir" })).status).toBe(404);
  });

  it("takes any readable directory as root — worktrees are not session cwds", async () => {
    const list = (await (await ls({ root: outside })).json()) as Listing;
    expect(list.entries).toEqual([{ name: "secret.txt", dir: false }]);
  });

  it("refuses relative roots, non-directories, and paths escaping the root", async () => {
    expect((await ls({ root: "relative/dir" })).status).toBe(404);
    expect((await ls({ root: join(root, "a.ts") })).status).toBe(404);
    expect((await ls({ root, path: "../" })).status).toBe(404);
    expect((await file({ root, path: "../../etc/passwd" })).status).toBe(404);
    // A symlink is followed and then judged by where it landed.
    expect((await file({ root, path: "escape.txt" })).status).toBe(404);
    expect((await file({ root, path: "sub" })).status).toBe(404); // a directory is not a file
  });

  it("serves text inline, unknown bytes as a download, and never an SVG in its own tab", async () => {
    const text = await file({ root, path: "a.ts" });
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(text.headers.get("content-disposition")).toContain("inline");
    expect(await text.text()).toBe("const x = 1;\n");

    const bin = await file({ root, path: "bin.dat" });
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toContain("attachment");

    // Typed, so an <img> renders it; attached, so a tab navigated at it cannot
    // run the script inside — same origin, already past the password.
    const svg = await file({ root, path: "logo.svg" });
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-disposition")).toContain("attachment");
  });

  it("offers a validator and answers a matching one with 304 and no body", async () => {
    const first = await file({ root, path: "a.ts" });
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.headers.get("last-modified")).toBe(statSync(join(root, "a.ts")).mtime.toUTCString());

    const again = await app.request(`/api/fs/file?${new URLSearchParams({ root, path: "a.ts" })}`, {
      headers: { "if-none-match": tag ?? "" },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(await again.text()).toBe("");
    // The validator is the file's own state: a rewrite invalidates it.
    writeFileSync(join(root, "a.ts"), "const x = 2;\nconst y = 3;\n");
    expect((await file({ root, path: "a.ts" })).headers.get("etag")).not.toBe(tag);
  });

  it("creates a folder by name, and refuses a path", async () => {
    const create = (body: unknown) =>
      app.request("/api/fs/mkdir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await create({ path: root, name: "new-project" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: join(root, "new-project") });
    expect(statSync(join(root, "new-project")).isDirectory()).toBe(true);

    // Traversal and separators are rejected, never normalized into a write.
    for (const name of ["../escape", "a/b", "..", ""]) {
      expect((await create({ path: root, name })).status).toBe(400);
    }
    expect((await create({ path: "relative", name: "x" })).status).toBe(400);
    // Existing folder, and a parent that does not exist: both 400, not 500.
    expect((await create({ path: root, name: "new-project" })).status).toBe(400);
    expect((await create({ path: join(root, "nope"), name: "x" })).status).toBe(400);
  });
});
