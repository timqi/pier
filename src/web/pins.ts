// Workbench organization state: which sessions show up under Projects.
// Sessions created in Pier are pinned on creation; everything Pi knows about
// stays in the All-sessions list until the user pins it. Plain JSON file —
// this is UI bookkeeping, not part of any seam.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultPinFile = (): string =>
  join(process.env.PIER_HOME ?? join(homedir(), ".pier"), "pins.json");

export class PinStore {
  readonly #file: string;
  readonly #ids: Set<string>;

  constructor(file: string = defaultPinFile()) {
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
