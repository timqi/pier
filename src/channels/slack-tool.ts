// The agent-facing Slack tool: the model states an intent, Pier performs it,
// and the token never leaves Pier. Every read goes to Slack — only it knows
// about an edit or a deletion. Affordable because a workspace-internal app gets
// Tier 3 (~50+ req/min) on history/replies; a distributed non-Marketplace app
// is capped at 1 req/min, and that is the decision to revisit.

import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import type { ChannelStore } from "./config.js";
import type { SlackDirectory } from "./slack-directory.js";
import type { SlackClient, SlackFile, SlackHistoryPage, SlackMessageEvent } from "./slack-api.js";
import { MARKDOWN_MAX } from "./slack-render.js";

/** So a wide range cannot blow up the model's context. */
const MAX_MESSAGES = 400;
const MAX_PAGES = 10;

const INBOX_CHANNEL = "slack";

/** A `ts` is `<epoch seconds>.<microseconds>`: sorts as a number, not as a
 *  string. Never rewritten — it is the id a reply must match exactly. */
const tsToNumber = (ts: string): number => Number(ts);

const tsToIso = (ts: string): string =>
  new Date(Math.floor(tsToNumber(ts) * 1000)).toISOString();

const tsToMinute = (ts: string): string => `${tsToIso(ts).slice(0, 16)}Z`;

/** Epoch seconds at the year 2100: past this, the caller meant milliseconds. */
const MAX_SECONDS = 4_102_444_800;

/** Accepts an ISO date, an epoch-seconds number, or a raw Slack ts. */
export function toTs(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const raw = typeof value === "number" ? String(value) : value.trim();
  const numeric = /^\d+(\.\d+)?$/.test(raw);
  const seconds = numeric ? Number(raw) : Date.parse(raw) / 1000;
  if (Number.isNaN(seconds)) throw new Error(`not a time: ${value}`);
  // Milliseconds: Slack takes the window without complaint and answers an empty
  // read indistinguishable from a channel where nobody spoke.
  if (seconds > MAX_SECONDS) {
    throw new Error(
      `${value} is past the year 2100 — Slack times are epoch seconds, not milliseconds`,
    );
  }
  return numeric ? raw : String(seconds);
}

/** Asked before the description is paid for. `handleSlackTool` keeps its own
 *  checks: a session opened while Slack was configured outlives the switch. */
export function slackToolAvailable(store: ChannelStore): boolean {
  const config = store.get("slack");
  return config.enabled && !!config.token && config.agentTool;
}

export function slackToolSpec(
  execute: AgentCustomTool["execute"],
  available: () => boolean,
): AgentCustomTool {
  return {
    name: "slack",
    label: "Slack",
    description:
      "Read and write Slack through Pier, which holds the bot token. Operations: context (which Slack conversation this session is in), read_channel (transcript for a time range), read_thread (one thread; only what is new since a message via after), read_message (the one at ts), fetch_file (save a file a transcript names, by its F… id), post, edit/delete (Pier's own messages only), channels (what Pier can reach). Omit channel and thread_ts to act on the conversation you are in. since/until/after accept ISO 8601, epoch seconds or a ts. Every read fetches live; nothing is kept between calls. @mentions, #channels and links need Slack's own syntax — read the pier-slack skill before posting.",
    parameters: Type.Object({
      // A JSON-Schema enum emits far fewer tokens than typebox's anyOf-of-consts.
      operation: Type.Unsafe<
        | "context"
        | "read_channel"
        | "read_thread"
        | "read_message"
        | "fetch_file"
        | "post"
        | "edit"
        | "delete"
        | "channels"
      >({
        type: "string",
        enum: [
          "context",
          "read_channel",
          "read_thread",
          "read_message",
          "fetch_file",
          "post",
          "edit",
          "delete",
          "channels",
        ],
      }),
      channel: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      ts: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      thread_ts: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
    }),
    available,
    skill: "pier-slack",
    execute,
  };
}

export interface SlackToolDeps {
  store: ChannelStore;
  /** Per call: the token can change under the Console. */
  client(): SlackClient | null;
  directory: SlackDirectory;
  /** Per call: `resume()` takes no launch options, so anything baked in at
   *  creation would be gone after a restart. */
  here(sessionId: string): { channel: string; threadTs: string } | null;
  log(message: string): void;
}

/** Narrower than the tool's deps, so the adapter can reuse `readThread`. */
export type SlackReadDeps = Pick<SlackToolDeps, "directory" | "log">;

export interface SlackThreadRead {
  channel: string;
  threadTs: string;
  count: number;
  truncated?: boolean;
  /** Present when a page failed: why the walk stopped. */
  incomplete?: string;
  format: string;
  messages: string[];
}

const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
};

/** Slack rejects an oversized message outright; a refusal the agent can act
 *  on beats a post that silently never happened. */
const messageText = (raw: unknown): string => {
  const text = required(raw, "text");
  if (text.length > MARKDOWN_MAX) {
    throw new Error(`text is ${text.length} chars; Slack accepts ${MARKDOWN_MAX} per message`);
  }
  return text;
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
  // The error says which switch: "it does nothing" is the most expensive
  // failure for a model to diagnose.
  if (!config.enabled || !config.token) throw new Error("the Slack channel is not configured in Pier");
  if (!config.agentTool) throw new Error("Slack agent access is switched off in Pier's Console");
  const client = deps.client();
  if (!client) throw new Error("the Slack client is unavailable");

  if (input.operation === "channels") {
    // Only what Pier has seen: Slack has no reliable "list my channels".
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

  // Before the channel default: a file id is unique workspace-wide.
  if (input.operation === "fetch_file") {
    return fetchFile(deps, client, required(input.file, "file"));
  }

  const channel = input.channel === undefined || input.channel === ""
    ? at?.channel ??
      (() => {
        throw new Error(
          "channel is required: this session was not reached through Slack, so there is no current conversation",
        );
      })()
    : resolveChannel(deps, required(input.channel, "channel"));

  // Slack's bounds are inclusive-ish, so the boundary message is dropped here.
  const after = toTs(input.after as string | undefined);
  const limit = Math.min(Number(input.limit) || MAX_MESSAGES, MAX_MESSAGES);

  if (input.operation === "read_channel") {
    const since = after ?? toTs(input.since as string | undefined);
    const until = toTs(input.until as string | undefined);
    return readChannel(deps, client, channel, since, until, after, limit);
  }

  if (input.operation === "read_thread") {
    const threadTs = typeof input.thread_ts === "string" && input.thread_ts.trim()
      ? input.thread_ts.trim()
      : at?.threadTs;
    if (!threadTs) throw new Error("thread_ts is required outside a Slack thread");
    return readThread(deps, client, channel, threadTs, after, limit);
  }

  if (input.operation === "read_message") {
    const asked = typeof input.thread_ts === "string" ? input.thread_ts.trim() : "";
    return readMessage(deps, client, channel, required(input.ts, "ts"), asked || undefined);
  }

  if (input.operation === "post") {
    const text = messageText(input.text);
    // `thread_ts: "none"` is the explicit way to start a top-level message.
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
      threadTs: threadTs ?? sent.ts,
      ...inertMention(text),
    };
  }

  if (input.operation === "edit") {
    const ts = required(input.ts, "ts");
    const text = messageText(input.text);
    // `conversations.history` cannot see inside a thread, so the read below
    // needs the thread `post` would default to.
    const asked = typeof input.thread_ts === "string" ? input.thread_ts.trim() : "";
    const inThread = asked || (channel === at?.channel ? at?.threadTs : undefined);
    // Slack keeps no version, so this log is the only record of what was replaced.
    const was = await previousText(client, channel, ts, inThread);
    try {
      await client.updateMessage({ channel, ts, text, blocks: [{ type: "markdown", text }] });
    } catch (err) {
      throw new Error(explain(err));
    }
    deps.log(`slack tool edited ${ts} in ${channel}; was: ${was ?? "(not captured)"}`);
    return { channel, ts, edited: true, ...inertMention(text) };
  }

  if (input.operation === "delete") {
    // Never defaulted from `here`: an implied target is the one mistake with no undo.
    const ts = required(input.ts, "ts");
    try {
      await client.deleteMessage(channel, ts);
    } catch (err) {
      throw new Error(explain(err));
    }
    deps.log(`slack tool deleted ${ts} in ${channel}`);
    return { channel, ts, deleted: true };
  }

  throw new Error(`unknown slack operation: ${String(input.operation)}`);
}

/** `conversations.history` never returns what was posted inside a thread, so
 *  a reply has to be asked for through its thread. */
async function oneMessage(
  client: SlackClient,
  channel: string,
  ts: string,
  threadTs: string | undefined,
): Promise<SlackMessageEvent | undefined> {
  const page = threadTs
    ? await client.replies(channel, threadTs, { oldest: ts, limit: 20 })
    : await client.history(channel, { oldest: ts, latest: ts, limit: 1 });
  return page.messages.find((msg) => msg.ts === ts);
}

async function previousText(
  client: SlackClient,
  channel: string,
  ts: string,
  threadTs: string | undefined,
): Promise<string | undefined> {
  try {
    const text = (await oneMessage(client, channel, ts, threadTs))?.text;
    return text === undefined ? undefined : text.slice(0, 200).replace(/\s+/g, " ");
  } catch {
    // The caller logs "not captured"; refusing the edit over it would be worse.
    return undefined;
  }
}

/** A plain `@alice` looks like it worked and notifies nobody. Reported, not
 *  refused: a name in prose is legitimate. */
function inertMention(text: string): { hint?: string } {
  const prose = text
    .replace(/```[\s\S]*?```|`[^`]*`/g, "") // code says @ and # for other reasons
    .replace(/<[^>]*>/g, ""); // already Slack syntax
  const hit = /(?:^|\s)([@#][A-Za-z][\w.-]*)/.exec(prose)?.[1];
  if (!hit) return {};
  const as = hit.startsWith("@")
    ? /^@(here|channel|everyone)$/.test(hit) ? `<!${hit.slice(1)}>` : "<@U…>"
    : "<#C…>";
  return {
    hint: `${hit} is plain text and notified nobody — Slack needs ${as}. ` +
      `Edit this ts if it was meant to reach someone.`,
  };
}

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

async function readChannel(
  deps: SlackReadDeps,
  client: SlackClient,
  channel: string,
  since: string | undefined,
  until: string | undefined,
  after: string | undefined,
  limit: number,
): Promise<unknown> {
  const fetched = await fetchPages(
    deps,
    (cursor) => client.history(channel, { oldest: since, latest: until, cursor }),
    `history for ${channel}`,
  );
  const all = newerThan(transcript(fetched.messages), after);
  // Truncated at the newest end: the oldest `limit` messages read as a transcript.
  const window = all.slice(0, limit);
  return {
    channel,
    range: `${since ? tsToMinute(since) : "start"} → ${until ? tsToMinute(until) : "now"}`,
    count: window.length,
    ...(fetched.truncated || all.length > window.length ? { truncated: true } : {}),
    ...(fetched.incomplete ? { incomplete: fetched.incomplete } : {}),
    format: LINE_FORMAT,
    messages: await lines(deps, client, window),
  };
}

/** Exported for the adapter, which inlines a small shared thread. */
export async function readThread(
  deps: SlackReadDeps,
  client: SlackClient,
  channel: string,
  threadTs: string,
  after: string | undefined,
  limit: number,
): Promise<SlackThreadRead> {
  const fetched = await fetchPages(
    deps,
    (cursor) => client.replies(channel, threadTs, { oldest: after, cursor }),
    `thread ${threadTs} in ${channel}`,
  );
  const all = newerThan(transcript(fetched.messages), after);
  const messages = all.slice(0, limit);
  return {
    channel,
    threadTs,
    count: messages.length,
    ...(fetched.truncated || all.length > messages.length ? { truncated: true } : {}),
    ...(fetched.incomplete ? { incomplete: fetched.incomplete } : {}),
    format: LINE_FORMAT,
    messages: await lines(deps, client, messages),
  };
}

async function readMessage(
  deps: SlackReadDeps,
  client: SlackClient,
  channel: string,
  ts: string,
  threadTs: string | undefined,
): Promise<unknown> {
  const found = await oneMessage(client, channel, ts, threadTs);
  if (!found) {
    throw new Error(
      threadTs
        ? `no message ${ts} in thread ${threadTs}`
        : `no message ${ts} in that channel — a reply posted inside a thread needs thread_ts`,
    );
  }
  const [line] = await lines(deps, client, [found]);
  return {
    channel,
    ...(found.thread_ts ? { threadTs: found.thread_ts } : {}),
    format: LINE_FORMAT,
    message: line,
  };
}

/** Explicit, not automatic: one read can name a hundred uploads, and the agent
 *  knows which one the question is about. `files.info` every call: the signed
 *  url expires. */
async function fetchFile(deps: SlackReadDeps, client: SlackClient, id: string): Promise<string> {
  let file: SlackFile;
  try {
    file = await client.filesInfo(id);
  } catch (err) {
    // Manifest scopes apply only at app creation, so an older install refuses
    // for a reason no agent can guess.
    if (/missing_scope/.test(String(err))) {
      throw new Error(
        "Pier's Slack app cannot read files — add the files:read scope to the Slack app " +
          "under OAuth & Permissions and reinstall it",
      );
    }
    throw new Error(explain(err));
  }
  const [marker] = await saveInboundAll(INBOX_CHANNEL, [{
    label: file.name ?? id,
    name: file.name,
    mimeType: file.mimetype ?? "application/octet-stream",
    size: file.size,
    // The response's content-type wins: Slack's metadata is a guess.
    fetch: () => client.downloadFile(file, MAX_INBOUND_BYTES),
  }], deps.log);
  return marker!;
}

/** A page that fails mid-walk keeps the pages before it, plus why it stopped:
 *  an exception alone cannot be told from a quiet channel. */
async function fetchPages(
  deps: SlackReadDeps,
  page: (cursor?: string) => Promise<SlackHistoryPage>,
  what: string,
): Promise<{ messages: SlackMessageEvent[]; truncated: boolean; incomplete?: string }> {
  const messages: SlackMessageEvent[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let batch: SlackHistoryPage;
    try {
      batch = await page(cursor);
    } catch (err) {
      if (messages.length === 0) throw new Error(explain(err));
      deps.log(`${what} stopped after ${messages.length} messages: ${String(err)}`);
      return { messages, truncated: true, incomplete: explain(err) };
    }
    messages.push(...batch.messages);
    cursor = batch.nextCursor;
    if (!cursor || messages.length >= MAX_MESSAGES) break;
  }
  if (cursor) deps.log(`${what} truncated at ${messages.length} messages`);
  return { messages, truncated: cursor !== undefined };
}

/** Error codes an agent can act on become the action; the rest keep their
 *  searchable raw code. */
function explain(err: unknown): string {
  const code = /slack [\w.]+: (\w+)/.exec(String(err))?.[1] ?? "";
  return {
    channel_not_found: "no such channel, or Pier's bot cannot see it — check the channels operation",
    not_in_channel:
      "Pier's bot is not in that channel; someone has to run `/invite @Pier` there before it can read",
    missing_scope: "Pier's Slack app lacks the scope for this call; the operator must reinstall it",
    ratelimited: "Slack rate-limited Pier; wait a minute, and narrow the range if this was a read",
    thread_not_found: "no thread with that ts in this channel",
    cant_delete_message:
      "Slack only lets Pier delete what its own bot posted; a person's message has to be deleted by them",
    cant_update_message:
      "Slack only lets Pier edit what its own bot posted; anyone else's message can only be replied to",
    edit_window_closed:
      "Slack's edit window for that message has closed; post a correction instead of rewriting it",
    message_not_found:
      "no message with that ts in this channel — a ts only means anything in the conversation it came from",
    file_not_found:
      "no file with that id, or Pier's bot cannot see it — the F… id comes from a transcript line",
  }[code] ?? String(err);
}

/** Strictly newer, so `after: <last ts I saw>` never repeats that message. */
const newerThan = (messages: SlackMessageEvent[], after: string | undefined) =>
  after === undefined ? messages : messages.filter((m) => tsToNumber(m.ts!) > tsToNumber(after));

/** Oldest first, one per ts: page bounds are inclusive-ish, so a paged read
 *  can repeat the message on the seam. */
function transcript(messages: SlackMessageEvent[]): SlackMessageEvent[] {
  const byTs = new Map<string, SlackMessageEvent>();
  for (const msg of messages) if (msg.ts) byTs.set(msg.ts, msg);
  return [...byTs.values()].sort((a, b) => tsToNumber(a.ts!) - tsToNumber(b.ts!));
}

/** Lines, not objects: four hundred six-key objects spend most of their tokens
 *  on key names. The id is the only thing `<@…>` can be built from. Terse: the
 *  adapter puts this string in a prompt, so every word is paid for per read. */
const LINE_FORMAT =
  "<ts> | <time, UTC> | <name>[<id>] | <text>, then — when there are any —"
  + " [thread: <n> replies] and one [file: <name> <F… id> <size>] per upload";

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

async function lines(
  deps: SlackReadDeps,
  client: SlackClient,
  messages: SlackMessageEvent[],
): Promise<string[]> {
  // The store is not consulted: a member need not be bound to have spoken.
  const ids = messages.map(speaker).filter((id): id is string => !!id);
  const names = await deps.directory.names(client, ids);
  return messages.map((msg) => {
    const id = speaker(msg);
    const known = id ? names.get(id) : undefined;
    const who = id ? (known && known !== id ? `${known}[${id}]` : `[${id}]`) : "[unknown]";
    const replies = msg.reply_count && (msg.thread_ts ?? msg.ts) === msg.ts
      ? ` [thread: ${msg.reply_count} replies]`
      : "";
    return `${msg.ts} | ${tsToMinute(msg.ts!)} | ${who} | ${msg.text ?? ""}${replies}${
      uploads(msg.files)
    }`;
  });
}
