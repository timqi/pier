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
