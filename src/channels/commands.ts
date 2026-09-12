// Slash commands in IM text, parsed once for every platform: clients add
// whitespace and capitalise.

export interface Command {
  /** Lowercase, without the slash. */
  name: string;
  /** Everything after the command word, trimmed. "" when there is none. */
  args: string;
}

/** One request, four spellings; the text after it is the panel's pending question. */
export const SETTINGS_WORDS = new Set(["s", "set", "setting", "settings"]);

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Args verbatim: a path or a sentence must keep its own spacing.
  const match = /^\/(\S+)[ \t]*([\s\S]*)$/.exec(trimmed);
  const name = match?.[1] ?? "";
  if (!name) return null; // a bare "/" is not a command
  return { name: name.toLowerCase(), args: match?.[2] ?? "" };
}
