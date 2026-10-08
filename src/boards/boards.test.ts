import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBoardRoutes, rotateBoardViews } from "./boards.js";

let dir: string;
let app: Hono;

/** A board `pier boards publish` has put on Pages: `url` is the fact. */
const published = { public: true, url: "https://pier-test.pages.dev/digest/", publishedAt: "2026-10-08T07:00:00.000Z" };

/** The operator prefix hands out a signed prefix instead of bytes; a test
 *  follows that redirect the way a browser does. `/b/<slug>/<view>` without
 *  the trailing slash, so a caller can append its own path. */
async function view(slug: string): Promise<string> {
  const res = await app.request(`/boards/${slug}/`);
  expect(res.status).toBe(302);
  return (res.headers.get("location") ?? "").replace(/\/$/, "");
}

/** Hermetic: every test gets its own boards dir, never $HOME. */
function makeBoard(
  slug: string,
  manifest: Record<string, unknown> | string = {},
  page = "<h1>hi</h1>",
): string {
  const board = join(dir, slug);
  mkdirSync(join(board, "site"), { recursive: true });
  writeFileSync(
    join(board, "board.json"),
    typeof manifest === "string" ? manifest : JSON.stringify({ title: slug, ...manifest }),
  );
  writeFileSync(join(board, "site", "index.html"), page);
  return board;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-boards-"));
  app = new Hono();
  registerBoardRoutes(app, dir);
});

describe("which directories are boards", () => {
  it("skips an unparsable manifest instead of half-serving it", async () => {
    makeBoard("broken", "{ not json");
    makeBoard("fine");
    expect((await app.request("/boards/broken/")).status).toBe(404);
    expect((await app.request("/boards/fine/")).status).toBe(302);
  });

  it("ignores directories whose name is not a slug", async () => {
    makeBoard("weekly-digest.deleted-1700000000000", published);
    makeBoard("Upper", published);
    for (const slug of ["weekly-digest.deleted-1700000000000", "Upper"]) {
      expect((await app.request(`/boards/${slug}/`)).status).toBe(404);
    }
  });
});

describe("serving", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges the operator prefix for a signed one, keeping the path", async () => {
    makeBoard("digest");
    const at = await view("digest");
    expect(at).toMatch(/^\/b\/digest\/[0-9a-z]+-[\w-]{22}$/);
    expect((await app.request("/boards/digest/style.css?v=2")).headers.get("location"))
      .toMatch(/^\/b\/digest\/[0-9a-z]+-[\w-]{22}\/style\.css\?v=2$/);

    const res = await app.request(`${at}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // The whole point of the signed prefix: no board runs with same-origin.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  it("sends a prefix that expired, was forged or lost its key back through the boundary", async () => {
    makeBoard("digest");
    const at = await view("digest");
    const stamp = at.split("/").at(-1)?.split("-")[0] ?? "";
    expect((await app.request(`${at}/`)).status).toBe(200);

    // Another board's page is not what this prefix was signed for.
    makeBoard("other");
    const elsewhere = await app.request(at.replace("digest", "other") + "/");
    expect(elsewhere.headers.get("location")).toBe("/boards/other/");
    // The signature is base64url and may hold a hyphen: only the stamp moves.
    for (const bad of [
      at.replace(`/${stamp}-`, `/${stamp}x-`),
      at.replace(`/${stamp}-`, `/${(Date.now() + 9 * 3600_000).toString(36)}-`),
      // A stamp `parseInt` would read as the real one, spelled differently.
      at.replace(`/${stamp}-`, `/${stamp}!-`),
    ]) {
      const res = await app.request(`${bad}/index.html?v=1`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/boards/digest/index.html?v=1");
    }

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 3600_000 + 1000);
    expect((await app.request(`${at}/`)).status).toBe(302);
    vi.useRealTimers();

    // Signing out rotates the key, so prefixes handed to that browser die with it.
    const live = await view("digest");
    rotateBoardViews();
    expect((await app.request(`${live}/`)).status).toBe(302);
    // A board deleted while a prefix is live cannot be reopened under its slug.
    const reused = await view("digest");
    renameSync(join(dir, "digest"), join(dir, "digest.deleted-1"));
    makeBoard("digest", {}, "<h1>someone else</h1>");
    expect((await app.request(`${reused}/`)).status).toBe(302);
  });

  it("redirects a missing trailing slash so relative assets resolve, query kept", async () => {
    makeBoard("digest");
    const at = await view("digest");
    expect((await app.request(`${at}?tab=2`)).headers.get("location")).toBe(`${at}/?tab=2`);
  });

  it("serves nothing on the retired public prefix, published or not", async () => {
    makeBoard("digest", published);
    for (const path of ["/p/digest/", "/p/digest-0123abcd/", "/p/_assets/pier.css"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it("keeps everything outside site/ off the wire", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(board, "README.md"), "secrets");
    mkdirSync(join(board, "src"));
    writeFileSync(join(board, "src", "index.html"), "<p>source</p>");

    // Encoded, because a literal `../` is collapsed by URL parsing long before
    // it reaches us — the escape attempt that actually arrives is this one.
    const at = await view("digest");
    expect((await app.request(`${at}/..%2Fboard.json`)).status).toBe(404);
    expect((await app.request(`${at}/..%2FREADME.md`)).status).toBe(404);
    expect((await app.request(`${at}/..%2Fsrc%2Findex.html`)).status).toBe(404);
    expect((await app.request(`${at}/%2e%2e%2fboard.json`)).status).toBe(404);
  });

  it("refuses a slug that is a path or carries a NUL byte", async () => {
    makeBoard("digest", published);
    writeFileSync(join(dir, "board.json"), '{"public":true}'); // a decoy above the boards
    for (const path of [
      "/boards/..%2F..%2Fetc/index.html",
      "/boards/..%2F/index.html",
      "/boards/a%00b/index.html",
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
    // The decoy above the boards dir must not be readable *or* written.
    expect(readFileSync(join(dir, "board.json"), "utf8")).toBe('{"public":true}');
  });

  it("refuses symlinks that leave the site dir", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(dir, "outside.html"), "<p>nope</p>");
    symlinkSync(join(dir, "outside.html"), join(board, "site", "link.html"));
    expect((await app.request(`${await view("digest")}/link.html`)).status).toBe(404);
  });

  it("serves only whitelisted extensions, and caches nothing", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(board, "site", "style.css"), "body{}");
    writeFileSync(join(board, "site", "notes.exe"), "x");
    const at = await view("digest");
    const viewed = await app.request(`${at}/style.css`);
    expect(viewed.status).toBe(200);
    // Every board URL is revocable, so no copy may outlive the revocation.
    expect(viewed.headers.get("cache-control")).toBe("no-store");
    // Opaque origin: a font or module asset needs CORS.
    expect(viewed.headers.get("access-control-allow-origin")).toBe("*");
    expect((await app.request(`${at}/notes.exe`)).status).toBe(404);
  });

  it("serves the shipped stylesheet on the exempt prefix", async () => {
    const res = await app.request("/b/_assets/pier.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain(".kpi");
  });
});

describe("manifests", () => {
  it("never writes one: a public board without a url is pending, not minted for", async () => {
    makeBoard("digest", { public: true, description: "keep me", note: "agent data" });
    expect((await app.request("/boards/digest/")).status).toBe(302);
    expect(JSON.parse(readFileSync(join(dir, "digest", "board.json"), "utf8")))
      .toEqual({ title: "digest", public: true, description: "keep me", note: "agent data" });
    const [board] = (await (await app.request("/api/boards")).json()) as Record<string, unknown>[];
    expect(board).toMatchObject({ slug: "digest", public: true });
    expect(board).not.toHaveProperty("url");
  });

  it("deletes by renaming, so the bytes survive and every route forgets it", async () => {
    makeBoard("digest", published);
    renameSync(join(dir, "digest"), join(dir, "digest.deleted-1700000000000"));
    expect((await app.request("/boards/digest/")).status).toBe(404);
    expect(readFileSync(join(dir, "digest.deleted-1700000000000", "site", "index.html"), "utf8")).toBe("<h1>hi</h1>");
  });
});

describe("the Settings API", () => {
  it("lists boards freshest first, skipping non-boards and deleted ones that are not live", async () => {
    const stale = makeBoard("stale", { description: "old" });
    makeBoard("fresh");
    makeBoard("gone.deleted-1");
    mkdirSync(join(dir, "not-a-board"));
    utimesSync(join(stale, "site"), new Date(1e9), new Date(1e9));
    const boards = (await (await app.request("/api/boards")).json()) as { slug: string; description: string }[];
    expect(boards.map((b) => b.slug)).toEqual(["fresh", "stale"]);
    expect(boards[1]).toMatchObject({ description: "old", public: false });
  });

  it("carries url and publishedAt, and lists a deleted board that is still live", async () => {
    makeBoard("digest", published);
    makeBoard("gone.deleted-1700000000000", { public: true, url: "https://pier-test.pages.dev/gone/", publishedAt: "2026-10-08T07:00:00.000Z" });
    const boards = (await (await app.request("/api/boards")).json()) as Record<string, unknown>[];
    expect(boards.find((b) => b.slug === "digest")).toMatchObject(published);
    expect(boards.find((b) => b.slug === "gone")).toMatchObject({ deleted: true, url: "https://pier-test.pages.dev/gone/" });
    // Live, with a url: the Console's link, not the private one.
    expect(boards).toHaveLength(2);
  });

  it("answers an empty list when the boards dir does not exist", async () => {
    const other = new Hono();
    registerBoardRoutes(other, join(dir, "missing"));
    expect(await (await other.request("/api/boards")).json()).toEqual([]);
  });

  it("has no publish switch: PATCH is gone, and a traversal 404s on DELETE", async () => {
    makeBoard("digest");
    const res = await app.request("/api/boards/digest", {
      method: "PATCH",
      body: JSON.stringify({ public: true }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(readFileSync(join(dir, "digest", "board.json"), "utf8"))).toEqual({ title: "digest" });
    expect((await app.request("/api/boards/..%2F", { method: "DELETE" })).status).toBe(404);
  });

  it("deletes by renaming the folder", async () => {
    makeBoard("digest");
    expect((await app.request("/api/boards/digest", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/boards/digest/")).status).toBe(404);
    expect(readdirSync(dir).some((name) => name.startsWith("digest.deleted-"))).toBe(true);
  });
});
