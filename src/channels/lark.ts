// Lark (Feishu) adapter: normalize long-connection events, render outbound
// turns as cards. As on Slack, Pier never posts into a chat's main flow: a
// conversation is `<chatId>/<rootMessageId>` (`reply_in_thread`; DMs thread
// too). Lark-specific: `content` is a double-encoded JSON string and a mention
// is a `@_user_N` placeholder resolved through `mentions[]`; 👀 is the reaction
// key `OnIt`, removed by reaction_id; a card callback does not say which thread
// its message lives in, so every button value carries the root; delivery is
// at-least-once and acked when the handler returns, so handlers queue and return.

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

const WORKING = "OnIt";
// The event is already acked, so this bounds concurrency, not the backlog.
const MAX_ACTIVE_CHATS = 16;
const RECEIPT_STALE_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

/** The only definition of the conversation id format; control.ts decodes with it. */
const conversationId = (chatId: string, root: string): string => `${chatId}/${root}`;

export const parseConversation = (id: string): { chatId: string; root: string } => {
  const at = id.indexOf("/");
  return at < 0
    ? { chatId: id, root: "" }
    : { chatId: id.slice(0, at), root: id.slice(at + 1) };
};

/** A message posted in the chat becomes the root of its own topic. */
const threadOf = (msg: LarkMessageEvent["message"]): string => msg.rootId || msg.messageId;

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
  /** Injected in tests. */
  client?: LarkClient;
  /** Injected in tests. */
  receipts?: ReceiptLedger;
  /** Wired by runtime.ts, so `/stop` and the panel never enter the Channel seam. */
  control?: ChannelControl;
}

export class LarkChannel implements Channel {
  readonly id = "lark";
  /** No `pier lark` CLI and no mention syntax out: its ids buy the prompt nothing. */
  readonly opaqueIds = true;
  private readonly api: LarkClient;
  private readonly log: (message: string) => void;
  private readonly receipts: Receipts;
  private readonly chains: Chains;
  private readonly gate: Gatekeeper;
  private readonly seen: Dedup;
  /** Absent when no control was wired (tests). */
  private readonly panel?: LarkPanel;
  private readonly names = new Map<string, string>();
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
      // Removal needs the emoji key back.
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
      // Every chat with require-mention on goes silent; loud, not a debug line.
      this.log("bot info returned no open_id: mention detection is disabled");
    }
    this.running = true;
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

  /** The SDK acks the frame when this returns, so routing is synchronous and
   *  the work is queued. */
  private onEvent(event: LarkMessageEvent, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
    void this.receipts.sweep();
    if (event.senderType === "app") return;
    if (this.seen.duplicate(event.eventId)) return;
    const chatId = event.message.chatId;
    if (!chatId) return this.log("message event without a chat id, dropped");
    this.chains.run(chatId, () => this.onMessage(event, onMessage));
  }

  private onCardEvent(action: LarkCardAction, onMessage: (msg: InboundMessage) => void): void {
    if (!this.running) return;
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
    if (!this.discovered.has(msg.chatId) && this.gate.mayDiscover({ isDm, userId: senderId })) {
      this.discovered.add(msg.chatId);
      const name = isDm
        ? `DM · ${await this.userName(senderId)}`
        : (await this.api.chatName(msg.chatId).catch((err) => {
          // Usually a missing scope.
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
    // Lark gives Pier no @username a command target could match, so any target
    // means "not us".
    const parsed = parseCommand(text);
    const command = parsed?.target ? undefined : parsed;
    const root = threadOf(msg);
    const here: ConversationKey = { channelId: this.id, conversationId: conversationId(msg.chatId, root) };
    const bindRequest = command?.name === "bind" && isDm;
    const admitted = this.gate.admit("message", msg.chatId, {
      isDm,
      // Mentioned, or continuing a topic Pier already owns — durable, so it
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
    // A bare `@bot` and `/settings` are the same request.
    if (this.panel && (command?.name === "settings" || (!text && !attachments.length && mentioned))) {
      return this.panel.open(here, msg.chatId, root);
    }

    // Downloading only past the gate: an unauthorized sender must not make the
    // bot pull bytes on their behalf.
    const markers = await this.saveAttachments(msg.messageId, attachments);
    // Resolved before the mark: any await between mark() and dispatch is a
    // window in which a previous turn can settle and take this receipt with it.
    const sender = { id: senderId, name: await this.userName(senderId) };
    this.receipts.mark(here.conversationId, msg.chatId, msg.messageId);
    // Steer: a follow-up is the wrong default when the human is watching a 👀.
    onMessage({
      key: here,
      senderId,
      sender,
      text: [text, ...markers].filter(Boolean).join("\n"),
      mode: "steer",
    });
  }

  /** `content` is a JSON string; malformed or unreadable types are logged and
   *  dropped at this boundary. */
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
          // `file_size` is optional and sometimes a numeric string.
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
    // The bot's own placeholder is addressing and is removed; anyone else's
    // becomes their name.
    let mentioned = false;
    for (const mention of msg.mentions ?? []) {
      const isMe = !!this.me && mention.id?.open_id === this.me;
      mentioned ||= isMe;
      text = text.replaceAll(mention.key, isMe ? "" : `@${mention.name ?? "?"}`);
    }
    return { text, attachments, mentioned };
  }

  private readPost(raw: Record<string, unknown>): { text: string; images: LarkAttachment[] } {
    // A post body may arrive flat or wrapped in a locale (`{zh_cn: {title, content}}`).
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
          // Rich text carries the at run inline, not as a placeholder; the
          // bot's own is detected via `mentions[]`.
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
    // A form submit carries the root in the button's name instead of the
    // value. Absent both, the payload is not one Pier minted.
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
    if (payload.startsWith(PANEL_PREFIX)) {
      if (!(await this.panel?.onAction(action, key, payload, root))) {
        this.log(`panel action ${payload} with no panel wired, dropped`);
      }
      return;
    }

    // The label travels in the echoed value (Lark cannot return a 2.0 card;
    // see LarkActionValue), so a click survives a restart. A value without
    // one is a stale card, and the user clicked expecting something.
    const label = payload.startsWith(OFFER_PREFIX) && typeof action.value?.label === "string"
      ? action.value.label
      : undefined;
    if (label === undefined) {
      this.log(`unknown or stale action ${payload} in chat ${action.chatId}`);
      await this.api.replyCard(root, card([markdown(STALE_OPTION)]))
        .catch((err) => this.log(`stale-option notice failed: ${String(err)}`));
      return;
    }
    // A bot cannot post as the user, so the pick is echoed: otherwise the
    // topic shows an answer to a request nobody can see, with nothing to carry the eyes.
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

  /** The abort ends the turn, which reaches send() and clears the receipts. */
  private async abortTurn(key: ConversationKey, messageId: string): Promise<void> {
    await this.deps.control?.abort(key);
    await this.api.replyCard(messageId, card([markdown(STOPPED)]));
  }

  // --- bind ------------------------------------------------------------------

  /** Groups stay silent, but a DM that swallows every message looks broken
   *  rather than locked. */
  private async hintBind(userId: string, messageId: string): Promise<void> {
    if (!this.gate.mayHint(userId)) return;
    await this.api.replyCard(messageId, card([markdown(bindHint("`/bind <code>`"))]))
      .catch((err) => this.log(`bind hint failed: ${String(err)}`));
  }

  private async bind(userId: string, messageId: string, code: string): Promise<void> {
    const name = await this.userName(userId);
    const outcome = this.deps.store.redeemBindCode("lark", code, { id: userId, name });
    await this.api.replyCard(messageId, card([markdown(bindResult(outcome, name))]));
  }

  // --- lookups ---------------------------------------------------------------

  private async userName(openId: string): Promise<string> {
    const hit = this.names.get(openId);
    if (hit) return hit;
    const name = await this.api.userName(openId).catch((err) => {
      this.log(`user lookup failed for ${openId}: ${String(err)}`);
      return openId;
    });
    this.names.set(openId, name);
    return name;
  }

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

  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { root } = parseConversation(conversation);
    // No root is a foreign id; posting it would put a turn in the chat's main
    // flow. Refused loudly, receipts still cleared.
    if (!root) {
      this.log(`refusing to answer ${conversation}: no thread root in the conversation id`);
      await this.receipts.settle(conversation);
      return;
    }
    // The turn ended either way; a 👀 left up by a failed send looks like work.
    await this.receipts.settleAfter(conversation, () => this.out.reply(root, reply), reply.meta);
  }

  /** The 👀 goes on the note itself: the turn it triggers has no message of
   *  the user's to carry them. */
  async notify(conversation: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const { chatId, root } = parseConversation(conversation);
    if (!root) {
      this.log(`refusing to post a system note to ${conversation}: no thread root in the conversation id`);
      return;
    }
    const messageId = await this.out.note(root, note);
    if (messageId && awaitsTurn(note.origin)) this.receipts.mark(conversation, chatId, messageId);
  }
}
