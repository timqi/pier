// A fetched page kept whole on disk, so the digest in the transcript is never
// the only copy: the model gets the distillate, the path gets the document.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../log.js";
import { pierPath } from "../../paths.js";

const log = logger("web");

const ARTIFACT_DIR = process.env.PIER_WEB_ARTIFACT_DIR?.trim() ||
  pierPath("artifacts", "web");
const RETENTION_DAYS = Number(process.env.PIER_WEB_ARTIFACT_DAYS) || 30;

/** Retention is measured in days, so sweeping more than hourly is a directory
 *  walk per fetch buying nothing. Per process; a restart sweeps again. */
const PRUNE_EVERY_MS = 3_600_000;
let prunedAt = 0;

/** Drops expired artifacts and the temp files a crashed run left behind. */
async function prune(): Promise<void> {
  prunedAt = Date.now();
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const names = await readdir(ARTIFACT_DIR);
  await Promise.all(
    names.map(async (name) => {
      const file = join(ARTIFACT_DIR, name);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs < cutoff) await rm(file, { force: true });
    }),
  );
}

function displayUrl(url: URL): string {
  const redacted = new URL(url);
  for (const key of redacted.searchParams.keys()) {
    if (/token|key|secret|signature|credential|auth/i.test(key)) {
      redacted.searchParams.set(key, "REDACTED");
    }
  }
  return redacted.toString();
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

export async function saveArtifact(
  url: URL,
  text: string,
  retrievedAt?: string,
): Promise<string> {
  await mkdir(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  const host = url.hostname.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 80) || "page";
  // The URL alone is not the file's identity: a page fetched again is a
  // different document, and keying on the URL overwrote the copy an older
  // transcript's `artifactPath` still points at — the one promise this file
  // makes. Content decides, so a refetch that changed writes a new file and one
  // that did not costs nothing.
  const path = join(ARTIFACT_DIR, `${host}-${digest(url.toString())}-${digest(text)}.md`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const header = [
    `Source: ${displayUrl(url)}`,
    `Retrieved: ${retrievedAt || new Date().toISOString()}`,
    "",
  ].join("\n");
  await writeFile(temporary, `${header}${text}`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  // Housekeeping must not fail a successful fetch, but it must not vanish either.
  if (Date.now() - prunedAt >= PRUNE_EVERY_MS) {
    await prune().catch((error: unknown) => {
      log.warn("artifact prune failed", error);
    });
  }
  return path;
}
