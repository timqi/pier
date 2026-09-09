// Assistant-reply presentation, computed once for every surface: the next-step
// block syntax, silence, completion stats and the emphasis repair. Web chat and
// every IM adapter render these, so the wording and units live here.

import type { AgentReply, NoteOrigin, ThinkingLevel, TurnMeta } from "./types.js";

/** The surface contract handed to every agent Pier launches (main.ts); the
 *  syntax the agent is told to emit sits beside the parser that reads it back. */
const REPLY_SURFACE_PROMPT = `## Pier chat surface

Your replies render in a chat UI (web and IM). Three optional markdown
conventions:

- **Next-step buttons** — a last line of \`---\`, then up to 5 \`[label]\` tokens
  separated by \`|\`: \`---\` / \`[Run it] | [Show the diff]\`. A click sends that
  label as the user's next message. Only for short, obvious next moves, never
  for anything destructive.
- **Attachments** — link a file you produced by absolute \`file://\` URL:
  \`[report.md](file:///abs/path/report.md)\`. Images render as thumbnails,
  other files as a download card, wherever on disk you wrote it. The same
  convention runs inbound: a user message ending in \`[name](file:///…)\`
  lines is carrying files the sender attached, already saved to disk — read
  one only when it matters to the task; every read puts its content in your
  context for good.
- **Staying silent** — \`<silent>why</silent>\` is stripped, and if nothing else
  remains no message is sent. In a group chat you are handed every message,
  including humans talking to each other: stay silent rather than acknowledge
  what was not addressed to you.

A message may start with \`[name<id> time]\` — the sender, added by Pier, not
typed by them. It appears only on a change — new speaker, a ~10-minute gap, a
new day — so the last one still applies; a gap alone shows as time only, like
\`[14:23]\`. Use that \`id\` to mention someone; never ask for their own.
`;

/** Deployment facts an agent cannot discover: a guessed path is wrong wherever
 *  `PIER_HOME` moved and fails as "nothing is configured"; GPT models carry
 *  `apply_patch` from post-training and go hunting for it in the shell. */
export function surfacePrompt(instance: { boardsDir: string; publicUrl: string }): string {
  const reach = instance.publicUrl
    ? `Address: ${instance.publicUrl} — a board's link is that plus ` +
      "`/boards/<slug>/`, or `/p/<slug>-<token>/` once published, where `token` " +
      "is the random field the manifest carries beside `public`."
    : "No public address is configured (the user sets one in Console → Settings), " +
      "so give paths and never guess a host.";
  return `${REPLY_SURFACE_PROMPT}
## This Pier instance

Boards: \`${instance.boardsDir}/<slug>/\` — this path, not \`~/.pier\`. ${reach}

Editing: files change through the \`edit\` tool (exact text replacement) or
\`write\`. There is no \`apply_patch\` here — not as a tool, not as a command —
so do not call one or go looking for one in the shell.
`;
}

/** Where a system input came from; wording every surface must spell the same. */
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

/** Is a turn coming once this note is posted? On IM the note is the only
 *  message that turn has to wear the 👀; an error note reports a turn that
 *  already ended, and a receipt on it would hang until the stale sweep. */
export const awaitsTurn = (origin: NoteOrigin): boolean => origin.kind !== "error";

/** Punctuation that may be lifted out of a `**strong**` run: nothing a reader
 *  can see changes, and the delimiter comes off a character the parser refuses
 *  to close on. */
const LIFTABLE = /[\u201c\u201d"\u2018\u2019'()\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u3008\u3009[\]]/;

/** CommonMark's right-flanking rule does not count CJK punctuation, so
 *  `**“怎么做”**：` never closes (a spec hole, not a platform bug, and constant
 *  in model output). Moving the punctuation outside — `“**怎么做**”：` — lands
 *  the `**` against a letter. Fences and code spans are content, protected first. */
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
    return lead || trail ? `${lead}**${body}**${trail}` : whole;
  });
  return out.replace(/\uE010(\d+)\uE011/g, (_m, i: string) => stash[Number(i)] ?? "");
}

/** The reason arrives pre-escaped: each surface escapes for its own markup,
 *  and the label itself contains nothing any of them escape. */
export const quietLabel = (silence?: string): string =>
  silence ? `stayed silent — ${silence}` : "no reply";

/** Options count as a reply: a turn that is only its buttons is not "nothing". */
export const isSilentReply = (reply: { text: string; suggestions: string[] }): boolean =>
  !reply.text.trim() && reply.suggestions.length === 0;

/** How a reasoning level is spelled wherever a human reads it. */
export const thinkingLabel = (level: ThinkingLevel): string =>
  level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1);

/** 1200 → "1.2K", 12_000 → "12K" — absolute token counts read badly inline. */
export const compact = (n: number): string => {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // Precision from the rounded value: 9_990 reads "10K", not "10.0K".
  return k >= 9.95 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
};

/** "45s" / "1m14s". Floored at one second: sub-second precision is noise. */
function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
}

/** `tokens` is the context size at completion, not a per-turn sum (TurnMeta). */
export const formatTurnMeta = (meta: TurnMeta): string =>
  `${formatDuration(meta.durationMs)} · ${compact(meta.tokens)} tok`;

/** Trailing `---` line + a row of bracket tokens, optionally `|`-separated. A
 *  markdown link leaves `(url)` unmatched, so reference-link blocks stay
 *  content. `(?:^|\n)`: a turn may be nothing but its options. */
const BLOCK = /(?:^|\n)[ \t]*-{3,}[ \t]*\r?\n((?:[ \t]*\[[^\]\r\n]+\][ \t]*(?:[|｜][ \t]*)?)+)\s*$/;
const TOKEN = /\[([^\]\r\n]+)\]/g;
const MAX_SUGGESTIONS = 5;

/** A deliberate non-answer. Stripped here so an adapter needs no new concept:
 *  an empty turn already posts nothing and retires its per-turn UI. The reason
 *  stays in the transcript, auditable without being broadcast. */
const SILENT = /<silent>([\s\S]*?)<\/silent>/gi;

/** Why the agent stayed quiet; hidden from the chat, shown on the workbench,
 *  where a silent turn must not look like a broken one. */
export function silentReason(markdown: string): string | undefined {
  const reasons = [...markdown.matchAll(SILENT)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return reasons.length ? reasons.join(" · ") : undefined;
}

/** Split an assistant turn's markdown into renderable text + next-step labels. */
export function splitReply(rawMarkdown: string, meta?: TurnMeta): AgentReply {
  const markdown = streamBody(rawMarkdown);
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

/** For rendering mid-turn: everything `splitReply` repairs, minus the
 *  next-step block, which is only one at the very end of a turn. */
export const streamBody = (markdown: string): string => cjkFriendly(markdown.replace(SILENT, "").trim());

/** Lines a blank line does not necessarily separate (a loose list is still one
 *  list). Over-matching is fine: one boundary too few costs only a repaint. */
const CONTINUES = /^(?:\s|[-*+>]|\d+[.)])/;

/** Offset past the last blank line after `from` that closes a block, so a
 *  streaming renderer can parse each closed prefix once (whole-reply reparse is
 *  O(N²) over a turn). A boundary is claimed only where the two sides render the
 *  same apart as together: never inside a fence, a `<silent>` block, or a loose
 *  list/quote. A ```` fence is not closed by the ``` it quotes. */
export function stableBlockEnd(markdown: string, from = 0): number {
  // The last line is still growing, so it decides nothing.
  const end = markdown.lastIndexOf("\n") + 1;
  /** Marker run of the fence currently open; empty = closed. */
  let open = "";
  let silent = false;
  let cut = from;
  /** Start of the block after a blank line, waiting for its first line. */
  let pending = -1;
  let prev = "";
  for (let at = from; at < end; ) {
    const nl = markdown.indexOf("\n", at);
    const line = markdown.slice(at, nl);
    at = nl + 1;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open && !silent && !line.trim()) {
      if (pending < 0 && prev) pending = at;
      continue;
    }
    if (!open && !silent && pending >= 0 && !(CONTINUES.test(prev) && CONTINUES.test(line))) cut = pending;
    const run = fence?.[1] ?? "";
    if (!open && run && !silent) open = run;
    else if (open && run[0] === open[0] && run.length >= open.length && !fence?.[2]?.trim()) open = "";
    if (!open && (!run || silent)) {
      for (const tag of line.matchAll(/<(\/?)silent>/gi)) silent = !tag[1];
    }
    pending = -1;
    prev = line;
  }
  return cut;
}
