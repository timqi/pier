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
import { fileMarker, lostMarker, MAX_INBOUND_BYTES, safeName } from "./inbound-file.js";

/** Where every inbound file lives; the attachment route allowlists this root. */
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

/**
 * Collect a fetch response's body, refusing past `maxBytes` mid-stream. The
 * metadata size gate in saveInboundAll is only as honest as the platform's
 * metadata — absent or wrong, `arrayBuffer()` buffers whatever arrives — so
 * the read itself is bounded too. Throws with "too large" in the message,
 * which the loop below translates into the honest lost-marker reason.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`attachment too large (>${maxBytes} bytes)`);
      parts.push(value);
    }
  } finally {
    // Also cancels the transfer on the too-large throw.
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/** One inbound attachment, as the adapter that received it describes it. */
export interface InboundAttachment {
  /** What the lost-marker calls it when there are no bytes to name. */
  label: string;
  name?: string;
  mimeType: string;
  /** Platform metadata when present; the fetch may still refuse mid-stream. */
  size?: number;
  /** Overrides win: some platforms only learn the name or type on download. */
  fetch(): Promise<{ bytes: Uint8Array; name?: string; mimeType?: string }>;
}

/**
 * Save a message's attachments; each becomes a marker line for the prompt —
 * and a failed or oversized one becomes a lost-marker line, never silence
 * (5b). Written three times, once per adapter, before landing here: the
 * size gate before the fetch (an unauthorized sender is already filtered by
 * then, but a movie must not be buffered whole either) and the never-silent
 * failure path are invariants, and invariants drift when copied.
 */
export async function saveInboundAll(
  channelId: string,
  files: InboundAttachment[],
  log: (message: string) => void,
): Promise<string[]> {
  const markers: string[] = [];
  for (const file of files) {
    if (file.size !== undefined && file.size > MAX_INBOUND_BYTES) {
      markers.push(lostMarker(file.label, "too large"));
      continue;
    }
    try {
      const got = await file.fetch();
      const path = await saveInbound(
        channelId,
        file.name ?? got.name,
        got.mimeType ?? file.mimeType,
        got.bytes,
      );
      markers.push(fileMarker(path));
    } catch (err) {
      log(`attachment download failed: ${String(err)}`);
      // A fetch that refused mid-stream names its reason; keep it honest.
      const why = String(err).includes("too large") ? "too large" : "download failed";
      markers.push(lostMarker(file.label, why));
    }
  }
  return markers;
}
