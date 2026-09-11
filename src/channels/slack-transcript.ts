// The one transcript format a Slack conversation is read in: the adapter's
// inline forwarded thread (slack-thread.ts) and `pier slack` (slack-cli.ts)
// both render through here, so the pier-slack skill describes it once and no
// header repeats it. Lines, not objects: forty six-key objects spend most of
// their tokens on key names.

import type { SlackMessageEvent } from "./slack-api.js";

/** A parent with its replies attached, the shape `--threads` and `--json` share. */
export type Threaded = SlackMessageEvent & { replies?: SlackMessageEvent[] };

export interface TranscriptOptions {
  /** Prefix every line with the message's `ts` — the id `thread`, `message`, `--after`, `edit` take. */
  ts?: boolean;
  /** `name[id]`: the id a `<@…>` mention is built from. */
  ids?: boolean;
  /** Inside one thread every reply is in it; the `[in thread <ts>]` marker
   *  is for a reply met in the channel's own flow. */
  thread?: boolean;
}

/** A `ts` is `<epoch seconds>.<microseconds>`: sorts as a number, not as a
 *  string. Never rewritten — it is the id a reply must match exactly. */
const tsToNumber = (ts: string): number => Number(ts);

const pad = (n: number): string => String(n).padStart(2, "0");
const local = (ts: string): Date => new Date(Math.floor(tsToNumber(ts) * 1000));

export const localDate = (ts: string): string => {
  const d = local(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const localTime = (ts: string): string => {
  const d = local(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const localStamp = (ts: string): string => `${localDate(ts)} ${localTime(ts)}`;

/** `+0800`: the header carries it once so HH:MM needs no suffix. */
export function tzLabel(now: Date = new Date()): string {
  const minutes = -now.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Enough to judge a fetch against the 32 MB cap without arithmetic. */
const sizeLabel = (bytes: number): string =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

const speaker = (msg: SlackMessageEvent): string | undefined => msg.user ?? msg.bot_id;

/** Oldest first, one per ts (page seams repeat), strictly newer than `after`. */
export function ordered<T extends SlackMessageEvent>(messages: T[], after?: string): T[] {
  const byTs = new Map<string, T>();
  for (const msg of messages) if (msg.ts) byTs.set(msg.ts, msg);
  const all = [...byTs.values()].sort((a, b) => tsToNumber(a.ts!) - tsToNumber(b.ts!));
  return after ? all.filter((m) => tsToNumber(m.ts!) > tsToNumber(after)) : all;
}

/** The text, or a stand-in for a message whose content is only blocks or attachments. */
function body(msg: SlackMessageEvent): string {
  if (msg.text) return msg.text;
  const titles = (msg.attachments ?? []).map((a) => a.title || a.fallback || a.text);
  if (titles.length) return titles.map((t) => (t ? `[attachment: ${t}]` : "[attachment]")).join(" ");
  return msg.blocks?.length ? "[blocks]" : "";
}

function markers(msg: SlackMessageEvent, inThread: boolean): string[] {
  const out: string[] = [];
  if (msg.edited) out.push("[edited]");
  if (msg.reply_count && (msg.thread_ts ?? msg.ts) === msg.ts) {
    out.push(`[thread ${msg.reply_count} · ${msg.ts}]`);
  } else if (!inThread && msg.thread_ts && msg.thread_ts !== msg.ts) {
    // A reply also sent to the channel; under its parent the indent says where it is.
    out.push(`[in thread ${msg.thread_ts}]`);
  }
  for (const file of msg.files ?? []) {
    out.push(`[file ${file.name ?? file.mimetype ?? "file"} ${file.id}${file.size === undefined ? "" : ` ${sizeLabel(file.size)}`}]`);
  }
  if (msg.reactions?.length) {
    out.push(`[${msg.reactions.map((r) => `:${r.name}: ${r.count ?? 1}`).join(", ")}]`);
  }
  return out;
}

/** One message as lines: `HH:MM name: text [markers]`, continuation lines
 *  indented four past the message. `names` resolves user ids; a bot names itself. */
export function renderMessage(
  msg: SlackMessageEvent,
  names: Map<string, string>,
  opts: TranscriptOptions = {},
  indent = "",
): string[] {
  const id = speaker(msg);
  const name = msg.user
    ? names.get(msg.user) ?? msg.user
    : msg.bot_profile?.name ?? msg.username ?? id;
  const who = !id || !name ? "unknown" : opts.ids && name !== id ? `${name}[${id}]` : name;
  const [first = "", ...rest] = body(msg).split("\n");
  const lines = [
    `${indent}${opts.ts ? `${msg.ts ?? ""} ` : ""}${localTime(msg.ts ?? "0")} ${who}:${first ? ` ${first}` : ""}`,
    ...rest.map((line) => `${indent}    ${line}`),
  ];
  const tail = markers(msg, opts.thread || indent !== "").join(" ");
  if (tail) lines[lines.length - 1] += ` ${tail}`;
  return lines;
}

/** Messages in the order given, a date line before the first and whenever the
 *  local day changes, replies two spaces under their parent. */
export function transcript(
  messages: Threaded[],
  names: Map<string, string>,
  opts: TranscriptOptions = {},
): string[] {
  const out: string[] = [];
  let day = "";
  const push = (msg: SlackMessageEvent, indent: string): void => {
    const date = localDate(msg.ts ?? "0");
    if (date !== day) {
      out.push(date);
      day = date;
    }
    out.push(...renderMessage(msg, names, opts, indent));
  };
  for (const msg of messages) {
    push(msg, "");
    for (const reply of msg.replies ?? []) push(reply, "  ");
  }
  return out;
}

/** `# <scope> · <tz> · <N> messages · last <ts>`: `last` is what `--after` takes next time. */
export const header = (scope: string, count: number, last?: string): string =>
  `# ${scope} · ${tzLabel()} · ${count} messages${last ? ` · last ${last}` : ""}`;
