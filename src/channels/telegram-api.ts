// Thin Telegram Bot API client: HTTP and payload shapes only, no policy.
// The one file in channels/ that talks to api.telegram.org, so the adapter
// stays testable against this interface. Long polling, not webhooks — Pier is
// one local process with no inbound HTTP requirement.
//
// Behind a proxy, run node with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set;
// nothing here needs to know.

const BASE = "https://api.telegram.org";

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  /** Public supergroups have one; it makes for a nicer deep link. */
  username?: string;
  is_forum?: boolean;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  photo?: { file_id: string; file_size?: number }[];
  /** Telegram echoes the inline keyboard back on the message it belongs to. */
  reply_markup?: InlineKeyboard;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgSend {
  chat_id: string | number;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  parse_mode?: "HTML";
  reply_markup?: InlineKeyboard | ForceReply;
}

/** Telegram's way to ask for one typed answer: the client pre-fills a reply. */
export interface ForceReply {
  force_reply: true;
  input_field_placeholder?: string;
}

export interface TgEdit {
  chat_id: string | number;
  message_id: number;
  text: string;
  parse_mode?: "HTML";
  reply_markup?: InlineKeyboard;
}

/** Every method the adapter needs — the seam a test double implements. */
export interface TelegramClient {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TgUpdate[]>;
  sendMessage(payload: TgSend): Promise<TgMessage>;
  /** Panels are edited in place; a new message per tap would bury the chat. */
  editMessage(payload: TgEdit): Promise<void>;
  deleteMessage(chatId: string | number, messageId: number): Promise<void>;
  /** Retire a used keyboard without touching the message text. */
  clearKeyboard(chatId: string | number, messageId: number): Promise<void>;
  /** Empty emoji clears; Telegram allows one bot reaction per message. */
  setReaction(chatId: string | number, messageId: number, emoji: string | null): Promise<void>;
  createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }>;
  /** `text` shows as a toast — the way to answer a tap without a message. */
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  downloadPhoto(fileId: string): Promise<{ data: string; mimeType: string }>;
}

export class TelegramApi implements TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, payload: unknown, timeoutMs = 30_000, retry = true): Promise<T> {
    const res = await fetch(`${BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (body.ok) return body.result as T;
    // Telegram answers a flood (a long turn split into chunks hits ~1 msg/s per
    // chat) with the exact wait. Obeying it once turns a dropped reply into a
    // late one; a second 429 is a real problem and surfaces as an error.
    const after = body.parameters?.retry_after;
    if (retry && after !== undefined && after <= 60) {
      await new Promise((r) => setTimeout(r, (after + 1) * 1000));
      return this.call<T>(method, payload, timeoutMs, false);
    }
    throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe", {});
  }

  getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      (timeoutSeconds + 15) * 1000,
    );
  }

  sendMessage(payload: TgSend): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", payload);
  }

  async editMessage(payload: TgEdit): Promise<void> {
    await this.call("editMessageText", payload);
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async clearKeyboard(chatId: string | number, messageId: number): Promise<void> {
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
  }

  async setReaction(chatId: string | number, messageId: number, emoji: string | null): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  }

  createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }> {
    return this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  async downloadPhoto(fileId: string): Promise<{ data: string; mimeType: string }> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("telegram getFile: no file_path");
    const res = await fetch(`${BASE}/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    return { data: buf.toString("base64"), mimeType };
  }
}
