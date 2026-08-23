// Adapter golden test: a fake Bot API client in, normalized messages and
// recorded API calls out. Hermetic — no network, no $HOME (in-memory store).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitInboundFiles } from "../core/inbound-file.js";
import { openDb } from "../db.js";
import type { ConversationKey, InboundMessage, ModelRef, ThinkingLevel } from "../core/types.js";
import { ChannelStore } from "./config.js";
import { ReceiptLedger } from "./receipts.js";
import { TelegramChannel } from "./telegram.js";
import type { ChannelControl } from "./control.js";
import type { TelegramClient, TgEdit, TgMessage, TgSend, TgUpdate, TgUser } from "./telegram-api.js";

const BOT: TgUser = { id: 1, username: "pierbot", first_name: "Pier" };

class FakeClient implements TelegramClient {
  readonly sent: TgSend[] = [];
  readonly reactions: { chatId: string | number; messageId: number; emoji: string | null }[] = [];
  readonly topics: { chatId: string | number; name: string }[] = [];
  queue: TgUpdate[] = [];
  nextTopicId = 77;
  closed = false;

  getMe(): Promise<TgUser> {
    return Promise.resolve(BOT);
  }

  /**
   * Real long-poll semantics: park until something is queued. Resolving an
   * empty batch instantly would either spin the adapter's loop or trip its
   * anti-spin floor, and neither belongs in a behaviour test.
   */
  async getUpdates(): Promise<TgUpdate[]> {
    for (let i = 0; i < 2000 && !this.closed; i++) {
      if (this.queue.length) {
        const batch = this.queue;
        this.queue = [];
        return batch;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    return [];
  }

  readonly edits: TgEdit[] = [];
  readonly deletes: number[] = [];
  nextMessageId = 999;

  sendMessage(payload: TgSend): Promise<TgMessage> {
    this.sent.push(payload);
    return Promise.resolve({ message_id: this.nextMessageId++, chat: { id: 1, type: "private" } });
  }

  editMessage(payload: TgEdit): Promise<void> {
    this.edits.push(payload);
    return Promise.resolve();
  }

  readonly cleared: number[] = [];

  deleteMessage(_chatId: string | number, messageId: number): Promise<void> {
    this.deletes.push(messageId);
    return Promise.resolve();
  }

  clearKeyboard(_chatId: string | number, messageId: number): Promise<void> {
    this.cleared.push(messageId);
    return Promise.resolve();
  }

  setReaction(chatId: string | number, messageId: number, emoji: string | null): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
    return Promise.resolve();
  }

  createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }> {
    this.topics.push({ chatId, name });
    return Promise.resolve({ message_thread_id: this.nextTopicId });
  }

  readonly toasts: (string | undefined)[] = [];

  answerCallbackQuery(_id: string, text?: string): Promise<void> {
    this.toasts.push(text);
    return Promise.resolve();
  }

  downloaded: string[] = [];

  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; name: string }> {
    this.downloaded.push(fileId);
    return Promise.resolve({ bytes: new TextEncoder().encode("fo"), name: `${fileId}.jpg` });
  }
}

let store: ChannelStore;
let client: FakeClient;
let channel: TelegramChannel;
let inbound: InboundMessage[];
let dropped: string[];
let receipts: ReceiptLedger;
let aborted: string[];
let control: ChannelControl & {
  created: { key: string; cwd?: string }[];
  models_: ModelRef[];
  thinking?: ThinkingLevel;
  model?: ModelRef;
};

/** Feed one update batch and wait for the poll loop to drain it. */
async function feed(...updates: TgUpdate[]): Promise<void> {
  client.queue = updates;
  for (let i = 0; i < 200 && client.queue.length; i++) await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => setTimeout(r, 10));
}

const message = (over: Partial<TgMessage> & { chat: TgMessage["chat"] }): TgUpdate => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: 10, from: { id: 42, first_name: "Q" }, ...over },
});

/** Open the group gates and bind the test sender (a DM is bind-only). */
function openGates(): void {
  const config = store.get("telegram");
  config.requireMention = false;
  config.requireBind = false;
  store.save("telegram", config);
  store.redeemBindCode("telegram", store.issueBindCode("telegram").code, { id: "42", name: "Q" });
}

/** Scripted ChannelControl: records what the panel asked core to do. */
function fakeControl() {
  const state = {
    created: [] as { key: string; cwd?: string }[],
    models_: [
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "openai", id: "gpt-5" },
    ] as ModelRef[],
    model: { provider: "anthropic", id: "claude-opus-4-5" } as ModelRef | undefined,
    thinking: "medium" as ThinkingLevel | undefined,
    launchFor: () => ({}),
    abort: (key: ConversationKey) => {
      aborted.push(key.conversationId);
      return Promise.resolve();
    },
    status: () =>
      Promise.resolve({
        sessionId: "session-abcdef12",
        cwd: "/srv/ops",
        state: "idle" as const,
        model: state.model,
        thinking: state.thinking ?? "medium",
        thinkingLevels: ["off", "medium", "high"] as ThinkingLevel[],
        tokens: 32_140,
        contextWindow: 200_000,
      }),
    models: () => Promise.resolve(state.models_),
    setModel: (_k: ConversationKey, model: ModelRef) => {
      state.model = model;
      return Promise.resolve();
    },
    setThinking: (_k: ConversationKey, level: ThinkingLevel) => {
      state.thinking = level;
      return Promise.resolve();
    },
    newSession: (key: ConversationKey, cwd?: string) => {
      state.created.push({ key: key.conversationId, cwd });
      return Promise.resolve("session-99887766");
    },
  };
  return state as unknown as typeof control;
}

const GROUP = { id: -100, type: "supergroup" as const, title: "Ops" };
const FORUM = { ...GROUP, is_forum: true };
const DM = { id: 42, type: "private" as const };

beforeEach(async () => {
  store = new ChannelStore(openDb(":memory:"));
  client = new FakeClient();
  inbound = [];
  dropped = [];
  receipts = new ReceiptLedger("telegram", openDb(":memory:"));
  aborted = [];
  control = fakeControl();
  channel = new TelegramChannel({ store, client, receipts, log: (m) => dropped.push(m), control });
  await channel.start((msg) => inbound.push(msg));
});

afterEach(async () => {
  client.closed = true;
  await channel.stop();
});

describe("gating", () => {
  it("drops an unmentioned group message under the default policy", async () => {
    await feed(message({ chat: GROUP, text: "hello there" }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in chat -100: not-addressed"]);
    // Discovery still happened: the operator can now configure the chat.
    expect(store.chat("telegram", "-100")).toMatchObject({ name: "Ops", kind: "group", enabled: true });
  });

  it("drops a mentioned message from an unbound sender", async () => {
    await feed(message({ chat: GROUP, text: "@pierbot ship it" }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in chat -100: not-bound"]);
  });

  it("accepts a mentioned bound sender, stripping the handle", async () => {
    store.redeemBindCode("telegram", store.issueBindCode("telegram").code, { id: "42", name: "Q" });
    await feed(message({ chat: GROUP, text: "@pierbot ship it" }));
    expect(inbound).toEqual([{
      key: { channelId: "telegram", conversationId: "-100" },
      senderId: "42",
      sender: { id: "42", name: "Q" },
      text: "ship it",
      mode: "steer",
    }]);
  });

  it("a reply to the bot counts as addressing it", async () => {
    store.redeemBindCode("telegram", store.issueBindCode("telegram").code, { id: "42", name: "Q" });
    await feed(message({
      chat: GROUP,
      text: "and the tests?",
      reply_to_message: { message_id: 9, chat: GROUP, from: BOT },
    }));
    expect(inbound).toHaveLength(1);
  });

  it("a DM needs no mention but always needs a bound sender", async () => {
    // Even with both group knobs off: a DM is bind-only by construction.
    const config = store.get("telegram");
    config.requireMention = false;
    config.requireBind = false;
    store.save("telegram", config);
    await feed(message({ chat: DM, text: "hi" }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in chat 42: not-bound"]);
    // ...and it says how to fix that, instead of swallowing the message.
    expect(client.sent[0]?.text).toMatch(/not bound yet.*\/bind <code>/);

    store.redeemBindCode("telegram", store.issueBindCode("telegram").code, { id: "42", name: "Q" });
    await feed(message({ chat: DM, text: "hi" }));
    expect(inbound).toHaveLength(1);
  });

  it("hints once, not once per message — a stranger must not get an echo", async () => {
    await feed(message({ chat: DM, text: "one" }));
    await feed({ update_id: 9, message: { message_id: 11, chat: DM, from: { id: 42 }, text: "two" } });
    expect(client.sent).toHaveLength(1);
  });

  it("a group stays silent when it denies", async () => {
    await feed(message({ chat: GROUP, text: "@pierbot hello" }));
    expect(dropped).toEqual(["dropped message in chat -100: not-bound"]);
    expect(client.sent).toEqual([]);
  });

  it("honours a per-chat override of the global default", async () => {
    const config = store.get("telegram");
    config.requireBind = false;
    store.save("telegram", config);
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    const chat = store.get("telegram");
    chat.chats[0]!.requireMention = false;
    store.save("telegram", chat);
    await feed(message({ chat: GROUP, text: "no mention needed" }));
    expect(inbound).toHaveLength(1);
  });

  it("drops everything in a disabled chat", async () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "group" });
    const config = store.get("telegram");
    config.requireMention = false;
    config.requireBind = false;
    config.chats[0]!.enabled = false;
    store.save("telegram", config);
    await feed(message({ chat: GROUP, text: "hello" }));
    expect(dropped).toEqual(["dropped message in chat -100: chat-disabled"]);
  });
});

describe("bind", () => {
  it("redeems a code sent in a DM even while unbound", async () => {
    const { code } = store.issueBindCode("telegram");
    await feed(message({ chat: DM, text: `/bind ${code}` }));
    expect(store.isBound("telegram", "42")).toBe(true);
    expect(client.sent[0]?.text).toBe("Bound as Q.");
    expect(inbound).toEqual([]); // a bind is not a prompt
  });

  it("reports a bad code instead of binding", async () => {
    await feed(message({ chat: DM, text: "/bind NOPE" }));
    expect(store.isBound("telegram", "42")).toBe(false);
    expect(client.sent[0]?.text).toMatch(/invalid or expired/);
  });
});

describe("topic mode", () => {
  beforeEach(() => {
    openGates();
  });

  it("opens a topic named after the first line and routes the session there", async () => {
    await feed(message({ chat: FORUM, text: "fix the flaky test\nsecond line" }));
    expect(client.topics).toEqual([{ chatId: -100, name: "fix the flaky test" }]);
    expect(inbound[0]?.key.conversationId).toBe("-100/77");
    // General gets a pointer so the request does not look ignored, and the
    // title is the link into the new topic — the point is to leave General.
    expect(client.sent[0]).toMatchObject({
      chat_id: -100,
      reply_to_message_id: 10,
      text: '→ <a href="https://t.me/c/100/77">fix the flaky test</a>',
    });
  });

  it("links a private supergroup by its /c/ id and a public one by username", async () => {
    const priv = { id: -1004493767833, type: "supergroup" as const, title: "Ops", is_forum: true };
    await feed(message({ chat: priv, text: "one" }));
    expect(client.sent.at(-1)!.text).toContain('href="https://t.me/c/4493767833/77"');

    client.nextTopicId = 78;
    await feed({
      update_id: 99,
      message: {
        message_id: 12,
        chat: { ...priv, id: -1009, username: "opsroom" },
        from: { id: 42 },
        text: "two",
      },
    });
    expect(client.sent.at(-1)!.text).toContain('href="https://t.me/opsroom/78"');
  });

  it("escapes a title that would otherwise break the link markup", async () => {
    await feed(message({ chat: FORUM, text: "fix <b>this</b> & that" }));
    expect(client.sent[0]!.text).toBe(
      '→ <a href="https://t.me/c/100/77">fix &lt;b&gt;this&lt;/b&gt; &amp; that</a>',
    );
  });

  it("truncates a long title", async () => {
    await feed(message({ chat: FORUM, text: "x".repeat(200) }));
    expect(client.topics[0]?.name).toHaveLength(60);
  });

  it("stays put inside an existing topic", async () => {
    await feed(message({ chat: FORUM, text: "more", message_thread_id: 12 }));
    expect(client.topics).toEqual([]);
    expect(inbound[0]?.key.conversationId).toBe("-100/12");
  });

  it("stays put for replies and commands — those continue something", async () => {
    await feed(message({ chat: FORUM, text: "/status" }));
    await feed(message({
      chat: FORUM,
      text: "and?",
      reply_to_message: { message_id: 9, chat: FORUM, from: BOT },
    }));
    expect(client.topics).toEqual([]);
    // Every decline says why: this is the only way to tell "working as
    // designed" from "broken" once a real group is involved.
    expect(dropped).toEqual([
      "no new topic in chat -100: message is a command",
      "no new topic in chat -100: message is a reply, so it continues an existing thread",
    ]);
  });

  it("says a plain group has Topics disabled rather than staying silent", async () => {
    await feed(message({ chat: GROUP, text: "hello" }));
    expect(dropped).toEqual(["no new topic in chat -100: group has Topics disabled in Telegram"]);
  });

  it("never opens topics in a non-forum group or a DM", async () => {
    await feed(message({ chat: GROUP, text: "hello" }), message({ chat: DM, text: "hello" }));
    expect(client.topics).toEqual([]);
    expect(inbound.map((m) => m.key.conversationId)).toEqual(["-100", "42"]);
  });

  it("falls back to General when topic creation fails", async () => {
    client.createForumTopic = () => Promise.reject(new Error("no rights"));
    await feed(message({ chat: FORUM, text: "hello" }));
    expect(inbound[0]?.key.conversationId).toBe("-100");
    expect(dropped[0]).toMatch(/topic creation failed/);
  });

  it("is skipped when the chat opts out", async () => {
    store.discoverChat("telegram", { id: "-100", name: "Ops", kind: "forum" });
    const config = store.get("telegram");
    config.chats[0]!.topicMode = false;
    store.save("telegram", config);
    await feed(message({ chat: FORUM, text: "hello" }));
    expect(client.topics).toEqual([]);
  });
});

describe("reaction receipts", () => {
  beforeEach(() => {
    openGates();
  });

  it("marks every message of a turn and clears them all when it settles", async () => {
    await feed(message({ chat: DM, text: "one" }));
    await feed({ update_id: 2, message: { message_id: 11, chat: DM, from: { id: 42 }, text: "also this" } });
    expect(client.reactions).toEqual([
      { chatId: "42", messageId: 10, emoji: "👀" },
      { chatId: "42", messageId: 11, emoji: "👀" },
    ]);
    await channel.send("42", { text: "done", suggestions: [] });
    expect(client.reactions.slice(2)).toEqual([
      { chatId: "42", messageId: 10, emoji: null },
      { chatId: "42", messageId: 11, emoji: null },
    ]);
  });

  it("says an empty turn happened, and clears its receipts", async () => {
    await feed(message({ chat: DM, text: "one" }));
    // Total silence is indistinguishable from a crash, so an empty turn still
    // posts one muted line saying which kind of nothing it was.
    await channel.send("42", {
      text: "",
      suggestions: [],
      meta: { completedAt: Date.now(), durationMs: 3000, tokens: 7900 },
    });
    expect(client.sent.at(-1)!.text).toContain("no reply");
    expect(client.reactions.at(-1)).toEqual({ chatId: "42", messageId: 10, emoji: null });
  });

  it("clears receipts a dead process left behind, at startup", async () => {
    // What a crash between 👀 and turn-end leaves on the books.
    receipts.add({ conversationId: "-100/5", chatId: "-100", messageId: "88" });
    const reborn = new TelegramChannel({ store, client, receipts, log: (m) => dropped.push(m) });
    await reborn.start(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(client.reactions).toEqual([{ chatId: "-100", messageId: 88, emoji: null }]);
    client.closed = true;
    await reborn.stop();
  });

  it("keeps two topics' receipts apart", async () => {
    await feed(message({ chat: FORUM, text: "a", message_thread_id: 5 }));
    await feed({
      update_id: 3,
      message: { message_id: 11, chat: FORUM, from: { id: 42 }, text: "b", message_thread_id: 6 },
    });
    await channel.send("-100/5", { text: "", suggestions: [] });
    expect(client.reactions.filter((r) => r.emoji === null)).toEqual([
      { chatId: "-100", messageId: 10, emoji: null },
    ]);
  });
});

describe("outbound", () => {
  it("renders markdown as Telegram HTML in the right topic", async () => {
    await channel.send("-100/7", { text: "**bold** and `code`", suggestions: [] });
    expect(client.sent).toEqual([{
      chat_id: "-100",
      message_thread_id: 7,
      text: "<b>bold</b> and <code>code</code>",
      parse_mode: "HTML",
      reply_markup: undefined,
    }]);
  });

  it("carries an index, not the label — a CJK label blows the 64-byte cap", async () => {
    // 67 bytes as a payload; this is what silently dropped every button before.
    const long = "验证不同任务的结果是否能发送到指定 Telegram 话题";
    expect(Buffer.byteLength(long)).toBeGreaterThan(64);
    await channel.send("42", { text: "pick", suggestions: [long, "跑一下测试"] });
    expect(client.sent[0]?.reply_markup).toEqual({
      inline_keyboard: [
        // The wide one keeps its own row; squeezing it would truncate its neighbour.
        [{ text: long, callback_data: "sg:0" }],
        [{ text: "跑一下测试", callback_data: "sg:1" }],
      ],
    });
  });

  it("packs short labels onto shared rows, in the offered order", async () => {
    await channel.send("42", { text: "pick", suggestions: ["Run it", "Diff", "Later", "跑一下测试", "改配置"] });
    const markup = client.sent[0]!.reply_markup as { inline_keyboard: { text: string }[][] };
    const rows = markup.inline_keyboard;
    expect(rows.map((row) => row.map((b) => b.text))).toEqual([
      // 6 + 4 + 5 cells, and three is the per-row cap.
      ["Run it", "Diff", "Later"],
      // 10 + 6 cells still fits one row.
      ["跑一下测试", "改配置"],
    ]);
    // Indices still address the original order.
    expect(rows.flat()).toHaveLength(5);
  });

  /** Telegram echoes the keyboard back on the message a tap came from. */
  const tapped = (data: string, labels: string[]): TgUpdate => ({
    update_id: Math.floor(Math.random() * 1e6),
    callback_query: {
      id: "cb",
      from: { id: 42 },
      data,
      message: {
        message_id: 20,
        chat: DM,
        reply_markup: {
          inline_keyboard: labels.map((text, i) => [{ text, callback_data: `sg:${i}` }]),
        },
      },
    },
  });

  it("reads the label off the tapped message, so a reload cannot break it", async () => {
    openGates();
    // No send() first, and a brand-new adapter instance would behave the same:
    // nothing is remembered between rendering the buttons and the tap.
    await feed(tapped("sg:1", ["跑一下测试", "给我看 diff"]));
    expect(inbound).toEqual([{
      key: { channelId: "telegram", conversationId: "42" },
      senderId: "42",
      text: "给我看 diff",
      mode: "steer",
    }]);
  });

  it("echoes the pick, retires the keyboard, and puts the eyes on the echo", async () => {
    openGates();
    client.nextMessageId = 500;
    await feed(tapped("sg:0", ["跑一下测试"]));
    // The buttons belonged to the turn that just ended.
    expect(client.cleared).toEqual([20]);
    // Visible in the timeline, and marked — but not quoting the answer it came
    // from, which would cost a screenful to say something the marker says.
    expect(client.sent).toEqual([{
      chat_id: "42",
      message_thread_id: undefined,
      text: "▸ 跑一下测试",
      parse_mode: "HTML",
    }]);
    // ...and it is the echo that wears the eyes, not the bot's own message.
    expect(client.reactions).toEqual([{ chatId: "42", messageId: 500, emoji: "👀" }]);
    // Cleared when the turn it started settles.
    await channel.send("42", { text: "done", suggestions: [] });
    expect(client.reactions.at(-1)).toEqual({ chatId: "42", messageId: 500, emoji: null });
  });

  it("still dispatches when the echo cannot be sent", async () => {
    openGates();
    client.sendMessage = () => Promise.reject(new Error("blocked"));
    await feed(tapped("sg:0", ["retry"]));
    expect(inbound.map((m) => m.text)).toEqual(["retry"]);
    expect(dropped.some((m) => m.includes("option echo failed"))).toBe(true);
  });

  it("says so when the payload is not on that message any more", async () => {
    openGates();
    await feed(tapped("sg:3", ["only one"]));
    expect(inbound).toEqual([]);
    expect(client.toasts.at(-1)).toMatch(/no longer on this message/);
  });
});

describe("update concurrency", () => {
  /** Park the photo download so one chat's handling is measurably slow. */
  function slowPhotos(): () => void {
    let release = (): void => {};
    client.downloadFile = () =>
      new Promise((resolve) => {
        release = () => resolve({ bytes: new TextEncoder().encode("fo"), name: "a.jpg" });
      });
    return () => release();
  }

  beforeEach(() => {
    openGates();
  });

  it("a stalled chat does not hold up another one", async () => {
    const release = slowPhotos();
    await feed(
      { update_id: 1, message: { message_id: 1, chat: DM, from: { id: 42 }, photo: [{ file_id: "a" }] } },
      { update_id: 2, message: { message_id: 2, chat: GROUP, from: { id: 43 }, text: "unblocked" } },
    );
    expect(inbound.map((m) => m.text)).toEqual(["unblocked"]);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(inbound).toHaveLength(2);
  });

  it("keeps one chat's messages in arrival order", async () => {
    const release = slowPhotos();
    await feed(
      { update_id: 1, message: { message_id: 1, chat: DM, from: { id: 42 }, caption: "first", photo: [{ file_id: "a" }] } },
      { update_id: 2, message: { message_id: 2, chat: DM, from: { id: 42 }, text: "second" } },
    );
    // "second" must not overtake the slow "first": a steer that arrives out of
    // order would interrupt a turn its predecessor never started.
    expect(inbound).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(inbound.map((m) => m.text.split("\n")[0])).toEqual(["first", "second"]);
  });
});

describe("commands", () => {
  beforeEach(() => {
    openGates();
  });

  it("/stop aborts the conversation and never reaches the agent", async () => {
    await feed(message({ chat: FORUM, text: "  /stop  ", message_thread_id: 9 }));
    expect(aborted).toEqual(["-100/9"]);
    expect(inbound).toEqual([]);
    expect(client.sent.at(-1)).toMatchObject({ chat_id: -100, message_thread_id: 9, text: "⏹ Stopped." });
  });

  it("/stop@otherbot is not ours", async () => {
    await feed(message({ chat: FORUM, text: "/stop@otherbot" }));
    expect(aborted).toEqual([]);
    // Not a command of ours, so it travels on as ordinary text.
    expect(inbound).toHaveLength(1);
  });

  it("a command never opens a topic", async () => {
    await feed(message({ chat: FORUM, text: "/stop" }));
    expect(client.topics).toEqual([]);
  });
});

describe("turn footer", () => {
  it("appends this turn's duration and context size", async () => {
    await channel.send("42", {
      text: "done",
      suggestions: [],
      meta: { completedAt: 0, durationMs: 74_300, tokens: 32_140 },
    });
    expect(client.sent[0]?.text).toBe("done\n<i>1m14s · 32K tok</i>");
  });

  it("delivers an options-only turn: footer plus buttons, never an empty send", async () => {
    await channel.send("42", {
      text: "",
      suggestions: ["韩式拌饭", "酸辣粉"],
      meta: { completedAt: 0, durationMs: 4000, tokens: 8000 },
    });
    expect(client.sent).toEqual([{
      chat_id: "42",
      message_thread_id: undefined,
      text: "\n<i>4s · 8.0K tok</i>",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "韩式拌饭", callback_data: "sg:0" },
          { text: "酸辣粉", callback_data: "sg:1" },
        ]],
      },
    }]);
  });

  it("uses the same wording as the web chip, and says nothing without meta", async () => {
    await channel.send("42", { text: "a", suggestions: [], meta: { completedAt: 0, durationMs: 1240, tokens: 940 } });
    await channel.send("42", { text: "b", suggestions: [], meta: { completedAt: 0, durationMs: 45_000, tokens: 4560 } });
    await channel.send("42", { text: "c", suggestions: [] });
    expect(client.sent.map((m) => m.text)).toEqual([
      "a\n<i>1s · 940 tok</i>",
      "b\n<i>45s · 4.6K tok</i>",
      "c",
    ]);
  });
});

describe("settings panel", () => {
  beforeEach(() => openGates());

  /** Tap a panel button; the panel message is the one the fake just sent. */
  const tap = (action: string, chat = DM, panelId = 999) =>
    feed({
      update_id: Math.floor(Math.random() * 1e6),
      callback_query: {
        id: "cb",
        from: { id: 42 },
        data: `cfg:${action}`,
        message: { message_id: panelId, chat },
      },
    });

  it("opens on a bare @mention and on /settings, never prompting the agent", async () => {
    await feed(message({ chat: GROUP, text: "@pierbot" }));
    await feed(message({ chat: DM, text: "/settings" }));
    expect(inbound).toEqual([]);
    expect(client.sent).toHaveLength(2);
    const panel = client.sent[0]!;
    expect(panel.text).toContain("session-");
    expect(panel.text).toContain("/srv/ops");
    expect(panel.text).toContain("32K/200K tok");
    // Group readout names the gates; the DM one says bound-users-only instead.
    expect(panel.text).toContain("mention off · bind off");
    expect(client.sent[1]!.text).toContain("bound users only");
  });

  it("a mention with real text is still a prompt", async () => {
    await feed(message({ chat: GROUP, text: "@pierbot ship it" }));
    expect(inbound.map((m) => m.text)).toEqual(["ship it"]);
    expect(client.sent).toEqual([]);
  });

  it("picks a model by index and reports it, editing one message", async () => {
    await feed(message({ chat: DM, text: "/settings" }));
    await tap("models:0");
    const list = client.edits.at(-1)!;
    expect(list.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual([
      "✓ claude-opus-4-5",
      "gpt-5",
      "‹ Back",
    ]);
    await tap("model:1");
    expect(control.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(client.edits.at(-1)!.text).toContain("Model set to gpt-5.");
    // One message throughout: taps edit, they never post.
    expect(client.sent).toHaveLength(1);
  });

  it("picks a reasoning level from the ones the session supports", async () => {
    await feed(message({ chat: DM, text: "/settings" }));
    await tap("think");
    expect(client.edits.at(-1)!.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual([
      "Off",
      "✓ Medium",
      "High",
      "‹ Back",
    ]);
    await tap("think:high");
    expect(control.thinking).toBe("high");
  });

  it("starts a new session, and closes by deleting the panel", async () => {
    await feed(message({ chat: DM, text: "/settings" }));
    await tap("new");
    expect(control.created).toEqual([{ key: "42", cwd: undefined }]);
    expect(client.edits.at(-1)!.text).toContain("Started session session-");
    await tap("close");
    expect(client.deletes).toEqual([999]);
  });

  it("changing the directory is one action: reply with a path, get a session", async () => {
    await feed(message({ chat: DM, text: "/settings" }));
    await tap("cwd");
    const prompt = client.sent.at(-1)!;
    expect(prompt.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "/path/to/project" });
    expect(prompt.text).toContain("new session starts there");

    await feed({
      update_id: 7,
      message: {
        message_id: 20,
        chat: DM,
        from: { id: 42 },
        text: " /srv/other ",
        reply_to_message: { message_id: 1000, chat: DM, from: BOT },
      },
    });
    expect(control.created).toEqual([{ key: "42", cwd: "/srv/other" }]);
    // The typed path is not a prompt.
    expect(inbound).toEqual([]);
  });

  it("refuses a relative path and changes nothing", async () => {
    await feed(message({ chat: DM, text: "/settings" }));
    await tap("cwd");
    await feed({
      update_id: 8,
      message: {
        message_id: 21,
        chat: DM,
        from: { id: 42 },
        text: "relative/path",
        reply_to_message: { message_id: 1000, chat: DM, from: BOT },
      },
    });
    expect(control.created).toEqual([]);
    expect(client.sent.at(-1)!.text).toContain("not an absolute path");
    expect(inbound).toEqual([]);
  });

  it("an ordinary reply to the bot is still a prompt", async () => {
    await feed(message({
      chat: DM,
      text: "and the tests?",
      reply_to_message: { message_id: 500, chat: DM, from: BOT },
    }));
    expect(inbound.map((m) => m.text)).toEqual(["and the tests?"]);
  });

  it("a next-step label is not a panel tap", async () => {
    await feed({
      update_id: 11,
      callback_query: { id: "cb", from: { id: 42 }, data: "Run it", message: { message_id: 30, chat: DM } },
    });
    expect(inbound.map((m) => m.text)).toEqual(["Run it"]);
    expect(client.edits).toEqual([]);
  });
});

describe("system notes", () => {
  const ORIGIN = {
    kind: "task-callback" as const,
    taskId: "t1",
    runId: "r1",
    sourceSessionId: "s2",
  };

  it("labels the origin, quotes the text, and lands in the right topic", async () => {
    await channel.notify("-100/7", { text: "**done**", origin: ORIGIN });
    expect(client.sent).toEqual([{
      chat_id: "-100",
      message_thread_id: 7,
      text: "<i>↩ task callback</i>\n<blockquote><b>done</b></blockquote>",
      parse_mode: "HTML",
    }]);
  });

  it("names which kind of subagent message it was", async () => {
    await channel.notify("42", {
      text: "need a call",
      origin: { ...ORIGIN, kind: "task-message", messageKind: "decision", messageId: "m1", sourceSessionId: "s2" },
    });
    expect(client.sent[0]?.text).toContain("decision needed");
  });

  it("leaves the 👀 receipts up — the turn it triggers has not ended", async () => {
    openGates();
    await feed(message({ chat: DM, text: "go" }));
    await channel.notify("42", { text: "note", origin: ORIGIN });
    expect(client.reactions).toEqual([{ chatId: "42", messageId: 10, emoji: "👀" }]);
  });
});

describe("attachments", () => {
  it("saves the largest photo to the inbox and appends its marker", async () => {
    openGates();
    await feed(message({
      chat: DM,
      caption: "look",
      photo: [{ file_id: "small" }, { file_id: "large" }],
    }));
    expect(client.downloaded).toEqual(["large"]);
    const { text, paths } = splitInboundFiles(inbound[0]!.text);
    expect(text).toBe("look");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.startsWith(join(process.env.PIER_HOME!, "inbox", "telegram"))).toBe(true);
    expect(paths[0]!.endsWith("-large.jpg")).toBe(true);
    expect(readFileSync(paths[0]!, "utf8")).toBe("fo");
  });

  it("saves a document under its own filename", async () => {
    openGates();
    await feed(message({
      chat: DM,
      document: { file_id: "doc1", file_name: "notes.pdf", mime_type: "application/pdf" },
    }));
    expect(client.downloaded).toEqual(["doc1"]);
    expect(splitInboundFiles(inbound[0]!.text).paths[0]).toMatch(/-notes\.pdf$/);
  });

  it("a failed download becomes a lost line in the prompt, never silence", async () => {
    openGates();
    client.downloadFile = () => Promise.reject(new Error("telegram file download: 404"));
    await feed(message({ chat: DM, caption: "look", photo: [{ file_id: "a" }] }));
    expect(inbound[0]!.text).toBe("look\n[attachment lost: photo — download failed]");
    expect(splitInboundFiles(inbound[0]!.text).paths).toEqual([]);
  });

  it("refuses an oversized document by metadata, without downloading", async () => {
    openGates();
    await feed(message({
      chat: DM,
      document: { file_id: "big", file_name: "movie.mp4", file_size: 33 * 1024 * 1024 },
    }));
    expect(client.downloaded).toEqual([]);
    expect(inbound[0]!.text).toBe("[attachment lost: movie.mp4 — too large]");
  });
});
