// The inbound file-link grammar. No node imports: the browser composer builds
// markers and the web chat parses them. Saving the bytes is core/inbox.ts.

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

/** Safe as a path segment (no traversal) and inside a markdown link. */
export function safeName(name: string | undefined, mimeType: string): string {
  const base = (name ?? "").split("/").pop()!.replace(/[\s\\()[\]<>%#?]/g, "-");
  if (!base || base === "." || base === "..") return `file${MIME_EXT[mimeType] ?? ""}`;
  if (base.length <= 64) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot, dot + 16) : "";
  return base.slice(0, 64 - ext.length) + ext;
}

/** Percent-encoded, parentheses included (encodeURI leaves them), so the link
 *  survives markdown when `PIER_HOME` contains spaces or parens. */
export const fileMarker = (path: string): string =>
  `[${path.split("/").pop() ?? "file"}](file://${
    encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29")
  })`;

/** A failed download must not look like no attachment (§5). Plain text, not a
 *  link, so every surface renders the words; used in both directions. */
export const lostMarker = (name: string, reason: string): string =>
  `[attachment lost: ${name} — ${reason}]`;

/** A fenced block's opening or closing line. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Code ranges: fenced blocks and inline spans. Spans are paired within a line,
 *  which keeps this a scan instead of a parser. */
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
      // A span closes on the next run of the same length; an unpaired opener
      // leaves the rest as prose.
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

/** `text.replace(pattern, …)` outside code only: an example link in backticks
 *  is not an attachment, and the reader asked to see it byte-identical. */
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

/** Only the contiguous trailing block of marker lines is an attachment, so a
 *  `file://` link mid-message stays text and a fenced example is never reached. */
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
