// `pier boards publish`: every `public: true` board, as one snapshot, to the
// instance's Cloudflare Pages project, and the manifests told what is live.
// Runs `wrangler` from the PATH of whoever publishes — a shell, or Pier's own
// process for the Console's button — whose credentials are never Pier's.

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { logger } from "../log.js";
import { defaultBoardsDir, PIER_CSS, scanBoards, writeManifest } from "./boards.js";

const log = logger("boards");

export interface BoardsCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** wrangler's own output as it arrives: chunks, not lines. */
  wrangler(chunk: string, stream: "stdout" | "stderr"): void;
}

/** Where public boards go: the Pages project and the address they are read at. */
export interface PagesTarget {
  project: string;
  base: string;
}

/** `POST /boards` as cli.ts performs it; the socket's own refusals never return. */
export type BoardsPost = () => Promise<{ status: number; body: { project?: string; base?: string; error?: string } }>;

const USAGE = [
  "usage: pier boards publish — push every public board to the instance's Pages project (skills/pier-boards)",
  "One line per board, `published <url>` or `removed <slug>`; a refusal is one `boards:` line, exit 1.",
].join("\n");

/** Pages' own: a page may fetch nothing but itself and is never framed. The
 *  sandbox is Pier's, for a page on the workbench's host; here the host is Pages'. */
const HEADERS = "/*\n  Content-Security-Policy: connect-src 'self'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n";

/** Pages' edge keeps answering a path the live deployment no longer has, from
 *  a copy cached up to its `s-maxage=604800` earlier — past redeploys, deleted
 *  deployments and purges; only a `_redirects` rule is consulted before it. */
const STALE_MS = 7 * 24 * 60 * 60_000;

/** 302, not 301: a browser keeps a permanent redirect, and the slug may be
 *  published again. The target `/` is Pages' 404. */
const redirects = (slugs: Iterable<string>): string =>
  [...slugs].map((slug) => `/${slug}/ / 302\n/${slug}/* / 302\n`).join("");

const processIo: BoardsCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  wrangler: (chunk, stream) => process[stream].write(chunk),
};

class WranglerMissing extends Error {}

/** One wrangler call. `quiet` keeps a `--json` answer off the terminal; the
 *  rest streams through as it happens, so a slow upload is seen uploading. */
function wrangler(args: string[], cwd: string, io: BoardsCliIo, quiet = false): Promise<{ code: number; stdout: string }> {
  return new Promise((done, reject) => {
    const child = spawn("wrangler", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    // Decoded per stream, so a character split across two chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!quiet) io.wrangler(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: string) => io.wrangler(chunk, "stderr"));
    child.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "ENOENT" ? new WranglerMissing() : err));
    child.on("close", (code) => done({ code: code ?? 1, stdout }));
  });
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export async function runBoardsCli(argv: string[], post: BoardsPost, io: BoardsCliIo = processIo, dir = defaultBoardsDir()): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    io.stdout(USAGE);
    return name ? 0 : 2;
  }
  if (name !== "publish" || rest.length) {
    io.stderr(`boards: ${name === "publish" ? `unexpected argument "${rest[0] ?? ""}"` : `unknown command "${name}"`}\n${USAGE}`);
    return 2;
  }
  const { status, body } = await post();
  const { project, base } = body;
  if (status !== 200 || !project || !base) {
    io.stderr(`boards: ${body.error ?? `socket answered ${String(status)}`}`);
    return 1;
  }
  return publishBoards(dir, { project, base }, io);
}

/** The whole publish, every failure one `boards:` line and exit 1. */
export async function publishBoards(dir: string, target: PagesTarget, io: BoardsCliIo): Promise<number> {
  try {
    return await publish(dir, target, io);
  } catch (err) {
    io.stderr(err instanceof WranglerMissing ? "boards: wrangler not found on PATH" : `boards: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function publish(dir: string, { project, base }: PagesTarget, io: BoardsCliIo): Promise<number> {
  // Taken before the snapshot: an edit landing during the upload is then
  // newer than the publish and shows as unpublished, not silently missed.
  const publishedAt = new Date().toISOString();
  const boards = await scanBoards(dir);
  const live: string[] = [];
  for (const { name, slug, deleted, manifest } of boards) {
    if (deleted || !manifest.public) continue;
    if (await stat(join(dir, name, "site", "index.html")).catch(() => null)) live.push(slug);
    else io.stderr(`boards: ${slug}: no site/index.html, skipped`);
  }
  // Every slug a publish took down within the week, and every one this publish
  // takes down: those the redirect hides until Pages' copies have expired.
  const now = Date.now();
  const withdrawn = new Set<string>();
  for (const { slug, manifest } of boards) {
    if (live.includes(slug)) continue;
    if (manifest.url || now - Date.parse(manifest.withdrawnAt ?? "") < STALE_MS) withdrawn.add(slug);
  }
  const tmp = await mkdtemp(join(tmpdir(), "pier-pages-"));
  const run = (args: string[], quiet = false) => wrangler(args, tmp, io, quiet);
  try {
    for (const slug of live) await cp(join(dir, slug, "site"), join(tmp, slug), { recursive: true });
    await mkdir(join(tmp, "b", "_assets"), { recursive: true });
    await cp(PIER_CSS, join(tmp, "b", "_assets", "pier.css"));
    await writeFile(join(tmp, "_headers"), HEADERS);
    if (withdrawn.size) await writeFile(join(tmp, "_redirects"), redirects(withdrawn));

    const listed = await run(["pages", "project", "list", "--json"], true);
    const projects = parseJson(listed.stdout);
    if (listed.code !== 0 || !Array.isArray(projects)) return fail(io, "project list");
    if (!projects.some((p: unknown) => (p as Record<string, unknown>)["Project Name"] === project)) {
      const created = await run(["pages", "project", "create", project, "--production-branch", "main"]);
      if (created.code !== 0) return fail(io, "project create");
    }

    const deployed = await run(["pages", "deploy", tmp, "--project-name", project, "--branch", "main", "--commit-dirty=true"]);
    const url = new RegExp(`https://([a-z0-9]+)\\.${project}\\.pages\\.dev`).exec(deployed.stdout);
    if (deployed.code !== 0 || !url) return fail(io, "deploy");
    const hash = url[1]!;
    // After the deploy: the last copy Pages can have cached is from before now.
    const deployedAt = new Date().toISOString();

    // Only the deployments older than this one: two publishes racing each
    // other then never delete the newer.
    const listing = await run(["pages", "deployment", "list", "--project-name", project, "--json"], true);
    const deployments = parseJson(listing.stdout);
    const ids = Array.isArray(deployments)
      ? deployments.map((d: unknown) => ({ id: String((d as Record<string, unknown>).Id ?? ""), url: String((d as Record<string, unknown>).Deployment ?? "") }))
      : [];
    const mine = ids.findIndex((d) => d.url === url[0] || d.id.startsWith(hash));
    const older = listing.code === 0 && mine >= 0 ? ids.slice(mine + 1) : null;
    let deleted = 0;
    let notDeleted = 0;
    for (const { id } of older ?? []) {
      const gone = await run(["pages", "deployment", "delete", id, "--project-name", project, "--force"]);
      if (gone.code === 0) deleted++;
      else notDeleted++;
    }

    // Live now, so the manifests say so even when the cleanup above failed.
    const removed: string[] = [];
    for (const { name, slug, deleted: isDeleted, manifest } of boards) {
      // `token` is the old `/p/` secret; the first publish retires it.
      const { url: was, publishedAt: _wasAt, withdrawnAt, token: _token, ...rest } = manifest;
      const out = was ? deployedAt : withdrawnAt;
      const next = live.includes(slug) && !isDeleted
        ? { ...rest, url: `${base}/${slug}/`, publishedAt }
        : withdrawn.has(slug) && out ? { ...rest, withdrawnAt: out } : rest;
      if (was && !("url" in next)) removed.push(slug);
      // Same keys in the same order as the read, so a private board untouched
      // by this publish is not rewritten.
      if (JSON.stringify(next) !== JSON.stringify(manifest)) await writeManifest(dir, name, next);
      if ("url" in next) io.stdout(`published ${next.url}`);
    }
    for (const slug of removed) io.stdout(`removed ${slug}`);
    io.stdout(`deployment ${hash}, ${String(deleted)} older deleted`);
    if (older === null || notDeleted) {
      const where = removed.length ? ` — ${removed.join(", ")} may still be reachable at their hash URLs` : "";
      io.stderr(`boards: ${older === null ? "deployment list failed, older deployments" : `${String(notDeleted)} older deployments`} not deleted${where}`);
      return 1;
    }
    return 0;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function fail(io: BoardsCliIo, step: string): number {
  io.stderr(`boards: ${step} failed`);
  return 1;
}

/** One SSE frame of `POST /api/boards/publish`: a result line, a `boards:`
 *  line, wrangler's output, or the exit code that ends the stream. */
export type PublishFrame = { out: string } | { err: string } | { log: string } | { exit: number };

/** Under a proxy's idle cutoff while wrangler waits on an approval. */
const PING_MS = 15_000;

/** The Console's Publish button: this same publish in Pier's own process, so
 *  `wrangler` is the one on the service's PATH. One at a time per process; a
 *  closed tab does not stop a deploy halfway. */
export function registerPublishRoute(app: Hono, target: () => PagesTarget | null, dir: string = defaultBoardsDir()): void {
  let running = false;
  app.post("/api/boards/publish", (c) => {
    const pages = target();
    if (!pages) return c.json({ error: "no Pages project configured — save one above" }, 422);
    if (running) return c.json({ error: "a publish is already running" }, 409);
    running = true;
    log.info(`publish to ${pages.project} started`);
    return streamSSE(c, async (stream) => {
      // Hono drops a write to a closed stream; the publish runs on regardless.
      const send = (frame: PublishFrame): Promise<unknown> => stream.writeSSE({ data: JSON.stringify(frame) });
      const ping = setInterval(() => void stream.write(": ping\n\n"), PING_MS);
      try {
        const code = await publishBoards(dir, pages, {
          stdout: (line) => void send({ out: line }),
          stderr: (line) => {
            log.warn(`publish: ${line}`);
            void send({ err: line });
          },
          wrangler: (chunk) => void send({ log: chunk }),
        });
        log.info(`publish to ${pages.project} exited ${String(code)}`);
        await send({ exit: code });
      } finally {
        clearInterval(ping);
        running = false;
      }
    });
  });
}
