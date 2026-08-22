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

import type { AgentReply, NoteOrigin, ThinkingLevel, TurnMeta } from "./types.js";

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

- **Staying silent.** \`<silent>why</silent>\` is stripped before sending; if
  nothing else remains, no message is sent at all. In a group chat you are
  handed every message, including humans talking to each other — use this
  instead of acknowledging what was not addressed to you.

A message may start with \`[name<id> time]\`. That is the sender, added by Pier,
not part of what they typed. It appears only when the speaker or the day
changes, so the last one you saw still applies. Use that \`id\` when you need to
mention someone back; never ask a person for their own id.
`;

/**
 * Where a system input came from, in the fewest words that still say it.
 *
 * Lives here with `formatTurnMeta` for the same reason: it is *wording*, and
 * every surface must spell it the same way. It was copied verbatim into the
 * second adapter before landing here.
 */
export function originLabel(origin: NoteOrigin): string {
  if (origin.kind === "error") return "\u26a0 failed";
  if (origin.kind !== "task-message") {
    return origin.kind === "task-delegation" ? "\u25b6 delegated task" : "\u21a9 task callback";
  }
  const kinds: Record<string, string> = {
    steer: "\u270e steer",
    follow_up: "\uff0b follow-up",
    progress: "\u25c7 progress",
    decision: "\u2753 decision needed",
    reply: "\u21a9 reply",
  };
  return `from a subagent \u00b7 ${kinds[origin.messageKind] ?? origin.messageKind}`;
}

/**
 * Quote and bracket characters that may be lifted out of a `**strong**` run.
 * Moving them changes nothing a reader can see — the punctuation is simply no
 * longer bold — while taking the delimiter off a character the parser refuses
 * to close on.
 */
const LIFTABLE = /[\u201c\u201d"\u2018\u2019'()\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u3008\u3009[\]]/;

/**
 * Repair emphasis that CommonMark refuses to close.
 *
 * A closing `**` must be *right-flanking*: preceded by non-whitespace, and
 * either not preceded by punctuation or else followed by whitespace or
 * punctuation. `**\u201c\u600e\u4e48\u505a\u201d**\uff1a` fails both halves \u2014 preceded by a quote,
 * followed by a CJK colon the rule does not count \u2014 so the run never closes and
 * the reader sees literal asterisks. `**\u95f2\u804a**\uff1a` is fine, because a letter
 * precedes the delimiter. This is a known ten-year-old hole in the spec around
 * CJK, not a Slack bug, and it shows up constantly in model output.
 *
 * The repair is to move the punctuation outside the delimiters, so the `**`
 * lands against a letter: `\u201c**\u600e\u4e48\u505a**\u201d\uff1a`. Code is protected first \u2014 asterisks
 * inside a fence or a code span are content, not markup.
 */
export function cjkFriendly(markdown: string): string {
  const stash: string[] = [];
  const keep = (text: string): string => `\uE010${stash.push(text) - 1}\uE011`;
  let out = markdown
    .replace(/```[\s\S]*?```/g, (m) => keep(m))
    .replace(/`[^`\n]+`/g, (m) => keep(m));
  out = out.replace(/\*\*(\S|\S[\s\S]*?\S)\*\*/g, (whole, inner: string) => {
    let lead = "";
    let trail = "";
    let body = inner;
    while (body.length > 1 && LIFTABLE.test(body[0]!)) {
      lead += body[0];
      body = body.slice(1);
    }
    while (body.length > 1 && LIFTABLE.test(body.at(-1)!)) {
      trail = body.at(-1)! + trail;
      body = body.slice(0, -1);
    }
    // Nothing was on the edges, or the run is only punctuation: leave it be.
    return lead || trail ? `${lead}**${body}**${trail}` : whole;
  });
  return out.replace(/\uE010(\d+)\uE011/g, (_m, i: string) => stash[Number(i)] ?? "");
}

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
/**
 * A deliberate non-answer. In a group thread the agent is handed every message,
 * and most of them are two humans talking; a bot that replies to each one is
 * unusable. Stripping the block here means an adapter needs no new concept: a
 * turn whose text is empty already posts nothing and still retires its per-turn
 * UI, which is exactly "listened, said nothing".
 *
 * The reason inside stays in the Pi transcript, so the choice is auditable
 * without being broadcast to the chat.
 */
const SILENT = /<silent>([\s\S]*?)<\/silent>/gi;

/**
 * Why the agent stayed quiet. Stripped from anything sent to a chat, but the
 * workbench is the operator's own view of the run — "it said nothing and here
 * is why" is observability, and hiding it there would just make a silent turn
 * look like a broken one.
 */
export function silentReason(markdown: string): string | undefined {
  const reasons = [...markdown.matchAll(SILENT)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return reasons.length ? reasons.join(" · ") : undefined;
}

export function splitReply(rawMarkdown: string, meta?: TurnMeta): AgentReply {
  // Every surface that renders this goes through here, and every CommonMark
  // parser has some version of the CJK emphasis hole — so the repair belongs
  // once, at the seam, not per adapter.
  const markdown = cjkFriendly(rawMarkdown.replace(SILENT, "").trim());
  const silence = silentReason(rawMarkdown);
  const m = BLOCK.exec(markdown);
  if (!m?.[1]) return { text: markdown, suggestions: [], meta, silence };
  const suggestions = [...m[1].matchAll(TOKEN)]
    .map((t) => (t[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length) return { text: markdown, suggestions: [], meta, silence };
  return { text: markdown.slice(0, m.index).trimEnd(), suggestions, meta, silence };
}
