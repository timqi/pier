// Slack adapter: normalize inbound Socket Mode envelopes, render outbound turns.
// Pier never posts into a channel's main flow but the home DM's
// (docs/design/11-im-conversation.md), which is one conversation keyed `<channel>`:
// any other is `<channel>/<threadTs>` and the thread is the session. Slack-specific: the
// client intercepts unregistered slash commands, so `%stop` is the spelling
// that arrives; reactions are short names (`reactions.add` rejects 👀 with
// `invalid_name`); unacked envelopes are redelivered, so `event_id` is deduplicated.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  InboundMessage,
  NoteOrigin,
  OpenItemsView,
} from "../core/types.js";
import { isChatCommand } from "../core/types.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { skillsText } from "../core/chain.js";
import { withQuote } from "../core/identity.js";
import { awaitsTurn, isSilentReply, shownByStatus } from "../core/reply.js";
import { bindHint, bindResult, picked, STALE_OPTION, STOPPED } from "./lines.js";
import { logger } from "../log.js";
import { Chains } from "./chains.js";
import { parseCommand, settingsDraft } from "./commands.js";
import { Dedup } from "./dedup.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { Gatekeeper } from "./gatekeeper.js";
import { ReceiptLedger, Receipts } from "./receipts.js";
import { StatusMessage } from "./status.js";
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
import { sharedBlock } from "./slack-thread.js";
import { context, escapeMrkdwn, offeredLabel, statusMessage } from "./slack-render.js";

const REACTION = "eyes";
// The envelope is already acked, so this bounds concurrency (sockets,
// downloads), not the backlog.
const MAX_ACTIVE_CHATS = 16;
/** Only an idle conversation ages out, so this need not cover a long turn. */
const RECEIPT_STALE_MS = 10 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
/** Only has to cover a redelivery that crossed our immediate ack. */
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

/** The only definition of the conversation id format; control.ts decodes with it. */
const conversationId = (channel: string, threadTs: string): string => `${channel}/${threadTs}`;

const parseConversation = (id: string): { channel: string; threadTs: string } => {
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

interface SlackDeps {
  store: ChannelStore;
  /** Dropped and malformed input is reported here — never a silent catch. */
  log?: (message: string) => void;
  /** Injected in tests. */
  client?: SlackClient;
  /** Injected in tests. */
  receipts?: ReceiptLedger;
  /** Wired by runtime.ts, so `%stop` and the panel never enter the Channel seam. */
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
  private readonly statusLine: StatusMessage<{ text: string; blocks: SlackBlock[] }>;
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
    const ledger = deps.receipts ?? new ReceiptLedger("slack");
    this.receipts = new Receipts(
      this.api,
      ledger,
      this.log,
      REACTION,
      RECEIPT_STALE_MS,
      (conversationId) => deps.control?.working({ channelId: this.id, conversationId }) ?? false,
      (chatId) => this.isHome(chatId),
    );
    this.statusLine = new StatusMessage("slack", ledger.db, {
      post: async (channel, body) => (await this.api.postMessage({ channel, ...body })).ts,
      edit: (channel, ts, body) => this.api.updateMessage({ channel, ts, ...body }),
      delete: (channel, ts) => this.api.deleteMessage(channel, ts),
    }, this.log, statusMessage);
    if (deps.control) {
      this.panel = new SlackPanel({ api: this.api, control: deps.control, log: this.log });
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
    const dropped = this.deps.control?.claimBot("slack", this.me) ?? [];
    if (dropped.length) this.log(`bot is now ${this.me}: forgot ${dropped.length} DM(s) the previous bot opened`);
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
    const command = parseCommand(text);
    const threadTs = threadOf(event);
    // The home DM is the head's, in a thread or not, under one key — except a
    // child's thread (docs/design/11 §Child threads), which is that session's.
    const home = this.isHead(channel, event.thread_ts);
    const here: ConversationKey = { channelId: this.id, conversationId: home ? channel : conversationId(channel, threadTs) };
    const bindRequest = command?.name === "bind" && isDm;
    const admitted = this.gate.admit("message", channel, {
      isDm,
      addressed: this.addressed(raw, event, here, home),
      userId: event.user,
      bindRequest,
    });
    if (!admitted) {
      if (isDm) await this.hintBind(channel, event.user, threadTs);
      return;
    }
    if (bindRequest) return this.bind(channel, event.user, threadTs, command?.args ?? "");
    // The head has no panel and takes `/stop` and `/skills` as chat commands (core/chain.ts).
    if (!home && command?.name === "stop") return this.abortTurn(here, channel, threadTs);
    if (!home && command?.name === "skills") return this.listSkills(here);
    if (!text && !files.length && !shares.length) return this.log(`empty message in ${here.conversationId}, dropped`);
    // Downloading only past the gate: an unauthorized sender must not make the
    // bot pull bytes on their behalf.
    const markers = await this.saveAttachments(files);
    const shared = await Promise.all(shares.map((share) => sharedBlock(this.directory, this.api, this.log, share)));
    // `/s <text>` drafts a session, so only where this message would start one:
    // a thread root. The held question carries its markers, so Start sends what the user sent.
    const question = threadTs === ts ? settingsDraft(text) : undefined;
    if (this.panel && !home && (question || command?.name === "settings")) {
      return this.panel.open(here, channel, threadTs, question && [question, ...shared, ...markers].join("\n"));
    }

    // Resolved before the mark: any await between mark() and dispatch is a
    // window in which a previous turn can settle and take this receipt with it.
    const sender = { id: event.user, name: await this.directory.user(this.api, event.user) };
    // The head answers a chat command with a note, not a turn: nothing would settle its receipt.
    const answered = home && command && !command.args && isChatCommand(command.name);
    if (!answered) this.receipts.mark(here.conversationId, channel, ts);
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
    // Any click in the home DM is the head's, echoed where the button was,
    // unless a child's thread; anywhere else a top-level message roots a thread.
    const home = this.isHead(channel, message.thread_ts);
    const threadTs = home ? message.thread_ts : message.thread_ts ?? message.ts;
    const key: ConversationKey = {
      channelId: this.id,
      conversationId: home ? channel : conversationId(channel, message.thread_ts ?? message.ts),
    };
    const admitted = this.gate.admit("action", channel, {
      isDm: (await this.directory.channel(this.api, channel)).kind === "dm",
      addressed: true, // clicking the bot's own button is addressing it
      userId: user,
    });
    if (!admitted) return;
    // Start's question: the card is the message the click was on, so it carries the 👀.
    const run = (text: string): Promise<void> => this.deliver(key, channel, message.ts, user, text, onMessage);
    // The head has no panel: a card left in the DM before it became the home is stale.
    if (!home && (await this.panel?.onAction(interaction, key, actionId, run))) return;

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
    const echo = await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: picked(escapeMrkdwn(text)),
    }).catch((err) => {
      this.log(`option echo failed: ${String(err)}`);
      return undefined;
    });
    // A pick is a reply to the message that offered it, as on the web. `text`,
    // not the blocks: Slack may store a `markdown` block as other block types.
    const at = Number(message.ts) * 1000;
    const said = message.text?.trim().replace(/^…$/, "") ?? "";
    if (!said || !(at > 0)) this.log(`option message ${message.ts} has no text to quote, pick sent unquoted`);
    const quoted = said && at > 0 ? withQuote({ role: "assistant", at, text: said }, text) : text;
    await this.deliver(key, channel, echo?.ts, user, quoted, onMessage);
  }

  /** A click's text as the clicker's message; `ts` is the message that carries the 👀. */
  private async deliver(
    key: ConversationKey,
    channel: string,
    ts: string | undefined,
    user: string,
    text: string,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    const sender = { id: user, name: await this.directory.user(this.api, user) };
    // No await between mark and dispatch — see onMessage.
    if (ts) this.receipts.mark(key.conversationId, channel, ts);
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

  /** The head's `/skills` is MainChain's; a thread has no chain, so it is answered here. */
  private async listSkills(key: ConversationKey): Promise<void> {
    const text = skillsText((await this.deps.control?.skills(key)) ?? []);
    await this.notify(key.conversationId, { text, origin: { kind: "chat-command", command: "skills" } });
  }

  // --- bind ------------------------------------------------------------------

  /** Channels stay silent, but a DM that swallows every message looks broken
   *  rather than locked. */
  private async hintBind(channel: string, userId: string, threadTs: string): Promise<void> {
    if (!this.gate.mayHint(userId)) return;
    await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: bindHint("`%bind <code>`"),
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
   *  holds after a restart. The home key has no row to know. */
  private addressed(raw: string, event: SlackMessageEvent, key: ConversationKey, home: boolean): boolean {
    if (this.me && raw.includes(`<@${this.me}>`)) return true;
    return !home && !!event.thread_ts && !!this.deps.control?.knows(key);
  }

  private isHome(channel: string): boolean {
    return this.deps.control?.isHome({ channelId: this.id, conversationId: channel }) ?? false;
  }

  /** The head's: the home DM, outside any thread a session of its own is bound to. */
  private isHead(channel: string, threadTs: string | undefined): boolean {
    return this.isHome(channel) &&
      !(threadTs && this.deps.control?.knows({ channelId: this.id, conversationId: conversationId(channel, threadTs) }));
  }

  /** A thread, or the home DM's main flow (no `threadTs`); undefined for any other channel's. */
  private target(conversation: string): { channel: string; threadTs?: string } | undefined {
    const { channel, threadTs } = parseConversation(conversation);
    if (threadTs) return { channel, threadTs };
    return this.isHome(channel) ? { channel } : undefined;
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
    const to = this.target(conversation);
    // No thread outside the home DM is a foreign id; posting it would put a
    // turn in the channel's main flow. Refused loudly, receipts still cleared.
    if (!to) {
      this.log(`refusing to answer ${conversation}: no thread in the conversation id`);
      await this.receipts.settle(conversation);
      return;
    }
    const main = !to.threadTs;
    // The turn ended either way; a 👀 left up by a failed send looks like work.
    await this.receipts.settleAfter(conversation, async (settles) => {
      // The home's quiet turn says so only when it settled a message of the user's.
      if (main && isSilentReply(reply) && !settles) return;
      await this.out.reply(to.channel, to.threadTs, reply);
    }, reply.meta);
  }

  /** The receipt goes on the note itself: the turn it triggers has no message
   *  of the user's to carry it. */
  async notify(
    conversation: string,
    note: { text: string; origin: NoteOrigin; at?: number },
  ): Promise<void> {
    const to = this.target(conversation);
    if (!to) {
      this.log(`refusing to post a system note to ${conversation}: no thread in the conversation id`);
      return;
    }
    // The home's main flow shows task progress in the status message; the web keeps the cards.
    if (!to.threadTs && shownByStatus(note.origin)) {
      return logger("slack").debug(`${note.origin.kind} note not posted to the home main flow ${conversation}`);
    }
    // `/status`'s answer is the status message re-posted, never a copy beside it.
    if (!to.threadTs && note.origin.kind === "chat-command" && note.origin.command === "status" && (await this.statusLine.answer(to.channel, note.text, note.origin.statusSnapshot))) return;
    const ts = await this.out.note(to.channel, to.threadTs, note);
    if (ts && awaitsTurn(note.origin)) this.receipts.mark(conversation, to.channel, ts, note.at);
  }

  async openThread(channel: string, note: { text: string; origin: NoteOrigin }): Promise<string> {
    if (!this.isHome(channel)) throw new Error(`refusing to open a thread in ${channel}: not the home DM`);
    const ts = await this.out.note(channel, undefined, note);
    if (!ts) throw new Error(`Slack returned no ts for the root in ${channel}`);
    return conversationId(channel, ts);
  }

  async status(channel: string, view: OpenItemsView): Promise<void> {
    if (!this.isHome(channel)) throw new Error(`refusing a status message in ${channel}: not the home DM`);
    await this.statusLine.show(channel, view);
  }

  async editRoot(conversation: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const { channel, threadTs } = parseConversation(conversation);
    if (!threadTs) throw new Error(`refusing to edit ${conversation}: no thread in the conversation id`);
    await this.out.edit(channel, threadTs, note);
  }
}

