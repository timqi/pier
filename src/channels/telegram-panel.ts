// Telegram's half of the settings panel (panel.ts has the rest). A forced reply
// arrives as an ordinary message, so the prompt's id is remembered to recognize it.

import type { ConversationKey } from "../core/types.js";
import {
  ChatPanel,
  CWD_PLACEHOLDER,
  CWD_TAIL,
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

interface TelegramPanelState extends PanelState {
  topicId?: number;
  messageId: number;
}

const button = (b: PanelButton) => ({ text: b.label, callback_data: `${PANEL_PREFIX}${b.action}` });

export class TelegramPanel extends ChatPanel<TelegramPanelState, void> {
  protected readonly platform = "telegram" as const;
  protected readonly fence: [string, string] = ["<code>", "</code>"];
  private readonly cwdPrompts = new Map<string, number>();

  constructor(protected override readonly deps: TelegramPanelDeps) {
    super(deps);
  }

  protected esc(text: string): string {
    return esc(text);
  }

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

  /** Returns false when the payload is not ours. */
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
      text:
        `Reply with an absolute path. ${CWD_TAIL}`,
      reply_markup: { force_reply: true, input_field_placeholder: CWD_PLACEHOLDER },
    });
    this.cwdPrompts.set(key.conversationId, sent.message_id);
  }

  /** True when this message was the answer and must not reach the agent. */
  async consumeCwdReply(msg: TgMessage, key: ConversationKey): Promise<boolean> {
    const pending = this.cwdPrompts.get(key.conversationId);
    if (!pending || msg.reply_to_message?.message_id !== pending) return false;
    this.cwdPrompts.delete(key.conversationId);
    const path = (msg.text ?? "").trim();
    const started = await this.startSessionIn(key, path);
    // The answer was typed in the chat, so the outcome is said there too.
    await this.deps.api.sendMessage({
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: "error" in started ? started.error : `New session in <code>${esc(path)}</code>.`,
      parse_mode: "HTML",
    });
    return true;
  }
}
