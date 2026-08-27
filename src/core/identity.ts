// Who is talking, and when — prefixed onto an inbound prompt.
//
// A session reached through a group chat sees a stream of messages from several
// people, and without this it cannot tell them apart or mention anyone back.
// The identity is per-*turn* information and deliberately never baked into a
// session's instructions: a thread is shared, so pinning the first speaker
// misattributes everyone who follows.
//
// The whole design constraint is token cost. A header on every message is
// ~15 wasted tokens per turn in a DM where the counterpart never changes, so a
// line is emitted only when it carries news: a different speaker, or a gap long
// enough that "when" matters. Nothing changed means nothing is sent.

/** A gap this long makes the timestamp worth its tokens. */
const GAP_MS = 10 * 60_000;

export interface Sender {
  id: string;
  /** Display name; falls back to the id when the platform cannot resolve one. */
  name: string;
}

/**
 * Strip the delimiters the format itself uses, plus newlines, and cap the
 * length. Without this a display name of `x<U9] [admin<U1` forges a second
 * speaker — the prefix is untrusted input wearing a trusted shape.
 */
export function sanitizeIdentity(value: string): string {
  const token = (value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]<>]/g, "")
    .trim();
  return token.slice(0, 60) || "unknown";
}

const two = (n: number): string => String(n).padStart(2, "0");
const hhmm = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`;
const day = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

interface Seen {
  senderId: string;
  at: number;
}

/**
 * Tracks what each session has already been told, so a prefix is only spent on
 * a change. In-memory on purpose: after a restart one redundant header is a
 * rounding error, and persisting it would be bookkeeping for nothing.
 */
export class SenderPrefix {
  private readonly seen = new Map<string, Seen>();

  /**
   * The line to put above this message, or `""` when the session already knows.
   * Same speaker, no real time gap, same day → nothing.
   */
  next(sessionId: string, sender: Sender | undefined, at = Date.now()): string {
    if (!sender?.id) return "";
    const last = this.seen.get(sessionId);
    this.seen.set(sessionId, { senderId: sender.id, at });

    const now = new Date(at);
    const newSpeaker = last?.senderId !== sender.id;
    const gap = !last || at - last.at >= GAP_MS;
    const newDay = !last || day(new Date(last.at)) !== day(now);
    if (!newSpeaker && !gap && !newDay) return "";

    // The id rides along with the name because it is the only thing a mention
    // can be built from, and asking the human for it is never acceptable.
    // When the platform could not resolve a name it hands back the id, and
    // `U123<U123>` reads as a broken record rather than as an unknown name —
    // so an unnamed speaker is just the id, once.
    const id = sanitizeIdentity(sender.id);
    const label = sanitizeIdentity(sender.name);
    const who = newSpeaker ? (label === id ? `<${id}>` : `${label}<${id}>`) : "";
    // The date only when it changed; inside one conversation-day it is noise.
    const when = gap || newDay ? `${newDay ? `${day(now)} ` : ""}${hhmm(now)}` : "";
    return `[${[who, when].filter(Boolean).join(" ")}]`;
  }

  /** Forget a session being evicted. Costs one redundant header if it comes
   *  back, which is the same price a restart already pays. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId);
  }
}

/** Put the prefix above the message, or hand the message back untouched. */
export const withPrefix = (prefix: string, text: string): string =>
  prefix ? `${prefix}\n${text}` : text;

/** What a header line said, once read back off a stored message. */
export interface Speaker {
  /** Absent when the platform only ever knew the id. */
  name?: string;
  id?: string;
  /** `2024-06-01 12:00` or `12:00`, exactly as it was written. */
  when?: string;
  /** The message with its header line removed. */
  text: string;
}

// Only the shapes `next()` emits: `who`, `when`, or both, and — because
// `withPrefix` always joins with one — a newline after them. Anything else, a
// markdown link opening the message or a human typing `[14:23] on my way`, is
// body text and must come back untouched.
const HEADER = /^\[(?:([^\n[\]<>]*)<([^\n[\]<>]+)>)? ?((?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2})?\]\n/;

/**
 * Read back a header this module wrote. The prefix is a token-saving device for
 * the model, not something a human should have to read: a surface showing a
 * stored message can render the speaker as it likes and the body without it.
 */
export function splitSpeaker(text: string): Speaker {
  const m = HEADER.exec(text);
  if (!m?.[2] && !m?.[3]) return { text };
  return {
    ...(m[1] ? { name: m[1] } : {}),
    ...(m[2] ? { id: m[2] } : {}),
    ...(m[3] ? { when: m[3] } : {}),
    text: text.slice(m[0].length),
  };
}

/**
 * A session titled by its first prompt inherits that prompt's header, and the
 * header is for the model: anything a person reads — a list row, a session
 * header, a notification on a phone — would say "operator: …" on every session
 * the workbench ever opened. So the speaker comes off and what they said is
 * the title. Here rather than in a UI module because the push notification
 * needs the same answer and a second copy of this would drift (AGENTS.md §3).
 */
export function readableTitle(title: string | undefined): string | undefined {
  if (!title) return title;
  const { text } = splitSpeaker(title);
  // No header — the title is what the person typed, and reflowing it would
  // change what the sidebar's search is matching against for nothing.
  if (text === title) return title;
  return text.replace(/\s+/g, " ").trim() || title;
}
