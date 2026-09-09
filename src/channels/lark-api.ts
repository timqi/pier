// Thin Lark (Feishu) client: API shapes and the WebSocket transport, no policy;
// the one file that talks to open.feishu.cn. The long connection is a
// protobuf-framed proprietary protocol, so the official SDK carries the
// transport, confined to this file. Domain is fixed to Feishu. ChannelConfig's
// `token` is the App ID and `appToken` the App Secret. The SDK acks a frame only
// after the handler resolves and Lark redelivers what it never saw answered, so
// handlers return once the event is queued.

import * as Lark from "@larksuiteoapi/node-sdk";

// --- card shapes (schema 2.0) --------------------------------------------------
// Schema 2.0 is what makes button callbacks arrive over the WebSocket; 1.0
// cards only answer to webhooks. 2.0 has no `note`, so the footer is a
// notation-sized markdown element.

export interface LarkButton {
  tag: "button";
  text: { tag: "plain_text"; content: string };
  type: "default" | "primary";
  width?: "fill";
  /** Form-submit buttons carry a name instead of a callback value. */
  name?: string;
  action_type?: "form_submit";
  behaviors?: { type: "callback"; value: LarkActionValue }[];
}

/** `root` rides along because the callback does not carry the message's
 *  thread. `label` too: `message.get` cannot return a 2.0 card (it answers a
 *  "please upgrade your client" post), so the echoed value is the only place a
 *  clicked button's meaning survives. */
export interface LarkActionValue {
  key: string;
  root: string;
  /** Next-step buttons only; panel buttons repaint from their own state. */
  label?: string;
}

export type LarkElement =
  | { tag: "markdown"; content: string; text_size?: "notation" }
  | { tag: "column_set"; flex_mode: "flow"; background_style: "default"; columns: LarkColumn[] }
  | { tag: "form"; name: string; elements: (LarkFormInput | LarkElement | LarkButton)[] }
  | LarkButton;

export interface LarkColumn {
  tag: "column";
  width: "auto";
  elements: LarkButton[];
}

export interface LarkFormInput {
  tag: "input";
  name: string;
  required: boolean;
  label: { tag: "plain_text"; content: string };
  placeholder: { tag: "plain_text"; content: string };
  default_value?: string;
}

export interface LarkCard {
  schema: "2.0";
  body: { direction: "vertical"; elements: LarkElement[] };
}

// --- event shapes ---------------------------------------------------------------

export interface LarkMention {
  key: string;
  id?: { open_id?: string };
  name?: string;
}

/** The subset of `im.message.receive_v1` the adapter reads. */
export interface LarkMessageEvent {
  eventId?: string;
  senderId?: string;
  senderType?: string;
  message: {
    messageId: string;
    rootId?: string;
    chatId: string;
    chatType?: string; // "p2p" | "group"
    messageType?: string;
    /** A JSON string — Lark double-encodes message bodies. */
    content?: string;
    mentions?: LarkMention[];
  };
}

export interface LarkCardAction {
  eventId?: string;
  messageId: string;
  chatId: string;
  operatorId: string;
  value?: Partial<LarkActionValue>;
  /** Form submissions: the submit button's `name` and the typed values. */
  name?: string;
  formValue?: Record<string, unknown>;
}

export interface LarkHandlers {
  onMessage(event: LarkMessageEvent): void;
  onCardAction(action: LarkCardAction): void;
}

/** Ids nested under `context`, with top-level fallbacks for older payload variants. */
interface RawCardTrigger {
  event_id?: string;
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  operator?: { open_id?: string };
  action?: {
    value?: Partial<LarkActionValue>;
    name?: string;
    form_value?: Record<string, unknown>;
  };
}

/** `close()` stops the SDK's own reconnect loop. */
export interface LarkSocket {
  close(): Promise<void>;
}

/** Every call the adapter makes — the seam a test double implements. */
export interface LarkClient {
  botOpenId(): Promise<string>;
  connect(handlers: LarkHandlers): Promise<LarkSocket>;
  /** Deliberately the only way to post: never into a chat's main flow. */
  replyCard(messageId: string, card: LarkCard): Promise<{ messageId: string }>;
  patchCard(messageId: string, card: LarkCard): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  /** `emojiType` is a Lark key (`OnIt`), never a codepoint. */
  addReaction(messageId: string, emojiType: string): Promise<void>;
  /** Deletion is by reaction_id, so this lists and removes only our own. */
  removeReaction(messageId: string, emojiType: string): Promise<void>;
  chatName(chatId: string): Promise<string | undefined>;
  userName(openId: string): Promise<string>;
  uploadFile(
    rootId: string,
    file: { name: string; bytes: Uint8Array; image: boolean },
  ): Promise<void>;
  /** Refuses past `maxBytes` mid-stream. */
  download(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array }>;
}

interface LarkResponse {
  code?: number;
  msg?: string;
}

/** Lark answers HTTP 200 with a business code; non-zero is the real error. */
function ok<T extends LarkResponse>(what: string, res: T): T {
  if (res.code !== 0) throw new Error(`lark ${what}: ${res.code} ${res.msg ?? ""}`.trim());
  return res;
}

export class LarkApi implements LarkClient {
  private readonly client: Lark.Client;
  /** Reaction removal must only touch a reaction this app made. */
  private me = "";

  constructor(
    appId: string,
    appSecret: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.client = new Lark.Client({
      appId,
      appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
    });
    this.appId = appId;
    this.appSecret = appSecret;
  }

  private readonly appId: string;
  private readonly appSecret: string;

  async botOpenId(): Promise<string> {
    const res = await this.client.request<{ code?: number; msg?: string; bot?: { open_id?: string } }>({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    this.me = ok("bot info", res).bot?.open_id ?? "";
    return this.me;
  }

  // --- long connection ---------------------------------------------------------

  /** `card.action.trigger` goes through `register`'s generic because IHandles
   *  types events only, not callbacks. */
  connect(handlers: LarkHandlers): Promise<LarkSocket> {
    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error,
    }).register<{ "card.action.trigger": (data: RawCardTrigger) => Promise<void> }>({
      "im.message.receive_v1": (data) => {
        handlers.onMessage({
          eventId: data.event_id,
          senderId: data.sender?.sender_id?.open_id,
          senderType: data.sender?.sender_type,
          message: {
            messageId: data.message.message_id,
            rootId: data.message.root_id,
            chatId: data.message.chat_id,
            chatType: data.message.chat_type,
            messageType: data.message.message_type,
            content: data.message.content,
            mentions: data.message.mentions,
          },
        });
        // The SDK acks only after this returns; a turn outlives the redelivery deadline.
        return Promise.resolve();
      },
      "card.action.trigger": (data) => {
        handlers.onCardAction({
          eventId: data.event_id,
          messageId: data.context?.open_message_id ?? data.open_message_id ?? "",
          chatId: data.context?.open_chat_id ?? data.open_chat_id ?? "",
          operatorId: data.operator?.open_id ?? "",
          value: data.action?.value,
          name: data.action?.name,
          formValue: data.action?.form_value,
        });
        return Promise.resolve();
      },
    });
    const ws = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
    });
    // Not awaited: start() can sit in the SDK's retry loop for a long time,
    // and ChannelRuntime serializes reloads, so one unreachable network would
    // block every later Console save. botOpenId() already proved the credentials.
    void ws.start({ eventDispatcher: dispatcher })
      .catch((err) => this.log(`lark long connection failed: ${String(err)}`));
    return Promise.resolve({
      close: () => {
        try {
          ws.close();
        } catch (err) {
          this.log(`lark socket close failed: ${String(err)}`);
        }
        return Promise.resolve();
      },
    });
  }

  // --- messages ------------------------------------------------------------------

  async replyCard(messageId: string, card: LarkCard): Promise<{ messageId: string }> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        // Lark's equivalent of posting to a thread_ts.
        reply_in_thread: true,
      },
    });
    return { messageId: ok("message.reply", res).data?.message_id ?? "" };
  }

  /** Images take the image endpoint so they render inline; `stream` is Lark's
   *  "type unknown". The SDK unwraps an upload response to its `data`, so a
   *  failure arrives as a missing key, not a code. */
  async uploadFile(
    rootId: string,
    file: { name: string; bytes: Uint8Array; image: boolean },
  ): Promise<void> {
    const bytes = Buffer.from(file.bytes);
    let content: { image_key: string } | { file_key: string };
    if (file.image) {
      const res = await this.client.im.v1.image.create({
        data: { image_type: "message", image: bytes },
      });
      if (!res?.image_key) throw new Error(`lark image.create: no image_key for ${file.name}`);
      content = { image_key: res.image_key };
    } else {
      const res = await this.client.im.v1.file.create({
        data: { file_type: "stream", file_name: file.name, file: bytes },
      });
      if (!res?.file_key) throw new Error(`lark file.create: no file_key for ${file.name}`);
      content = { file_key: res.file_key };
    }
    ok(
      "message.reply",
      await this.client.im.v1.message.reply({
        path: { message_id: rootId },
        data: {
          msg_type: file.image ? "image" : "file",
          content: JSON.stringify(content),
          reply_in_thread: true,
        },
      }),
    );
  }

  async patchCard(messageId: string, card: LarkCard): Promise<void> {
    ok(
      "message.patch",
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }),
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    ok("message.delete", await this.client.im.v1.message.delete({ path: { message_id: messageId } }));
  }

  // --- reactions -------------------------------------------------------------------

  async addReaction(messageId: string, emojiType: string): Promise<void> {
    ok(
      "reaction.create",
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }),
    );
  }

  /** `operator_type` alone is not ownership: another bot's 👀 is an app
   *  reaction too, and deleting it would strand our own. */
  async removeReaction(messageId: string, emojiType: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const res = ok(
        "reaction.list",
        await this.client.im.v1.messageReaction.list({
          path: { message_id: messageId },
          params: { reaction_type: emojiType, page_size: 50, page_token: pageToken },
        }),
      );
      for (const item of res.data?.items ?? []) {
        const op = item.operator;
        if (op?.operator_type !== "app") continue;
        // The list reports an app operator by open_id or app_id depending on
        // surface; accept either of ours, never a blank.
        const id = (op.operator_id ?? "").trim();
        if (!id || (id !== this.me && id !== this.appId)) continue;
        if (item.reaction_id) {
          ok(
            "reaction.delete",
            await this.client.im.v1.messageReaction.delete({
              path: { message_id: messageId, reaction_id: item.reaction_id },
            }),
          );
          return;
        }
      }
      pageToken = res.data?.has_more ? res.data?.page_token : undefined;
    } while (pageToken);
  }

  // --- lookups ---------------------------------------------------------------------

  async chatName(chatId: string): Promise<string | undefined> {
    const res = ok("chat.get", await this.client.im.v1.chat.get({ path: { chat_id: chatId } }));
    return res.data?.name || undefined;
  }

  async userName(openId: string): Promise<string> {
    // Needs contact:user.base:readonly; without it the id is the honest label.
    try {
      const res = ok(
        "user.get",
        await this.client.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: "open_id" },
        }),
      );
      return res.data?.user?.name || openId;
    } catch (err) {
      this.log(`lark user lookup failed for ${openId}: ${String(err)}`);
      return openId;
    }
  }

  // --- files ----------------------------------------------------------------------

  /** Enforced while streaming: the receive event often omits `file_size`. The
   *  error carries "too large", which the lost-marker wording keys on. */
  async download(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array }> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const stream = res.getReadableStream();
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of stream) {
      const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
      size += buf.length;
      if (size > maxBytes) {
        stream.destroy?.();
        throw new Error(`lark resource ${fileKey}: too large (>${maxBytes} bytes)`);
      }
      parts.push(buf);
    }
    return { bytes: new Uint8Array(Buffer.concat(parts)) };
  }
}
