// Slash commands in IM text, parsed once for every platform: Telegram appends
// `@botname` when several bots share a group, clients add whitespace, users capitalise.

export interface Command {
  /** Lowercase, without the slash and without any `@target` suffix. */
  name: string;
  /** Everything after the command word, trimmed. "" when there is none. */
  args: string;
  /** The caller decides whether the `@target` is us. */
  target?: string;
}

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Args verbatim: a path or a sentence must keep its own spacing.
  const match = /^\/(\S+)[ \t]*([\s\S]*)$/.exec(trimmed);
  const [name = "", target] = (match?.[1] ?? "").split("@");
  if (!name) return null; // a bare "/" is not a command
  return {
    name: name.toLowerCase(),
    args: match?.[2] ?? "",
    ...(target ? { target } : {}),
  };
}
