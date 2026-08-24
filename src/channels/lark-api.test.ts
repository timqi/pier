// The production boundary, tested against a mocked SDK: event normalization
// (the wire shapes the adapter's golden tests assume), the fire-and-forget
// long connection, business-code errors, reaction ownership, and the
// mid-stream download cap. The SDK itself is stubbed — these tests pin what
// Pier does with it, not what Lark does.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Handles {
  [key: string]: (data: unknown) => Promise<void>;
}

/** What the test scripts per SDK call; reset in beforeEach. */
const sdk = {
  registered: {} as Handles,
  wsStarted: 0,
  wsClosed: 0,
  /** ws.start's promise never settles — connect() must not care. */
  request: vi.fn(),
  reply: vi.fn(),
  get: vi.fn(),
  reactionList: vi.fn(),
  reactionDelete: vi.fn(),
  resourceGet: vi.fn(),
};

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu" },
  LoggerLevel: { error: "error" },
  EventDispatcher: class {
    register(handles: Handles) {
      Object.assign(sdk.registered, handles);
      return this;
    }
  },
  WSClient: class {
    start(): Promise<void> {
      sdk.wsStarted++;
      return new Promise(() => {}); // the SDK may retry forever; see test
    }
    close(): void {
      sdk.wsClosed++;
    }
  },
  Client: class {
    request = sdk.request;
    im = {
      v1: {
        message: { reply: sdk.reply, patch: vi.fn(), delete: vi.fn(), get: sdk.get },
        messageReaction: { create: vi.fn(), list: sdk.reactionList, delete: sdk.reactionDelete },
        messageResource: { get: sdk.resourceGet },
        chat: { get: vi.fn() },
      },
    };
    contact = { v3: { user: { get: vi.fn() } } };
  },
}));

const { LarkApi } = await import("./lark-api.js");

let api: InstanceType<typeof LarkApi>;
let logs: string[];

beforeEach(() => {
  sdk.registered = {};
  sdk.wsStarted = 0;
  sdk.wsClosed = 0;
  for (const fn of [sdk.request, sdk.reply, sdk.get, sdk.reactionList, sdk.reactionDelete, sdk.resourceGet]) {
    fn.mockReset();
  }
  logs = [];
  api = new LarkApi("cli_app", "secret", (m) => logs.push(m));
});

describe("connect", () => {
  it("resolves without waiting for the SDK's start, and close() reaches the socket", async () => {
    const socket = await api.connect({ onMessage: () => {}, onCardAction: () => {} });
    expect(sdk.wsStarted).toBe(1);
    await socket.close();
    expect(sdk.wsClosed).toBe(1);
  });

  it("normalizes im.message.receive_v1 and resolves the handler immediately", async () => {
    const events: unknown[] = [];
    await api.connect({ onMessage: (e) => events.push(e), onCardAction: () => {} });
    await sdk.registered["im.message.receive_v1"]!({
      event_id: "ev1",
      sender: { sender_id: { open_id: "ou_42" }, sender_type: "user" },
      message: {
        message_id: "om_1",
        root_id: "om_root",
        chat_id: "oc_1",
        chat_type: "group",
        message_type: "text",
        content: "{\"text\":\"hi\"}",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Pier" }],
      },
    });
    expect(events).toEqual([{
      eventId: "ev1",
      senderId: "ou_42",
      senderType: "user",
      message: {
        messageId: "om_1",
        rootId: "om_root",
        chatId: "oc_1",
        chatType: "group",
        messageType: "text",
        content: "{\"text\":\"hi\"}",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Pier" }],
      },
    }]);
  });

  it("normalizes card.action.trigger, ids nested under context or at the root", async () => {
    const actions: unknown[] = [];
    await api.connect({ onMessage: () => {}, onCardAction: (a) => actions.push(a) });
    const handler = sdk.registered["card.action.trigger"]!;
    await handler({
      event_id: "ev2",
      context: { open_message_id: "om_9", open_chat_id: "oc_9" },
      operator: { open_id: "ou_42" },
      action: { value: { key: "sg:0", root: "om_r" } },
    });
    await handler({
      open_message_id: "om_flat",
      open_chat_id: "oc_flat",
      operator: { open_id: "ou_42" },
      action: { name: "cwdgo:om_r", form_value: { cwd: "/x" } },
    });
    expect(actions[0]).toMatchObject({ eventId: "ev2", messageId: "om_9", chatId: "oc_9", value: { key: "sg:0" } });
    expect(actions[1]).toMatchObject({ messageId: "om_flat", chatId: "oc_flat", name: "cwdgo:om_r", formValue: { cwd: "/x" } });
  });
});

describe("business-code errors", () => {
  it("throws the code and message on a non-zero answer", async () => {
    sdk.reply.mockResolvedValue({ code: 230002, msg: "bot not in chat" });
    await expect(api.replyCard("om_1", { schema: "2.0", body: { direction: "vertical", elements: [] } }))
      .rejects.toThrow("lark message.reply: 230002 bot not in chat");
  });

});

describe("reaction ownership", () => {
  it("removes only this app's reaction, paging past other apps'", async () => {
    sdk.request.mockResolvedValue({ code: 0, bot: { open_id: "ou_me" } });
    await api.botOpenId();
    sdk.reactionList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            // Another bot's 👀 — an app operator, but not ours.
            { reaction_id: "r_theirs", reaction_type: { emoji_type: "OnIt" }, operator: { operator_type: "app", operator_id: "ou_other" } },
            { reaction_id: "r_human", reaction_type: { emoji_type: "OnIt" }, operator: { operator_type: "user", operator_id: "ou_42" } },
          ],
          has_more: true,
          page_token: "p2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ reaction_id: "r_mine", reaction_type: { emoji_type: "OnIt" }, operator: { operator_type: "app", operator_id: "ou_me" } }],
          has_more: false,
        },
      });
    sdk.reactionDelete.mockResolvedValue({ code: 0 });
    await api.removeReaction("om_1", "OnIt");
    expect(sdk.reactionDelete).toHaveBeenCalledTimes(1);
    expect(sdk.reactionDelete.mock.calls[0]![0]).toMatchObject({ path: { message_id: "om_1", reaction_id: "r_mine" } });
  });
});

describe("download cap", () => {
  const streamOf = (chunks: Buffer[], destroy: () => void) => ({
    getReadableStream: () => ({
      destroy,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    }),
  });

  it("aborts a stream that outgrows the cap, naming the reason", async () => {
    const destroy = vi.fn();
    sdk.resourceGet.mockResolvedValue(streamOf([Buffer.alloc(600), Buffer.alloc(600)], destroy));
    await expect(api.download("om_1", "f1", "file", 1000)).rejects.toThrow(/too large/);
    expect(destroy).toHaveBeenCalled();
  });

  it("returns the joined bytes under the cap", async () => {
    sdk.resourceGet.mockResolvedValue(streamOf([Buffer.from("ab"), Buffer.from("cd")], vi.fn()));
    const { bytes } = await api.download("om_1", "f1", "file", 1000);
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });
});
