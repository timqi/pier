// What makes a task *the* librarian: the marker name it is found again by, the
// schedule it is seeded with, and the prompt it runs. One reason to exist —
// seeding a librarian and detecting one later read the same three facts, so
// neither can drift into describing a librarian the other cannot see — and the
// seam at the bottom is that same identity enforced once, so "which directory
// already has one" has a single answer. Nothing here knows what a task is;
// main.ts turns these into an ordinary definition and supplies the store.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LibrarianSeam } from "./routes.js";
import type { BusLibrarianRow } from "./types.js";

/** The marker. A librarian is detected by this name plus the cwd in its action
 *  — never by reading its prompt, because an operator who edits the prompt in
 *  the Tasks panel still owns the same librarian. */
export const LIBRARIAN_NAME = "bus-librarian";

/** 05:00 daily, in whichever timezone the caller stores (every cron task names
 *  one). Before the working day, so a session's first read of the morning
 *  already sees the night's distillation. */
export const LIBRARIAN_CRON = "0 5 * * *";

export const LIBRARIAN_DESCRIPTION = "Daily bus maintenance: distill, archive, propose (docs/bus.md)";

let cached: string | undefined;

/**
 * The prompt, read from `librarian-prompt.md` beside this module — the one
 * canonical copy, which is why it is not inlined here. It ships the way every
 * other non-TS asset Pier serves does: copied into `dist/` by
 * `npm run build:assets` and resolved relative to this file, so a dev run
 * (`src/`) and an installed package (`dist/`) read the same bytes.
 *
 * Read on the first seed rather than at import: a file the build forgot then
 * fails the click that needed it, naming the path, instead of taking the whole
 * instance down at boot.
 */
export function librarianPrompt(): string {
  cached ??= readFileSync(fileURLToPath(new URL("librarian-prompt.md", import.meta.url)), "utf8");
  return cached;
}

/**
 * One librarian per directory, enforced where identity is decided.
 *
 * Two things made that untrue. A cwd has more than one spelling — `/home/u/x`
 * and `/essd/u/x` are one directory on this machine — and the librarian's cwd
 * *is* the project scope it maintains, so an aliased seed produced two
 * librarians archiving one project's topics against each other. And the check
 * and the create are separated by an await, so two clicks both saw "none" and
 * both created one; SQLite offers no transaction across that await, so the
 * chain below is the lock.
 *
 * `created: false` is the refusal, carrying the row that already has the
 * directory — the caller needs to know which librarian won.
 */
export function librarianSeam(deps: {
  /** Every librarian the task store holds, in the canonical spelling. */
  list: () => BusLibrarianRow[];
  /** Creates the cron task; throws the task layer's own refusal. */
  create: (cwd: string) => Promise<BusLibrarianRow>;
  /** realpath, or undefined when the path cannot be resolved at all. */
  canonical: (cwd: string) => string | undefined;
}): LibrarianSeam {
  const chain = new Map<string, Promise<unknown>>();
  const findOrCreate = async (cwd: string): Promise<{ librarian: BusLibrarianRow; created: boolean }> => {
    const existing = deps.list().find((row) => row.cwd === cwd);
    return existing
      ? { librarian: existing, created: false }
      : { librarian: await deps.create(cwd), created: true };
  };
  return {
    list: deps.list,
    seed: (raw) => {
      const cwd = deps.canonical(raw);
      // Not a directory identity we can stand behind, so nothing is created:
      // guessing here is how the alias split happened in the first place.
      if (cwd === undefined) {
        return Promise.reject(new Error(`could not resolve ${raw}: a librarian's scope is the canonical path`));
      }
      // Queued behind whatever is already seeding this cwd rather than sharing
      // its answer: the second caller must be told it created nothing.
      const run = (chain.get(cwd) ?? Promise.resolve()).then(() => findOrCreate(cwd));
      const settled = run.then(() => undefined, () => undefined);
      chain.set(cwd, settled);
      void settled.then(() => {
        if (chain.get(cwd) === settled) chain.delete(cwd);
      });
      return run;
    },
  };
}
