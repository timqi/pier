// Who is talking, when, and where — prefixed onto an inbound prompt so a
// group-chat session can tell speakers apart, mention them back, and name its
// own conversation to a script. Per turn, never in the session's instructions
// (a thread is shared), and emitted only on news: a header costs ~15 tokens,
// wasted in a DM where the counterpart never changes.

/** A gap this long makes the timestamp worth its tokens. */
const GAP_MS = 10 * 60_000;

export interface Sender {
  id: string;
  /** Display name; falls back to the id when the platform cannot resolve one. */
  name: string;
}

/** A display name of `x<U9] [admin<U1` would forge a second speaker: the
 *  prefix is untrusted input wearing a trusted shape. */
export function sanitizeIdentity(value: string): string {
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
const day = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

interface Seen {
  senderId: string;
  at: number;
  conversation?: string;
}

/** What each session has already been told. In memory: after a restart one
 *  redundant header is a rounding error. */
export class SenderPrefix {
  private readonly seen = new Map<string, Seen>();

  /** The line to put above this message, or `""` when the session already
   *  knows. `conversation` is the chat's `<channelId>:<conversationId>`, told
   *  once: a session never moves, but the rule stays the same as the rest.
   *  `opaqueIds` is the platform's (`core/types.ts`): its ids buy nothing. */
  next(
    sessionId: string,
    sender: Sender | undefined,
    at = Date.now(),
    conversation?: string,
    opaqueIds = false,
  ): string {
    if (!sender?.id) return "";
    const last = this.seen.get(sessionId);
    this.seen.set(sessionId, { senderId: sender.id, at, conversation });

    const now = new Date(at);
    const newSpeaker = last?.senderId !== sender.id;
    const gap = !last || at - last.at >= GAP_MS;
    const newDay = !last || day(new Date(last.at)) !== day(now);
    const newPlace = !!conversation && last?.conversation !== conversation;
    if (!newSpeaker && !gap && !newDay && !newPlace) return "";

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
    return `[${[who, when, where].filter(Boolean).join(" ")}]`;
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId);
  }
}

export const withPrefix = (prefix: string, text: string): string =>
  prefix ? `${prefix}\n${text}` : text;

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
  /** The message with its header line removed. */
  text: string;
}

// Only the shapes `next()` emits, newline included: a human typing
// `[14:23] on my way` is body text and must come back untouched.
const TIME = String.raw`(?<when>(?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2})`;
const WITH_ID = new RegExp(
  String.raw`^\[(?:(?<name>[^\n[\]<>]*)<(?<id>[^\n[\]<>]+)>)? ?${TIME}? ?(?<where>[a-z]+:[^\s[\]<>]+)?\]\n`,
);

/** The opaque-ids shape: a name with no `<>`, told apart from body text by the
 *  time that always follows it, and a platform with no conversation after it.
 *  A line of its own reading `[meeting 14:23]` is the price. */
const NAMED = new RegExp(String.raw`^\[(?<name>[^\n[\]<>]*?) ${TIME}(?: (?<where>[a-z]+))?\]\n`);

/** Read back a header this module wrote: the prefix is for the model, and a
 *  surface showing a stored message renders the speaker its own way. */
export function splitSpeaker(text: string): Speaker {
  const head = WITH_ID.exec(text);
  const { id, when, where } = head?.groups ?? {};
  // A name on its own proves nothing: try the shape that requires a time.
  const m = id || when || where ? head : NAMED.exec(text);
  if (!m?.groups) return { text };
  return {
    ...(m.groups.name ? { name: m.groups.name } : {}),
    ...(m.groups.id ? { id: m.groups.id } : {}),
    ...(m.groups.when ? { when: m.groups.when } : {}),
    ...(m.groups.where ? { where: m.groups.where } : {}),
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
  const said = text
    .replace(ATTACHMENT_LINES, "")
    .replace(LEADING_CODE_SPAN, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return said || title;
}

/** How a session is named where it is announced (a push, a handoff): its
 *  readable title, else its directory. Never empty — a listing that could
 *  not answer must not silence the message. One line: every caller puts it
 *  inside emphasis or a button, where a newline breaks the markup. */
export const sessionLabel = (s?: { title?: string; cwd: string }): string =>
  readableTitle(s?.title)?.replace(/\s+/g, " ").trim() || s?.cwd.split("/").filter(Boolean).at(-1) || "Pier session";

/** Distinct directories, newest session first: the ground `projectCwds` picks
 *  from. */
export const distinctCwds = (list: { cwd: string; createdAt: number }[]): string[] =>
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
