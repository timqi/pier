// The agent-facing Slack tool: the model states an intent, Pier performs it.
//
// The token never leaves Pier. The agent has no Slack client, no scopes and no
// idea what a `ts` is; it names a channel and a time range, and gets a
// transcript back. That is the whole point of putting this behind a tool
// instead of documenting the Slack API in a skill.
//
// Every read goes to Slack. Slack is the source of truth and it is the only
// party that knows about an edit or a deletion, so a stored copy can only be a
// copy that is wrong later — and Pier is a workspace-internal app, where
// `conversations.history`/`replies` are Tier 3 (~50+ req/min) and a read costs
// one or two calls. If that assumption changes (a distributed non-Marketplace
// app is capped at 1 req/min), this is the decision to revisit.

import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import type { ChannelStore } from "./config.js";
import type { SlackDirectory } from "./slack-directory.js";
import type { SlackClient, SlackFile, SlackHistoryPage, SlackMessageEvent } from "./slack-api.js";
import { MARKDOWN_MAX } from "./slack-render.js";

/** Hard cap on one read, so a wide range cannot blow up the model's context. */
const MAX_MESSAGES = 400;
/** Pages to walk before giving up on a very wide window. */
const MAX_PAGES = 10;

/** Where fetched bytes land: the adapter's own channel id, so a file the agent
 *  asked for sits beside the ones people uploaded to Pier. */
const INBOX_CHANNEL = "slack";

/**
 * A Slack `ts` is `<epoch seconds>.<microseconds>` and sorts correctly as a
 * number but *not* as a string once the integer part changes width. Ordering
 * goes through this; the string itself is never rewritten, because it is the
 * id a reply or a reaction has to match exactly.
 */
const tsToNumber = (ts: string): number => Number(ts);

const tsToIso = (ts: string): string =>
  new Date(Math.floor(tsToNumber(ts) * 1000)).toISOString();

/** Minute precision in the transcript: the exact time is in the `ts` beside it. */
const tsToMinute = (ts: string): string => `${tsToIso(ts).slice(0, 16)}Z`;

/** Epoch seconds at the year 2100: past this, the caller meant milliseconds. */
const MAX_SECONDS = 4_102_444_800;

/** Accepts an ISO date, an epoch-seconds number, or a raw Slack ts. */
export function toTs(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const raw = typeof value === "number" ? String(value) : value.trim();
  // A ts is passed through untouched — it is an id, not a number to reformat.
  const numeric = /^\d+(\.\d+)?$/.test(raw);
  const seconds = numeric ? Number(raw) : Date.parse(raw) / 1000;
  if (Number.isNaN(seconds)) throw new Error(`not a time: ${value}`);
  // Milliseconds are the mistake worth naming: Slack takes the window without
  // complaint, finds nothing that far in the future, and answers with an empty
  // read that is indistinguishable from a channel where nobody spoke.
  if (seconds > MAX_SECONDS) {
    throw new Error(
      `${value} is past the year 2100 — Slack times are epoch seconds, not milliseconds`,
    );
  }
  return numeric ? raw : String(seconds);
}

/**
 * Whether a session opened now is given the tool at all: the same two switches
 * `handleSlackTool` checks, asked before the description is paid for. The call
 * keeps its own checks and its own two messages — a session opened while Slack
 * was configured outlives the operator switching it off, and that turn has to
 * say so rather than find the tool quietly gone.
 */
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
    // One screen of contract; the paragraph this once was lives in the
    // pier-slack skill, which the description sends the model to before it
    // posts — the part that goes wrong without instructions.
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
      /**
       * Channel id (`C…`/`D…`/`G…`) or the `#name` shown by `channels`. Omit to
       * use the conversation this session is answering.
       */
      channel: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
      /** Strictly newer than this — "what changed since I last looked". */
      after: Type.Optional(Type.String()),
      /** The one message `read_message`, `edit` or `delete` is about. */
      ts: Type.Optional(Type.String()),
      /** `fetch_file`: the `F…` id a transcript line carries. */
      file: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      thread_ts: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
    }),
    available,
    // Stands down with the tool: without Slack, its manual is a route to nowhere.
    skill: "pier-slack",
    execute,
  };
}

export interface SlackToolDeps {
  store: ChannelStore;
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

/**
 * What a *read* needs, which is less than the tool does: names for the
 * speakers and somewhere to report a page that failed mid-walk. Narrower on
 * purpose, so the adapter can reuse `readThread` for a shared thread without
 * pretending to be the tool — it has no session to resolve "here" for and
 * builds no client of its own.
 */
export type SlackReadDeps = Pick<SlackToolDeps, "directory" | "log">;

/** One thread, as lines. Declared because the adapter reads these fields. */
export interface SlackThreadRead {
  channel: string;
  threadTs: string;
  count: number;
  truncated?: boolean;
  /** Present when a page failed: what came before it, plus why it stopped. */
  incomplete?: string;
  /** The line grammar, so no second copy of it has to be written down. */
  format: string;
  messages: string[];
}

const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
};

/**
 * Slack rejects an oversized message outright, so the length is checked here:
 * a refusal the agent can act on beats a post that silently never happened.
 */
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

  // Before the channel default below: a file id is unique workspace-wide, so
  // asking a session that never touched Slack for a channel it has no way to
  // name would refuse a call that needs none.
  if (input.operation === "fetch_file") {
    return fetchFile(deps, client, required(input.file, "file"));
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

  // `after` is the "what is new since I last looked" form of `since`: Slack's
  // own bounds are inclusive-ish, so the boundary message is dropped here
  // rather than trusted to the API.
  const after = toTs(input.after as string | undefined);
  // Both reads take it, so it is read once: a cap that worked on a channel and
  // was ignored on a thread would be the more expensive kind of surprise.
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
      ...inertMention(text),
    };
  }

  if (input.operation === "edit") {
    // Explicit `ts`, for delete's reason: an edit replaces the text outright,
    // and Slack keeps no visible record of what it said before.
    const ts = required(input.ts, "ts");
    const text = messageText(input.text);
    // Defaulted from `here` as `post` is: a correction is nearly always to a
    // reply the agent made in this thread, and `conversations.history` cannot
    // see inside a thread — without this the read below always comes up empty.
    const asked = typeof input.thread_ts === "string" ? input.thread_ts.trim() : "";
    const inThread = asked || (channel === at?.channel ? at?.threadTs : undefined);
    // Read before the write, because after it the old wording exists nowhere:
    // Slack keeps no version, so this log is the only record of what was
    // replaced. Best-effort — a failed read must not block the correction.
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
    // Never defaulted from `here`: the thread's ts is the parent message, and
    // "delete" with an implied target is the one mistake with no undo.
    const ts = required(input.ts, "ts");
    try {
      await client.deleteMessage(channel, ts);
    } catch (err) {
      throw new Error(explain(err));
    }
    // A removal leaves nothing behind to read, so the log is the only record
    // that it happened at all.
    deps.log(`slack tool deleted ${ts} in ${channel}`);
    return { channel, ts, deleted: true };
  }

  throw new Error(`unknown slack operation: ${String(input.operation)}`);
}

/**
 * The one message at `ts`. A `ts` is unique only within its conversation, and
 * `conversations.history` never returns what was posted inside a thread — so a
 * reply has to be asked for through its thread, and only the caller knows.
 */
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

/** One line of what a message said, for the log an edit leaves behind. */
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
    // Not swallowed: the caller logs that the old wording was not captured,
    // which is the fact that matters. Refusing the edit over it would be worse.
    return undefined;
  }
}

/**
 * A plain `@alice` is the one Slack mistake that looks like it worked: the
 * message goes up, renders as text, and notifies nobody. Reported after the
 * fact rather than refused — a name in prose is legitimate, an unping is not
 * worth losing the message over.
 */
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
  // Slack hands back the newest first, so a window wider than the caps is
  // truncated at its newest end — the oldest `limit` messages are the ones
  // that read as a transcript.
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

/**
 * Exported for one caller: the adapter inlines a small shared thread, and a
 * second `conversations.replies` walker — its paging, seam dedup, ordering and
 * error translation — is exactly the copy this file exists to prevent.
 */
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
  // Oldest first, as in a channel read: a thread cut at its newest end still
  // reads as a thread, and the cut has to be said either way — a long thread
  // that answers as if it were complete is the read nobody double-checks.
  const messages = all.slice(0, limit);
  return {
    channel,
    // Hoisted: every line in a thread carries the same one.
    threadTs,
    count: messages.length,
    ...(fetched.truncated || all.length > messages.length ? { truncated: true } : {}),
    ...(fetched.incomplete ? { incomplete: fetched.incomplete } : {}),
    format: LINE_FORMAT,
    messages: await lines(deps, client, messages),
  };
}

/** One message, because that is sometimes the whole question. */
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

/**
 * A file a transcript named, on disk. Fetching is explicit rather than
 * automatic: one channel read can name a hundred uploads, and the agent — not
 * Pier — knows which of them the question is about. Even then the reply is only
 * the marker line, so the bytes enter its context if it opens the file.
 *
 * `files.info` every call. A `SlackFile` carries a signed url that expires and
 * a name its owner can change, so a kept copy is the same wrong-later copy this
 * file's header refuses for messages.
 */
async function fetchFile(deps: SlackReadDeps, client: SlackClient, id: string): Promise<string> {
  let file: SlackFile;
  try {
    file = await client.filesInfo(id);
  } catch (err) {
    // The manifest's scopes are only applied when an app is *created*, so an
    // app installed before this operation existed refuses for a reason no
    // agent can guess. Name the fix, as uploadFile does for files:write.
    if (/missing_scope/.test(String(err))) {
      throw new Error(
        "Pier's Slack app cannot read files — add the files:read scope to the Slack app " +
          "under OAuth & Permissions and reinstall it",
      );
    }
    throw new Error(explain(err));
  }
  // The shared save loop owns the size gate, the marker and the lost-marker
  // wording (core/inbox.ts), so a file over the cap or a refused download
  // answers in the words every other inbound failure uses — never a stack, and
  // never an empty reply.
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

/**
 * Walk the cursor until it ends or the caps bite.
 *
 * A page that fails mid-walk does not throw away the pages before it: an
 * agent that asked for a day of history and got an exception cannot tell a
 * broken read from a quiet channel. It gets what there was, plus why the walk
 * stopped, and decides for itself whether to retry or work with it.
 */
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

/**
 * Slack's error codes are not instructions. Turn the ones an agent can act on
 * into the action; anything else keeps its raw code, which is at least
 * searchable.
 */
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

/**
 * Oldest first, one message per ts. Slack answers newest-first and its page
 * bounds are inclusive-ish, so a paged read can repeat the message on the
 * seam; the SQL `PRIMARY KEY` used to absorb that.
 */
function transcript(messages: SlackMessageEvent[]): SlackMessageEvent[] {
  const byTs = new Map<string, SlackMessageEvent>();
  for (const msg of messages) if (msg.ts) byTs.set(msg.ts, msg);
  return [...byTs.values()].sort((a, b) => tsToNumber(a.ts!) - tsToNumber(b.ts!));
}

/**
 * One line per message instead of one object per message. Four hundred
 * six-key objects spend most of their tokens on the key names; the same
 * transcript as lines costs a fraction, and a model reads it more easily than
 * it reads JSON. The shape is declared in the reply's `format` so nothing has
 * to be guessed.
 *
 * The name makes it readable, the id is the only thing `<@…>` can be built
 * from, and Slack's own `ts` string is passed through untouched — it is what
 * a reply, a reaction or `after` has to match exactly.
 *
 * The two suffixes are what a message *has* rather than what it said, so they
 * are declared here and appended only when there is one: a message with
 * neither reads exactly as it always did. Kept terse — the adapter puts this
 * string in a prompt (`slack.ts`, an inlined shared thread), so every word is
 * paid for per read.
 */
const LINE_FORMAT =
  "<ts> | <time, UTC> | <name>[<id>] | <text>, then — when there are any —"
  + " [thread: <n> replies] and one [file: <name> <F… id> <size>] per upload";

/** Enough to judge a fetch against the 32 MB cap without arithmetic; left out
 *  entirely when Slack sent no size, because a guessed one would be worse. */
const sizeLabel = (bytes: number): string =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/**
 * A message's uploads, named with the one handle that can fetch them. Without
 * this the transcript dropped `files` entirely: a PDF somebody posted read as
 * an empty message, and nothing said there was anything to open.
 */
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
  // Names come from the directory the adapter also uses, so re-reading a
  // thread costs no lookups; the store is not consulted because a member need
  // not be bound to have spoken.
  const ids = messages.map(speaker).filter((id): id is string => !!id);
  const names = await deps.directory.names(client, ids);
  return messages.map((msg) => {
    const id = speaker(msg);
    const known = id ? names.get(id) : undefined;
    const who = id ? (known && known !== id ? `${known}[${id}]` : `[${id}]`) : "[unknown]";
    // A parent's reply count, so the agent can decide whether the thread is
    // worth opening instead of spending a read to find out.
    const replies = msg.reply_count && (msg.thread_ts ?? msg.ts) === msg.ts
      ? ` [thread: ${msg.reply_count} replies]`
      : "";
    return `${msg.ts} | ${tsToMinute(msg.ts!)} | ${who} | ${msg.text ?? ""}${replies}${
      uploads(msg.files)
    }`;
  });
}
