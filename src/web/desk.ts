// The desk folder: seeded on the user's click, then opened as an ordinary
// session in it — the same click that resets it, when the conversation it would
// have continued is provably spent. One reason to exist — everything that makes `$PIER_HOME/desk`
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
import type { AgentSession, SessionSummary } from "../core/types.js";

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
 * Past this share of the context window, opening Desk means a *new*
 * conversation rather than the old one.
 *
 * Why 0.7 and not "when it is full": past it Pi's own auto-compaction is near,
 * and a lossy summary of a transcript is exactly what Desk's state makes
 * unnecessary — the successor rehydrates from `AGENTS.md`, `projects.md` and
 * the bus facts, which is the whole reason a desk reset is cheap (decision 3,
 * docs/design/06-desk.md). Under it, continuing costs nothing.
 */
const RESET_ABOVE_CONTEXT_SHARE = 0.7;

/** What the cold test reads off a session — narrowed on purpose: this route
 *  decides whether to open a new conversation, it does not drive one. */
type DeskSession = Pick<AgentSession, "id" | "state" | "contextUsage">;

/** What the route needs from the server that registers it (server.ts). */
export interface DeskDeps {
  /** Create, attach, pin and announce a session in `cwd` — the one sequence
   *  `POST /api/sessions` is also made of. */
  openSession: (cwd: string) => Promise<string>;
  /** The pinned sessions, the same rows the rail derives Desk from. */
  pinned: () => SessionSummary[];
  /** Resume one: the server's `ensureLoadable`, which rejects for a session Pi
   *  never persisted *and* drops its rail entry on the way out. */
  load: (id: string) => Promise<DeskSession>;
  /** Background runs this session launched that are still in flight. */
  activeRuns: (id: string) => number;
  busEnabled: () => boolean;
}

/**
 * The desk conversation the rail's row points at, resumed — or null when there
 * is none.
 *
 * The derivation is `splitDesk`'s (ui/sidebar.ts), over the same pinned rows
 * the rail draws: newest `createdAt` whose cwd is the desk folder. A ghost
 * counts as none — `load` is where one is discovered and its rail entry
 * dropped, so the click that found it opens a real conversation instead of
 * failing on a dead id.
 */
async function newestDesk(deps: DeskDeps, dir: string): Promise<DeskSession | null> {
  const row = deps.pinned()
    .filter((s) => s.cwd === dir)
    .reduce<SessionSummary | null>((a, b) => (a && a.createdAt >= b.createdAt ? a : b), null);
  if (!row) return null;
  return await deps.load(row.id).catch((err: unknown) => {
    log.warn(`desk session ${row.id} could not be resumed; opening a new one`, err);
    return null;
  });
}

/**
 * Provably done with: nothing running, nothing it delegated still in flight,
 * and a context far enough along that continuing buys a summary instead of the
 * files and facts a successor reads anyway.
 *
 * Unknown usage is not cold — before the first turn, and right after a
 * compaction, `tokens` is null — because a reset is only ever the answer when
 * the evidence for it is there. Deliberately *not* consulted: `desk/threads`
 * and a finished run still waiting for a decision reply. The first would drag
 * bus knowledge into this route for a fact the prompt already writes; the
 * second is an accepted edge, recorded in docs/design/06-desk.md.
 */
const spent = (session: DeskSession, activeRuns: number): boolean => {
  const usage = session.contextUsage;
  return session.state === "idle" && activeRuns === 0 &&
    usage?.tokens != null && usage.contextWindow > 0 &&
    usage.tokens / usage.contextWindow >= RESET_ABOVE_CONTEXT_SHARE;
};

/**
 * `POST /api/desk` — seed the folder, then hand back the desk conversation to
 * open: the existing one, or a new one when the existing one is provably cold.
 *
 * This is the entire Desk click, so the rail decides nothing: `fresh` says
 * which of the two it got. Opening a session is `openSession`, the one
 * sequence `POST /api/sessions` is also made of (server.ts), so a desk session
 * is pinned, attached and announced exactly like every other one.
 *
 * **The reset is the user's own click, and nothing else.** No timer, no sweep:
 * a boundary drawn by the person who drew it can never interrupt a turn they
 * were watching, and it creates no conversation nobody asked for.
 *
 * Gated on the bus, like seeding a librarian is: the dispatcher's continuity
 * across its own reset *is* `desk/threads` (desk-AGENTS.md), so with the
 * capability off there is nothing for a successor to rehydrate from. The gate
 * is therefore on *making* a desk conversation, not on having one — an
 * existing one still opens, and is never reset while the bus is off.
 */
export function registerDeskRoutes(app: Hono, deps: DeskDeps): void {
  app.post("/api/desk", async (c) => {
    const dir = deskDir();
    const existing = await newestDesk(deps, dir);
    if (!existing && !deps.busEnabled()) {
      return c.json({ error: "the bus is off — turn it on in Console → Bus before opening the desk" }, 409);
    }
    try {
      await seedDesk(dir);
    } catch (err) {
      log.error(`could not seed ${dir}`, err);
      return c.json({ error: `could not create the desk folder: ${String(err)}` }, 500);
    }
    if (existing && (!deps.busEnabled() || !spent(existing, deps.activeRuns(existing.id)))) {
      return c.json({ id: existing.id, cwd: dir, fresh: false });
    }
    return c.json({ id: await deps.openSession(dir), cwd: dir, fresh: true }, 201);
  });
}
