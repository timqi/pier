// Workbench organization state, one persisted session-id set per concern:
// pins (which sessions show up under Projects — created in Pier means pinned,
// everything else waits in All sessions) and unread (turn finished, no client
// has viewed it yet). Plain JSON files — this is UI bookkeeping, not part of
// any seam.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class IdSetStore {
  readonly #file: string;
  readonly #ids: Set<string>;

  constructor(file: string) {
    this.#file = file;
    this.#ids = new Set(load(file));
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  set(id: string, pinned: boolean): void {
    if (this.#ids.has(id) === pinned) return;
    if (pinned) this.#ids.add(id);
    else this.#ids.delete(id);
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify([...this.#ids]));
  }
}

/** Missing file = no pins yet; malformed file is reported and treated as empty. */
function load(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected an array of session ids");
    return parsed.filter((id): id is string => typeof id === "string");
  } catch (err) {
    console.warn(`pier: ignoring unreadable pin file ${file}: ${String(err)}`);
    return [];
  }
}
