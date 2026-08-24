// Splitting a long turn into sendable messages.
//
// Every platform caps a message, and the index arithmetic for "cut at the last
// blank line that fits, else the last newline, else mid-text" is fiddly enough
// that having it twice is having it wrong once. The cap and any per-platform
// repair (Slack re-balances code fences across the cut) stay with the renderer.

/**
 * Cut `text` into pieces of at most `max` characters, preferring a blank line,
 * then a newline, then the hard limit. A cut lands mid-text only when there is
 * no break in the second half of the window — better a blunt split than a
 * dropped turn.
 */
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

/**
 * Close a fence a chunk left open, and reopen it on the next one. Telegram can
 * be cut mid-`<pre>` and shrug — its parser closes the tag itself — but Slack
 * and Lark both swallow the rest of a message after an unterminated ```, and
 * the next chunk starts *outside* a fence, so the tail of a long code block
 * renders as prose.
 *
 * Fences are tracked by line-leading runs with their *length*, per CommonMark:
 * a ```` fence (used to quote a ``` block) only closes on a run at least as
 * long, so counting bare ``` occurrences would see the inner block close the
 * outer one and mangle both halves of the cut.
 */
export function balanceFences(parts: string[]): string[] {
  /** Backticks of the fence currently open across the boundary; 0 = closed. */
  let open = 0;
  const fence = (n: number): string => "`".repeat(n);
  return parts.map((part) => {
    const reopened = open ? `${fence(open)}\n${part}` : part;
    // The prepended fence counts too — the scan restarts from "closed" and
    // reads it as the opener, so a chunk that closes the block it inherited
    // comes out even.
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
