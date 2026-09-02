// Lark (Feishu) adapter: normalize long-connection events, render outbound
// turns as cards.
//
// The anchor is threads, exactly as on Slack: Pier never posts into a chat's
// main flow — a message in the chat is answered in *its own* topic
// (`reply_in_thread`), a message inside a topic is answered there. So a
// conversation is `<chatId>/<rootMessageId>`, the thread is the session, and
// DMs follow the same rule (Feishu DMs thread; avibe verified it). Telegram's
// `topicMode` toggle is meaningless here — there is no other behaviour.
//
// Four more things are Lark-specific and live only here:
//  - Message bodies are JSON *strings* (`content` is double-encoded), and a
//    mention is a `@_user_N` placeholder resolved through `mentions[]`.
//  - Reactions are named keys: 👀 is `OnIt`, and removal is list-then-delete
//    because the API deletes by reaction_id.
//  - A card callback does not say which thread its message lives in, so every
//    button's value carries the thread root (`LarkActionValue.root`).
//  - Delivery is at-least-once and the transport acks only after the handler
//    returns, so handlers queue work and return; `event_id` is deduplicated.
//
// Everything policy-shaped (mention/bind gates, per-chat overrides) is in
// config.ts, platform-blind and shared with Telegram and Slack.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  InboundMessage,
  NoteOrigin,
} from "../core/types.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { bindHint, bindResult, picked, STALE_OPTION, STOPPED } from "./lines.js";
import { logger } from "../log.js";
import { Chains } from "./chains.js";
import { parseCommand } from "./commands.js";
import { Dedup } from "./dedup.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { Gatekeeper } from "./gatekeeper.js";
import {
  LarkApi,
  type LarkCardAction,
  type LarkClient,
  type LarkMessageEvent,
  type LarkSocket,
} from "./lark-api.js";
import { LarkOutbound } from "./lark-outbound.js";
import { CWD_SUBMIT_PREFIX, LarkPanel } from "./lark-panel.js";
import { card, markdown, OFFER_PREFIX } from "./lark-render.js";
import { PANEL_PREFIX } from "./panel.js";
import { ReceiptLedger, Receipts } from "./receipts.js";

/** Lark wants a named key here; 👀 has none, `OnIt` is its "being handled". */
const WORKING = "OnIt";
// Backpressure: bounds concurrency (downloads, API calls), not the backlog —
// the event is already acked by the transport, so nothing slows the source.
const MAX_ACTIVE_CHATS = 16;
const RECEIPT_STALE_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
/** How long a delivered event id is remembered, against redelivery. */
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

/**
 * A Lark conversation is always `<chatId>/<rootMessageId>` — the thread is
 * the session. This pair is the only definition of the format; control.ts
 * decodes with it rather than splitting on "/" itself.
 */
const conversationId = (chatId: string, root: string): string => `${chatId}/${root}`;

export const parseConversation = (id: string): { chatId: string; root: string } => {
  const at = id.indexOf("/");
  return at < 0
    ? { chatId: id, root: "" }
    : { chatId: id.slice(0, at), root: id.slice(at + 1) };
};

/**
 * The thread a message belongs to. A message already in a topic keeps its
 * root; one posted in the chat becomes the root of its own — which is what
 * makes every request its own session without asking Lark for anything.
 */
const threadOf = (msg: LarkMessageEvent["message"]): string => msg.rootId || msg.messageId;

/** An inbound attachment: where its bytes live and what to call them. */
interface LarkAttachment {
  key: string;
  type: "image" | "file";
  name?: string;
  size?: number;
}

export interface LarkDeps {
  store: ChannelStore;
  /** Dropped and malformed input is reported here — never a silent catch. */
  log?: (message: string) => void;
  /** Injected in tests; production builds a real Lark client. */
  client?: LarkClient;
  /** Injected in tests; production opens the shared channel database. */
  receipts?: ReceiptLedger;
  /** Channel-level control that is not a prompt; wired by runtime.ts. */
  control?: ChannelControl;
}

export class LarkChannel implements Channel {
  readonly id = "lark";
  private readonly api: LarkClient;
  private readonly log: (message: string) => void;
  /** 👀 lifecycle, durable; see receipts.ts for why it is not just a Map. */
  private readonly receipts: Receipts;
  /** Ordering per chat, concurrency across them; see chains.ts. */
  private readonly chains: Chains;
  /** The inbound gate and the bind-hint throttle; see gatekeeper.ts. */
  private readonly gate: Gatekeeper;
  /** Event ids already handled, against at-least-once delivery. */
  private readonly seen: Dedup;
  /** The in-chat settings panel; absent when no control was wired (tests). */
  private readonly panel?: LarkPanel;
  /** User names, cached for the process — one contact lookup per person. */
  private readonly names = new Map<string, string>();
  /** Chats already reported to the store this process; a rename waits for a
   *  restart, which is soon enough for a Console display label. */
  private readonly discovered = new Set<string>();
  private me = "";
  private readonly out: LarkOutbound;
  private socket?: LarkSocket;
  private running = false;

  constructor(private readonly deps: LarkDeps) {
    const config = deps.store.get("lark");
    this.log = deps.log ?? ((m) => logger("lark").warn(m));
    this.chains = new Chains(this.log, MAX_ACTIVE_CHATS);
    this.gate = new Gatekeeper(deps.store, "lark", this.log, "chat");
    this.seen = new Dedup(this.log, DEDUP_TTL_MS, DEDUP_MAX);
    // token = App ID, appToken = App Secret (see lark-api.ts).
    this.api = deps.client ?? new LarkApi(config.token, config.appToken, this.log);
    this.out = new LarkOutbound(this.api, this.log);
    this.receipts = new Receipts(
      // Reaction removal needs the emoji key back, and Pier only applies one.
      {
        setReaction: (_chatId, messageId, emoji) =>
          emoji
            ? this.api.addReaction(messageId, emoji)
            : this.api.removeReaction(messageId, WORKING),
      },
      deps.receipts ?? new ReceiptLedger("lark"),
      this.log,
      WORKING,
      RECEIPT_STALE_MS,
    );
    if (deps.control) {
      this.panel = new LarkPanel({
        api: this.api,
        control: deps.control,
        store: deps.store,
        log: this.log,
      });
    }
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.me = await this.api.botOpenId();
    if (!this.me) {
      // Without our own open_id, "was I mentioned?" can only answer no, so
      // every chat with require-mention on goes silent. Loud, not a debug line.
      this.log("bot info returned no open_id: mention detection is disabled");
    }
    this.running = true;
    // Best-effort and off the critical path.
    void this.receipts.sweep(true);
    this.socket = await this.api.connect({
      onMessage: (event) => this.onEvent(event, onMessage),
      onCardAction: (action) => this.onCardEvent(action, onMessage),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.socket?.close().catch((err: unknown) =>
      this.log(`lark socket did not close cleanly: ${String(err)}`));
    this.socket = undefined;
    await this.chains.drain(DRAIN_TIMEOUT_MS);
  }

  // --- inbound ---------------------------------------------------------------

  /**
   * Already (about to be) acked by the transport — the SDK answers the frame
   * when this returns, so routing is synchronous and the work is queued.
   */
  private onEvent(event: LarkMessageEvent, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
    // Asked on every event, throttled inside receipts.ts.
    void this.receipts.sweep();
    // Our own echo or another app's message.
    if (event.senderType === "app") return;
    if (this.seen.duplicate(event.eventId)) return;
    const chatId = event.message.chatId;
    if (!chatId) return this.log("message event without a chat id, dropped");
    this.chains.run(chatId, () => this.onMessage(event, onMessage));
  }

  private onCardEvent(action: LarkCardAction, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
    // A card callback carries its own event id; the composed key is the
    // fallback for a payload that arrives without one.
    const dedupId = action.eventId ??
      `card:${action.messageId}:${action.operatorId}:${action.value?.key ?? action.name ?? ""}`;
    if (this.seen.duplicate(dedupId)) return;
    if (!action.chatId || !action.messageId || !action.operatorId) {
      this.log("incomplete card action payload, dropped");
      return;
    }
    this.chains.run(action.chatId, () => this.onAction(action, onMessage));
  }

  private async onMessage(
    event: LarkMessageEvent,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    const msg = event.message;
    const senderId = event.senderId;
    if (!senderId || !msg.messageId) return;

    const { text: raw, attachments, mentioned } = this.readContent(msg);
    if (!raw && !attachments.length && !mentioned) return;

    const isDm = msg.chatType === "p2p";
    if (!this.discovered.has(msg.chatId)) {
      this.discovered.add(msg.chatId);
      const name = isDm
        ? `DM · ${await this.userName(senderId)}`
        : (await this.api.chatName(msg.chatId).catch((err) => {
          // Named, not silent: this failing usually means a missing scope.
          this.log(`chat lookup failed for ${msg.chatId}: ${String(err)}`);
          return undefined;
        })) ?? msg.chatId;
      this.deps.store.discoverChat("lark", {
        id: msg.chatId,
        name,
        kind: isDm ? "dm" : "group",
      });
    }

    const text = raw.trim();
    // A command aimed at another bot (`/stop@other`) is not ours to answer
    // and travels on as ordinary text — Lark gives Pier no @username a target
    // could positively match, so any target means "not us".
    const parsed = parseCommand(text);
    const command = parsed?.target ? undefined : parsed;
    const root = threadOf(msg);
    const here: ConversationKey = { channelId: this.id, conversationId: conversationId(msg.chatId, root) };
    const bindRequest = command?.name === "bind" && isDm;
    const admitted = this.gate.admit("message", msg.chatId, {
      isDm,
      // Mentioned, or continuing a topic Pier already owns — Lark's
      // equivalent of Telegram's "replying to the bot", durable so it still
      // holds after a restart.
      addressed: mentioned || (!!msg.rootId && !!this.deps.control?.knows(here)),
      userId: senderId,
      bindRequest,
    });
    if (!admitted) {
      if (isDm) await this.hintBind(senderId, msg.messageId);
      return;
    }
    if (bindRequest) return this.bind(senderId, msg.messageId, command?.args ?? "");
    if (command?.name === "stop") return this.abortTurn(here, msg.messageId);
    // `@bot` on its own (the text is empty once the mention is stripped) and
    // `/settings` are the same request: show me this conversation's settings.
    if (this.panel && (command?.name === "settings" || (!text && !attachments.length && mentioned))) {
      return this.panel.open(here, msg.chatId, root);
    }

    // Downloading only past the gate: an unauthorized sender must not be able
    // to make the bot pull bytes on their behalf.
    const markers = await this.saveAttachments(msg.messageId, attachments);
    // Every await between mark() and dispatch is a window in which a previous
    // turn can end and settle — taking this receipt with it before its own
    // turn even starts — so the name is resolved first and the mark→dispatch
    // pair stays synchronous.
    const sender = { id: senderId, name: await this.userName(senderId) };
    this.receipts.mark(here.conversationId, msg.chatId, msg.messageId);
    // IM messages steer by default: a follow-up that waits for the turn to
    // end is the wrong default when the human is watching a 👀 in a topic.
    onMessage({
      key: here,
      senderId,
      sender,
      text: [text, ...markers].filter(Boolean).join("\n"),
      mode: "steer",
    });
  }

  /**
   * One message's readable content: text with mentions resolved, attachments
   * to fetch, and whether the bot was addressed. `content` is a JSON string;
   * malformed or unreadable types are logged and dropped at this boundary.
   */
  private readContent(
    msg: LarkMessageEvent["message"],
  ): { text: string; attachments: LarkAttachment[]; mentioned: boolean } {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(msg.content ?? "{}") as Record<string, unknown>;
    } catch {
      this.log(`unparseable message content in ${msg.messageId}, dropped`);
    }
    let text = "";
    const attachments: LarkAttachment[] = [];
    switch (msg.messageType) {
      case "text":
        text = String(content.text ?? "");
        break;
      case "post": {
        const post = this.readPost(content);
        text = post.text;
        attachments.push(...post.images);
        break;
      }
      case "image":
        if (content.image_key) {
          attachments.push({ key: String(content.image_key), type: "image", name: "image.png" });
        }
        break;
      case "file":
      case "media":
      case "audio":
        if (content.file_key) {
          // `file_size` is optional and sometimes a numeric string; a missing
          // one is fine — download() enforces the cap mid-stream regardless.
          const size = Number(content.file_size);
          attachments.push({
            key: String(content.file_key),
            type: "file",
            name: content.file_name ? String(content.file_name) : undefined,
            size: Number.isFinite(size) && size > 0 ? size : undefined,
          });
        }
        break;
      default:
        this.log(`ignored message type ${msg.messageType ?? "?"}`);
    }
    // A mention arrives as a `@_user_N` placeholder: the bot's own is
    // addressing, not content, and is removed; anyone else's becomes their
    // name, so the agent sees who was meant.
    let mentioned = false;
    for (const mention of msg.mentions ?? []) {
      const isMe = !!this.me && mention.id?.open_id === this.me;
      mentioned ||= isMe;
      text = text.replaceAll(mention.key, isMe ? "" : `@${mention.name ?? "?"}`);
    }
    return { text, attachments, mentioned };
  }

  /** Rich text: the readable runs, and any images embedded in it. */
  private readPost(raw: Record<string, unknown>): { text: string; images: LarkAttachment[] } {
    // A post body may arrive wrapped in a locale (`{zh_cn: {title, content}}`)
    // rather than flat — both shapes are real. Take the flat body when it is
    // one, else the first locale entry that is an object.
    const content = Array.isArray(raw.content) || typeof raw.title === "string"
      ? raw
      : (Object.values(raw).find((v) => !!v && typeof v === "object" && !Array.isArray(v)) ??
        {}) as Record<string, unknown>;
    const lines: string[] = [];
    const images: LarkAttachment[] = [];
    const title = typeof content.title === "string" ? content.title : "";
    if (title) lines.push(title);
    const rows = Array.isArray(content.content) ? content.content : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const parts: string[] = [];
      for (const run of row as Record<string, unknown>[]) {
        if (run.tag === "text" || run.tag === "a") parts.push(String(run.text ?? ""));
        else if (run.tag === "at") {
          // Inline, not a `@_user_N` placeholder: rich text carries the at run
          // itself. The bot's own is addressing (detected via `mentions[]`),
          // not content; anyone else's becomes their name.
          if (run.user_id !== this.me) parts.push(`@${run.user_name ?? run.user_id ?? "?"}`);
        } else if (run.tag === "img" && run.image_key) {
          images.push({ key: String(run.image_key), type: "image", name: "image.png" });
        }
      }
      if (parts.length) lines.push(parts.join(""));
    }
    return { text: lines.join("\n"), images };
  }

  // --- card actions ------------------------------------------------------------

  private async onAction(
    action: LarkCardAction,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    // The thread root travels in the button payload (a callback does not say
    // which topic its message lives in); a form submit carries it in the
    // button's name. Absent both, the payload is not one Pier minted.
    const payload = action.value?.key ?? "";
    const formRoot = action.name?.startsWith(CWD_SUBMIT_PREFIX)
      ? action.name.slice(CWD_SUBMIT_PREFIX.length)
      : "";
    const root = action.value?.root ?? formRoot;
    if (!root) {
      this.log(`card action without a thread root in ${action.chatId}, dropped`);
      return;
    }
    const key: ConversationKey = {
      channelId: this.id,
      conversationId: conversationId(action.chatId, root),
    };
    const admitted = this.gate.admit("action", action.chatId, {
      isDm: this.deps.store.chat("lark", action.chatId)?.kind === "dm",
      addressed: true, // clicking the bot's own button is addressing it
      userId: action.operatorId,
    });
    if (!admitted) return;
    if (formRoot && action.formValue) {
      await this.panel?.onCwdSubmit(key, action, root);
      return;
    }
    // Panel clicks are namespaced `cfg:` and never reach the agent.
    if (payload.startsWith(PANEL_PREFIX)) {
      if (!(await this.panel?.onAction(action, key, payload, root))) {
        this.log(`panel action ${payload} with no panel wired, dropped`);
      }
      return;
    }

    // A next-step button. The label travels in the value the platform echoes
    // back — the only durable place, since Lark cannot return a 2.0 card
    // (LarkActionValue documents the probe) — so a click needs no adapter
    // state and survives a restart. A value without one is a stale card from
    // before this convention, and the user clicked expecting something.
    const label = payload.startsWith(OFFER_PREFIX) && typeof action.value?.label === "string"
      ? action.value.label
      : undefined;
    if (label === undefined) {
      this.log(`unknown or stale action ${payload} in chat ${action.chatId}`);
      await this.api.replyCard(root, card([markdown(STALE_OPTION)]))
        .catch((err) => this.log(`stale-option notice failed: ${String(err)}`));
      return;
    }
    // The taken row comes off (best-effort; see LarkOutbound.retire), and the
    // pick is echoed — a bot cannot post as the user, so without the echo the
    // topic shows an answer to a request nobody can see being made, and there
    // is nothing to carry the eyes.
    const sender = { id: action.operatorId, name: await this.userName(action.operatorId) };
    await this.out.retire(action.messageId);
    const echo = await this.api.replyCard(root, card([markdown(picked(label))]))
      .catch((err) => {
        this.log(`option echo failed: ${String(err)}`);
        return undefined;
      });
    // No await between mark and dispatch — see onMessage.
    if (echo?.messageId) this.receipts.mark(key.conversationId, action.chatId, echo.messageId);
    onMessage({
      key,
      senderId: action.operatorId,
      sender,
      text: label,
      mode: "steer",
    });
  }

  /**
   * Stop the turn this conversation is running. The abort makes Pi end the
   * turn, which reaches send() through the normal turn-end path and clears
   * the 👀 receipts — so nothing here touches them.
   */
  private async abortTurn(key: ConversationKey, messageId: string): Promise<void> {
    await this.deps.control?.abort(key);
    await this.api.replyCard(messageId, card([markdown(STOPPED)]));
  }

  // --- bind ------------------------------------------------------------------

  /**
   * Tell an unbound DM sender what to do. Groups stay silent (see gate()),
   * but a DM that swallows every message looks broken rather than locked.
   */
  private async hintBind(userId: string, messageId: string): Promise<void> {
    if (!this.gate.mayHint(userId)) return;
    await this.api.replyCard(messageId, card([markdown(bindHint("`/bind <code>`"))]))
      .catch((err) => this.log(`bind hint failed: ${String(err)}`));
  }

  private async bind(userId: string, messageId: string, code: string): Promise<void> {
    const name = await this.userName(userId);
    const ok = this.deps.store.redeemBindCode("lark", code, { id: userId, name });
    await this.api.replyCard(messageId, card([markdown(bindResult(ok, name))]));
  }

  // --- lookups ---------------------------------------------------------------

  private async userName(openId: string): Promise<string> {
    const hit = this.names.get(openId);
    if (hit) return hit;
    const name = await this.api.userName(openId).catch((err) => {
      // The id is the honest fallback label; the reason still gets said.
      this.log(`user lookup failed for ${openId}: ${String(err)}`);
      return openId;
    });
    this.names.set(openId, name);
    return name;
  }

  /** The message's attachments as the shared save loop wants them (the loop
   *  itself, size gate and lost markers included, is core/inbox.ts; the
   *  mid-stream refusal in download() names "too large" so the loop's marker
   *  stays honest when the metadata lied by omission). */
  private saveAttachments(messageId: string, files: LarkAttachment[]): Promise<string[]> {
    return saveInboundAll(this.id, files.map((file) => ({
      label: file.name ?? "attachment",
      name: file.name,
      mimeType: file.type === "image" ? "image/png" : "application/octet-stream",
      size: file.size,
      fetch: async () => this.api.download(messageId, file.key, file.type, MAX_INBOUND_BYTES),
    })), this.log);
  }

  // --- outbound --------------------------------------------------------------

  /**
   * Called on every turn-end, empty text included: the turn settled with
   * nothing to say, and the 👀 receipts still have to come off.
   */
  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { root } = parseConversation(conversation);
    // Every id this adapter mints carries a thread root, so an empty one is a
    // corrupted or foreign conversation id. Posting it would put an agent
    // turn in the chat's main flow — the one thing this adapter promises
    // never to do — so it is refused loudly instead, and the receipts still
    // come off so no 👀 is stranded.
    if (!root) {
      this.log(`refusing to answer ${conversation}: no thread root in the conversation id`);
      await this.receipts.settle(conversation);
      return;
    }
    // settleAfter: the turn ended either way, and a 👀 left up because the
    // reply failed to send looks like work until the stale sweep.
    await this.receipts.settleAfter(conversation, () => this.out.reply(root, reply));
  }

  /** A system note, posted without touching the receipts: the turn it
   *  triggers has not ended yet. */
  async notify(conversation: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const { root } = parseConversation(conversation);
    if (!root) {
      this.log(`refusing to post a system note to ${conversation}: no thread root in the conversation id`);
      return;
    }
    await this.out.note(root, note);
  }
}
