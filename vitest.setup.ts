// One scratch root per run. TMPDIR points inside it, so every mkdtemp in the
// suite — and in the processes tests spawn — lands there and this teardown
// takes the lot; without it a run leaves thousands of directories in /tmp.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const scratch = join(tmpdir(), `pier-test-${String(process.pid)}`);

export function setup() {
  mkdirSync(scratch, { recursive: true });
}

export function teardown() {
  rmSync(scratch, { recursive: true, force: true });
}
