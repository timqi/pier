// Telegram adapter: normalize inbound updates, render outbound turns.
// Telegram-specific: topic mode, where a message in a forum group's General
// opens a topic that becomes the session; 👀 receipts on every message that
// entered a turn; `/bind <code>` in a DM.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  InboundMessage,
  NoteOrigin,
  TurnMeta,
} from "../core/types.js";
import { awaitsTurn, formatTurnMeta, isSilentReply, originLabel, quietLabel } from "../core/reply.js";
import { saveInboundAll } from "../core/inbox.js";
import { MAX_INBOUND_BYTES } from "../core/inbound-file.js";
import { sendAttachments, splitAttachments } from "./attach.js";
import { bindHint, bindResult, picked, STALE_OPTION, STOPPED } from "./lines.js";
import { logger } from "../log.js";
import { Chains } from "./chains.js";
import { parseCommand } from "./commands.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { Gatekeeper } from "./gatekeeper.js";
import { ReceiptLedger, Receipts } from "./receipts.js";
import { TelegramPanel } from "./telegram-panel.js";
import { chunk, escapeHtml, keyboard, offeredLabel, toTelegramHtml } from "./telegram-render.js";
import {
  TelegramApi,
  type TelegramClient,
  type TgCallbackQuery,
  type TgChat,
  type TgMessage,
} from "./telegram-api.js";
import type { ChatKind } from "./types.js";

const WORKING = "👀";
const POLL_SECONDS = 30;
// The poll loop waits here without advancing the offset past what it accepted.
const MAX_ACTIVE_CHATS = 16;
// Generous: a real coding turn can be long.
const RECEIPT_STALE_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 5000;
const TOPIC_TITLE_MAX = 60;

/** `<chatId>/<topicId>` or `<chatId>`; the only definition of the format. */
const conversationId = (chatId: number | string, topicId?: number): string =>
  topicId ? `${chatId}/${topicId}` : String(chatId);

export const parseConversation = (id: string): { chatId: string; topicId?: number } => {
  const [chatId = "", topic] = id.split("/");
  const topicId = topic ? Number(topic) : undefined;
  return { chatId, topicId: Number.isSafeInteger(topicId) ? topicId : undefined };
};

/** Telegram numbers General as topic 1 and omits the id on plain groups. */
const inGeneral = (msg: TgMessage): boolean =>
  !msg.message_thread_id || msg.message_thread_id === 1;

function topicTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  if (!line) return `Session ${new Date().toISOString().slice(5, 16).replace("T", " ")}`;
  return line.length > TOPIC_TITLE_MAX ? `${line.slice(0, TOPIC_TITLE_MAX - 3).trimEnd()}...` : line;
}

export interface TelegramDeps {
  store: ChannelStore;
  /** Dropped and malformed input is reported here — never a silent catch. */
  log?: (message: string) => void;
  /** Injected in tests. */
  client?: TelegramClient;
  /** Injected in tests. */
  receipts?: ReceiptLedger;
  /** Wired by runtime.ts, so `/stop` and the panel never enter the Channel seam. */
  control?: ChannelControl;
}

export class TelegramChannel implements Channel {
  readonly id = "telegram";
  private readonly api: TelegramClient;
  private readonly log: (message: string) => void;
  private readonly receipts: Receipts;
  private readonly chains: Chains;
  private readonly gate: Gatekeeper;
  /** Absent when no control was wired (tests). */
  private readonly panel?: TelegramPanel;
  private me?: { id: number; username: string };
  private offset?: number;
  private running = false;

  constructor(private readonly deps: TelegramDeps) {
    this.api = deps.client ?? new TelegramApi(deps.store.get("telegram").token);
    this.log = deps.log ?? ((m) => logger("telegram").warn(m));
    // No cap: the poll loop applies backpressure itself.
    this.chains = new Chains(this.log);
    this.gate = new Gatekeeper(deps.store, "telegram", this.log);
    this.receipts = new Receipts(
      // The ledger keeps message ids as opaque strings (a Slack ts is not a number).
      { setReaction: (chatId, messageId, emoji) => this.api.setReaction(chatId, Number(messageId), emoji) },
      deps.receipts ?? new ReceiptLedger("telegram"),
      this.log,
      WORKING,
      RECEIPT_STALE_MS,
    );
    if (deps.control) {
      this.panel = new TelegramPanel({
        api: this.api,
        control: deps.control,
        store: deps.store,
        log: this.log,
      });
    }
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    const me = await this.api.getMe();
    this.me = { id: me.id, username: me.username ?? "" };
    if (!this.me.username) {
      // Every group with require-mention on goes silent; loud, not a debug line.
      this.log("bot has no username: mention detection is disabled");
    }
    this.running = true;
    void this.receipts.sweep(true);
    void this.poll(onMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    // reload() starts a replacement right after; two adapters handling one
    // message would prompt the session twice. Bounded: a stuck handler must not
    // hold the Console's save request open.
    await this.chains.drain(DRAIN_TIMEOUT_MS);
  }

  // --- inbound ---------------------------------------------------------------

  private async poll(onMessage: (msg: InboundMessage) => void): Promise<void> {
    while (this.running) {
      try {
        // Floor on an empty round trip: a proxy that answers instantly would
        // otherwise turn the long poll into a hot loop.
        const startedAt = Date.now();
        const updates = await this.api.getUpdates(this.offset, POLL_SECONDS);
        if (!this.running) return;
        void this.receipts.sweep();
        if (!updates.length && Date.now() - startedAt < 1000) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        for (const update of updates) {
          if (!this.running) return;
          while (this.chains.size >= MAX_ACTIVE_CHATS) await this.chains.oldest();
          this.offset = update.update_id + 1;
          const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
          if (chat === undefined) continue; // malformed: no chat to answer in
          this.chains.run(String(chat), async () => {
            try {
              if (update.callback_query) await this.onCallback(update.callback_query, onMessage);
              else if (update.message) await this.onMessage(update.message, onMessage);
            } catch (err) {
              this.log(`update ${update.update_id} dropped: ${String(err)}`);
            }
          });
        }
      } catch (err) {
        if (!this.running) return;
        this.log(`poll failed, retrying: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async onMessage(msg: TgMessage, onMessage: (msg: InboundMessage) => void): Promise<void> {
    if (!msg.from || msg.from.id === this.me?.id) return; // own echo, or malformed
    const raw = (msg.text ?? msg.caption ?? "").trim();
    if (!raw && !msg.photo?.length && !msg.document) return;

    const chatId = String(msg.chat.id);
    const isDm = msg.chat.type === "private";
    const kind: ChatKind = isDm ? "dm" : msg.chat.is_forum ? "forum" : "group";
    const name = msg.chat.title ?? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
    this.deps.store.discoverChat("telegram", { id: chatId, name: name || chatId, kind });

    const text = this.stripMention(raw);
    const command = parseCommand(text);
    const mine = !command?.target || command.target.toLowerCase() === this.me?.username.toLowerCase();
    const bindRequest = mine && command?.name === "bind" && isDm;
    const admitted = this.gate.admit("message", chatId, {
      isDm,
      addressed: this.addressed(raw, msg),
      userId: String(msg.from.id),
      bindRequest,
    });
    if (!admitted) {
      if (isDm) await this.hintBind(msg);
      return;
    }
    if (bindRequest) return this.bind(msg, command?.args ?? "");
    if (mine && command?.name === "stop") return this.abortTurn(msg);

    const here: ConversationKey = {
      channelId: this.id,
      conversationId: conversationId(chatId, msg.message_thread_id),
    };
    if (await this.panel?.consumeCwdReply(msg, here)) return;
    // A bare `@bot` and `/settings` are the same request.
    if (this.panel && mine && (command?.name === "settings" || (!text && !msg.photo?.length && !msg.document))) {
      return this.panel.open(here, chatId, msg.message_thread_id);
    }

    // Downloading only past the gate: an unauthorized sender must not make the
    // bot pull bytes on their behalf.
    const markers = await this.saveAttachments(msg);
    const topicId = await this.routeTopic(msg, text);
    const key = { channelId: this.id, conversationId: conversationId(chatId, topicId) };
    this.receipts.mark(key.conversationId, chatId, String(msg.message_id));
    // Steer: a follow-up is the wrong default when the human is watching a 👀.
    onMessage({
      key,
      senderId: String(msg.from.id),
      sender: { id: String(msg.from.id), name: senderName(msg.from) },
      text: [text, ...markers].filter(Boolean).join("\n"),
      mode: "steer",
    });
  }

  private async onCallback(
    query: TgCallbackQuery,
    onMessage: (msg: InboundMessage) => void,
  ): Promise<void> {
    await this.api.answerCallbackQuery(query.id).catch(() => {});
    const msg = query.message;
    if (!msg || !query.data) return;
    const chatId = String(msg.chat.id);
    const admitted = this.gate.admit("callback", chatId, {
      isDm: msg.chat.type === "private",
      addressed: true, // pressing the bot's own button is addressing it
      userId: String(query.from.id),
    });
    if (!admitted) return;
    const key: ConversationKey = {
      channelId: this.id,
      conversationId: conversationId(chatId, msg.message_thread_id),
    };
    if (await this.panel?.onCallback(query, key)) return;
    const text = offeredLabel(msg, query.data);
    if (text === undefined) {
      // A callback query may be answered exactly once, and the ack above was
      // it; a second answer is silently dropped.
      await this.api.sendMessage({
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: STALE_OPTION,
      }).catch((err) => this.log(`stale-option notice failed: ${String(err)}`));
      return;
    }
    await this.api.clearKeyboard(chatId, msg.message_id).catch(() => {});
    // A bot cannot post as the user, so the pick is echoed: otherwise the chat
    // shows an answer to a request nobody can see, with nothing to carry the eyes.
    const echo = await this.api.sendMessage({
      chat_id: chatId,
      message_thread_id: msg.message_thread_id,
      text: picked(escapeHtml(text)),
      parse_mode: "HTML",
    }).catch((err) => {
      this.log(`option echo failed: ${String(err)}`);
      return undefined;
    });
    if (echo) this.receipts.mark(key.conversationId, chatId, String(echo.message_id));
    onMessage({ key, senderId: String(query.from.id), text, mode: "steer" });
  }

  /** The abort ends the turn, which reaches send() and clears the receipts. */
  private async abortTurn(msg: TgMessage): Promise<void> {
    const key: ConversationKey = {
      channelId: this.id,
      conversationId: conversationId(msg.chat.id, msg.message_thread_id),
    };
    await this.deps.control?.abort(key);
    await this.api.sendMessage({
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: STOPPED,
    });
  }

  /** Groups stay silent, but a DM that swallows every message looks broken
   *  rather than locked. */
  private async hintBind(msg: TgMessage): Promise<void> {
    if (!this.gate.mayHint(String(msg.from?.id ?? ""))) return;
    await this.api.sendMessage({
      chat_id: msg.chat.id,
      text: bindHint("/bind <code>"),
    }).catch((err) => this.log(`bind hint failed: ${String(err)}`));
  }

  private async bind(msg: TgMessage, code: string): Promise<void> {
    const user = msg.from!;
    const name = senderName(user);
    const ok = this.deps.store.redeemBindCode("telegram", code, { id: String(user.id), name });
    await this.api.sendMessage({
      chat_id: msg.chat.id,
      text: bindResult(ok, name),
    });
  }

  /** A reply or a command stays put; failure falls back to the current thread. */
  private async routeTopic(msg: TgMessage, text: string): Promise<number | undefined> {
    // Every reason to decline is logged: six invisible conditions are
    // indistinguishable from a bug.
    const decline = !this.deps.store.policy("telegram", String(msg.chat.id)).topicMode
      ? "topic mode off for this chat"
      : msg.chat.type !== "supergroup"
      ? `chat is a ${msg.chat.type}, not a supergroup`
      : !msg.chat.is_forum
      ? "group has Topics disabled in Telegram"
      : !inGeneral(msg)
      ? `already inside topic ${msg.message_thread_id}`
      : msg.reply_to_message
      ? "message is a reply, so it continues an existing thread"
      : text.startsWith("/")
      ? "message is a command"
      : "";
    if (decline) {
      this.log(`no new topic in chat ${msg.chat.id}: ${decline}`);
      return msg.message_thread_id;
    }
    const title = topicTitle(text);
    try {
      const topic = await this.api.createForumTopic(msg.chat.id, title);
      await this.api.sendMessage({
        chat_id: msg.chat.id,
        text: `→ <a href="${topicLink(msg.chat, topic.message_thread_id)}">${escapeHtml(title)}</a>`,
        parse_mode: "HTML",
        message_thread_id: msg.message_thread_id,
        reply_to_message_id: msg.message_id,
      }).catch(() => {});
      return topic.message_thread_id;
    } catch (err) {
      this.log(`topic creation failed, staying in General: ${String(err)}`);
      return msg.message_thread_id;
    }
  }

  private saveAttachments(msg: TgMessage): Promise<string[]> {
    // A photo is a size ladder; the last entry is the largest.
    const photo = msg.photo?.at(-1);
    const doc = msg.document;
    return saveInboundAll(this.id, [
      ...(photo ? [{
        label: "photo",
        mimeType: "image/jpeg",
        size: photo.file_size,
        // A filename comes only from getFile, so the fetch's wins.
        fetch: async () => this.api.downloadFile(photo.file_id, MAX_INBOUND_BYTES),
      }] : []),
      ...(doc ? [{
        label: doc.file_name ?? "file",
        name: doc.file_name,
        mimeType: doc.mime_type ?? "application/octet-stream",
        size: doc.file_size,
        fetch: async () => this.api.downloadFile(doc.file_id, MAX_INBOUND_BYTES),
      }] : []),
    ], this.log);
  }

  // --- addressing ------------------------------------------------------------

  private addressed(text: string, msg: TgMessage): boolean {
    if (msg.reply_to_message?.from?.id === this.me?.id) return true;
    if (text.startsWith("/")) {
      const target = /^\/\S+?@(\S+)/.exec(text)?.[1];
      return !target || target.toLowerCase() === this.me?.username.toLowerCase();
    }
    const handle = `@${this.me?.username.toLowerCase()}`;
    return !!this.me?.username && text.toLowerCase().includes(handle);
  }

  private stripMention(text: string): string {
    const handle = `@${this.me?.username ?? ""}`;
    if (!this.me?.username) return text;
    return text.toLowerCase().startsWith(handle.toLowerCase())
      ? text.slice(handle.length).replace(/^[\s,:-]+/, "")
      : text;
  }

  // --- outbound --------------------------------------------------------------

  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { chatId, topicId } = parseConversation(conversation);
    // A local file link is dead in Telegram: the bytes are uploaded instead.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    // An empty turn still posts its footer and says which kind of nothing (§5).
    const buttons = keyboard(reply.suggestions);
    const quiet = isSilentReply(reply)
      ? `<i>${quietLabel(reply.silence && escapeHtml(reply.silence))}</i>`
      : "";
    // A keyboard cannot ride a message that was never sent.
    const body = ((text ? toTelegramHtml(text) : quiet) + turnFooter(reply.meta)) ||
      (buttons ? "…" : "");
    // A 👀 left up by a failed send looks like work until the stale sweep.
    await this.receipts.settleAfter(conversation, async () => {
      if (body.trim()) {
        const parts = chunk(body);
        for (const [i, part] of parts.entries()) {
          await this.api.sendMessage({
            chat_id: chatId,
            message_thread_id: topicId,
            text: part,
            parse_mode: "HTML",
            reply_markup: i === parts.length - 1 ? buttons : undefined,
          });
        }
      }
      const lost = await sendAttachments(
        paths,
        (file) => this.api.sendFile({ chat_id: chatId, message_thread_id: topicId, file }),
        this.log,
      );
      if (lost) {
        await this.api.sendMessage({
          chat_id: chatId,
          message_thread_id: topicId,
          text: escapeHtml(lost),
          parse_mode: "HTML",
        });
      }
    }, reply.meta);
  }

  /** No footer: the turn this input triggers has not ended. The 👀 goes on the
   *  note itself, since that turn has no message of the user's to carry them. */
  async notify(conversation: string, note: { text: string; origin: NoteOrigin }): Promise<void> {
    const { chatId, topicId } = parseConversation(conversation);
    const label = originLabel(note.origin);
    let posted: TgMessage | undefined;
    for (const part of chunk(`<i>${label}</i>\n<blockquote>${toTelegramHtml(note.text)}</blockquote>`)) {
      posted = await this.api.sendMessage({
        chat_id: chatId,
        message_thread_id: topicId,
        text: part,
        parse_mode: "HTML",
      });
    }
    if (posted && awaitsTurn(note.origin)) {
      this.receipts.mark(conversation, chatId, String(posted.message_id));
    }
  }

}

const senderName = (user: NonNullable<TgMessage["from"]>): string =>
  [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);

/** A private supergroup links as `/c/<internal id>`: the chat id with its
 *  `-100` prefix removed. */
function topicLink(chat: TgChat, topicId: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${topicId}`;
  const internal = String(chat.id).replace(/^-100(?=\d)/, "").replace(/^-/, "");
  return `https://t.me/c/${internal}/${topicId}`;
}


/** One newline, not a blank line: Telegram has no muted text, so tucking it
 *  against the reply is the only way it reads as a footnote. */
const turnFooter = (meta: TurnMeta | undefined): string =>
  meta ? `\n<i>${formatTurnMeta(meta)}</i>` : "";

