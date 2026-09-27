// A Slack thread as transcript lines for the prompt: what a forwarded thread
// parent is read into when a person hands the agent a message. One page, since
// the adapter only inlines a thread it already knows to be short; anything
// longer is the pier-slack skill's business, in a shell.

import type { SlackAttachment, SlackClient } from "./slack-api.js";
import type { SlackDirectory } from "./slack-directory.js";
import { ordered, transcript } from "./slack-transcript.js";

interface SlackThreadRead {
  count: number;
  truncated?: boolean;
  format: string;
  messages: string[];
}

/** Terse: this string goes in a prompt, so every word is paid for per read. */
const LINE_FORMAT =
  "<ts> HH:MM name[id]: text, local time, a date line when the day changes;"
  + " [thread N · <ts>] marks a parent, [file <name> <F…> <size>] an upload";

/** Error codes an agent can act on become the action; the rest keep their
 *  searchable raw code. */
function explain(err: unknown): string {
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
  const all = ordered(page.messages);
  const window = all.slice(0, limit);
  // Only users: a bot names itself, and users.info on a `B…` id fails.
  const ids = window.map((msg) => msg.user ?? "").filter(Boolean);
  const names = await directory.names(client, ids);
  return {
    count: window.length,
    ...(page.nextCursor || all.length > window.length ? { truncated: true } : {}),
    format: LINE_FORMAT,
    messages: transcript(window, names, { ts: true, ids: true, thread: true }),
  };
}

/** A token budget, not a Slack limit: past this the agent gets the
 *  coordinates and decides for itself. */
const INLINE_REPLY_MAX = 30;

/** The eager thread read is not gated: a human handing the agent a message
 *  is the same act as an upload. */
export async function sharedBlock(
  directory: SlackDirectory,
  api: SlackClient,
  log: (message: string) => void,
  share: SlackAttachment,
): Promise<string> {
  const source = share.original_message;
  const ts = share.ts ?? source?.ts;
  const threadTs = share.thread_ts ?? source?.thread_ts ?? ts;
  const replies = share.reply_count ?? source?.reply_count;
  // A share of a reply is one message; only a parent has a thread.
  const parent = share.channel_id && ts && threadTs === ts && replies
    ? { channel: share.channel_id, ts, replies }
    : null;
  // `name<id>` is the sender prefix's grammar (core/identity.ts).
  const author = share.author_id
    ? `${await directory.user(api, share.author_id)}<${share.author_id}>`
    : share.author_name || share.author_subname;
  const where = share.channel_name
    ? `#${share.channel_name}${share.channel_id ? `<${share.channel_id}>` : ""}`
    : share.channel_id;
  const head = [
    "shared message",
    author && `from ${author}`,
    where && `in ${where}`,
    ts && `at ${ts}`,
  ].filter(Boolean).join(" ");
  // `fallback` is Slack's plain-text rendering when a share's `text` is
  // empty (a file-only forward, or a body that is all blocks); "" is normal.
  const body = (share.text || share.fallback || source?.text || "").trim();
  const thread = parent && parent.replies <= INLINE_REPLY_MAX
    ? await sharedThread(directory, api, log, parent.channel, parent.ts, parent.replies)
    : { transcript: false, lines: [] };
  // The coordinates in `pier slack`'s own words (skills/pier-slack).
  const hint = parent && !thread.transcript
    ? `[thread: ${parent.replies} replies — channel ${parent.channel}, thread_ts ${parent.ts}]`
    : "";
  // The transcript opens with the shared message itself.
  return [`[${head}]`, thread.transcript ? "" : body, ...thread.lines, hint]
    .filter(Boolean).join("\n");
}

/** A read that fails or comes back cut says so in the prompt (§5). */
export async function sharedThread(
  directory: SlackDirectory,
  api: SlackClient,
  log: (message: string) => void,
  channel: string,
  ts: string,
  replies: number,
): Promise<{ transcript: boolean; lines: string[] }> {
  try {
    // One over the budget, so an undercounting reply_count still reports as cut.
    const read = await readThread(directory, api, channel, ts, INLINE_REPLY_MAX + 2);
    if (!read.messages.length) return { transcript: false, lines: [] };
    return {
      transcript: true,
      lines: [
        `[thread: ${replies} replies, oldest first — ${read.format}]`,
        ...read.messages,
        ...(read.truncated ? [`[thread partly read: cut at ${read.count} lines]`] : []),
      ],
    };
  } catch (err) {
    log(`shared thread ${channel}/${ts} not read: ${String(err)}`);
    return {
      transcript: false,
      lines: [`[thread not read: ${err instanceof Error ? err.message : String(err)}]`],
    };
  }
}
