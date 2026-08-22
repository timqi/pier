// Slack adapter: normalize inbound Socket Mode envelopes, render outbound turns.
//
// The anchor is threads. Pier never posts into a channel's main flow: a message
// in the channel is answered in *its own* thread, a message in a thread is
// answered in that thread. So a conversation is `<channel>/<threadTs>` and the
// thread is the session — which makes Telegram's `topicMode` toggle meaningless
// here, because there is no other behaviour to switch to. Threads cost no admin
// right and no group conversion on Slack, so the feature Telegram has to
// negotiate for is simply how this adapter always works.
//
// Three more things are Slack-specific and live only here:
//  - Commands cannot start with `/`. The Slack client intercepts an
//    unregistered slash command and never sends it to an app, so `stop` and
//    `settings` are bare words instead. Registering real slash commands is
//    deliberately not a feature: it needs manifest setup to add a second way to
//    do what a word in the thread already does, and Slack only sends `thread_ts`
//    for a command typed *inside* a thread, so it would be the weaker path too.
//  - Reactions are short names (`eyes`), not codepoints; `reactions.add`
//    rejects 👀 with `invalid_name`.
//  - Slack redelivers anything it did not see acknowledged, so `event_id` is
//    deduplicated.
//
// Everything policy-shaped (mention/bind gates, per-chat overrides) is in
// config.ts, platform-blind and shared with Telegram.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  ImageAttachment,
  InboundMessage,
  SystemInputOrigin,
} from "../core/types.js";
import { Chains } from "./chains.js";
import { parseCommand } from "./commands.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { Gatekeeper } from "./gatekeeper.js";
import { ReceiptLedger, Receipts } from "./receipts.js";
import { SlackDirectory } from "./slack-directory.js";
import {
  SlackApi,
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
import { context, escapeMrkdwn, offeredLabel } from "./slack-render.js";

/** Slack wants a short name here; the raw codepoint is an `invalid_name`. */
const WORKING = "eyes";
// Backpressure: how many channels may be handled at once before a new one
// queues behind an existing chain. Unlike Telegram's poll loop this cannot
// slow the source down — the envelope is already acked — so it bounds
// concurrency (open sockets, downloads) rather than the backlog itself.
const MAX_ACTIVE_CHATS = 16;
const RECEIPT_STALE_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
/**
 * How long a delivered `event_id` is remembered. Slack retries an unacked
 * envelope for a few minutes; we ack immediately, so this only has to cover
 * a redelivery that crossed our ack.
 */
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;
/** How often the straggler sweep may run; see onEnvelope. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Commands that may appear as a bare word, and exactly how many arguments each
 * takes. Both halves are load-bearing, because Slack gives us no leading `/` to
 * key on: a closed set keeps ordinary prose from being a command, and the
 * exact arity keeps "settings are broken, please help" from opening the panel
 * (or worse, "stop the deploy and tell me why" from aborting the turn that was
 * about to explain). Anything longer is a sentence, and goes to the agent.
 */
const BARE_COMMANDS = new Map<string, number>([["stop", 0], ["settings", 0], ["bind", 1]]);

/**
 * A Slack conversation is always `<channel>/<threadTs>` — the thread is the
 * session. This pair is the only definition of the format; control.ts decodes
 * with it rather than splitting on "/" itself.
 */
const conversationId = (channel: string, threadTs: string): string => `${channel}/${threadTs}`;

export const parseConversation = (id: string): { channel: string; threadTs: string } => {
  const at = id.indexOf("/");
  return at < 0
    ? { channel: id, threadTs: "" }
    : { channel: id.slice(0, at), threadTs: id.slice(at + 1) };
};

/**
 * The thread a message belongs to. A message already in a thread keeps it; one
 * posted in the channel becomes the root of its own — which is what makes
 * every request its own session without asking Slack for anything.
 */
const threadOf = (event: SlackMessageEvent): string => event.thread_ts ?? event.ts ?? "";

/**
 * Subtypes worth reading. Everything else (joins, edits, deletions, topic
 * changes) is noise, and `bot_message` is either our own echo or another app's.
 */
const READABLE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

interface SlackCommand {
  name: string;
  args: string;
}

/**
 * What the user asked for, from text a mention has already been stripped from.
 * `/stop` is accepted for muscle memory even though Slack rarely lets one
 * through; a bare `stop` is the form that actually arrives.
 */
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
  /** Injected in tests; production builds a real Slack client. */
  client?: SlackClient;
  /** Injected in tests; production opens the shared channel database. */
  receipts?: ReceiptLedger;
  /** Shared with the agent-facing tool so a name is looked up once per process. */
  directory?: SlackDirectory;
  /**
   * Channel-level control that is not a prompt. Wired by runtime.ts, which
   * owns the router — so `stop` and the settings panel never become part of
   * the Channel seam.
   */
  control?: ChannelControl;
}

export class SlackChannel implements Channel {
  readonly id = "slack";
  private readonly api: SlackClient;
  private readonly log: (message: string) => void;
  /** 👀 lifecycle, durable; see receipts.ts for why it is not just a Map. */
  private readonly receipts: Receipts;
  /** Ordering per channel, concurrency across them; see chains.ts. */
  private readonly chains: Chains;
  /** The inbound gate and the bind-hint throttle; see gatekeeper.ts. */
  private readonly gate: Gatekeeper;
  /** `event_id`s already handled, against Slack's at-least-once delivery. */
  private readonly seen = new Map<string, number>();
  /** The in-chat settings panel; absent when no control was wired (tests). */
  private readonly panel?: SlackPanel;
  /** Channel kinds/names and user names, cached; see slack-directory.ts. */
  private readonly directory: SlackDirectory;
  /**
   * Channels already reported to the store this process. Slack's message event
   * carries no channel name, so discovery costs an API call — once per channel
   * per process rather than once per message. A rename is picked up on restart,
   * which is soon enough for a Console display label.
   */
  private readonly discovered = new Set<string>();
  private me = "";
  /** Precompiled from `me`: a leading mention, and any mention. */
  private mention?: { leading: RegExp; any: RegExp };
  private readonly out: SlackOutbound;
  private socket?: SlackSocket;
  private running = false;
  private sweptAt = 0;

  constructor(private readonly deps: SlackDeps) {
    const config = deps.store.get("slack");
    this.log = deps.log ?? ((m) => console.warn(`slack: ${m}`));
    this.chains = new Chains(this.log, MAX_ACTIVE_CHATS);
    this.directory = deps.directory ?? new SlackDirectory(this.log);
    this.gate = new Gatekeeper(deps.store, "slack", this.log, "channel");
    this.api = deps.client ?? new SlackApi(config.token, config.appToken, this.log);
    this.out = new SlackOutbound(this.api, this.log);
    this.receipts = new Receipts(
      // Slack names its reactions; the clear needs that name back, and Pier
      // only ever applies the one.
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
      // A Slack user id is `[A-Z0-9]+`, so it needs no escaping — but building
      // these once keeps two regex compiles off the per-message path.
      this.mention = {
        leading: new RegExp(`^\\s*<@${this.me}>[\\s,:-]*`),
        any: new RegExp(`<@${this.me}>`, "g"),
      };
    } else {
      // Without our own user id, "was I mentioned?" can only answer no, so
      // every channel with require-mention on goes silent. Loud, not a debug line.
      this.log("auth.test returned no user id: mention detection is disabled");
    }
    this.running = true;
    // Best-effort and off the critical path.
    void this.receipts.sweep(true);
    this.socket = await this.api.connect((env) => this.onEnvelope(env, onMessage));
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.socket?.close().catch(() => {});
    this.socket = undefined;
    await this.chains.drain(DRAIN_TIMEOUT_MS);
  }

  // --- inbound ---------------------------------------------------------------

  /**
   * Already acknowledged by the transport. Routing is synchronous so ordering
   * is decided here, before any await.
   */
  private onEnvelope(env: SlackEnvelope, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
    // Envelopes arrive pushed, not in polled batches, so the sweep is timed
    // rather than per-envelope: a busy channel would otherwise run this query
    // hundreds of times a minute for something that changes every 30.
    if (Date.now() - this.sweptAt > SWEEP_EVERY_MS) {
      this.sweptAt = Date.now();
      void this.receipts.sweep();
    }
    if (env.type === "events_api") {
      const payload = env.payload as SlackEventPayload | undefined;
      const event = payload?.event;
      if (!event) return;
      // `app_mention` duplicates a `message.channels` we already get, and has
      // its own event_id, so dedup cannot save us — it has to be ignored here.
      if (event.type !== "message") {
        this.log(`ignored event type ${event.type}`);
        return;
      }
      if (this.duplicate(payload?.event_id)) return;
      const channel = event.channel;
      if (!channel) return this.log("message event without a channel, dropped");
      this.chains.run(channel, () => this.onMessage(event, onMessage));
      return;
    }
    if (env.type === "interactive") {
      const interaction = env.payload as SlackInteraction | undefined;
      if (!interaction) return;
      // A modal submission carries its conversation in private_metadata, so it
      // is not tied to a channel chain.
      const channel = interaction.channel?.id ?? "modal";
      this.chains.run(channel, () => this.onInteraction(interaction, onMessage));
      return;
    }
    this.log(`ignored envelope type ${env.type}`);
  }

  /**
   * Slack redelivers an envelope it did not see acknowledged, so the same
   * `event_id` can arrive twice. Bounded and time-limited: the map is fed by
   * every message in every channel the bot is in.
   */
  private duplicate(eventId: string | undefined): boolean {
    if (!eventId) return false;
    const now = Date.now();
    if (this.seen.size > DEDUP_MAX) {
      for (const [id, at] of this.seen) {
        if (now - at > DEDUP_TTL_MS) this.seen.delete(id);
      }
    }
    const at = this.seen.get(eventId);
    if (at !== undefined && now - at <= DEDUP_TTL_MS) {
      this.log(`duplicate event ${eventId} ignored`);
      return true;
    }
    this.seen.set(eventId, now);
    return false;
  }

  private async onMessage(
    event: SlackMessageEvent,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    // Our own echo, another app, or a subtype that is not a person talking.
    if (event.bot_id || !event.user || event.user === this.me) return;
    if (event.subtype && !READABLE_SUBTYPES.has(event.subtype)) {
      this.log(`ignored message subtype ${event.subtype}`);
      return;
    }
    const channel = event.channel!;
    const ts = event.ts;
    if (!ts) return this.log("message event without a ts, dropped");
    const raw = (event.text ?? "").trim();
    const files = (event.files ?? []).filter((f) => f.mimetype?.startsWith("image/"));
    if (!raw && !files.length) return;

    const { kind } = await this.directory.channel(this.api, channel, event);
    const isDm = kind === "dm";
    if (!this.discovered.has(channel)) {
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
    // `@bot` on its own (the text is empty once the mention is stripped) and
    // `settings` are the same request: show me this conversation's settings.
    if (this.panel && (command?.name === "settings" || (!text && !files.length))) {
      return this.panel.open(here, channel, threadTs);
    }

    // Downloading only past the gate: an unauthorized sender must not be able
    // to make the bot pull bytes on their behalf.
    const images = await this.images(files);
    this.receipts.mark(here.conversationId, channel, ts);
    // IM messages steer by default: a follow-up that waits for the turn to end
    // is the wrong default when the human is watching a 👀 in a thread.
    onMessage({
      key: here,
      senderId: event.user,
      // A Slack thread is many people talking into one session, so the agent is
      // told who spoke — and the id, which is what a mention needs.
      sender: { id: event.user, name: await this.directory.user(this.api, event.user) },
      text,
      images,
      mode: "steer",
    });
  }

  // --- interactions ----------------------------------------------------------

  private async onInteraction(
    interaction: SlackInteraction,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    // A modal submission carries the conversation in private_metadata and is
    // answered entirely by the panel.
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
    // Panel clicks are namespaced `cfg:` and never reach the agent.
    if (await this.panel?.onAction(interaction, key, actionId)) return;

    const text = offeredLabel(message.blocks, actionId);
    if (text === undefined) {
      this.log(`unknown action ${actionId} in channel ${channel}`);
      return;
    }
    // The options belonged to the turn that just ended; once one is taken the
    // rest answer a question the conversation has moved past (the web drops
    // them for the same reason).
    await this.retireOptions(channel, message.ts, message.blocks);
    // A bot cannot post as the user, so the pick is echoed and marked as one.
    // Without it the thread shows an answer to a request nobody can see being
    // made, and there is no message of the user's to carry the eyes.
    const echo = await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: `\u25b8 ${escapeMrkdwn(text)}`,
    }).catch((err) => {
      this.log(`option echo failed: ${String(err)}`);
      return undefined;
    });
    // The receipt goes on the echo, not on the bot message that held the
    // buttons: the eyes mean "this input is being worked on".
    if (echo?.ts) this.receipts.mark(key.conversationId, channel, echo.ts);
    onMessage({
      key,
      senderId: user,
      sender: { id: user, name: await this.directory.user(this.api, user) },
      text,
      mode: "steer",
    });
  }

  /**
   * Drop the actions row, keeping the reply itself exactly as it was. A turn
   * that was *nothing but* its options leaves nothing to keep, and Slack will
   * not accept a message with neither text nor blocks — so it becomes a muted
   * line rather than staying clickable forever.
   */
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

  /**
   * Stop the turn this conversation is running. The abort makes Pi end the
   * turn, which reaches send() through the normal turn-end path and clears the
   * 👀 receipts — so nothing here touches them.
   */
  private async abortTurn(key: ConversationKey, channel: string, threadTs: string): Promise<void> {
    await this.deps.control?.abort(key);
    await this.api.postMessage({ channel, thread_ts: threadTs, text: "⏹ Stopped." });
  }

  // --- bind ------------------------------------------------------------------

  /**
   * Tell an unbound DM sender what to do. Channels stay silent (see gate()),
   * but a DM that swallows every message looks broken rather than locked.
   */
  private async hintBind(channel: string, userId: string, threadTs: string): Promise<void> {
    if (!this.gate.mayHint(userId)) return;
    await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: "You are not bound yet. Ask the operator for a bind code, then send `bind <code>`.",
    }).catch((err) => this.log(`bind hint failed: ${String(err)}`));
  }

  private async bind(
    channel: string,
    userId: string,
    threadTs: string,
    code: string,
  ): Promise<void> {
    const name = await this.directory.user(this.api, userId);
    const ok = this.deps.store.redeemBindCode("slack", code, { id: userId, name });
    await this.api.postMessage({
      channel,
      thread_ts: threadTs,
      text: ok ? `Bound as ${escapeMrkdwn(name)}.` : "That bind code is invalid or expired.",
    });
  }

  // --- addressing ------------------------------------------------------------

  /**
   * Mentioned, or continuing a thread Pier already owns — Slack's equivalent
   * of Telegram's "replying to the bot". The thread check is what lets a
   * conversation flow without an `@` on every line, and it is durable so it
   * still holds after a restart.
   */
  private addressed(raw: string, event: SlackMessageEvent, key: ConversationKey): boolean {
    if (this.me && raw.includes(`<@${this.me}>`)) return true;
    return !!event.thread_ts && !!this.deps.control?.knows(key);
  }

  /**
   * A leading `<@BOT>` is addressing, not content — the agent should not see
   * it. Slack does not strip it for us, and puts it wherever the user typed it.
   */
  private stripMention(text: string): string {
    if (!this.mention) return text;
    return text.replace(this.mention.leading, "").replace(this.mention.any, "").trim();
  }

  // --- lookups ---------------------------------------------------------------

  /** A readable label for the Console's channel list; the id is the fallback. */
  private async nameOf(channel: string, event: SlackMessageEvent): Promise<string> {
    const { kind, name } = await this.directory.channel(this.api, channel, event);
    if (kind === "dm") {
      return event.user ? `DM · ${await this.directory.user(this.api, event.user)}` : channel;
    }
    return name ?? channel;
  }

  private async images(files: SlackFile[]): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    for (const file of files) {
      try {
        out.push(await this.api.downloadFile(file));
      } catch (err) {
        this.log(`file download failed: ${String(err)}`);
      }
    }
    return out;
  }

  // --- outbound --------------------------------------------------------------

  /**
   * Called on every turn-end, empty text included: the turn settled with
   * nothing to say, and the 👀 receipts still have to come off.
   */
  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { channel, threadTs } = parseConversation(conversation);
    // Every id this adapter mints carries a thread, so an empty one is a
    // corrupted or foreign conversation id. Posting it would put an agent turn
    // in the channel's main flow — the one thing this adapter promises never to
    // do — so it is refused loudly instead, and the receipts still come off so
    // no 👀 is stranded.
    if (!threadTs) {
      this.log(`refusing to answer ${conversation}: no thread in the conversation id`);
      await this.receipts.settle(conversation);
      return;
    }
    try {
      await this.out.reply(channel, threadTs, reply);
    } finally {
      // Always: the turn ended either way, and a 👀 left on a user's message
      // because the reply failed to send would sit there until the stale sweep
      // half an hour later, looking like the agent is still working.
      await this.receipts.settle(conversation);
    }
  }

  /** A system note, posted without touching the receipts: the turn it triggers
   * has not ended yet. */
  async notify(
    conversation: string,
    note: { text: string; origin: SystemInputOrigin },
  ): Promise<void> {
    const { channel, threadTs } = parseConversation(conversation);
    if (!threadTs) {
      this.log(`refusing to post a system note to ${conversation}: no thread in the conversation id`);
      return;
    }
    await this.out.note(channel, threadTs, note);
  }
}

