import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPublishRoute, runBoardsCli, type BoardsCliIo, type PublishFrame } from "./publish.js";

let dir: string;
let bin: string;
let out: string[];
let err: string[];
let log: string;
const io: BoardsCliIo = { stdout: (l) => out.push(l), stderr: (l) => err.push(l), wrangler: (chunk) => void (log += chunk) };
const PROJECT = "pier-test";
const BASE = "https://pier-test.pages.dev";
const ok = async () => ({ status: 200, body: { project: PROJECT, base: BASE } });

/** What a deployment list answers (wrangler's `--json` shape), newest first;
 *  the deploy answers the middle one, so there is one newer and one older. */
const DEPLOYMENTS = [
  { Id: "ffffffff-0000-0000-0000-000000000000", Environment: "Production", Deployment: `https://ffffffff.${PROJECT}.pages.dev`, Status: "Active" },
  { Id: "abcd1234-0000-0000-0000-000000000000", Environment: "Production", Deployment: `https://abcd1234.${PROJECT}.pages.dev`, Status: "Active" },
  { Id: "00000001-0000-0000-0000-000000000000", Environment: "Production", Deployment: `https://00000001.${PROJECT}.pages.dev`, Status: "Active" },
];

/** A `wrangler` on PATH that records argv and replays canned answers; the
 *  snapshot it was handed is copied aside, since the real one is removed. */
function fakeWrangler(over: Partial<Record<"projects" | "deploy" | "list" | "delete", string>> = {}): void {
  const script = `#!/bin/sh
echo "$@" >> "${join(bin, "calls")}"
case "$*" in
  "pages project list --json") ${over.projects ?? `echo '[{"Project Name":"${PROJECT}"}]'`} ;;
  "pages project create "*) echo "Successfully created the '${PROJECT}' project." ;;
  "pages deploy "*) mkdir -p "$3/.wrangler"; cp -r "$3" "${join(bin, "snapshot")}"; ${over.deploy ?? `echo "✨ Deployment complete! Take a peek over at https://abcd1234.${PROJECT}.pages.dev"`} ;;
  "pages deployment list "*) ${over.list ?? `cat "${join(bin, "deployments.json")}"`} ;;
  "pages deployment delete "*) ${over.delete ?? 'echo "Successfully deleted deployment $4"'} ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`;
  writeFileSync(join(bin, "wrangler"), script);
  chmodSync(join(bin, "wrangler"), 0o755);
  writeFileSync(join(bin, "deployments.json"), JSON.stringify(DEPLOYMENTS));
}

const calls = (): string[] => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : []);

function makeBoard(name: string, manifest: Record<string, unknown>, withIndex = true): string {
  const board = join(dir, name);
  mkdirSync(join(board, "site"), { recursive: true });
  writeFileSync(join(board, "board.json"), JSON.stringify({ title: name, ...manifest }));
  if (withIndex) writeFileSync(join(board, "site", "index.html"), `<h1>${name}</h1>`);
  return board;
}

const manifest = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, name, "board.json"), "utf8")) as Record<string, unknown>;

let savedPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-boards-"));
  bin = mkdtempSync(join(tmpdir(), "pier-wrangler-"));
  out = [];
  err = [];
  log = "";
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

describe("pier boards publish", () => {
  it("snapshots only public boards' site/, deploys, prunes older deployments and writes back", async () => {
    fakeWrangler();
    const digest = makeBoard("digest", { public: true, token: "0123abcd", note: "agent data" });
    writeFileSync(join(digest, "README.md"), "how it was built");
    mkdirSync(join(digest, "site", "img"));
    writeFileSync(join(digest, "site", "img", "a.svg"), "<svg/>");
    makeBoard("draft", { public: false });
    makeBoard("stale", { public: false, url: `${BASE}/stale/`, publishedAt: "2026-01-01T00:00:00.000Z" });
    makeBoard("gone.deleted-1700000000000", { public: true, url: `${BASE}/gone/`, publishedAt: "2026-01-01T00:00:00.000Z" });
    makeBoard("empty", { public: true }, false);
    const before = statSync(join(dir, "draft", "board.json")).mtimeMs;

    const started = Date.now();
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(0);

    const snapshot = join(bin, "snapshot");
    expect(readdirSync(snapshot).sort()).toEqual([".wrangler", "_headers", "_redirects", "b", "digest"]);
    expect(readdirSync(join(snapshot, "digest")).sort()).toEqual(["img", "index.html"]);
    expect(readFileSync(join(snapshot, "_headers"), "utf8")).toBe(
      "/*\n  Content-Security-Policy: connect-src 'self'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n",
    );
    expect(readFileSync(join(snapshot, "b", "_assets", "pier.css"), "utf8")).toContain(".kpi");
    // What was live and is not: Pages' edge would keep serving it from cache.
    expect(readFileSync(join(snapshot, "_redirects"), "utf8")).toBe("/gone/ / 302\n/gone/* / 302\n/stale/ / 302\n/stale/* / 302\n");

    expect(calls()).toEqual([
      "pages project list --json",
      expect.stringMatching(/^pages deploy \/.+ --project-name pier-test --branch main --commit-dirty=true$/),
      "pages deployment list --project-name pier-test --json",
      "pages deployment delete 00000001-0000-0000-0000-000000000000 --project-name pier-test --force",
    ]);

    const published = manifest("digest");
    expect(published).toMatchObject({ title: "digest", public: true, note: "agent data", url: `${BASE}/digest/` });
    expect(published).not.toHaveProperty("token");
    // The publish's start, not its end: an edit during the upload stays unpublished.
    expect(Date.parse(String(published.publishedAt))).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(String(published.publishedAt))).toBeLessThanOrEqual(Date.now());
    // A rewrite is the normalized manifest: title and description always present.
    const withdrawnAt = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
    expect(manifest("stale")).toEqual({ title: "stale", description: "", public: false, withdrawnAt });
    expect(Date.parse(String(manifest("stale").withdrawnAt))).toBeGreaterThanOrEqual(Date.parse(String(published.publishedAt)));
    expect(manifest("gone.deleted-1700000000000")).toEqual({ title: "gone.deleted-1700000000000", description: "", public: true, withdrawnAt });
    expect(statSync(join(dir, "draft", "board.json")).mtimeMs).toBe(before);

    expect(err).toEqual(["boards: empty: no site/index.html, skipped"]);
    expect(out).toEqual([`published ${BASE}/digest/`, "removed gone", "removed stale", "deployment abcd1234, 1 older deleted"]);
    // The snapshot dir is gone, `.wrangler/` with it.
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("pier-pages-"))).toEqual([]);
  });

  it("creates the project when the account has none by that name", async () => {
    fakeWrangler({ projects: "echo '[]'" });
    makeBoard("digest", { public: true });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(0);
    expect(calls()[1]).toBe("pages project create pier-test --production-branch main");
  });

  it("publishes an empty snapshot when no board is public: the all-unpublish path", async () => {
    fakeWrangler();
    makeBoard("stale", { public: false, url: `${BASE}/stale/`, publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(0);
    expect(readdirSync(join(bin, "snapshot")).sort()).toEqual([".wrangler", "_headers", "_redirects", "b"]);
    expect(manifest("stale")).toMatchObject({ public: false, withdrawnAt: expect.any(String) });
    expect(manifest("stale")).not.toHaveProperty("url");
    expect(out).toEqual(["removed stale", "deployment abcd1234, 1 older deleted"]);
  });

  it("keeps redirecting a withdrawn slug for a week, then drops it; publishing it again ends the redirect", async () => {
    fakeWrangler();
    const day = 24 * 60 * 60_000;
    const recent = new Date(Date.now() - 3 * day).toISOString();
    makeBoard("recent", { public: false, description: "", withdrawnAt: recent });
    makeBoard("old.deleted-1700000000000", { description: "", public: true, withdrawnAt: new Date(Date.now() - 8 * day).toISOString() });
    makeBoard("back", { public: true, withdrawnAt: recent });
    const before = statSync(join(dir, "recent", "board.json")).mtimeMs;

    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(0);

    expect(readFileSync(join(bin, "snapshot", "_redirects"), "utf8")).toBe("/recent/ / 302\n/recent/* / 302\n");
    expect(manifest("recent").withdrawnAt).toBe(recent);
    expect(statSync(join(dir, "recent", "board.json")).mtimeMs).toBe(before);
    expect(manifest("old.deleted-1700000000000")).toEqual({ title: "old.deleted-1700000000000", description: "", public: true });
    expect(manifest("back")).toMatchObject({ url: `${BASE}/back/` });
    expect(manifest("back")).not.toHaveProperty("withdrawnAt");
    expect(out).toEqual([`published ${BASE}/back/`, "deployment abcd1234, 1 older deleted"]);
  });

  it("writes no _redirects when nothing was withdrawn", async () => {
    fakeWrangler();
    makeBoard("digest", { public: true });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(0);
    expect(readdirSync(join(bin, "snapshot"))).not.toContain("_redirects");
  });

  it("leaves every manifest alone when the deploy fails", async () => {
    fakeWrangler({ deploy: 'echo "upload failed" >&2; exit 1' });
    makeBoard("digest", { public: true, token: "0123abcd" });
    makeBoard("stale", { public: false, url: `${BASE}/stale/` });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(1);
    expect(err).toEqual(["boards: deploy failed"]);
    expect(log).toContain("upload failed");
    expect(manifest("digest")).toEqual({ title: "digest", public: true, token: "0123abcd" });
    expect(manifest("stale")).toEqual({ title: "stale", public: false, url: `${BASE}/stale/` });
    expect(calls()).toHaveLength(2);
  });

  it("writes back but exits 1 when an older deployment could not be deleted", async () => {
    fakeWrangler({ delete: 'echo "nope" >&2; exit 1' });
    makeBoard("digest", { public: true });
    makeBoard("stale", { public: false, url: `${BASE}/stale/` });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(1);
    expect(manifest("digest")).toMatchObject({ url: `${BASE}/digest/` });
    expect(manifest("stale")).toEqual({ title: "stale", description: "", public: false, withdrawnAt: expect.any(String) });
    expect(out.at(-1)).toBe("deployment abcd1234, 0 older deleted");
    expect(err).toEqual(["boards: 1 older deployments not deleted — stale may still be reachable at their hash URLs"]);
  });

  it("says so when wrangler is not on PATH", async () => {
    process.env.PATH = "/nonexistent";
    makeBoard("digest", { public: true });
    expect(await runBoardsCli(["publish"], ok, io, dir)).toBe(1);
    expect(err).toEqual(["boards: wrangler not found on PATH"]);
    expect(manifest("digest")).toEqual({ title: "digest", public: true });
  });

  it("prints the socket's refusal when no project is configured, before touching wrangler", async () => {
    fakeWrangler();
    makeBoard("digest", { public: true });
    const refused = async () => ({ status: 422, body: { error: "no Pages project configured — Console → Boards" } });
    expect(await runBoardsCli(["publish"], refused, io, dir)).toBe(1);
    expect(err).toEqual(["boards: no Pages project configured — Console → Boards"]);
    expect(calls()).toEqual([]);
  });

  it("knows only publish", async () => {
    expect(await runBoardsCli([], ok, io, dir)).toBe(2);
    expect(await runBoardsCli(["--help"], ok, io, dir)).toBe(0);
    expect(await runBoardsCli(["unpublish"], ok, io, dir)).toBe(2);
    expect(await runBoardsCli(["publish", "digest"], ok, io, dir)).toBe(2);
    expect(err[0]).toContain('boards: unknown command "unpublish"');
    expect(err[1]).toContain('boards: unexpected argument "digest"');
  });
});

describe("POST /api/boards/publish", () => {
  const app = (target: { project: string; base: string } | null = { project: PROJECT, base: BASE }): Hono => {
    const hono = new Hono();
    registerPublishRoute(hono, () => target, dir);
    return hono;
  };
  const frames = async (res: Response): Promise<PublishFrame[]> =>
    (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as PublishFrame);

  it("streams the same publish as the CLI and ends on its exit code", async () => {
    fakeWrangler();
    makeBoard("digest", { public: true });
    const res = await app().request("/api/boards/publish", { method: "POST" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const got = await frames(res);
    expect(got.filter((f) => "out" in f)).toEqual([{ out: `published ${BASE}/digest/` }, { out: "deployment abcd1234, 1 older deleted" }]);
    expect(got.some((f) => "log" in f && f.log.includes("Deployment complete"))).toBe(true);
    expect(got.at(-1)).toEqual({ exit: 0 });
    expect(manifest("digest")).toMatchObject({ url: `${BASE}/digest/` });
  });

  it("carries a refused credential as wrangler's output, a boards: line and exit 1", async () => {
    fakeWrangler({ projects: 'echo "vt: approval denied" >&2; exit 1' });
    makeBoard("digest", { public: true });
    const got = await frames(await app().request("/api/boards/publish", { method: "POST" }));
    expect(got).toEqual([{ log: "vt: approval denied\n" }, { err: "boards: project list failed" }, { exit: 1 }]);
  });

  it("refuses a second publish while one runs, and takes one again after", async () => {
    fakeWrangler({ projects: `sleep 0.3; echo '[{"Project Name":"${PROJECT}"}]'` });
    makeBoard("digest", { public: true });
    const hono = app();
    const first = await hono.request("/api/boards/publish", { method: "POST" });
    const second = await hono.request("/api/boards/publish", { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "a publish is already running" });
    expect((await frames(first)).at(-1)).toEqual({ exit: 0 });
    expect((await frames(await hono.request("/api/boards/publish", { method: "POST" }))).at(-1)).toEqual({ exit: 0 });
  });

  it("says no project is configured, before touching wrangler", async () => {
    fakeWrangler();
    const res = await app(null).request("/api/boards/publish", { method: "POST" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "no Pages project configured — save one above" });
    expect(calls()).toEqual([]);
  });
});
