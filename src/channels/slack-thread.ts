// A Slack thread as transcript lines for the prompt: what a forwarded thread
// parent is read into when a person hands the agent a message. One page, since
// the adapter only inlines a thread it already knows to be short; anything
// longer is the pier-slack skill's business, in a shell.

import type { SlackClient, SlackFile, SlackMessageEvent } from "./slack-api.js";
import type { SlackDirectory } from "./slack-directory.js";

export interface SlackThreadRead {
  count: number;
  truncated?: boolean;
  format: string;
  messages: string[];
}

/** Lines, not objects: forty six-key objects spend most of their tokens on key
 *  names. The id is the only thing `<@…>` can be built from. Terse: this string
 *  goes in a prompt, so every word is paid for per read. */
export const LINE_FORMAT =
  "<ts> | <time, UTC> | <name>[<id>] | <text>, then — when there are any —"
  + " [thread: <n> replies] and one [file: <name> <F… id> <size>] per upload";

/** A `ts` is `<epoch seconds>.<microseconds>`: sorts as a number, not as a
 *  string. Never rewritten — it is the id a reply must match exactly. */
const tsToNumber = (ts: string): number => Number(ts);

const tsToMinute = (ts: string): string =>
  `${new Date(Math.floor(tsToNumber(ts) * 1000)).toISOString().slice(0, 16)}Z`;

/** Enough to judge a fetch against the 32 MB cap without arithmetic. */
const sizeLabel = (bytes: number): string =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Without this a PDF somebody posted reads as an empty message. */
const uploads = (files: SlackFile[] | undefined): string =>
  (files ?? []).map((file) =>
    ` [file: ${file.name ?? file.mimetype ?? "file"} ${file.id}${
      file.size === undefined ? "" : ` ${sizeLabel(file.size)}`
    }]`
  ).join("");

const speaker = (msg: SlackMessageEvent): string | null => msg.user ?? msg.bot_id ?? null;

/** Error codes an agent can act on become the action; the rest keep their
 *  searchable raw code. */
export function explain(err: unknown): string {
  const code = /slack [\w.]+: (\w+)/.exec(String(err))?.[1] ?? "";
  return {
    channel_not_found: "no such channel, or Pier's bot cannot see it",
    not_in_channel:
      "Pier's bot is not in that channel; someone has to run `/invite @Pier` there before it can read",
    missing_scope: "Pier's Slack app lacks the scope for this call; the operator must reinstall it",
    ratelimited: "Slack rate-limited Pier; wait a minute before reading again",
    thread_not_found: "no thread with that ts in this channel",
  }[code] ?? String(err);
}

/** Oldest first, one per ts, cut to `limit` at the newest end and saying so. */
export async function readThread(
  directory: SlackDirectory,
  client: SlackClient,
  channel: string,
  threadTs: string,
  limit: number,
): Promise<SlackThreadRead> {
  let page;
  try {
    page = await client.replies(channel, threadTs, { limit });
  } catch (err) {
    throw new Error(explain(err));
  }
  const byTs = new Map<string, SlackMessageEvent>();
  for (const msg of page.messages) if (msg.ts) byTs.set(msg.ts, msg);
  const all = [...byTs.values()].sort((a, b) => tsToNumber(a.ts!) - tsToNumber(b.ts!));
  const window = all.slice(0, limit);
  // The store is not consulted: a member need not be bound to have spoken.
  const ids = window.map(speaker).filter((id): id is string => !!id);
  const names = await directory.names(client, ids);
  return {
    count: window.length,
    ...(page.nextCursor || all.length > window.length ? { truncated: true } : {}),
    format: LINE_FORMAT,
    messages: window.map((msg) => {
      const id = speaker(msg);
      const known = id ? names.get(id) : undefined;
      const who = id ? (known && known !== id ? `${known}[${id}]` : `[${id}]`) : "[unknown]";
      const replies = msg.reply_count && (msg.thread_ts ?? msg.ts) === msg.ts
        ? ` [thread: ${msg.reply_count} replies]`
        : "";
      return `${msg.ts} | ${tsToMinute(msg.ts!)} | ${who} | ${msg.text ?? ""}${replies}${uploads(msg.files)}`;
    }),
  };
}
