import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { listBoards, registerBoardRoutes } from "./boards.js";

let dir: string;
let app: Hono;

/** A published board is addressed by `<slug>-<token>`; fixtures pin the token
 *  so a test can build the URL without publishing through the API first. */
const TOKEN = "0123abcd";
const published = { public: true, token: TOKEN };
const key = (slug: string): string => `${slug}-${TOKEN}`;

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

describe("scanning", () => {
  it("lists boards with manifest defaults and skips non-boards", async () => {
    makeBoard("weekly-digest", { description: "what changed", sessions: ["s1"] });
    makeBoard("no-title", {});
    mkdirSync(join(dir, "not-a-board")); // no manifest
    mkdirSync(join(dir, "_toolchain"));

    const boards = await listBoards(dir);
    expect(boards.map((b) => b.slug)).toEqual(["no-title", "weekly-digest"]);
    const digest = boards[1];
    expect(digest).toMatchObject({
      title: "weekly-digest",
      description: "what changed",
      sessions: ["s1"],
      public: false,
    });
    expect(Date.parse(digest?.updatedAt ?? "")).toBeGreaterThan(0);
    // A missing title falls back to the slug rather than rendering blank.
    expect(boards[0]?.title).toBe("no-title");
  });

  it("skips an unparsable manifest instead of half-listing it", async () => {
    makeBoard("broken", "{ not json");
    makeBoard("fine");
    expect((await listBoards(dir)).map((b) => b.slug)).toEqual(["fine"]);
  });

  it("ignores directories whose name is not a slug", async () => {
    makeBoard("weekly-digest.deleted-1700000000000");
    makeBoard("Upper");
    expect(await listBoards(dir)).toEqual([]);
  });

  it("returns nothing when the boards dir does not exist", async () => {
    expect(await listBoards(join(dir, "missing"))).toEqual([]);
  });
});

describe("serving", () => {
  it("serves a board's page on the operator prefix, public or not", async () => {
    makeBoard("digest");
    const res = await app.request("/boards/digest/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts allow-same-origin",
    );
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  it("redirects a missing trailing slash so relative assets resolve", async () => {
    makeBoard("digest");
    expect((await app.request("/boards/digest")).headers.get("location")).toBe("/boards/digest/");
    expect((await app.request("/p/digest")).headers.get("location")).toBe("/p/digest/");
  });

  it("404s a private board on the public prefix and serves it once published", async () => {
    makeBoard("digest");
    expect((await app.request("/p/digest/")).status).toBe(404);

    const patch = await app.request("/api/boards/digest", {
      method: "PATCH",
      body: JSON.stringify({ public: true }),
      headers: { "content-type": "application/json" },
    });
    expect(patch.status).toBe(200);
    const { token } = (await patch.json()) as { token: string };
    expect(token).toMatch(/^[a-f0-9]{8}$/);
    // The slug alone stays a non-answer: publishing hides the door, it does
    // not put the board back on a guessable name.
    expect((await app.request("/p/digest/")).status).toBe(404);

    const res = await app.request(`/p/digest-${token}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps everything outside site/ off the wire", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(board, "README.md"), "secrets");
    mkdirSync(join(board, "src"));
    writeFileSync(join(board, "src", "index.html"), "<p>source</p>");

    // Encoded, because a literal `../` is collapsed by URL parsing long before
    // it reaches us — the escape attempt that actually arrives is this one.
    for (const at of ["/boards/digest", `/p/${key("digest")}`]) {
      expect((await app.request(`${at}/..%2Fboard.json`)).status).toBe(404);
      expect((await app.request(`${at}/..%2FREADME.md`)).status).toBe(404);
      expect((await app.request(`${at}/..%2Fsrc%2Findex.html`)).status).toBe(404);
      expect((await app.request(`${at}/%2e%2e%2fboard.json`)).status).toBe(404);
    }
  });

  it("refuses a slug that is a path or carries a NUL byte", async () => {
    makeBoard("digest", published);
    writeFileSync(join(dir, "board.json"), '{"public":true}'); // a decoy above the boards
    for (const path of [
      "/p/..%2F..%2Fetc/index.html",
      `/p/..%2F..%2Fetc-${TOKEN}/index.html`,
      "/boards/..%2F/index.html",
      `/p/a%00b-${TOKEN}/index.html`,
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
    // The decoy above the boards dir must not be readable *or* writable.
    const patch = await app.request("/api/boards/..%2F", {
      method: "PATCH",
      body: JSON.stringify({ public: false }),
      headers: { "content-type": "application/json" },
    });
    expect(patch.status).toBe(404);
    expect(readFileSync(join(dir, "board.json"), "utf8")).toBe('{"public":true}');
  });

  it("refuses symlinks that leave the site dir", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(dir, "outside.html"), "<p>nope</p>");
    symlinkSync(join(dir, "outside.html"), join(board, "site", "link.html"));
    expect((await app.request(`/p/${key("digest")}/link.html`)).status).toBe(404);
  });

  it("serves only whitelisted extensions and never shares private assets", async () => {
    const board = makeBoard("digest", published);
    writeFileSync(join(board, "site", "style.css"), "body{}");
    writeFileSync(join(board, "site", "notes.exe"), "x");
    const privateAsset = await app.request("/boards/digest/style.css");
    const publicAsset = await app.request(`/p/${key("digest")}/style.css`);
    expect(privateAsset.status).toBe(200);
    expect(privateAsset.headers.get("cache-control")).toBe("private, max-age=300");
    expect(privateAsset.headers.get("access-control-allow-origin")).toBeNull();
    expect(publicAsset.status).toBe(200);
    expect(publicAsset.headers.get("cache-control")).toBe("no-store");
    expect(publicAsset.headers.get("access-control-allow-origin")).toBe("*");
    expect((await app.request(`/p/${key("digest")}/notes.exe`)).status).toBe(404);
  });

  it("404s a wrong, missing or truncated token on a published board", async () => {
    makeBoard("digest", published);
    for (const at of [
      "/p/digest/",
      "/p/digest-/",
      "/p/digest-0123abc/",
      "/p/digest-0123abce/",
      `/p/digest-${TOKEN.toUpperCase()}/`,
      `/p/${TOKEN}/`,
    ]) {
      expect((await app.request(at)).status).toBe(404);
    }
    expect((await app.request(`/p/${key("digest")}/`)).status).toBe(200);
  });

  it("serves the shipped stylesheet", async () => {
    const res = await app.request("/p/_assets/pier.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain(".kpi");
  });
});

describe("manifest writes", () => {
  it("rejects a non-boolean public and an unknown slug", async () => {
    makeBoard("digest");
    const bad = await app.request("/api/boards/digest", {
      method: "PATCH",
      body: JSON.stringify({ public: "yes" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/api/boards/nope", {
      method: "PATCH",
      body: JSON.stringify({ public: true }),
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });

  it("preserves agent-owned fields when publishing", async () => {
    makeBoard("digest", { description: "keep me", sessions: ["s1"], note: "agent data" });
    await app.request("/api/boards/digest", {
      method: "PATCH",
      body: JSON.stringify({ public: true }),
      headers: { "content-type": "application/json" },
    });
    const boards = await listBoards(dir);
    expect(boards[0]).toMatchObject({ public: true, description: "keep me", sessions: ["s1"] });
    expect(JSON.parse(readFileSync(join(dir, "digest", "board.json"), "utf8"))).toMatchObject({
      note: "agent data",
    });
    const raw = await app.request("/api/boards");
    expect(await raw.json()).toHaveLength(1);
  });

  it("mints a token for a board an agent published itself, once and for good", async () => {
    // No PATCH: the manifest arrives public with no token, the way an agent
    // writing board.json leaves it.
    makeBoard("digest", { public: true });
    const [board] = await listBoards(dir);
    expect(board?.token).toMatch(/^[a-f0-9]{8}$/);
    // Persisted, or the next request would hand out a different URL.
    const stored = JSON.parse(readFileSync(join(dir, "digest", "board.json"), "utf8")) as {
      token: string;
    };
    expect(stored.token).toBe(board?.token);
    expect((await listBoards(dir))[0]?.token).toBe(board?.token);
    expect((await app.request(`/p/digest-${board?.token}/`)).status).toBe(200);
  });

  it("keeps a private board's manifest untouched", async () => {
    makeBoard("digest");
    expect((await listBoards(dir))[0]?.token).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "digest", "board.json"), "utf8"))).not.toHaveProperty(
      "token",
    );
  });

  it("deletes by renaming, so the bytes survive and the scan forgets it", async () => {
    makeBoard("digest");
    expect((await app.request("/api/boards/digest", { method: "DELETE" })).status).toBe(200);
    expect(await listBoards(dir)).toEqual([]);
    expect((await app.request("/boards/digest/")).status).toBe(404);
    expect((await app.request("/api/boards/digest", { method: "DELETE" })).status).toBe(404);
  });
});
