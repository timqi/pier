// Outbound attachments: which links in a turn are files the platform has to
// carry, and the bytes behind them.
//
// The agent links a file it produced by absolute `file://` URL — the
// convention core/reply.ts hands it, spelled the same way inbound
// (core/inbound-file.ts). The web chat renders that link as a card because the
// browser can fetch the bytes back over an authenticated route; an IM client
// cannot, and a `file:///…` link in Slack is a dead path on someone else's
// machine. So an adapter uploads the file to the platform instead, and the
// link's label stays behind as the words around it.
//
// The upload itself is per-platform and stays in each `*-api.ts`; what is
// shared — the grammar, the caps, and the line a failed attachment still owes
// the conversation — lives here so three adapters do not each have a copy.

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { lostMarker } from "../core/inbound-file.js";

/**
 * One cap for every platform: Telegram refuses a photo past 10 MB, which is
 * the smallest of the three, and a turn that lands on one chat and not on
 * another is worse than a turn that is honest everywhere.
 */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

/** Per turn. Linking a directory's worth of files is a mistake, not a plan. */
const MAX_ATTACHMENTS = 5;

/** Extensions the platforms show inline. Everything else goes as a document —
 *  svg included, deliberately: it is markup, and it renders as a file. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** One file, read and ready to hand to a platform's upload call. */
export interface Attachment {
  name: string;
  bytes: Uint8Array;
  /** Platforms have a nicer path for images (inline, not a download card). */
  image: boolean;
}

/** `[label](file:///abs/path)`, inline or on a line of its own. The optional
 *  `!` is an image embed, which is the same request with a different sigil. */
const LINK = /!?\[([^\]\n]*)\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)/g;

/** A trailing slash or a bare root would otherwise leave an unnamed file. */
const nameOf = (path: string): string => basename(path) || "file";

/**
 * Split a turn's markdown into the text an IM chat should show and the files
 * it linked. Each link collapses to its label — or to the file's name when the
 * agent wrote none — so the sentence it sat in still reads, and the turn never
 * becomes empty just because its only content was an attachment.
 */
export function splitAttachments(markdown: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const text = markdown.replace(LINK, (_m, label: string, raw: string) => {
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

/**
 * Upload every file a turn linked, and return the line the conversation still
 * owes: an attachment that never arrived must not look like an attachment that
 * was never mentioned (AGENTS.md 5b), so each failure is named in the chat as
 * well as in the log. Empty string when everything landed.
 */
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
  // Five files that know nothing about each other cost one round trip, not
  // five. Two phases so the platform still receives them in the order the
  // turn linked them, and each failure is kept in its own slot — `lost` reads
  // in link order whichever upload finished first.
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
