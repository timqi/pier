// Thin Telegram Bot API client: HTTP and payload shapes only, no policy.
// The one file in channels/ that talks to api.telegram.org, so the adapter
// stays testable against this interface. Long polling, not webhooks — Pier is
// one local process with no inbound HTTP requirement.
//
// Behind a proxy, run node with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set;
// nothing here needs to know.

import { readCapped } from "../core/inbox.js";

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
  /** A non-photo attachment (sent as "File"); photos compressed by Telegram
   *  arrive in `photo` instead. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
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

/** One file on its way out. `image` picks `sendPhoto` (inline) over
 *  `sendDocument` (a download card) — see channels/attach.ts. */
export interface TgSendFile {
  chat_id: string | number;
  message_thread_id?: number;
  file: { name: string; bytes: Uint8Array; image: boolean };
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
  /** Upload one file into a chat (or a forum topic). */
  sendFile(payload: TgSendFile): Promise<void>;
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
  /** Bytes of any file_id; `name` is the basename Telegram stored it under. */
  downloadFile(fileId: string, maxBytes: number): Promise<{ bytes: Uint8Array; name: string }>;
}

export class TelegramApi implements TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, payload: unknown, timeoutMs = 30_000, retry = true): Promise<T> {
    // An upload is the one call that is not JSON: FormData carries the bytes,
    // and fetch sets its own multipart boundary. It is re-sendable, so the
    // flood retry below still works on it.
    const multipart = payload instanceof FormData;
    const res = await fetch(`${BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: multipart ? undefined : { "content-type": "application/json" },
      body: multipart ? payload : JSON.stringify(payload),
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

  /** Bytes, not a file_id or a URL: the file is local to this machine, which
   *  is the whole reason the agent could not just link it. */
  async sendFile({ chat_id, message_thread_id, file }: TgSendFile): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chat_id));
    if (message_thread_id !== undefined) form.set("message_thread_id", String(message_thread_id));
    const field = file.image ? "photo" : "document";
    // Copied into a fresh view: a Blob part must be backed by an ArrayBuffer,
    // and a Buffer read off disk carries the wider ArrayBufferLike type.
    form.set(field, new Blob([new Uint8Array(file.bytes)]), file.name);
    // A long upload on a slow link is not a hung request; 30s is the budget
    // for a JSON call, not for megabytes.
    await this.call(file.image ? "sendPhoto" : "sendDocument", form, 120_000);
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

  /** Bounded mid-stream: metadata size is the platform's word, not a cap. */
  async downloadFile(fileId: string, maxBytes: number): Promise<{ bytes: Uint8Array; name: string }> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("telegram getFile: no file_path");
    const res = await fetch(`${BASE}/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const name = file.file_path.split("/").pop() || "file";
    return { bytes: await readCapped(res.body, maxBytes), name };
  }
}
