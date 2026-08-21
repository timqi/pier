// Assistant-reply presentation, computed once for every surface: the next-step
// block below, and a turn's completion stats. Both are rendered by the web
// chat and by every IM adapter, so the wording and the units live here rather
// than being re-derived per surface (they drifted once already).
//
// An agent may
// end a turn with a "next step" block — a `---` rule followed by a row of
// `[label]` tokens — and each surface renders those labels as buttons whose
// click sends the label back as an ordinary user message. The syntax lives
// here so web, IM adapters and Show pages never re-implement it.

import type { AgentReply, ThinkingLevel, TurnMeta } from "./types.js";

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

/** How a reasoning level is spelled wherever a human reads it. */
export const thinkingLabel = (level: ThinkingLevel): string =>
  level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1);

/** 1200 → "1.2K", 12_000 → "12K" — absolute token counts read badly inline. */
export const compact = (n: number): string => {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // Precision comes from the *rounded* value, so 9_990 reads "10K" instead of
  // a "10.0K" that claims a decimal it does not have.
  return k >= 9.95 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
};

/** "45s" / "1m14s". Floored at one second: sub-second precision is noise. */
function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
}

/**
 * A turn's cost, in the one wording every surface uses: how long it took and
 * how big the context is now. `tokens` is the context size at completion, not
 * a per-turn sum (see TurnMeta) — the label stays "tok" because that is what
 * the number is counted in.
 */
export const formatTurnMeta = (meta: TurnMeta): string =>
  `${formatDuration(meta.durationMs)} · ${compact(meta.tokens)} tok`;

/**
 * Trailing `---` line + a row of bracket tokens, optionally `|`-separated.
 * A markdown link (`[label](url)`) leaves `(url)` unmatched, so reference-link
 * blocks stay message content instead of turning into buttons.
 *
 * `(?:^|\n)` because a turn is allowed to be nothing but its options: anchoring
 * on a preceding newline left that whole block sitting in the message as raw
 * text, with no buttons anywhere.
 */
const BLOCK = /(?:^|\n)[ \t]*-{3,}[ \t]*\r?\n((?:[ \t]*\[[^\]\r\n]+\][ \t]*(?:[|｜][ \t]*)?)+)\s*$/;
const TOKEN = /\[([^\]\r\n]+)\]/g;
const MAX_SUGGESTIONS = 5;

/** Split an assistant turn's markdown into renderable text + next-step labels. */
export function splitReply(markdown: string, meta?: TurnMeta): AgentReply {
  const m = BLOCK.exec(markdown);
  if (!m?.[1]) return { text: markdown, suggestions: [], meta };
  const suggestions = [...m[1].matchAll(TOKEN)]
    .map((t) => (t[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length) return { text: markdown, suggestions: [], meta };
  return { text: markdown.slice(0, m.index).trimEnd(), suggestions, meta };
}
