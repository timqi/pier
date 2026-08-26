// What makes a task *the* librarian: the marker name it is found again by, the
// schedule it is seeded with, and the prompt it runs. One reason to exist —
// seeding a librarian and detecting one later read the same three facts, so
// neither can drift into describing a librarian the other cannot see. Nothing
// here knows what a task is; main.ts turns these into an ordinary definition.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
