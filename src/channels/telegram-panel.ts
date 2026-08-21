// The in-chat settings panel: what `@bot` and `/settings` open.
//
// One message, edited in place — a new message per tap would bury the chat.
// Every button payload is namespaced `cfg:` and consumed here, so a panel tap
// can never be mistaken for the agent's own next-step buttons (whose payload is
// the label itself) and never reaches the agent.
//
// Changing the working directory is the one action that is not reversible in
// place: Pi fixes cwd at session creation, so it starts a new session and the
// button says exactly that.

import { compact, thinkingLabel } from "../core/reply.js";
import type { ConversationKey, ModelRef, ThinkingLevel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl, ConversationStatus } from "./control.js";
import type { InlineKeyboard, TelegramClient, TgCallbackQuery, TgMessage } from "./telegram-api.js";
import { escapeHtml as esc } from "./telegram-render.js";
import type { ChatConfig } from "./types.js";

const PREFIX = "cfg:";
const MODELS_PER_PAGE = 8;

const onOff = (v: boolean): string => (v ? "on" : "off");

const button = (text: string, action: string) => ({ text, callback_data: `${PREFIX}${action}` });

export interface PanelDeps {
  api: Pick<TelegramClient, "sendMessage" | "editMessage" | "deleteMessage">;
  control: ChannelControl;
  store: ChannelStore;
  log(message: string): void;
}

/**
 * Where a conversation's panel lives, plus the model list its indices mean.
 * The chat and topic ids are kept here rather than decoded back out of the
 * conversation id: the adapter already knew them when it opened the panel, and
 * re-deriving them would make this file depend on that encoding.
 */
interface PanelState {
  chatId: string;
  topicId?: number;
  messageId: number;
  models: ModelRef[];
}

export class TelegramPanel {
  private readonly panels = new Map<string, PanelState>();
  /** Conversations waiting for a typed working directory (ForceReply). */
  private readonly cwdPrompts = new Map<string, number>();

  constructor(private readonly deps: PanelDeps) {}

  // --- rendering ---------------------------------------------------------------

  private async body(key: ConversationKey, chatId: string): Promise<string> {
    const chat = this.deps.store.chat("telegram", chatId);
    const status = await this.deps.control.status(key);
    return [
      `<b>Session</b>`,
      status ? this.sessionLines(status) : "None yet — send a message to start one.",
      "",
      `<b>Chat</b>`,
      this.chatLines(chatId, chat),
    ].flat().join("\n");
  }

  private sessionLines(status: ConversationStatus): string[] {
    const context = status.tokens !== null && status.contextWindow
      ? `${compact(status.tokens)}/${compact(status.contextWindow)} tok`
      : "not measured yet";
    return [
      `<code>${status.sessionId.slice(0, 8)}</code> · ${status.state}`,
      `Directory: <code>${esc(status.cwd || "?")}</code>`,
      `Model: ${status.model ? esc(status.model.id) : "Pi default"} · ${thinkingLabel(status.thinking)}`,
      `Context: ${context}`,
    ];
  }

  private chatLines(chatId: string, chat: ChatConfig | undefined): string[] {
    if (!chat) return [`<code>${esc(chatId)}</code>`];
    const policy = this.deps.store.policy("telegram", chatId);
    const gates = chat.kind === "dm"
      // A DM is bind-only by construction, so the group knobs would be a lie.
      ? "bound users only"
      : `mention ${onOff(policy.requireMention)} · bind ${onOff(policy.requireBind)}${
        chat.kind === "forum" ? ` · topics ${onOff(policy.topicMode)}` : ""
      }`;
    return [`${esc(chat.name || chatId)} · ${chat.kind} · <code>${esc(chatId)}</code>`, gates];
  }

  private keyboard(status: ConversationStatus | null): InlineKeyboard {
    return {
      inline_keyboard: [
        [button("Model", "models:0"), button("Reasoning", "think")],
        [button("New session", "new"), button("New session in…", "cwd")],
        [
          ...(status?.state === "streaming" ? [button("⏹ Stop", "stop")] : []),
          button("Close", "close"),
        ],
      ],
    };
  }

  /** Open a fresh panel, replacing whichever one this conversation had. */
  async open(key: ConversationKey, chatId: string, topicId?: number): Promise<void> {
    const status = await this.deps.control.status(key);
    const sent = await this.deps.api.sendMessage({
      chat_id: chatId,
      message_thread_id: topicId,
      text: await this.body(key, chatId),
      parse_mode: "HTML",
      reply_markup: this.keyboard(status),
    });
    this.panels.set(key.conversationId, { chatId, topicId, messageId: sent.message_id, models: [] });
  }

  /** Redraw the panel this conversation owns. */
  private async refresh(key: ConversationKey, note?: string): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    if (!panel) return;
    const status = await this.deps.control.status(key);
    const body = await this.body(key, panel.chatId);
    const text = note ? `${body}\n\n<i>${esc(note)}</i>` : body;
    await this.edit(panel, text, this.keyboard(status));
  }

  private async edit(panel: PanelState, text: string, reply_markup: InlineKeyboard): Promise<void> {
    await this.deps.api.editMessage({
      chat_id: panel.chatId,
      message_id: panel.messageId,
      text,
      parse_mode: "HTML",
      reply_markup,
    }).catch((err) => this.deps.log(`panel edit failed: ${String(err)}`));
  }

  // --- actions -----------------------------------------------------------------

  /**
   * Handle a `cfg:` button. Returns false when the payload is not ours, so the
   * caller can treat it as one of the agent's next-step labels instead.
   */
  async onCallback(query: TgCallbackQuery, key: ConversationKey): Promise<boolean> {
    const data = query.data ?? "";
    if (!data.startsWith(PREFIX)) return false;
    const [action = "", arg = ""] = data.slice(PREFIX.length).split(":");
    const panel = this.panels.get(key.conversationId);
    // A panel from a previous process has no state here; reopening is the only
    // honest recovery, and it is one tap.
    if (!panel && action !== "close") {
      const message = query.message;
      if (message) await this.open(key, String(message.chat.id), message.message_thread_id);
      return true;
    }

    switch (action) {
      case "close":
        this.panels.delete(key.conversationId);
        if (panel) {
          await this.deps.api.deleteMessage(panel.chatId, panel.messageId)
            .catch((err) => this.deps.log(`panel close failed: ${String(err)}`));
        }
        return true;
      case "panel":
        await this.refresh(key);
        return true;
      case "models":
        await this.showModels(key, Number(arg) || 0);
        return true;
      case "model":
        await this.pickModel(key, Number(arg));
        return true;
      case "think":
        if (arg) await this.pickThinking(key, arg as ThinkingLevel);
        else await this.showThinking(key);
        return true;
      case "new": {
        const id = await this.deps.control.newSession(key);
        await this.refresh(key, `Started session ${id.slice(0, 8)}.`);
        return true;
      }
      case "cwd":
        await this.promptCwd(key, panel!);
        return true;
      case "stop":
        await this.deps.control.abort(key);
        await this.refresh(key, "Stop requested.");
        return true;
      default:
        this.deps.log(`unknown panel action: ${action}`);
        return true;
    }
  }

  private async showModels(key: ConversationKey, page: number): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    if (!panel) return;
    panel.models = await this.deps.control.models().catch(() => []);
    const status = await this.deps.control.status(key);
    const pages = Math.max(1, Math.ceil(panel.models.length / MODELS_PER_PAGE));
    const at = Math.min(Math.max(page, 0), pages - 1);
    const slice = panel.models.slice(at * MODELS_PER_PAGE, (at + 1) * MODELS_PER_PAGE);
    const rows = slice.map((model, i) => {
      const index = at * MODELS_PER_PAGE + i;
      const current = status?.model?.provider === model.provider && status.model.id === model.id;
      return [button(`${current ? "✓ " : ""}${model.id}`, `model:${index}`)];
    });
    // Paging by index, not by name: callback_data caps at 64 bytes.
    const nav = [
      ...(at > 0 ? [button("‹ Prev", `models:${at - 1}`)] : []),
      ...(at < pages - 1 ? [button("Next ›", `models:${at + 1}`)] : []),
      button("‹ Back", "panel"),
    ];
    await this.edit(
      panel,
      `<b>Model</b> · page ${at + 1}/${pages}${panel.models.length ? "" : "\n\nNo models with configured auth."}`,
      { inline_keyboard: [...rows, nav] },
    );
  }

  private async pickModel(key: ConversationKey, index: number): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    const model = panel?.models[index];
    if (!model) return this.refresh(key, "That model is no longer listed.");
    try {
      await this.deps.control.setModel(key, model);
      await this.refresh(key, `Model set to ${model.id}.`);
    } catch (err) {
      await this.refresh(key, `Could not set that model: ${String(err)}`);
    }
  }

  private async showThinking(key: ConversationKey): Promise<void> {
    const panel = this.panels.get(key.conversationId);
    const status = await this.deps.control.status(key);
    if (!panel) return;
    const levels = status?.thinkingLevels ?? [];
    const rows = levels.map((level) => [
      button(`${status?.thinking === level ? "✓ " : ""}${thinkingLabel(level)}`, `think:${level}`),
    ]);
    await this.edit(panel, `<b>Reasoning</b>${levels.length ? "" : "\n\nThis model has no levels."}`, {
      inline_keyboard: [...rows, [button("‹ Back", "panel")]],
    });
  }

  private async pickThinking(key: ConversationKey, level: ThinkingLevel): Promise<void> {
    await this.deps.control.setThinking(key, level);
    await this.refresh(key, `Reasoning set to ${thinkingLabel(level)}.`);
  }

  // --- working directory (one typed answer) ------------------------------------

  private async promptCwd(key: ConversationKey, panel: PanelState): Promise<void> {
    const sent = await this.deps.api.sendMessage({
      chat_id: panel.chatId,
      message_thread_id: panel.topicId,
      // Said plainly: this is not an edit, it is a new session.
      text: "Reply with an absolute path. A new session starts there; the current one stays in its own directory.",
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
    if (!path.startsWith("/")) {
      await this.deps.api.sendMessage({
        chat_id: msg.chat.id,
        message_thread_id: msg.message_thread_id,
        text: "That is not an absolute path — nothing changed.",
      });
      return true;
    }
    try {
      const id = await this.deps.control.newSession(key, path);
      await this.refresh(key, `Started session ${id.slice(0, 8)} in ${path}.`);
      await this.deps.api.sendMessage({
        chat_id: msg.chat.id,
        message_thread_id: msg.message_thread_id,
        text: `New session in <code>${esc(path)}</code>.`,
        parse_mode: "HTML",
      });
    } catch (err) {
      await this.deps.api.sendMessage({
        chat_id: msg.chat.id,
        message_thread_id: msg.message_thread_id,
        text: `Could not start a session there: ${String(err)}`,
      });
    }
    return true;
  }
}
