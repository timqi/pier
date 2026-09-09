// Inbound user files: bytes land on disk once under `$PIER_HOME/inbox/<channel>/`
// and the prompt carries only a marker line, so a file is never re-sent with
// every provider request and the agent reads it only when it chooses to.

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { pierPath } from "../paths.js";
import { fileMarker, lostMarker, MAX_INBOUND_BYTES, safeName } from "./inbound-file.js";

/** Where every inbound file lives; the attachment route allowlists this root. */
const INBOX_DIR = pierPath("inbox");

/** `wx` turns a prefix collision into an error, not an overwrite. Owner-only
 *  modes: uploads are private content on a possibly shared machine. Nothing is
 *  deleted here; pruning is the operator's call (docs/deploy.md). */
export async function saveInbound(
  channelId: string,
  name: string | undefined,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> {
  // The channel id is ours, not user input; basename() keeps a future id honest.
  const dir = join(INBOX_DIR, basename(channelId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${String(Date.now())}-${randomBytes(3).toString("hex")}-${safeName(name, mimeType)}`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}

/** The metadata size gate is only as honest as the platform's metadata, so the
 *  read itself is bounded too. Throws with "too large" in the message, which
 *  saveInboundAll translates into the lost-marker reason. */
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

/** Each attachment becomes a marker line; a failed or oversized one becomes a
 *  lost-marker line, never silence (§5). The size gate runs before the fetch. */
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
      const why = String(err).includes("too large") ? "too large" : "download failed";
      markers.push(lostMarker(file.label, why));
    }
  }
  return markers;
}
