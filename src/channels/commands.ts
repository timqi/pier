// Slash commands in IM text, parsed once for every platform.
//
// Every chat platform types commands the same way and mangles them slightly
// differently: Telegram appends `@botname` when several bots share a group,
// clients add stray whitespace, and users capitalise. One parser so an adapter
// never re-derives "is this a command" and the answer never drifts between
// platforms.

export interface Command {
  /** Lowercase, without the slash and without any `@target` suffix. */
  name: string;
  /** Everything after the command word, trimmed. "" when there is none. */
  args: string;
  /** The `@target` the user aimed at, if any — the caller decides if it is us. */
  target?: string;
}

/**
 * Parse a command out of one inbound message. Whitespace on both ends is
 * dropped first, then a leading `/` is required: anything else is ordinary
 * text and must reach the agent untouched.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Args are taken verbatim, not re-joined from split words: a path or a
  // sentence must survive with its own spacing intact.
  const match = /^\/(\S+)[ \t]*([\s\S]*)$/.exec(trimmed);
  const [name = "", target] = (match?.[1] ?? "").split("@");
  if (!name) return null; // a bare "/" is not a command
  return {
    name: name.toLowerCase(),
    args: match?.[2] ?? "",
    ...(target ? { target } : {}),
  };
}
