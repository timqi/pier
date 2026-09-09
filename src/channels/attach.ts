// Outbound attachments: a `file://` link in a turn is a dead path on someone
// else's machine, so an IM adapter uploads the bytes and keeps the label. The
// upload is per-platform; the grammar, the caps and the line a failed
// attachment still owes the conversation are shared here.

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { lostMarker, replaceOutsideCode } from "../core/inbound-file.js";

/** Telegram refuses a photo past 10 MB, the smallest of the three; one cap so
 *  a turn does not land on one chat and not another. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

const MAX_ATTACHMENTS = 5;

/** svg excluded deliberately: it is markup, and renders as a file. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export interface Attachment {
  name: string;
  bytes: Uint8Array;
  image: boolean;
}

/** `[label](file:///abs/path)`; a leading `!` is the same request as an image embed. */
const LINK = /!?\[([^\]\n]*)\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)/g;

const nameOf = (path: string): string => basename(path) || "file";

/** Each link collapses to its label (or the file's name), so the sentence it
 *  sat in still reads. A link inside code is an example, left alone. */
export function splitAttachments(markdown: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const text = replaceOutsideCode(markdown, LINK, (match) => {
    const label = match[1]!;
    const raw = match[2]!;
    let path = raw;
    try {
      path = decodeURIComponent(raw);
    } catch {
      /* not percent-encoded — take the path as written */
    }
    if (!paths.includes(path)) paths.push(path);
    return label || nameOf(path);
  });
  return { text, paths };
}

/** Returns the line the conversation still owes: an attachment that never
 *  arrived must not look like one never mentioned (§5). "" when all landed. */
export async function sendAttachments(
  paths: string[],
  upload: (file: Attachment) => Promise<void>,
  log: (message: string) => void,
): Promise<string> {
  const lost: string[] = [];
  const fail = (path: string, reason: string): void => {
    log(`attachment ${path} not sent: ${reason}`);
    lost.push(lostMarker(nameOf(path), reason));
  };
  const taken = paths.slice(0, MAX_ATTACHMENTS);
  // Two phases: reads in parallel, then uploads, so the platform receives
  // files in link order and `lost` reads in link order too.
  const reasons: (string | undefined)[] = [];
  const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const files = await Promise.all(taken.map(async (path, i): Promise<Attachment | undefined> => {
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      if (info.size > MAX_ATTACH_BYTES) throw new Error(`too large (>${MAX_ATTACH_BYTES} bytes)`);
      const name = nameOf(path);
      const ext = extname(name).slice(1).toLowerCase();
      return { name, bytes: await readFile(path), image: IMAGE_EXT.has(ext) };
    } catch (err) {
      reasons[i] = reasonOf(err);
      return undefined;
    }
  }));
  await Promise.all(files.map((file, i) =>
    file ? upload(file).catch((err: unknown) => void (reasons[i] = reasonOf(err))) : undefined));
  taken.forEach((path, i) => {
    const reason = reasons[i];
    if (reason !== undefined) fail(path, reason);
  });
  for (const path of paths.slice(MAX_ATTACHMENTS)) {
    fail(path, `more than ${MAX_ATTACHMENTS} files in one turn`);
  }
  return lost.join("\n");
}
