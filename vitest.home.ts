// A PIER_HOME of its own for each test file, set before the file imports
// `paths.ts`: a db or inbox another file wrote must not change what this one sees.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "pier-home-"));
process.env.PIER_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
