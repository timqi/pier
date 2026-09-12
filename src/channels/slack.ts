// Slack adapter: normalize inbound Socket Mode envelopes, render outbound turns.
// Pier never posts into a channel's main flow: a conversation is
// `<channel>/<threadTs>` and the thread is the session. Slack-specific: the
// client intercepts unregistered slash commands, so `stop` and `settings` are
// bare words; reactions are short names (`reactions.add` rejects 👀 with
// `invalid_name`); unacked envelopes are redelivered, so `event_id` is deduplicated.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  InboundMessage,
  NoteOrigin,
} from "../core/types.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { awaitsTurn } from "../core/reply.js";
import { bindHint, bindResult, picked, STALE_OPTION, STOPPED } from "./lines.js";
import { logger } from "../log.js";
import { Chains } from "./chains.js";
import { parseCommand } from "./commands.js";
import { Dedup } from "./dedup.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { Gatekeeper } from "./gatekeeper.js";
import { ReceiptLedger, Receipts } from "./receipts.js";
import { SlackDirectory } from "./slack-directory.js";
import {
  SlackApi,
  type SlackAttachment,
  type SlackBlock,
  type SlackClient,
  type SlackEnvelope,
  type SlackEventPayload,
  type SlackFile,
  type SlackInteraction,
  type SlackMessageEvent,
  type SlackSocket,
} from "./slack-api.js";
import { SlackOutbound } from "./slack-outbound.js";
import { SlackPanel } from "./slack-panel.js";
import { readThread } from "./slack-thread.js";
import type { HandoffNote } from "./types.js";
import { context, escapeMrkdwn, offeredLabel } from "./slack-render.js";

const WORKING = "eyes";
// The envelope is already acked, so this bounds concurrency (sockets,
// downloads), not the backlog.
const MAX_ACTIVE_CHATS = 16;
const RECEIPT_STALE_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
/** Only has to cover a redelivery that crossed our immediate ack. */
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

/** Bare words with exact arity, since there is no leading `/` to key on: "stop
 *  the deploy and tell me why" is a sentence for the agent, not an abort. */
const BARE_COMMANDS = new Map<string, number>([["stop", 0], ["settings", 0], ["bind", 1]]);

/** The only definition of the conversation id format; control.ts decodes with it. */
const conversationId = (channel: string, threadTs: string): string => `${channel}/${threadTs}`;

export const parseConversation = (id: string): { channel: string; threadTs: string } => {
  const at = id.indexOf("/");
  return at < 0
    ? { channel: id, threadTs: "" }
    : { channel: id.slice(0, at), threadTs: id.slice(at + 1) };
};

/** A message posted in the channel becomes the root of its own thread. */
const threadOf = (event: SlackMessageEvent): string => event.thread_ts ?? event.ts ?? "";

/** Everything else (joins, edits, topic changes, `bot_message`) is noise; a
 *  forward is a person handing the agent something to look at. */
const READABLE_SUBTYPES = new Set(["file_share", "thread_broadcast", "message_share"]);

/** `is_share` is the flag proper, and a `message_share` may arrive without it.
 *  `is_msg_unfurl` alone is Slack previewing a pasted permalink, which the
 *  sender did not choose to forward; a real share carries both flags. */
const sharesOf = (event: SlackMessageEvent): SlackAttachment[] =>
  (event.attachments ?? []).filter((a) =>
    a.is_share === true || (event.subtype === "message_share" && !a.is_msg_unfurl));

const sharedFiles = (share: SlackAttachment): SlackFile[] =>
  share.files ?? share.original_message?.files ?? [];

/** A token budget, not a Slack limit: past this the agent gets the
 *  coordinates and decides for itself. */
const INLINE_REPLY_MAX = 30;

interface SlackCommand {
  name: string;
  args: string;
}

/** `/stop` is accepted for muscle memory; a bare `stop` is what actually arrives. */
function slackCommand(text: string): SlackCommand | undefined {
  const slash = parseCommand(text);
  if (slash) return { name: slash.name, args: slash.args };
  const words = text.trim().split(/\s+/).filter(Boolean);
  const name = words[0]?.toLowerCase() ?? "";
  const arity = BARE_COMMANDS.get(name);
  if (arity === undefined || words.length - 1 !== arity) return undefined;
  return { name, args: words.slice(1).join(" ") };
}

export interface SlackDeps {
  store: ChannelStore;
  /** Dropped and malformed input is reported here — never a silent catch. */
  log?: (message: string) => void;
  /** Injected in tests. */
  client?: SlackClient;
  /** Injected in tests. */
  receipts?: ReceiptLedger;
  /** Wired by runtime.ts, so `stop` and the panel never enter the Channel seam. */
  control?: ChannelControl;
}

export class SlackChannel implements Channel {
  readonly id = "slack";
  private readonly api: SlackClient;
  private readonly log: (message: string) => void;
  private readonly receipts: Receipts;
  private readonly chains: Chains;
  private readonly gate: Gatekeeper;
  private readonly seen: Dedup;
  /** Absent when no control was wired (tests). */
  private readonly panel?: SlackPanel;
  private readonly directory: SlackDirectory;
  /** The message event carries no channel name, so discovery costs an API call
   *  — once per channel per process. */
  private readonly discovered = new Set<string>();
  private me = "";
  private mention?: { leading: RegExp; any: RegExp };
  private readonly out: SlackOutbound;
  private socket?: SlackSocket;
  private running = false;

  constructor(private readonly deps: SlackDeps) {
    const config = deps.store.get("slack");
    this.log = deps.log ?? ((m) => logger("slack").warn(m));
    this.chains = new Chains(this.log, MAX_ACTIVE_CHATS);
    this.directory = new SlackDirectory(this.log);
    this.gate = new Gatekeeper(deps.store, "slack", this.log, "channel");
    this.seen = new Dedup(this.log, DEDUP_TTL_MS, DEDUP_MAX);
    this.api = deps.client ?? new SlackApi(config.token, config.appToken, this.log);
    this.out = new SlackOutbound(this.api, this.log);
    this.receipts = new Receipts(
      // The clear needs the reaction's name back.
      {
        setReaction: (channel, ts, emoji) =>
          emoji
            ? this.api.addReaction(channel, ts, emoji)
            : this.api.removeReaction(channel, ts, WORKING),
      },
      deps.receipts ?? new ReceiptLedger("slack"),
      this.log,
      WORKING,
      RECEIPT_STALE_MS,
    );
    if (deps.control) {
      this.panel = new SlackPanel({
        api: this.api,
        control: deps.control,
        store: deps.store,
        log: this.log,
      });
    }
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    const auth = await this.api.authTest();
    this.me = auth.userId;
    if (this.me) {
      // A Slack user id is `[A-Z0-9]+`, so it needs no escaping.
      this.mention = {
        leading: new RegExp(`^\\s*<@${this.me}>[\\s,:-]*`),
        any: new RegExp(`<@${this.me}>`, "g"),
      };
    } else {
      // Every channel with require-mention on goes silent; loud, not a debug line.
      this.log("auth.test returned no user id: mention detection is disabled");
    }
    this.running = true;
    void this.receipts.sweep(true);
    this.socket = await this.api.connect((env) => this.onEnvelope(env, onMessage));
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.socket?.close().catch((err: unknown) =>
      this.log(`slack socket did not close cleanly: ${String(err)}`));
    this.socket = undefined;
    await this.chains.drain(DRAIN_TIMEOUT_MS);
  }

  // --- inbound ---------------------------------------------------------------

  /** Routing is synchronous so ordering is decided before any await. */
  private onEnvelope(env: SlackEnvelope, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
    void this.receipts.sweep();
    if (env.type === "events_api") {
      const payload = env.payload as SlackEventPayload | undefined;
      const event = payload?.event;
      if (!event) return;
      // `app_mention` duplicates a `message.channels` under its own event_id.
      if (event.type !== "message") {
        this.log(`ignored event type ${event.type}`);
        return;
      }
      if (this.seen.duplicate(payload?.event_id)) return;
      const channel = event.channel;
      if (!channel) return this.log("message event without a channel, dropped");
      this.chains.run(channel, () => this.onMessage(event, onMessage));
      return;
    }
    if (env.type === "interactive") {
      const interaction = env.payload as SlackInteraction | undefined;
      if (!interaction) return;
      // A modal submission carries its conversation in private_metadata.
      const channel = interaction.channel?.id ?? "modal";
      this.chains.run(channel, () => this.onInteraction(interaction, onMessage));
      return;
    }
    this.log(`ignored envelope type ${env.type}`);
  }

  private async onMessage(
    event: SlackMessageEvent,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    if (event.bot_id || !event.user || event.user === this.me) return;
    if (event.subtype && !READABLE_SUBTYPES.has(event.subtype)) {
      this.log(`ignored message subtype ${event.subtype}`);
      return;
    }
    const channel = event.channel!;
    const ts = event.ts;
    if (!ts) return this.log("message event without a ts, dropped");
    const raw = (event.text ?? "").trim();
    const shares = sharesOf(event);
    const files = [...(event.files ?? []), ...shares.flatMap(sharedFiles)];
    if (!raw && !files.length && !shares.length) {
      // An opted-in subtype with nothing readable is a shape this adapter did
      // not recognize, not an empty message (§5).
      if (event.subtype) this.log(`${event.subtype} with nothing readable in it, dropped`);
      return;
    }

    const { kind } = await this.directory.channel(this.api, channel, event);
    const isDm = kind === "dm";
    if (!this.discovered.has(channel) && this.gate.mayDiscover({ isDm, userId: event.user })) {
      this.discovered.add(channel);
      const name = await this.nameOf(channel, event);
      this.deps.store.discoverChat("slack", { id: channel, name, kind });
    }

    const text = this.stripMention(raw);
    const command = slackCommand(text);
    const threadTs = threadOf(event);
    const here: ConversationKey = { channelId: this.id, conversationId: conversationId(channel, threadTs) };
    const bindRequest = command?.name === "bind" && isDm;
    const admitted = this.gate.admit("message", channel, {
      isDm,
      addressed: this.addressed(raw, event, here),
      userId: event.user,
      bindRequest,
    });
    if (!admitted) {
      if (isDm) await this.hintBind(channel, event.user, threadTs);
      return;
    }
    if (bindRequest) return this.bind(channel, event.user, threadTs, command?.args ?? "");
    if (command?.name === "stop") return this.abortTurn(here, channel, threadTs);
    // A bare `@bot` and `settings` are the same request.
    if (this.panel && (command?.name === "settings" || (!text && !files.length && !shares.length))) {
      return this.panel.open(here, channel, threadTs);
    }

    // Downloading only past the gate: an unauthorized sender must not make the
    // bot pull bytes on their behalf.
    const markers = await this.saveAttachments(files);
    const shared = await Promise.all(shares.map((share) => this.sharedBlock(share)));
    // Resolved before the mark: any await between mark() and dispatch is a
    // window in which a previous turn can settle and take this receipt with it.
    const sender = { id: event.user, name: await this.directory.user(this.api, event.user) };
    this.receipts.mark(here.conversationId, channel, ts);
    // Steer: a follow-up is the wrong default when the human is watching a 👀.
    onMessage({
      key: here,
      senderId: event.user,
      sender,
      // Markers last: the inbound-file convention is a trailing block.
      text: [text, ...shared, ...markers].filter(Boolean).join("\n"),
      mode: "steer",
    });
  }

  // --- interactions ----------------------------------------------------------

  private async onInteraction(
    interaction: SlackInteraction,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    if (interaction.type === "view_submission") {
      if (!(await this.panel?.onViewSubmission(interaction))) {
        this.log(`unhandled view submission ${interaction.view?.callback_id ?? "?"}`);
      }
      return;
    }
    if (interaction.type !== "block_actions") {
      this.log(`ignored interaction type ${interaction.type}`);
      return;
    }
    const channel = interaction.channel?.id;
    const message = interaction.message;
    const actionId = interaction.actions?.[0]?.action_id;
    const user = interaction.user?.id;
    if (!channel || !message || !actionId || !user) {
      this.log("incomplete block_actions payload, dropped");
      return;
    }
    const threadTs = message.thread_ts ?? message.ts;
    const key: ConversationKey = {
      channelId: this.id,
      conversationId: conversationId(channel, threadTs),
    };
    const admitted = this.gate.admit("action", channel, {
      isDm: (await this.directory.channel(this.api, channel)).kind === "dm",
      addressed: true, // clicking the bot's own button is addressing it
      userId: user,
    });
    if (!admitted) return;
    if (await this.panel?.onAction(interaction, key, actionId)) return;

    const text = offeredLabel(message.blocks, actionId);
    if (text === undefined) {
      // The person clicked and would otherwise see nothing happen (§5).
      this.log(`unknown action ${actionId} in channel ${channel}`);
      await this.api.postMessage({ channel, thread_ts: threadTs, text: STALE_OPTION })
        .catch((err) => this.log(`stale-option notice failed: ${String(err)}`));
      return;
    }
    await this.retireOptions(channel, message.ts, message.blocks);
    // A bot cannot post as the user, so the pick is echoed: otherwise the
    // thread shows an answer to a request nobody can see, with nothing to carry the eyes.
    const sender = { id: user, name: await this.directory.user(this.api, user) };
    const echo = await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: picked(escapeMrkdwn(text)),
    }).catch((err) => {
      this.log(`option echo failed: ${String(err)}`);
      return undefined;
    });
    // No await between mark and dispatch — see onMessage.
    if (echo?.ts) this.receipts.mark(key.conversationId, channel, echo.ts);
    onMessage({ key, senderId: user, sender, text, mode: "steer" });
  }

  /** Slack will not accept a message with neither text nor blocks, so a turn
   *  that was nothing but its options becomes a muted line. */
  private async retireOptions(
    channel: string,
    ts: string,
    blocks: SlackBlock[] | undefined,
  ): Promise<void> {
    const kept = (blocks ?? []).filter((b) => b.type !== "actions");
    const fallback = kept.find((b) => b.type === "section")?.text.text;
    await this.api.setBlocks(
      channel,
      ts,
      fallback ?? "Option taken.",
      kept.length ? kept : [context("_Option taken._")],
    ).catch((err) => this.log(`retiring options failed: ${String(err)}`));
  }

  /** The abort ends the turn, which reaches send() and clears the receipts. */
  private async abortTurn(key: ConversationKey, channel: string, threadTs: string): Promise<void> {
    await this.deps.control?.abort(key);
    await this.api.postMessage({ channel, thread_ts: threadTs, text: STOPPED });
  }

  // --- bind ------------------------------------------------------------------

  /** Channels stay silent, but a DM that swallows every message looks broken
   *  rather than locked. */
  private async hintBind(channel: string, userId: string, threadTs: string): Promise<void> {
    if (!this.gate.mayHint(userId)) return;
    await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: bindHint("`bind <code>`"),
    }).catch((err) => this.log(`bind hint failed: ${String(err)}`));
  }

  private async bind(
    channel: string,
    userId: string,
    threadTs: string,
    code: string,
  ): Promise<void> {
    const name = await this.directory.user(this.api, userId);
    const outcome = this.deps.store.redeemBindCode("slack", code, { id: userId, name });
    await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: bindResult(outcome, escapeMrkdwn(name)),
    });
  }

  // --- addressing ------------------------------------------------------------

  /** Mentioned, or continuing a thread Pier already owns — durable, so it
   *  holds after a restart. */
  private addressed(raw: string, event: SlackMessageEvent, key: ConversationKey): boolean {
    if (this.me && raw.includes(`<@${this.me}>`)) return true;
    return !!event.thread_ts && !!this.deps.control?.knows(key);
  }

  /** Slack does not strip the mention for us. */
  private stripMention(text: string): string {
    if (!this.mention) return text;
    return text.replace(this.mention.leading, "").replace(this.mention.any, "").trim();
  }

  // --- lookups ---------------------------------------------------------------

  private async nameOf(channel: string, event: SlackMessageEvent): Promise<string> {
    const { kind, name } = await this.directory.channel(this.api, channel, event);
    if (kind === "dm") {
      return event.user ? `DM · ${await this.directory.user(this.api, event.user)}` : channel;
    }
    return name ?? channel;
  }

  /** The eager thread read is not gated: a human handing the agent a message
   *  is the same act as an upload. */
  private async sharedBlock(share: SlackAttachment): Promise<string> {
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
      ? `${await this.directory.user(this.api, share.author_id)}<${share.author_id}>`
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
      ? await this.sharedThread(parent.channel, parent.ts, parent.replies)
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
  private async sharedThread(
    channel: string,
    ts: string,
    replies: number,
  ): Promise<{ transcript: boolean; lines: string[] }> {
    try {
      // One over the budget, so an undercounting reply_count still reports as cut.
      const read = await readThread(this.directory, this.api, channel, ts, INLINE_REPLY_MAX + 2);
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
      this.log(`shared thread ${channel}/${ts} not read: ${String(err)}`);
      return {
        transcript: false,
        lines: [`[thread not read: ${err instanceof Error ? err.message : String(err)}]`],
      };
    }
  }

  private saveAttachments(files: SlackFile[]): Promise<string[]> {
    return saveInboundAll(this.id, files.map((file) => ({
      label: file.name ?? "attachment",
      name: file.name,
      mimeType: file.mimetype ?? "application/octet-stream",
      size: file.size,
      // The response's content-type wins: Slack's metadata is a guess.
      fetch: async () => this.api.downloadFile(file, MAX_INBOUND_BYTES),
    })), this.log);
  }

  // --- outbound --------------------------------------------------------------

  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { channel, threadTs } = parseConversation(conversation);
    // No thread is a foreign id; posting it would put a turn in the channel's
    // main flow. Refused loudly, receipts still cleared.
    if (!threadTs) {
      this.log(`refusing to answer ${conversation}: no thread in the conversation id`);
      await this.receipts.settle(conversation);
      return;
    }
    // The turn ended either way; a 👀 left up by a failed send looks like work.
    await this.receipts.settleAfter(
      conversation,
      () => this.out.reply(channel, threadTs, reply),
      reply.meta,
    );
  }

  /** A web session's thread: the root is the one message Pier posts into a
   *  channel's main flow (channels/handoff.ts). */
  async openThread(chatId: string, note: HandoffNote): Promise<string> {
    return conversationId(chatId, await this.out.open(chatId, note));
  }

  /** The 👀 goes on the note itself: the turn it triggers has no message of
   *  the user's to carry them. */
  async notify(
    conversation: string,
    note: { text: string; origin: NoteOrigin },
  ): Promise<void> {
    const { channel, threadTs } = parseConversation(conversation);
    if (!threadTs) {
      this.log(`refusing to post a system note to ${conversation}: no thread in the conversation id`);
      return;
    }
    const ts = await this.out.note(channel, threadTs, note);
    if (ts && awaitsTurn(note.origin)) this.receipts.mark(conversation, channel, ts);
  }
}

