// Assistant-reply presentation, computed once for every surface: the next-step
// block syntax, silence, the open-item markers, completion stats and the
// emphasis repair. Web chat and every IM adapter render these, so the wording
// and units live here.

import { replaceOutsideCode } from "./inbound-file.js";
import { NOT_IN_LEDGER, TASK_RUN_STATES } from "./types.js";
import type { AgentReply, LedgerRun, NoteOrigin, RunModel, TaskRunState, ThinkingLevel, TurnMeta } from "./types.js";

// The syntax is told in agent/roles.ts; this file parses it back.

/** Where a system input came from; wording every surface must spell the same. */
export function originLabel(origin: NoteOrigin): string {
  switch (origin.kind) {
    case "error": return "\u26a0 failed";
    case "task-delegation": return "\u25b6 delegated task";
    case "task-callback": return "\u21a9 task callback";
    case "session-seed": return `\u21ba new session \u00b7 ${origin.reason}`;
    case "restart": return "\u21bb restarted \u00b7 continuing";
    case "chat-command": return `/${origin.command}`;
    case "task-message":
      return `from a supervisor \u00b7 ${origin.messageKind === "steer" ? "\u270e steer" : "\uff0b follow-up"}`;
  }
}

/** The system input a turn the stop cut is resumed with (docs/design/13-stop-and-resume.md
 *  §Boot); `queued` are the texts Pi's queue held, which died with the process. */
export function restartInput(at: number, downMs: number, queued: string[] = []): string {
  const time = new Date(at).toISOString().replace("T", " ").slice(0, 19);
  return [
    `[Pier restarted at ${time} (down ${String(Math.round(downMs / 1000))}s) while this turn was running. ` +
    "Continue where you left off: the transcript above is complete up to the interruption; " +
    "a tool that was executing then was cut short — check its outcome before relying on it.]",
    ...(queued.length ? [restartQueued(queued)] : []),
  ].join("\n");
}

/** The queued half alone, for a session a user reached first: its running turn has the transcript. */
export const restartQueued = (queued: string[]): string =>
  ["Messages the user sent before the restart that you had not yet seen:", ...queued.map((text) => `> ${text}`)].join("\n");

/** A run's model as every surface names it: `tier · model id · level`, each part only when recorded. */
export const runModelLabel = ({ tier, model, thinking }: RunModel): string =>
  [tier, model?.id, thinking].filter(Boolean).join(" \u00b7 ");

/** Is a turn coming once this note is posted? On IM the note is the only
 *  message that turn has to carry its receipt; a receipt on any other would hang
 *  until the stale sweep: an error reports a turn that already ended, a chat
 *  command's answer starts none, and the message that made a seed carries its own. */
export const awaitsTurn = (origin: NoteOrigin): boolean =>
  origin.kind !== "error" && origin.kind !== "chat-command" && origin.kind !== "session-seed";

/** Is this note progress the home chat's status message already shows? A run
 *  that failed is not: its trace must not depend on the head choosing to speak. */
export const shownByStatus = (origin: NoteOrigin): boolean =>
  (origin.kind === "task-delegation" || origin.kind === "task-callback")
  && (origin.state === undefined || origin.state === "succeeded" || origin.state === "skipped");

/** Punctuation that may be lifted out of a `**strong**` run: nothing a reader
 *  can see changes, and the delimiter comes off a character the parser refuses
 *  to close on. */
const LIFTABLE = /[\u201c\u201d"\u2018\u2019'()\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u3008\u3009[\]]/;

/** CommonMark's right-flanking rule does not count CJK punctuation, so
 *  `**“怎么做”**：` never closes (a spec hole, not a platform bug, and constant
 *  in model output). Moving the punctuation outside — `“**怎么做**”：` — lands
 *  the `**` against a letter. Fences and code spans are content, never touched. */
function cjkFriendly(markdown: string): string {
  return replaceOutsideCode(markdown, /\*\*(\S|\S[\s\S]*?\S)\*\*/g, ([whole, inner = ""]) => {
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

/** `max` characters, the last one an ellipsis when something was cut. */
export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Compact age of `ts` at `now` ("now", "12m", "3h", "2d"): every surface ages things the same way. */
export function relTime(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${String(mins)}m`;
  if (mins < 1440) return `${String(Math.round(mins / 60))}h`;
  return `${String(Math.round(mins / 1440))}d`;
}

/** The age as it reads beside a wall clock, where "now" would be a fragment. */
export const agoLabel = (ts: number, now: number): string => {
  const age = relTime(ts, now);
  return age === "now" ? "just now" : `${age} ago`;
};

/** A run's state and its age: how long it has been going, or how long ago it ended. */
export const runStatus = (r: LedgerRun, now: number): string =>
  r.finishedAt === null ? `${r.state} ${relTime(r.queuedAt, now)}` : `${r.state} ${agoLabel(r.finishedAt, now)}`;

/** A lead's launches by state, in the states' own order: "2 running, 1 failed". */
export const workerCounts = (workers: Record<TaskRunState, number>): string =>
  TASK_RUN_STATES.filter((s) => workers[s] > 0).map((s) => `${String(workers[s])} ${s}`).join(", ") || "none";

/** The open items' text with each ` · run <id8>…` token dropped and its state kept, for an IM
 *  chat where the id opens nothing; anchored on the state after it, so a problem's own "run" stays. */
const OPEN_RUN_ID = new RegExp(` · run [\\w-]+(?:…? (?=(?:${TASK_RUN_STATES.join("|")}) )| — (?=${NOT_IN_LEDGER}))`, "g");
export const withoutRunIds = (text: string): string => text.replace(OPEN_RUN_ID, " · ");

/** The one open-item status (tasks/types.ts `OpenStatus`) that asks anything of the user:
 *  what `/status`, the status panel, its chip's `needs you` and the app badge group by. */
export const waitsOnYou = (status: string): boolean => status === "waiting on you";

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
// A model has been seen emitting `<s<U+200B>ilent>`: zero-width characters inside
// the tag, which would post the literal tag to a channel instead of silence.
const ZW = String.raw`[\u200B-\u200D\u2060\uFEFF]*`;
const tag = (literal: string): string => literal.split("").join(ZW);
const SILENT = new RegExp(`${tag("<silent>")}([\\s\\S]*?)${tag("</silent>")}`, "gi");
/** A tag that hides what it wraps: a streaming renderer never cuts inside one. */
const HIDDEN_TAG = new RegExp(`<(\\/?)(${["silent", "open", "done", "note", "topic"].map(tag).join("|")})${ZW}>`, "gi");
const ZW_CHARS = new RegExp(ZW.slice(0, -1), "g");

/** Main's markers (docs/design/10-continuous-session.md): stripped like
 *  `<silent>`, and read back on the head's turn end. Code is content, so a
 *  marker inside a fence or a code span is neither. Group 1 is an `<open>`
 *  body, group 2 a `<done>` body, group 3 a `<note>` body, group 4 a
 *  `<topic>` body. */
const MARKER = new RegExp(
  ["open", "done", "note", "topic"].map((t) => `${tag(`<${t}>`)}([\\s\\S]*?)${tag(`</${t}>`)}[ \\t]*\\n?`).join("|"),
  "gi",
);
const RUN_TOKEN = /\s*\(run\s+([^\s()]+)\)\s*$/i;

/** `open` adds or replaces the item keyed by `problem`; `done` removes it. */
export type OpenItemMarker =
  | { op: "open"; problem: string; stage: string; runIds: string[] }
  | { op: "done"; problem: string };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** An `<open>` line read apart: the `problem` key before the ` — stage`, the
 *  `(run <id>)` tokens off its end — a `<topic>` written the same way keys the same. */
function openLine(text: string): { problem: string; stage: string; runIds: string[] } {
  let rest = oneLine(text);
  const runIds: string[] = [];
  for (let run = RUN_TOKEN.exec(rest); run; run = RUN_TOKEN.exec(rest)) {
    runIds.unshift(run[1]!);
    rest = rest.slice(0, run.index);
  }
  const dash = rest.indexOf("\u2014");
  return { problem: (dash < 0 ? rest : rest.slice(0, dash)).trim(), stage: dash < 0 ? "" : rest.slice(dash + 1).trim(), runIds };
}

/** The markers in reply order, `notes` the daily-note lines, `topic` the
 *  `<topic>` body; `dropped` holds the ones with no text, for the caller to log. */
export function openItemMarkers(markdown: string): { markers: OpenItemMarker[]; notes: string[]; topic?: string; dropped: string[] } {
  const markers: OpenItemMarker[] = [];
  const notes: string[] = [];
  const dropped: string[] = [];
  let topic: string | undefined;
  replaceOutsideCode(markdown, MARKER, (m) => {
    if (m[1] === undefined) {
      const body = m[3] !== undefined ? oneLine(m[3]) : openLine(m[2] ?? m[4] ?? "").problem;
      if (!body) dropped.push(m[0].trim());
      else if (m[4] !== undefined) topic ??= body;
      else if (m[2] === undefined) notes.push(body);
      else markers.push({ op: "done", problem: body });
      return "";
    }
    const { problem, stage, runIds } = openLine(m[1]);
    if (problem) markers.push({ op: "open", problem, stage, runIds });
    else dropped.push(m[0].trim());
    return "";
  });
  return { markers, notes, ...(topic ? { topic } : {}), dropped };
}

/** The open item a reply is about, by its `problem` key: the `<topic>` body,
 *  else the first `<open>`/`<done>` it carries; none for a reply about nothing
 *  on the list. Every surface that tags a message by topic reads this. */
export function replyTopic(markdown: string): string | undefined {
  const { markers, topic } = openItemMarkers(markdown);
  return topic ?? markers[0]?.problem;
}

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
  const tags = { meta, silence };
  const m = BLOCK.exec(markdown);
  if (!m?.[1]) return { text: markdown, suggestions: [], ...tags };
  const suggestions = [...m[1].matchAll(TOKEN)]
    .map((t) => (t[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length) return { text: markdown, suggestions: [], ...tags };
  return { text: markdown.slice(0, m.index).trimEnd(), suggestions, ...tags };
}

/** For rendering mid-turn: everything `splitReply` repairs, minus the
 *  next-step block, which is only one at the very end of a turn. */
export const streamBody = (markdown: string): string => cjkFriendly(unmarked(markdown));

/** The streaming tail cut before a hiding tag still open: the marker's body
 *  would flash as prose until its closer arrives. Code is content here as in
 *  `openItemMarkers`; a tag in a span still growing hides for a paint and
 *  comes back with its closing backtick. */
export function streamTail(markdown: string): string {
  let openAt = -1;
  let hidden = "";
  replaceOutsideCode(markdown, HIDDEN_TAG, (t) => {
    const name = t[2]!.replace(ZW_CHARS, "").toLowerCase();
    if (!t[1] && !hidden) { hidden = name; openAt = t.index!; }
    else if (t[1] && name === hidden) hidden = "";
    return t[0];
  });
  return hidden ? markdown.slice(0, openAt) : markdown;
}

const unmarked = (markdown: string): string =>
  replaceOutsideCode(markdown.replace(SILENT, ""), MARKER, () => "").trim();

/** What a message says with Pier's markup off — `<silent>`, the open-item
 *  markers, the next-step block — and otherwise untouched: search cuts a
 *  hit's text from this. */
export function saidText(markdown: string): string {
  const body = unmarked(markdown);
  const m = BLOCK.exec(body);
  return m?.[1] ? body.slice(0, m.index).trimEnd() : body;
}

/** Lines a blank line does not necessarily separate (a loose list is still one
 *  list). Over-matching is fine: one boundary too few costs only a repaint. */
const CONTINUES = /^(?:\s|[-*+>]|\d+[.)])/;

/** Offset past the last blank line after `from` that closes a block, so a
 *  streaming renderer can parse each closed prefix once (whole-reply reparse is
 *  O(N²) over a turn). A boundary is claimed only where the two sides render the
 *  same apart as together: never inside a fence, a `<silent>`/`<open>`/`<done>` block, or a loose
 *  list/quote. A ```` fence is not closed by the ``` it quotes. */
export function stableBlockEnd(markdown: string, from = 0): number {
  // The last line is still growing, so it decides nothing.
  const end = markdown.lastIndexOf("\n") + 1;
  /** Marker run of the fence currently open; empty = closed. */
  let open = "";
  /** The hiding tag currently open; empty = none. */
  let hidden = "";
  let cut = from;
  /** Start of the block after a blank line, waiting for its first line. */
  let pending = -1;
  let prev = "";
  for (let at = from; at < end; ) {
    const nl = markdown.indexOf("\n", at);
    const line = markdown.slice(at, nl);
    at = nl + 1;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open && !hidden && !line.trim()) {
      if (pending < 0 && prev) pending = at;
      continue;
    }
    if (!open && !hidden && pending >= 0 && !(CONTINUES.test(prev) && CONTINUES.test(line))) cut = pending;
    const run = fence?.[1] ?? "";
    if (!open && run && !hidden) open = run;
    else if (open && run[0] === open[0] && run.length >= open.length && !fence?.[2]?.trim()) open = "";
    if (!open && (!run || hidden)) {
      for (const t of line.matchAll(HIDDEN_TAG)) {
        const name = t[2]!.replace(ZW_CHARS, "").toLowerCase();
        if (!t[1] && !hidden) hidden = name;
        else if (t[1] && name === hidden) hidden = "";
      }
    }
    pending = -1;
    prev = line;
  }
  return cut;
}
