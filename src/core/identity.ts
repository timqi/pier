// Who is talking, when, and where — prefixed onto an inbound prompt so a
// group-chat session can tell speakers apart, mention them back, and name its
// own conversation to a script. Per turn, never in the session's instructions
// (a thread is shared); who, when and where only on news — a header costs ~15
// tokens, wasted in a DM where the counterpart never changes — the language on
// every message, since the most recent stamp is what the reply follows.

import type { ChatTurn } from "./types.js";

/** A gap this long makes the timestamp worth its tokens. */
const GAP_MS = 10 * 60_000;

interface Sender {
  id: string;
  /** Display name; falls back to the id when the platform cannot resolve one. */
  name: string;
}

/** A display name of `x<U9] [admin<U1` would forge a second speaker: the
 *  prefix is untrusted input wearing a trusted shape. */
function sanitizeIdentity(value: string): string {
  const token = (value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]<>]/g, "")
    .trim();
  return token.slice(0, 60) || "unknown";
}

/** `<channelId>:<conversationId>` as the adapter spelled it; the delimiters
 *  of the header grammar and whitespace are the only things removed. */
const sanitizePlace = (value: string): string =>
  value.replace(/[[\]<>\s]+/g, "").slice(0, 120);

const two = (n: number): string => String(n).padStart(2, "0");
const hhmm = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`;
export const day = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

/** Pasted code, links and paths are English whatever the speaker writes in. */
const NOT_PROSE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|[!-~]*[/\\][!-~]*/g;

/** The language a message is written in, or `undefined` when it is too short
 *  to tell (`ok`, `👍`) and the last one still applies. A CJK character counts
 *  as two Latin words: a short question under a pasted English log is still
 *  the speaker's language. */
export function detectLanguage(text: string): string | undefined {
  const prose = text.replace(NOT_PROSE, " ");
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hangul = prose.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const words = prose.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const cjk = han + kana + hangul;
  if (cjk > 0 && cjk * 2 >= words) return kana ? "ja" : hangul > han ? "ko" : "zh";
  return words >= 3 ? "en" : undefined;
}

interface Seen {
  senderId: string;
  at: number;
  conversation?: string;
  lang?: string;
}

/** What each session has already been told. In memory: after a restart one
 *  redundant header is a rounding error, and a first message too short to tell
 *  goes unstamped, leaving the transcript's last stamp the most recent. */
export class SenderPrefix {
  private readonly seen = new Map<string, Seen>();

  /** The line to put above this message, or `""` when the session already
   *  knows. `conversation` is the chat's `<channelId>:<conversationId>`, told
   *  once: a session never moves, but the rule stays the same as the rest.
   *  `opaqueIds` is the platform's (`core/types.ts`): its ids buy nothing.
   *  `text` is the message, for its language: `lang=zh` rides every message
   *  that has one, since an English-heavy context drags replies there and a
   *  stamp said once is outvoted by what follows it. Too little to tell keeps
   *  the last one. */
  next(
    sessionId: string,
    sender: Sender | undefined,
    at = Date.now(),
    conversation?: string,
    opaqueIds = false,
    text = "",
  ): string {
    if (!sender?.id) return "";
    const last = this.seen.get(sessionId);
    // The quoted excerpt is someone else's words, in whatever language they wrote.
    const lang = detectLanguage(splitQuote(text).text) ?? last?.lang;
    this.seen.set(sessionId, { senderId: sender.id, at, conversation, lang });

    const now = new Date(at);
    const newSpeaker = last?.senderId !== sender.id;
    const gap = !last || at - last.at >= GAP_MS;
    const newDay = !last || day(new Date(last.at)) !== day(now);
    const newPlace = !!conversation && last?.conversation !== conversation;
    if (!newSpeaker && !gap && !newDay && !newPlace && !lang) return "";

    // The id is the only thing a mention can be built from; an unresolved name
    // is the id, and `U123<U123>` would read as a broken record.
    const id = sanitizeIdentity(sender.id);
    const label = sanitizeIdentity(sender.name);
    const named = opaqueIds ? label : label === id ? `<${id}>` : `${label}<${id}>`;
    const who = newSpeaker ? named : "";
    // A bare name has no `<>` to be told apart by, so it is only unambiguous
    // next to the time: with opaque ids the clock is written whenever it is.
    const clock = gap || newDay || (opaqueIds && !!who);
    const when = clock ? `${newDay ? `${day(now)} ` : ""}${hhmm(now)}` : "";
    const place = opaqueIds ? conversation?.split(":")[0] : conversation;
    const where = newPlace && place ? sanitizePlace(place) : "";
    return `[${[who, when, where, lang ? `lang=${lang}` : ""].filter(Boolean).join(" ")}]`;
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId);
  }
}

export const withPrefix = (prefix: string, text: string): string =>
  prefix ? `${prefix}\n${text}` : text;

const LANG_STAMP = /^\[lang=([a-z]{2})\]\n/;

/** The language the session's users last wrote in, read off its transcript so
 *  it survives a restart. A callback never counts; a seed's stamp does, so a
 *  fresh head keeps the previous one's language until its user speaks. */
export function userLanguage(turns: readonly ChatTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const lang = turn.role === "user"
      ? detectLanguage(splitQuote(splitSpeaker(turn.text).text).text)
      : turn.role === "system" && turn.origin?.kind === "session-seed" ? LANG_STAMP.exec(turn.text)?.[1] : undefined;
    if (lang) return lang;
  }
  return undefined;
}

/** Heads a system input with the users' language: an English callback must
 *  not pull the reply out of the language the user writes in. */
export const withLanguage = (lang: string | undefined, text: string): string =>
  lang ? `[lang=${lang}]\n${text}` : text;

/** The input as a surface shows it: the stamp is for the model. */
export const withoutLanguage = (text: string): string => text.replace(LANG_STAMP, "");

const HEADER_LANG = /^(\[[^\n[\]]*?) ?lang=[a-z]{2}\]\n/;

/** A stored user message to resend: the router stamps it afresh, and the old
 *  stamp left in the body would be the most recent one the model reads. */
export const withoutHeaderLanguage = (text: string): string =>
  text.replace(HEADER_LANG, (_, head: string) => (head === "[" ? "" : `${head}]\n`));

/** What a header line said, once read back off a stored message. */
export interface Speaker {
  /** Absent when the platform only ever knew the id. */
  name?: string;
  id?: string;
  /** `2024-06-01 12:00` or `12:00`, exactly as it was written. */
  when?: string;
  /** `slack:C0123/1712.345600` — platform, then the adapter's conversation id,
   *  which is absent on a platform whose ids the agent cannot use. */
  where?: string;
  /** `zh`, `en`: the language the message is in, or the last one when it is
   *  too short to tell. */
  lang?: string;
  /** The message with its header line removed. */
  text: string;
}

// Only the shapes `next()` emits, newline included: a human typing
// `[14:23] on my way` is body text and must come back untouched.
const TIME = String.raw`(?<when>(?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2})`;
const LANG = String.raw`lang=(?<lang>[a-z]{2})`;
const WITH_ID = new RegExp(
  String.raw`^\[(?:(?<name>[^\n[\]<>]*)<(?<id>[^\n[\]<>]+)>)? ?${TIME}? ?(?<where>[a-z]+:[^\s[\]<>]+)? ?(?:${LANG})?\]\n`,
);

/** The opaque-ids shape: a name with no `<>`, told apart from body text by the
 *  time that always follows it, and a platform with no conversation after it.
 *  A line of its own reading `[meeting 14:23]` is the price. */
const NAMED = new RegExp(String.raw`^\[(?<name>[^\n[\]<>]*?) ${TIME}(?: (?<where>[a-z]+))?(?: ${LANG})?\]\n`);

/** Read back a header this module wrote: the prefix is for the model, and a
 *  surface showing a stored message renders the speaker its own way. */
export function splitSpeaker(text: string): Speaker {
  const head = WITH_ID.exec(text);
  const { id, when, where, lang } = head?.groups ?? {};
  // A name on its own proves nothing: try the shape that requires a time.
  const m = id || when || where || lang ? head : NAMED.exec(text);
  // `[re assistant 12:00]` fits the named shape; it is the quote line below.
  if (!m?.groups || QUOTE.test(text)) return { text };
  return {
    ...(m.groups.name ? { name: m.groups.name } : {}),
    ...(m.groups.id ? { id: m.groups.id } : {}),
    ...(m.groups.when ? { when: m.groups.when } : {}),
    ...(m.groups.where ? { where: m.groups.where } : {}),
    ...(m.groups.lang ? { lang: m.groups.lang } : {}),
    text: text.slice(m[0].length),
  };
}

// --- the quote -----------------------------------------------------------------------
// A reply to one message names it in the text, under the speaker header, so it
// survives reload, edit and rotation with no field of its own:
//   [re assistant 2026-06-01 12:00]
//   > the first lines of what that message said
//
//   the user's reply

/** The excerpt a quote keeps: enough to find the source again, not the message. */
export const QUOTE_CHARS = 240;

/** What a quote line said, read back off the message. */
export interface Quote {
  role: "user" | "assistant";
  /** `2024-06-01 12:00`, the source's minute, exactly as written. */
  when: string;
  /** The source's opening text as written, markers included, cut at `QUOTE_CHARS`. */
  excerpt: string;
}

const quoteWhen = (at: number): string => {
  const d = new Date(at);
  return `${day(d)} ${hhmm(d)}`;
};

/** `body` under a quote of `source`; a source that says nothing quotes nothing. */
export function withQuote(source: { role: Quote["role"]; at: number; text: string }, body: string): string {
  const excerpt = source.text.trim().slice(0, QUOTE_CHARS).trimEnd();
  if (!excerpt) return body;
  const lines = excerpt.split("\n").map((line) => (line ? `> ${line}` : ">"));
  return `[re ${source.role} ${quoteWhen(source.at)}]\n${lines.join("\n")}\n\n${body}`;
}

const QUOTE = /^\[re (?<role>user|assistant) (?<when>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n(?<lines>(?:>[^\n]*\n)+)\n?/;

/** Read back a quote this module wrote; anything else is the message as typed. */
export function splitQuote(text: string): { quote?: Quote; text: string } {
  const m = QUOTE.exec(text);
  if (!m?.groups) return { text };
  const excerpt = m.groups.lines!.trimEnd().split("\n").map((line) => line.replace(/^> ?/, "")).join("\n");
  return {
    quote: { role: m.groups.role as Quote["role"], when: m.groups.when!, excerpt },
    text: text.slice(m[0].length),
  };
}

/** Trailing lines that open a `[name](file://` link — or a last line that is
 *  only `[name` because the clip fell inside it. */
const ATTACHMENT_LINES = /(?:\n\[[^\]\n]*(?:\]\(\s*<?file:\/\/[^\n]*|$))+$/;

/** A long code span that opens the message, when something else follows it.
 *  Long, because `npm test` before "fails" is the subject, not a paste. */
const LEADING_CODE_SPAN = /^\s*`[^`\n]{40,}`\s+(\S[\s\S]*)$/;

/** A title derived from a first prompt drops what was for the model, not the
 *  reader: the speaker header, the attachment lines a channel appended, and a
 *  pasted code span ahead of the actual question. Shared by list rows and push
 *  notifications, hence core. */
export function readableTitle(title: string | undefined): string | undefined {
  if (!title) return title;
  const { text } = splitSpeaker(title);
  // No header: reflowing what the person typed would change what search matches.
  if (text === title) return title;
  const said = splitQuote(text).text
    .replace(ATTACHMENT_LINES, "")
    .replace(LEADING_CODE_SPAN, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return said || title;
}

/** How a session is named where it is announced (a push): its
 *  readable title, else its directory. Never empty — a listing that could
 *  not answer must not silence the message. One line: every caller puts it
 *  inside emphasis or a button, where a newline breaks the markup. */
export const sessionLabel = (s?: { title?: string; cwd: string }): string =>
  readableTitle(s?.title)?.replace(/\s+/g, " ").trim() || s?.cwd.split("/").filter(Boolean).at(-1) || "Pier session";

/** Distinct directories, newest session first: the ground `projectCwds` picks
 *  from. */
const distinctCwds = (list: { cwd: string; createdAt: number }[]): string[] =>
  [...new Set([...list].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.cwd))];

/** The distinct directories less the worktrees: `wt` puts a checkout beside its
 *  repository as `<repo>.<branch>`, and the next conversation about a project
 *  belongs in the project. A worktree with no such sibling stays. What every
 *  directory picker — web New-session menu, Settings scope, IM panel — offers. */
export function projectCwds(list: { cwd: string; createdAt: number }[]): string[] {
  const all = distinctCwds(list);
  const known = new Set(all);
  return all.filter((cwd) => {
    const slash = cwd.lastIndexOf("/");
    const dot = cwd.indexOf(".", slash + 2); // not a leading dot: `.pier` is a name
    return dot < 0 || !known.has(cwd.slice(0, dot));
  });
}
