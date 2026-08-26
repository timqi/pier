// Telegram adapter: normalize inbound updates, render outbound turns.
//
// Three behaviours are Telegram-specific and live only here:
//  - Topic mode. A message that lands in a forum group's General opens a fresh
//    topic named after its first line, and the conversation (hence the Pi
//    session) is that topic. One group therefore hosts many parallel sessions.
//  - Reaction receipts. Intermediate reasoning is never posted to IM; instead
//    every message that entered a turn wears 👀 until the turn settles, so a
//    steered message gets feedback without a line in the chat.
//  - Bind. `/bind <code>` in a DM redeems a Console-issued code.
//
// Everything policy-shaped (mention/bind gates, per-chat overrides) is in
// config.ts, platform-blind and shared with the adapters still to come.

import type {
  AgentReply,
  Channel,
  ConversationKey,
  InboundMessage,
  SystemInputOrigin,
  TurnMeta,
} from "../core/types.js";
import { formatTurnMeta, isSilentReply, originLabel, quietLabel } from "../core/reply.js";
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
// Backpressure: how many chats may be mid-handling before the poll loop waits.
// Bounds memory without ever advancing the offset past what we accepted.
const MAX_ACTIVE_CHATS = 16;
// Longest a 👀 may sit before we assume its turn will never settle (a dispatch
// that failed, a session that died). Generous: a real coding turn can be long.
const RECEIPT_STALE_MS = 30 * 60_000;
// Longest stop() waits for in-flight handlers before letting reload() proceed.
const DRAIN_TIMEOUT_MS = 5000;
const TOPIC_TITLE_MAX = 60;

/**
 * A forum conversation is `<chatId>/<topicId>`; anything else is `<chatId>`.
 * This pair is the only definition of the format — control.ts and the panel
 * decode with it rather than splitting on "/" themselves.
 */
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
  /** Injected in tests; production builds a real Bot API client. */
  client?: TelegramClient;
  /** Injected in tests; production opens the shared channel database. */
  receipts?: ReceiptLedger;
  /**
   * Channel-level control that is not a prompt. Wired by runtime.ts, which
   * owns the router — so `/stop` and the settings panel never become part of
   * the Channel seam.
   */
  control?: ChannelControl;
}

export class TelegramChannel implements Channel {
  readonly id = "telegram";
  private readonly api: TelegramClient;
  private readonly log: (message: string) => void;
  /** 👀 lifecycle, durable; see receipts.ts for why it is not just a Map. */
  private readonly receipts: Receipts;
  /** Ordering per chat, concurrency across them; see chains.ts. */
  private readonly chains: Chains;
  /** The inbound gate and the bind-hint throttle; see gatekeeper.ts. */
  private readonly gate: Gatekeeper;
  /** The in-chat settings panel; absent when no control was wired (tests). */
  private readonly panel?: TelegramPanel;
  private me?: { id: number; username: string };
  private offset?: number;
  private running = false;

  constructor(private readonly deps: TelegramDeps) {
    this.api = deps.client ?? new TelegramApi(deps.store.get("telegram").token);
    this.log = deps.log ?? ((m) => logger("telegram").warn(m));
    // No cap here: the poll loop applies backpressure itself, before advancing
    // the ack cursor past an update it has not accepted.
    this.chains = new Chains(this.log);
    this.gate = new Gatekeeper(deps.store, "telegram", this.log);
    this.receipts = new Receipts(
      // The ledger keeps message ids as opaque strings (a Slack ts is not a
      // number); Telegram's own are numeric, so the cast happens right here at
      // the API boundary rather than leaking a platform's id type into shared code.
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
      // Without a handle, "was I mentioned?" can only ever answer no, so every
      // group with require-mention on goes silent. Loud, not a debug line.
      this.log("bot has no username: mention detection is disabled");
    }
    this.running = true;
    // Best-effort and off the critical path.
    void this.receipts.sweep(true);
    void this.poll(onMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    // Let in-flight updates finish: reload() starts a replacement right after,
    // and two adapters handling one message would prompt the session twice.
    // Bounded, because reload() runs on the Console's save request — a stuck
    // handler must not hold that open.
    await this.chains.drain(DRAIN_TIMEOUT_MS);
  }

  // --- inbound ---------------------------------------------------------------

  private async poll(onMessage: (msg: InboundMessage) => void): Promise<void> {
    while (this.running) {
      try {
        // Floor on an empty round trip: getUpdates is supposed to block for
        // POLL_SECONDS, and a proxy that answers instantly would otherwise
        // turn this into a hot loop.
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
    // A command aimed at another bot in the same group is not ours to answer.
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
    // A typed answer to the panel's directory prompt, not a prompt for the agent.
    if (await this.panel?.consumeCwdReply(msg, here)) return;
    // `@bot` on its own (text is empty once the mention is stripped) and
    // `/settings` are the same request: show me this conversation's settings.
    if (this.panel && mine && (command?.name === "settings" || (!text && !msg.photo?.length && !msg.document))) {
      return this.panel.open(here, chatId, msg.message_thread_id);
    }

    // Downloading only past the gate: an unauthorized sender must not be able
    // to make the bot pull bytes on their behalf.
    const markers = await this.saveAttachments(msg);
    const topicId = await this.routeTopic(msg, text);
    const key = { channelId: this.id, conversationId: conversationId(chatId, topicId) };
    this.receipts.mark(key.conversationId, chatId, String(msg.message_id));
    // IM messages steer by default: a follow-up that waits for the turn to end
    // is the wrong default when the human is watching a 👀 in a chat window.
    onMessage({
      key,
      senderId: String(msg.from.id),
      // A group is many people talking into one session; the update already
      // carries the name, so no lookup is needed here.
      sender: { id: String(msg.from.id), name: senderName(msg.from) },
      text: [text, ...markers].filter(Boolean).join("\n"),
      mode: "steer",
    });
  }

  /** Quick-reply buttons send their own label back as an ordinary message. */
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
    // Panel taps are namespaced `cfg:` and never reach the agent.
    if (await this.panel?.onCallback(query, key)) return;
    const text = offeredLabel(msg, query.data);
    if (text === undefined) {
      // Said in the chat, not as a second answerCallbackQuery: a query may be
      // answered exactly once, and the toast already went to the ack above —
      // against the real API the second answer is silently dropped.
      await this.api.sendMessage({
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: STALE_OPTION,
      }).catch((err) => this.log(`stale-option notice failed: ${String(err)}`));
      return;
    }
    // The options belonged to the turn that just ended; once one is taken the
    // rest answer a question the conversation has moved past (the web drops
    // them for the same reason).
    await this.api.clearKeyboard(chatId, msg.message_id).catch(() => {});
    // A bot cannot post as the user, so the pick is echoed and marked as one.
    // Without it the chat shows an answer to a request nobody can see being
    // made, and there is no message of the user's to carry the eyes.
    //
    // No reply quote: the marker already says what this is, and quoting a long
    // answer to show which of its buttons was tapped costs more space than it
    // explains.
    const echo = await this.api.sendMessage({
      chat_id: chatId,
      message_thread_id: msg.message_thread_id,
      text: picked(escapeHtml(text)),
      parse_mode: "HTML",
    }).catch((err) => {
      this.log(`option echo failed: ${String(err)}`);
      return undefined;
    });
    // The receipt goes on the echo, not on the bot message that held the
    // buttons: the eyes mean "this input is being worked on".
    if (echo) this.receipts.mark(key.conversationId, chatId, String(echo.message_id));
    onMessage({ key, senderId: String(query.from.id), text, mode: "steer" });
  }

  /**
   * Stop the turn this conversation is running. The abort makes Pi end the
   * turn, which reaches send() through the normal turn-end path and clears the
   * 👀 receipts — so nothing here touches them.
   */
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

  /**
   * Tell an unbound DM sender what to do. Groups stay silent (see gate()), but
   * a DM that swallows every message looks broken rather than locked.
   */
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

  /**
   * Topic mode: a message arriving in a forum group's General starts a new
   * topic, so every request gets its own thread and its own Pi session. A
   * reply or a slash command stays put — it is continuing something, not
   * starting it. Failure falls back to the current thread rather than losing
   * the message.
   */
  private async routeTopic(msg: TgMessage, text: string): Promise<number | undefined> {
    // Every reason to decline is named and logged: "why did it not open a
    // topic" is the question this feature will be asked forever, and silence
    // makes six invisible conditions indistinguishable from a bug.
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
      // The whole point of the notice is to get out of General, so the title is
      // the link into the new topic rather than decoration.
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

  /** The message's attachments as the shared save loop wants them (the loop
   *  itself, size gate and lost markers included, is core/inbox.ts). */
  private saveAttachments(msg: TgMessage): Promise<string[]> {
    // Telegram sends a photo as a size ladder — the last entry is the largest.
    const photo = msg.photo?.at(-1);
    const doc = msg.document;
    return saveInboundAll(this.id, [
      ...(photo ? [{
        label: "photo",
        mimeType: "image/jpeg",
        size: photo.file_size,
        // Telegram only learns a filename from getFile, so the fetch's wins.
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

  /** Mentioned, replying to the bot, or a slash command aimed at this bot. */
  private addressed(text: string, msg: TgMessage): boolean {
    if (msg.reply_to_message?.from?.id === this.me?.id) return true;
    if (text.startsWith("/")) {
      const target = /^\/\S+?@(\S+)/.exec(text)?.[1];
      return !target || target.toLowerCase() === this.me?.username.toLowerCase();
    }
    const handle = `@${this.me?.username.toLowerCase()}`;
    return !!this.me?.username && text.toLowerCase().includes(handle);
  }

  /** A leading @bot is addressing, not content — the agent should not see it. */
  private stripMention(text: string): string {
    const handle = `@${this.me?.username ?? ""}`;
    if (!this.me?.username) return text;
    return text.toLowerCase().startsWith(handle.toLowerCase())
      ? text.slice(handle.length).replace(/^[\s,:-]+/, "")
      : text;
  }

  // --- outbound --------------------------------------------------------------

  /**
   * Called on every turn-end, empty text included: the turn settled with
   * nothing to say, and the 👀 receipts still have to come off.
   */
  async send(conversation: string, reply: AgentReply): Promise<void> {
    const { chatId, topicId } = parseConversation(conversation);
    // A file the agent linked is local to this machine, so the link is dead in
    // Telegram: the bytes are uploaded instead and the label stays in the text.
    const { text: spoken, paths } = splitAttachments(reply.text);
    const text = spoken.trim();
    // A turn that produced no text still posts its footer, and says which kind
    // of nothing it was: total silence is indistinguishable from a crash, and
    // the person waiting cannot tell. See AGENTS.md — an empty turn is still an
    // event, and an event nobody can see is not observable.
    const buttons = keyboard(reply.suggestions);
    const quiet = isSilentReply(reply)
      ? `<i>${quietLabel(reply.silence && escapeHtml(reply.silence))}</i>`
      : "";
    // A turn that is only its options still has to carry them: with no text,
    // no silence marker and no meta the body is empty, and a keyboard cannot
    // ride a message that was never sent — so it gets the smallest one.
    const body = ((text ? toTelegramHtml(text) : quiet) + turnFooter(reply.meta)) ||
      (buttons ? "…" : "");
    // settleAfter: a 👀 left up because the reply failed would sit there until
    // the stale sweep, looking like the agent is still working.
    await this.receipts.settleAfter(conversation, async () => {
      if (body.trim()) {
        const parts = chunk(body);
        for (const [i, part] of parts.entries()) {
          await this.api.sendMessage({
            chat_id: chatId,
            message_thread_id: topicId,
            text: part,
            parse_mode: "HTML",
            // Next-step buttons ride the last chunk; a click sends the label.
            reply_markup: i === parts.length - 1 ? buttons : undefined,
          });
        }
      }
      // Attachments follow the words, so the message that introduces them is
      // above them; anything that could not be sent says so in the chat.
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
    });
  }

  /**
   * A system note: quoted, labelled with where it came from, and deliberately
   * plain — no buttons, no turn footer, and the 👀 receipts stay up, because
   * the turn this input triggers has not ended yet.
   */
  async notify(conversation: string, note: { text: string; origin: SystemInputOrigin }): Promise<void> {
    const { chatId, topicId } = parseConversation(conversation);
    const label = originLabel(note.origin);
    for (const part of chunk(`<i>${label}</i>\n<blockquote>${toTelegramHtml(note.text)}</blockquote>`)) {
      await this.api.sendMessage({
        chat_id: chatId,
        message_thread_id: topicId,
        text: part,
        parse_mode: "HTML",
      });
    }
  }

}

/** Display name from an update, which always carries enough to build one. */
const senderName = (user: NonNullable<TgMessage["from"]>): string =>
  [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);

/**
 * Deep link to a forum topic. A public supergroup links by username; a private
 * one uses the `/c/<internal id>` form, which is the chat id with its `-100`
 * supergroup prefix removed. Both only resolve for members — exactly the
 * audience standing in General.
 */
function topicLink(chat: TgChat, topicId: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${topicId}`;
  const internal = String(chat.id).replace(/^-100(?=\d)/, "").replace(/^-/, "");
  return `https://t.me/c/${internal}/${topicId}`;
}


/**
 * The web shows a turn's cost on hover; IM has none, so it becomes a footer.
 * One newline, not a blank line: Telegram has no small or muted text, so the
 * only way to make it read as a footnote instead of its own paragraph is to
 * keep it tucked against the reply.
 */
const turnFooter = (meta: TurnMeta | undefined): string =>
  meta ? `\n<i>${formatTurnMeta(meta)}</i>` : "";

