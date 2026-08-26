// The inbound-file convention, browser-safe: what a user's attachment may be
// called, the marker line that tells the agent about it, the parser that
// splits it back out of a message, and the size cap both ends enforce.
// Producers are node code (channels/, web/server.ts) but the web composer
// builds markers and the web chat parses them in the browser, so the grammar
// lives in a module with no node imports that either side can load. The
// filesystem half (saving the bytes) is core/inbox.ts.

/** One cap for every inbound path: composer, upload route, Slack metadata. */
export const MAX_INBOUND_BYTES = 32 * 1024 * 1024;

/** Extension for a name-less upload (a pasted screenshot has no filename). */
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/**
 * A filename that is safe as a path segment and inside a markdown link:
 * basename only (no traversal), whitespace and link-breaking characters
 * folded to `-`, length capped.
 */
export function safeName(name: string | undefined, mimeType: string): string {
  const base = (name ?? "").split("/").pop()!.replace(/[\s\\()[\]<>%#?]/g, "-");
  if (!base || base === "." || base === "..") return `file${MIME_EXT[mimeType] ?? ""}`;
  if (base.length <= 64) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot, dot + 16) : "";
  return base.slice(0, 64 - ext.length) + ext;
}

/**
 * The prompt line for a saved file — the attachment convention, inbound. The
 * path is percent-encoded (parentheses included, which encodeURI leaves
 * alone) so the link survives markdown and the marker regex even when
 * `PIER_HOME` contains spaces or parens; splitInboundFiles decodes.
 */
export const fileMarker = (path: string): string =>
  `[${path.split("/").pop() ?? "file"}](file://${
    encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29")
  })`;

/**
 * The conversation-visible line for an attachment that never made it (5b: a
 * failed download must not look like no attachment). Plain text on purpose —
 * not a link — so every surface renders it as the words it is. Both
 * directions: an inbound file Pier could not fetch and an outbound one it
 * could not upload (channels/attach.ts) are the same fact to the reader.
 */
export const lostMarker = (name: string, reason: string): string =>
  `[attachment lost: ${name} — ${reason}]`;

// A whole line that is one `[name](file:///…)` link — what fileMarker emits.
const MARKER_RE = /^\[[^\]\n]*\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)$/;

/**
 * Split a user message into its typed text and the attached files' paths.
 * Only the contiguous *trailing* block of marker lines is an attachment —
 * that is where every producer puts them — so a `file://` link the user
 * wrote mid-message stays message text.
 */
export function splitInboundFiles(raw: string): { text: string; paths: string[] } {
  const lines = raw.split("\n");
  let start = lines.length;
  while (start > 0 && MARKER_RE.test(lines[start - 1]!.trim())) start--;
  const paths = lines.slice(start).map((line) => {
    const path = MARKER_RE.exec(line.trim())![1]!;
    try {
      return decodeURIComponent(path);
    } catch {
      return path; // not percent-encoded — take the path as written
    }
  });
  return { text: lines.slice(0, start).join("\n").trimEnd(), paths };
}
