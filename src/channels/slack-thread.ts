// A Slack thread as transcript lines for the prompt: what a forwarded thread
// parent is read into when a person hands the agent a message. One page, since
// the adapter only inlines a thread it already knows to be short; anything
// longer is the pier-slack skill's business, in a shell.

import type { SlackClient, SlackMessageEvent } from "./slack-api.js";
import type { SlackDirectory } from "./slack-directory.js";
import { ordered, transcript } from "./slack-transcript.js";

export interface SlackThreadRead {
  count: number;
  truncated?: boolean;
  format: string;
  messages: string[];
}

/** slack-transcript.ts with ts and ids on: the id is the only thing `<@…>`
 *  can be built from. Terse: this string goes in a prompt, so every word is
 *  paid for per read. */
export const LINE_FORMAT =
  "<ts> HH:MM name[id]: text, local time, a date line when the day changes;"
  + " [thread N · <ts>] marks a parent, [file <name> <F…> <size>] an upload";

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
  const all = ordered(page.messages);
  const window: SlackMessageEvent[] = all.slice(0, limit);
  // The store is not consulted: a member need not be bound to have spoken.
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
