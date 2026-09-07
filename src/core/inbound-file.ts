// The file-link convention, browser-safe: what a user's attachment may be
// called, the marker line that tells the agent about it, the parser that
// splits it back out of a message, the size cap both ends enforce, and where a
// `file://` link does not count as one at all (inside code).
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

/** A fenced block's opening or closing line. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The character ranges of `text` that are code: fenced blocks (fence lines
 * included) and inline spans. Inline spans are paired within a line — one that
 * wraps across a newline is legal markdown and not how anyone writes an
 * example link, and per-line pairing keeps this a scan instead of a parser.
 */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: string | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    const run = FENCE_RE.exec(line)?.[1];
    if (fence !== undefined) {
      ranges.push([at, at + line.length]);
      if (run && run[0] === fence[0] && run.length >= fence.length) fence = undefined;
    } else if (run) {
      fence = run;
      ranges.push([at, at + line.length]);
    } else {
      // A span closes on the next backtick run of the same length; runs in
      // between are content, so an unpaired opener leaves the rest as prose.
      const runs = [...line.matchAll(/`+/g)];
      for (let i = 0; i < runs.length; i++) {
        const open = runs[i]!;
        let close = i + 1;
        while (close < runs.length && runs[close]![0].length !== open[0].length) close++;
        if (close === runs.length) break;
        ranges.push([at + open.index, at + runs[close]!.index + runs[close]![0].length]);
        i = close;
      }
    }
    at += line.length + 1; // the newline split() removed
  }
  return ranges;
}

/**
 * `text.replace(pattern, …)` for every match that is not inside code. An agent
 * that documents this convention writes an example link in backticks, and a
 * scanner that cannot tell an example from a link turned that example into a
 * real attachment — a dead card in the chat, a lost-attachment line in Slack.
 * Matches inside code are left byte-identical: the reader asked to see them.
 */
export function replaceOutsideCode(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => string,
): string {
  const skip = codeRanges(text);
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (skip.some(([from, to]) => start < to && end > from)) continue;
    out += text.slice(last, start) + replace(match);
    last = end;
  }
  return out + text.slice(last);
}

// A whole line that is one `[name](file:///…)` link — what fileMarker emits.
const MARKER_RE = /^\[[^\]\n]*\]\(\s*<?file:\/\/(\/[^)>\s]*)>?\s*\)$/;

/**
 * Split a user message into its typed text and the attached files' paths.
 * Only the contiguous *trailing* block of marker lines is an attachment —
 * that is where every producer puts them — so a `file://` link the user
 * wrote mid-message stays message text. No code scan needed for the same
 * reason: an example in a fence sits under its closing line, which is not a
 * marker line, so the walk stops there before ever reaching it.
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
