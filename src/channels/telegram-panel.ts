// Telegram's half of the settings panel: HTML markup, an inline keyboard, and
// a forced reply for the one typed answer. The panel itself lives in
// `panel.ts`.
//
// Asking for a working directory costs a Map here: a forced reply arrives as
// an ordinary message, so the prompt's message id has to be remembered to
// recognize the answer. Slack's modal carries that context itself.

import type { ConversationKey } from "../core/types.js";
import {
  ChatPanel,
  PANEL_PREFIX,
  type PanelButton,
  type PanelDeps,
  type PanelState,
  type PanelView,
} from "./panel.js";
import type { InlineKeyboard, TelegramClient, TgCallbackQuery, TgMessage } from "./telegram-api.js";
import { escapeHtml as esc } from "./telegram-render.js";
import type { ChatConfig, ChatPolicy } from "./types.js";

export interface TelegramPanelDeps extends PanelDeps {
  api: Pick<TelegramClient, "sendMessage" | "editMessage" | "deleteMessage">;
}

/** Where this conversation's panel lives. */
interface TelegramPanelState extends PanelState {
  topicId?: number;
  messageId: number;
}

const button = (b: PanelButton) => ({ text: b.label, callback_data: `${PANEL_PREFIX}${b.action}` });

export class TelegramPanel extends ChatPanel<TelegramPanelState, void> {
  protected readonly platform = "telegram" as const;
  protected readonly fence: [string, string] = ["<code>", "</code>"];
  /** Conversations waiting for a typed working directory (ForceReply). */
  private readonly cwdPrompts = new Map<string, number>();

  constructor(protected override readonly deps: TelegramPanelDeps) {
    super(deps);
  }

  protected esc(text: string): string {
    return esc(text);
  }

  /** Topics are a Telegram-only gate, and only on a forum. */
  protected override gateExtras(chat: ChatConfig, policy: ChatPolicy): string {
    return chat.kind === "forum" ? ` · topics ${policy.topicMode ? "on" : "off"}` : "";
  }

  // --- rendering ---------------------------------------------------------------

  private text(view: PanelView, note?: string): string {
    const body = view.groups
      .map((g) => [`<b>${g.title}</b>${g.suffix ?? ""}`, ...g.lines].join("\n"))
      .join("\n\n");
    return note ? `${body}\n\n<i>${esc(note)}</i>` : body;
  }

  /** A long model id does not share a row with anything. */
  private keyboard(view: PanelView): InlineKeyboard {
    return {
      inline_keyboard: [
        ...(view.picks ?? []).map((pick) => [button(pick)]),
        ...view.rows.map((row) => row.map(button)),
      ],
    };
  }

  /** Open a fresh panel, replacing whichever one this conversation had. */
  async open(key: ConversationKey, chatId: string, topicId?: number): Promise<void> {
    const view = await this.view(key, chatId);
    const sent = await this.deps.api.sendMessage({
      chat_id: chatId,
      message_thread_id: topicId,
      text: this.text(view),
      parse_mode: "HTML",
      reply_markup: this.keyboard(view),
    });
    this.remember(key, { chatId, topicId, messageId: sent.message_id, models: [] });
  }

  protected async draw(
    state: TelegramPanelState,
    view: PanelView,
    note?: string,
  ): Promise<void> {
    await this.deps.api.editMessage({
      chat_id: state.chatId,
      message_id: state.messageId,
      text: this.text(view, note),
      parse_mode: "HTML",
      reply_markup: this.keyboard(view),
    }).catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  protected async erase(state: TelegramPanelState): Promise<void> {
    await this.deps.api.deleteMessage(state.chatId, state.messageId)
      .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
  }

  // --- actions -----------------------------------------------------------------

  /**
   * Handle a `cfg:` button. Returns false when the payload is not ours, so the
   * caller can treat it as one of the agent's next-step labels instead.
   */
  async onCallback(query: TgCallbackQuery, key: ConversationKey): Promise<boolean> {
    return this.dispatch(key, query.data ?? "", undefined, async () => {
      const message = query.message;
      if (message) await this.open(key, String(message.chat.id), message.message_thread_id);
    });
  }

  // --- working directory (one typed answer) ------------------------------------

  protected async promptCwd(key: ConversationKey, state: TelegramPanelState): Promise<void> {
    const sent = await this.deps.api.sendMessage({
      chat_id: state.chatId,
      message_thread_id: state.topicId,
      // Said plainly: this is not an edit, it is a new session.
      text:
        "Reply with an absolute path. A new session starts there; the current one stays in its own directory.",
      reply_markup: { force_reply: true, input_field_placeholder: "/path/to/project" },
    });
    this.cwdPrompts.set(key.conversationId, sent.message_id);
  }

  /**
   * Consume a reply to the working-directory prompt. Returns true when this
   * message was that answer and must not reach the agent.
   */
  async consumeCwdReply(msg: TgMessage, key: ConversationKey): Promise<boolean> {
    const pending = this.cwdPrompts.get(key.conversationId);
    if (!pending || msg.reply_to_message?.message_id !== pending) return false;
    this.cwdPrompts.delete(key.conversationId);
    const path = (msg.text ?? "").trim();
    const started = await this.startSessionIn(key, path);
    // The answer was typed in the chat, so the outcome is said in the chat:
    // a panel note alone would be easy to miss under one's own message.
    await this.deps.api.sendMessage({
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: "error" in started ? started.error : `New session in <code>${esc(path)}</code>.`,
      parse_mode: "HTML",
    });
    return true;
  }
}
