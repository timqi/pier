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

}

/** Put the prefix above the message, or hand the message back untouched. */
export const withPrefix = (prefix: string, text: string): string =>
  prefix ? `${prefix}\n${text}` : text;
