// The agent-facing Slack tool: the model states an intent, Pier performs it.
//
// The token never leaves Pier. The agent has no Slack client, no scopes and no
// idea what a `ts` is; it names a channel and a time range, and gets a
// transcript back. That is the whole point of putting this behind a tool
// instead of documenting the Slack API in a skill.
//
// Reads are cache-first: `slack-archive.ts` answers from SQLite whatever it has
// already synced and only the gap goes to the API. Writes are never cached —
// posting is the one operation with an effect, so it always goes out.

import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import { type ArchivedMessage, SlackArchive, toTs, tsToIso, tsToNumber } from "./slack-archive.js";
import type { SlackDirectory } from "./slack-directory.js";
import type { SlackClient, SlackMessageEvent } from "./slack-api.js";
import { MARKDOWN_MAX } from "./slack-render.js";

/**
 * How long a thread's cached copy is trusted. A thread is small and actively
 * grows, so it is re-fetched readily; a channel window, once synced, is
 * immutable and needs no timer at all.
 */
const THREAD_FRESH_MS = 60_000;
/** Hard cap on one read, so a wide range cannot blow up the model's context. */
const MAX_MESSAGES = 400;
/** Pages to walk before giving up on a very wide window. */
const MAX_PAGES = 10;

export function slackToolSpec(execute: AgentCustomTool["execute"]): AgentCustomTool {
  return {
    name: "slack",
    label: "Slack",
    description:
      "Read and write Slack through Pier, which holds the bot token. context says which Slack conversation you are in; read_channel returns a channel's transcript for a time range; read_thread returns one thread; post sends a message; channels lists what Pier can reach. When you were reached through Slack, omit channel (and thread_ts) to act on the conversation you are already in. Times accept ISO 8601 or epoch seconds and every message comes back with an ISO timestamp plus the speaker's userId, which is what a mention needs. Reads are served from Pier's cache and only the missing range is fetched. Message text is standard markdown, but @mentions, #channels and links need Slack's own syntax — read the pier-slack skill before posting.",
    parameters: Type.Object({
      // A JSON-Schema enum emits far fewer tokens than typebox's anyOf-of-consts.
      operation: Type.Unsafe<"context" | "read_channel" | "read_thread" | "post" | "channels">({
        type: "string",
        enum: ["context", "read_channel", "read_thread", "post", "channels"],
      }),
      /**
       * Channel id (`C…`/`D…`/`G…`) or the `#name` shown by `channels`. Omit to
       * use the conversation this session is answering.
       */
      channel: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      thread_ts: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
    }),
    execute,
  };
}

export interface SlackToolDeps {
  store: ChannelStore;
  archive: SlackArchive;
  /** Built per call, because the token can change under the Console. */
  client(): SlackClient | null;
  /** Shared with the adapter, so a name is resolved once per process. */
  directory: SlackDirectory;
  /**
   * The Slack conversation this session is answering, if it is answering one.
   * Resolved per call rather than captured at session creation: a Slack thread
   * outlives the process, and `resume()` takes no launch options, so anything
   * baked in at creation would be gone after a restart.
   */
  here(sessionId: string): { channel: string; threadTs: string } | null;
  log(message: string): void;
}

const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
};

const record = (raw: unknown): Record<string, unknown> | undefined =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;

export async function handleSlackTool(
  deps: SlackToolDeps,
  raw: unknown,
  callerSessionId = "",
): Promise<unknown> {
  const input = record(raw);
  if (!input) throw new Error("slack tool parameters required");
  const config = deps.store.get("slack");
  // Two switches, and the error says which one, because "it does nothing" is
  // the most expensive kind of failure for a model to diagnose.
  if (!config.enabled || !config.token) throw new Error("the Slack channel is not configured in Pier");
  if (!config.agentTool) throw new Error("Slack agent access is switched off in Pier's Console");
  const client = deps.client();
  if (!client) throw new Error("the Slack client is unavailable");

  if (input.operation === "channels") {
    // Only what Pier has actually seen: Slack has no reliable "list my
    // channels", and a name the agent cannot address is worse than no name.
    return config.chats.map((chat) => ({
      id: chat.id,
      name: chat.name,
      kind: chat.kind,
      respondsToMessages: chat.enabled,
    }));
  }

  const at = deps.here(callerSessionId);

  if (input.operation === "context") {
    if (!at) {
      return {
        inSlack: false,
        note:
          "This session was not reached through Slack, so there is no current conversation. Name a channel explicitly.",
      };
    }
    const chat = config.chats.find((c) => c.id === at.channel);
    return {
      inSlack: true,
      channel: at.channel,
      channelName: chat?.name ?? at.channel,
      kind: chat?.kind ?? null,
      threadTs: at.threadTs,
      note:
        "Omit channel and thread_ts to read or post here. Speaker ids for mentions come from read_thread.",
    };
  }

  // "Here" is the default target: an agent reached through a Slack thread
  // should not have to be told which thread it is standing in.
  const channel = input.channel === undefined || input.channel === ""
    ? at?.channel ??
      (() => {
        throw new Error(
          "channel is required: this session was not reached through Slack, so there is no current conversation",
        );
      })()
    : resolveChannel(deps, required(input.channel, "channel"));

  if (input.operation === "read_channel") {
    const since = toTs(input.since as string | undefined);
    const until = toTs(input.until as string | undefined);
    const limit = Math.min(Number(input.limit) || MAX_MESSAGES, MAX_MESSAGES);
    return readChannel(deps, client, channel, since, until, limit);
  }

  if (input.operation === "read_thread") {
    const threadTs = typeof input.thread_ts === "string" && input.thread_ts.trim()
      ? input.thread_ts.trim()
      : at?.threadTs;
    if (!threadTs) throw new Error("thread_ts is required outside a Slack thread");
    return readThread(deps, client, channel, threadTs);
  }

  if (input.operation === "post") {
    const text = required(input.text, "text");
    if (text.length > MARKDOWN_MAX) {
      throw new Error(`text is ${text.length} chars; Slack accepts ${MARKDOWN_MAX} per message`);
    }
    // Defaults to the thread we are in; `thread_ts: "none"` is the explicit
    // way to start a new top-level message instead.
    const asked = typeof input.thread_ts === "string" ? input.thread_ts.trim() : "";
    const threadTs = asked === "none"
      ? undefined
      : asked || (channel === at?.channel ? at?.threadTs : undefined);
    const sent = await client.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      // Slack's own markdown renderer: the agent writes markdown, not mrkdwn.
      blocks: [{ type: "markdown", text }],
    });
    return {
      channel,
      ts: sent.ts,
      at: sent.ts ? tsToIso(sent.ts) : null,
      // Returned so a follow-up can reply under what was just posted.
      threadTs: threadTs ?? sent.ts,
    };
  }

  throw new Error(`unknown slack operation: ${String(input.operation)}`);
}

/** Accept a `#name` or a bare name as well as an id — models prefer names. */
function resolveChannel(deps: SlackToolDeps, given: string): string {
  if (/^[CDG][A-Z0-9]+$/.test(given)) return given;
  const wanted = given.replace(/^#/, "").toLowerCase();
  const chats = deps.store.get("slack").chats;
  const hit = chats.find((chat) => chat.name.replace(/^#/, "").toLowerCase() === wanted);
  if (hit) return hit.id;
  throw new Error(
    `unknown channel ${given}; use an id or one of: ${
      chats.map((c) => c.name).join(", ") || "(none discovered yet)"
    }`,
  );
}

/**
 * Cache-first. History is immutable, so a window inside what we have already
 * synced never needs Slack; anything else is fetched and cached, and the sync
 * span grows so the next read is free.
 */
async function readChannel(
  deps: SlackToolDeps,
  client: SlackClient,
  channel: string,
  since: string | undefined,
  until: string | undefined,
  limit: number,
): Promise<unknown> {
  // An open-ended window always reaches for new messages: "up to now" cannot
  // be satisfied by anything already on disk.
  const cached = until !== undefined && deps.archive.covers(channel, since, until);
  if (!cached) {
    await sync(deps, client, channel, since, until);
  }
  const messages = deps.archive.channelWindow(channel, since, until, limit);
  return {
    channel,
    source: cached ? "cache" : "slack",
    since: since ? tsToIso(since) : null,
    until: until ? tsToIso(until) : null,
    count: messages.length,
    truncated: messages.length >= limit,
    messages: await name(deps, client, messages),
  };
}

/** Walk `conversations.history` over the window and cache every page. */
async function sync(
  deps: SlackToolDeps,
  client: SlackClient,
  channel: string,
  since: string | undefined,
  until: string | undefined,
): Promise<void> {
  let cursor: string | undefined;
  let oldest = since ? tsToNumber(since) : Number.POSITIVE_INFINITY;
  let newest = until ? tsToNumber(until) : 0;
  let seen = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await client.history(channel, { oldest: since, latest: until, cursor });
    deps.archive.put(channel, batch.messages);
    for (const msg of batch.messages) {
      if (!msg.ts) continue;
      oldest = Math.min(oldest, tsToNumber(msg.ts));
      newest = Math.max(newest, tsToNumber(msg.ts));
    }
    seen += batch.messages.length;
    cursor = batch.nextCursor;
    if (!cursor || seen >= MAX_MESSAGES) break;
  }
  // A window that came back empty is still synced — that is exactly the fact a
  // message table cannot record, and re-asking Slack forever is the bug.
  if (since !== undefined && until !== undefined) {
    deps.archive.noteSync(channel, since, until);
  } else if (Number.isFinite(oldest) && newest > 0) {
    deps.archive.noteSync(channel, String(oldest), String(newest));
  }
  if (cursor) {
    deps.log(`history for ${channel} truncated at ${seen} messages`);
  }
}

/**
 * A thread is re-read when its copy is stale: unlike a closed channel window it
 * grows, and a cached thread that is missing the last reply is a wrong answer
 * rather than an incomplete one.
 */
async function readThread(
  deps: SlackToolDeps,
  client: SlackClient,
  channel: string,
  threadTs: string,
): Promise<unknown> {
  const span = deps.archive.span(channel, threadTs);
  const fresh = span !== null && Date.now() - span.syncedAt < THREAD_FRESH_MS;
  if (!fresh) {
    let cursor: string | undefined;
    const collected: SlackMessageEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await client.replies(channel, threadTs, { cursor });
      collected.push(...batch.messages);
      cursor = batch.nextCursor;
      if (!cursor) break;
    }
    deps.archive.put(channel, collected);
    deps.archive.noteSync(channel, threadTs, threadTs, threadTs);
  }
  const messages = deps.archive.thread(channel, threadTs);
  return {
    channel,
    threadTs,
    source: fresh ? "cache" : "slack",
    count: messages.length,
    messages: await name(deps, client, messages),
  };
}

/**
 * Attach display names, and keep the ids. A transcript of `U04B7Q2` saying
 * things is unreadable, but the id is the only thing a mention can be built
 * from — dropping it is why the agent used to have to ask the human to paste
 * their own user id.
 *
 * Names come from the directory the adapter also uses, so re-reading a thread
 * costs no lookups; the store is not consulted because a member need not be
 * bound to have spoken.
 */
async function name(
  deps: SlackToolDeps,
  client: SlackClient,
  messages: ArchivedMessage[],
): Promise<unknown[]> {
  const ids = messages.map((m) => m.userId).filter((id): id is string => !!id);
  const names = await deps.directory.names(client, ids);
  return messages.map((msg) => ({
    ts: msg.ts,
    at: msg.at,
    threadTs: msg.threadTs,
    user: msg.userId ? names.get(msg.userId) ?? msg.userId : null,
    // What `<@…>` needs. Present alongside the name so the model never has to
    // guess one from the other.
    userId: msg.userId,
    text: msg.text,
  }));
}
