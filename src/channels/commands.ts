// Slash commands in IM text, parsed once for every platform: clients add
// whitespace and capitalise.

export interface Command {
  /** Lowercase, without the slash. */
  name: string;
  /** Everything after the command word, trimmed. "" when there is none. */
  args: string;
}

/** The configure-first trigger, one spelling on both platforms: `s <text>`
 *  (Lark also `/s <text>`), the text being the panel's pending question. A bare
 *  `s` carries no question and is prose. */
export function settingsDraft(text: string): string | undefined {
  return /^\/?s[ \t]+(\S[\s\S]*)$/i.exec(text.trim())?.[1];
}

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Args verbatim: a path or a sentence must keep its own spacing.
  const match = /^\/(\S+)[ \t]*([\s\S]*)$/.exec(trimmed);
  const name = match?.[1] ?? "";
  if (!name) return null; // a bare "/" is not a command
  return { name: name.toLowerCase(), args: match?.[2] ?? "" };
}
