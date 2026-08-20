// Assistant-reply presentation, parsed once for every surface. An agent may
// end a turn with a "next step" block — a `---` rule followed by a row of
// `[label]` tokens — and each surface renders those labels as buttons whose
// click sends the label back as an ordinary user message. The syntax lives
// here so web, IM adapters and Show pages never re-implement it.

import type { AgentReply } from "./types.js";

/**
 * The surface contract handed to every agent Pier launches (main.ts wires it
 * into the factory). Both halves of the feature live in this file: the syntax
 * the agent is told to emit, and the parser that reads it back.
 */
export const REPLY_SURFACE_PROMPT = `## Pier chat surface

Your replies are rendered in a chat UI (web now, IM later). Two optional
markdown conventions are recognized:

- **Next-step buttons.** A last line of \`---\` then up to 5 \`[label]\` tokens
  separated by \`|\` renders as buttons; a click sends that label as the user's
  next message. Example last two lines: \`---\` / \`[Run it] | [Show the diff]\`.
  Offer them only when the likely next moves are short and obvious, and never
  for anything destructive.

- **Attachments.** Link a file you produced by absolute \`file://\` URL —
  \`[report.md](file:///abs/path/report.md)\` — images render as thumbnails,
  other files as a download card. Only files inside the session's working
  directory are readable by the client.
`;

/**
 * Trailing `---` line + a row of bracket tokens, optionally `|`-separated.
 * A markdown link (`[label](url)`) leaves `(url)` unmatched, so reference-link
 * blocks stay message content instead of turning into buttons.
 */
const BLOCK = /\n[ \t]*-{3,}[ \t]*\r?\n((?:[ \t]*\[[^\]\r\n]+\][ \t]*(?:[|｜][ \t]*)?)+)\s*$/;
const TOKEN = /\[([^\]\r\n]+)\]/g;
const MAX_SUGGESTIONS = 5;

/** Split an assistant turn's markdown into renderable text + next-step labels. */
export function splitReply(markdown: string): AgentReply {
  const m = BLOCK.exec(markdown);
  if (!m?.[1]) return { text: markdown, suggestions: [] };
  const suggestions = [...m[1].matchAll(TOKEN)]
    .map((t) => (t[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length) return { text: markdown, suggestions: [] };
  return { text: markdown.slice(0, m.index).trimEnd(), suggestions };
}
