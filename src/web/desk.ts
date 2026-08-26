// The desk folder: seeded on the user's click, then opened as an ordinary
// session in it. One reason to exist — everything that makes `$PIER_HOME/desk`
// a dispatcher is two prose files and a cwd, and this is the only module that
// knows which two files and which cwd. Nothing here is stored: delete the
// folder and Desk is gone, with no row to reconcile (docs/design/06-desk.md).

import { readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { logger } from "../log.js";
import { DESK_DIR, PIER_HOME } from "../paths.js";

const log = logger("desk");

/** What the folder *is*: the dispatcher prompt Pi injects because it is the
 *  cwd's own agent file, and the index it routes from. Prose in `.md` files
 *  rather than TS template literals — a 100-line prompt inside a string is a
 *  diff nobody can review — shipped beside this module the way
 *  `bus/librarian-prompt.md` is, copied into `dist/` by `build:assets`. The
 *  source names carry a `desk-` prefix because a file literally called
 *  `AGENTS.md` inside `src/` is an instruction to every agent working in this
 *  repository. */
const TEMPLATES: [written: string, source: string][] = [
  ["AGENTS.md", "desk-AGENTS.md"],
  ["projects.md", "desk-projects.md"],
];

const cache = new Map<string, string>();

/** Read on the first seed rather than at import: a file the build forgot then
 *  fails the click that needed it, naming the path, instead of taking the
 *  whole instance down at boot. */
function template(source: string): string {
  const text = cache.get(source) ??
    readFileSync(fileURLToPath(new URL(source, import.meta.url)), "utf8");
  cache.set(source, text);
  return text;
}

/**
 * The desk directory as a session's own cwd will spell it.
 *
 * `$PIER_HOME` under a symlink makes `pierPath("desk")` and the canonical path
 * two different strings, and both the rail (cwd equality) and the bus (scope
 * identity, main.ts) compare spellings — so the canonical one is resolved
 * here, server-side, once. `PIER_HOME` is what gets resolved because `realpath`
 * needs its leaf to exist and an unseeded desk has none.
 */
export function deskDir(): string {
  try {
    return join(realpathSync(PIER_HOME), "desk");
  } catch (err) {
    log.warn(`could not canonicalize ${PIER_HOME}; the rail compares raw paths`, err);
    return DESK_DIR;
  }
}

/**
 * Create the folder and write each template that is not there.
 *
 * Idempotent by construction: `wx` fails on a file that already exists, so an
 * edited `AGENTS.md` is never overwritten and a deleted one comes back on the
 * next explicit open — a visible consequence of a user action, not a
 * background restoration. 0700 like the inbox: the folder is a conversation's
 * private state, not a shared directory.
 *
 * The leaf is verified, not assumed: `mkdir` follows a symlink it finds
 * instead of failing, so a `desk` link pointing anywhere would take the
 * templates with it, and its `mode` applies only to a directory it actually
 * creates — a folder that was already 0755 would keep it. Both are refusals
 * here, and the route reports them (5b).
 */
export async function seedDesk(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`${dir} is a symlink; the desk folder must be a real directory`);
  }
  const real = await realpath(dir);
  if (real !== dir) throw new Error(`${dir} resolves to ${real}, which is outside ${PIER_HOME}`);
  if ((stat.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  for (const [written, source] of TEMPLATES) {
    // 0600 for the same reason the folder is 0700: a dispatcher prompt and a
    // project index are this instance's, not the machine's.
    await writeFile(join(dir, written), template(source), { flag: "wx", mode: 0o600 }).catch((err: unknown) => {
      // The expected path, not a swallowed failure: the user owns these files.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
  }
}

/**
 * `POST /api/desk` — seed the folder, then open a session in it.
 *
 * That is the whole route: opening a session is `openSession`, the one
 * sequence `POST /api/sessions` is also made of (server.ts), so a desk session
 * is pinned, attached and announced exactly like every other one.
 *
 * Gated on the bus, like seeding a librarian is: the dispatcher's continuity
 * across its own reset *is* `desk/threads` on the bus (desk-AGENTS.md), so
 * with the capability off this click would open a conversation whose whole
 * recovery story is missing. Sessions that already exist are untouched — only
 * the affordance that makes one is refused.
 */
export function registerDeskRoutes(
  app: Hono,
  openSession: (cwd: string) => Promise<string>,
  busEnabled: () => boolean,
): void {
  app.post("/api/desk", async (c) => {
    if (!busEnabled()) {
      return c.json({ error: "the bus is off — turn it on in Console → Bus before opening the desk" }, 409);
    }
    const dir = deskDir();
    try {
      await seedDesk(dir);
    } catch (err) {
      log.error(`could not seed ${dir}`, err);
      return c.json({ error: `could not create the desk folder: ${String(err)}` }, 500);
    }
    return c.json({ id: await openSession(dir), cwd: dir }, 201);
  });
}
