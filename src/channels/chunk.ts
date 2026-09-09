// Splitting a long turn into sendable messages; the cap and any per-platform
// repair stay with the renderer.

/** Prefers a blank line, then a newline, then the hard limit; a cut lands
 *  mid-text only when there is no break in the second half of the window. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Slack and Lark swallow the rest of a message after an unterminated ```, so a
 *  fence left open is closed and reopened on the next chunk. Runs are tracked
 *  by length, per CommonMark: a ```` fence only closes on a run at least as long. */
export function balanceFences(parts: string[]): string[] {
  let open = 0;
  const fence = (n: number): string => "`".repeat(n);
  return parts.map((part) => {
    const reopened = open ? `${fence(open)}\n${part}` : part;
    // The scan restarts from "closed" and reads the prepended fence as the opener.
    open = 0;
    for (const line of reopened.split("\n")) {
      const run = /^\s*(`{3,})/.exec(line)?.[1]?.length ?? 0;
      if (!run) continue;
      if (!open) open = run;
      else if (run >= open) open = 0; // a closing run must match the opener
    }
    return open ? `${reopened}\n${fence(open)}` : reopened;
  });
}
