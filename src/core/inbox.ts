// Inbound user files: bytes land on disk exactly once.
//
// A photo pasted on the web, dropped in Telegram or uploaded to Slack used to
// travel as base64 through the seam into the transcript, where it was re-sent
// with every provider request until compaction. Now the adapter (or the web
// upload route) saves the bytes under `$PIER_HOME/inbox/<channel>/` and the
// prompt carries only a marker line (core/inbound-file.ts owns that grammar),
// so the agent reads a file only when it decides the file is worth looking at.

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { pierPath } from "../paths.js";
import { safeName } from "./inbound-file.js";

/** Where every inbound file lives; web/files.ts allowlists this root. */
export const INBOX_DIR = pierPath("inbox");

/**
 * Write one inbound file and return its absolute path. The timestamp-random
 * prefix keeps concurrent saves collision-free (`wx` turns the impossible
 * collision into an error instead of an overwrite) and makes `ls` read as a
 * timeline. Owner-only modes: uploads are private conversation content on a
 * possibly shared machine. Nothing is ever deleted here — pruning the inbox
 * is the operator's call (docs/deploy.md).
 */
export async function saveInbound(
  channelId: string,
  name: string | undefined,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> {
  // The channel id is ours ("web" | "telegram" | "slack"), not user input,
  // but basename() keeps a future id honest.
  const dir = join(INBOX_DIR, basename(channelId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${String(Date.now())}-${randomBytes(3).toString("hex")}-${safeName(name, mimeType)}`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}
