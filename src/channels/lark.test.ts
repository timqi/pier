// Adapter golden test: fake long-connection events in, normalized messages and
// recorded API calls out. Hermetic — no network, no $HOME (in-memory store).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitInboundFiles } from "../core/inbound-file.js";
import { openDb } from "../db.js";
import type { ConversationKey, InboundMessage, ModelRef, ThinkingLevel } from "../core/types.js";
import { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { LarkChannel } from "./lark.js";
import type {
  LarkCard,
  LarkCardAction,
  LarkClient,
  LarkHandlers,
  LarkMessageEvent,
} from "./lark-api.js";
import { ReceiptLedger } from "./receipts.js";

const ME = "ou_bot";
const CHAT = "oc_100";
const USER = "ou_42";

class FakeClient implements LarkClient {
  /** replyCard calls: which message was replied to, with which card. */
  readonly replied: { to: string; card: LarkCard }[] = [];
  readonly patched: { messageId: string; card: LarkCard }[] = [];
  readonly deleted: string[] = [];
  readonly reactions: { messageId: string; emoji: string; add: boolean }[] = [];
  readonly downloads: { messageId: string; fileKey: string; type: string }[] = [];
  /** Cards by message id, for the button-label readback. */
  readonly cards = new Map<string, LarkCard>();
  /** Set by start(); the test pushes events through it. */
  handlers: LarkHandlers = { onMessage: () => {}, onCardAction: () => {} };
  socketClosed = false;
  private nextId = 900;

  botOpenId(): Promise<string> {
    return Promise.resolve(ME);
  }

  connect(handlers: LarkHandlers): Promise<{ close(): Promise<void> }> {
    this.handlers = handlers;
    return Promise.resolve({
      close: () => {
        this.socketClosed = true;
        return Promise.resolve();
      },
    });
  }

  replyCard(to: string, card: LarkCard): Promise<{ messageId: string }> {
    this.replied.push({ to, card });
    const messageId = `om_${this.nextId++}`;
    this.cards.set(messageId, card);
    return Promise.resolve({ messageId });
  }

  patchCard(messageId: string, card: LarkCard): Promise<void> {
    this.patched.push({ messageId, card });
    this.cards.set(messageId, card);
    return Promise.resolve();
  }

  deleteMessage(messageId: string): Promise<void> {
    this.deleted.push(messageId);
    return Promise.resolve();
  }

  addReaction(messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ messageId, emoji, add: true });
    return Promise.resolve();
  }

  removeReaction(messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ messageId, emoji, add: false });
    return Promise.resolve();
  }

  chatName(chatId: string): Promise<string | undefined> {
    return Promise.resolve(chatId === CHAT ? "ops" : undefined);
  }

  userName(openId: string): Promise<string> {
    return Promise.resolve(openId === USER ? "Q" : openId);
  }

  oversized = false;

  download(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array }> {
    this.downloads.push({ messageId, fileKey, type });
    if (this.oversized) return Promise.reject(new Error(`lark resource ${fileKey}: too large (>${maxBytes} bytes)`));
    return Promise.resolve({ bytes: new TextEncoder().encode("fo") });
  }
}

let store: ChannelStore;
let client: FakeClient;
let channel: LarkChannel;
let inbound: InboundMessage[];
let dropped: string[];
let receipts: ReceiptLedger;
let aborted: string[];
let known: Set<string>;
let control: ChannelControl & { created: { key: string; cwd?: string }[] };

let eventSeq = 0;

/** One `im.message.receive_v1` event, text unless overridden. */
function message(over: {
  text?: string;
  messageId?: string;
  rootId?: string;
  chatId?: string;
  chatType?: string;
  messageType?: string;
  content?: string;
  mentions?: { key: string; id?: { open_id?: string }; name?: string }[];
  senderId?: string;
  senderType?: string;
  eventId?: string;
}): LarkMessageEvent {
  eventSeq++;
  return {
    eventId: over.eventId ?? `ev${eventSeq}`,
    senderId: over.senderId ?? USER,
    senderType: over.senderType ?? "user",
    message: {
      messageId: over.messageId ?? `om_in_${eventSeq}`,
      rootId: over.rootId,
      chatId: over.chatId ?? CHAT,
      chatType: over.chatType ?? "group",
      messageType: over.messageType ?? "text",
      content: over.content ?? JSON.stringify({ text: over.text ?? "" }),
      mentions: over.mentions,
    },
  };
}

/** Push events and let the per-chat chains drain. */
async function feed(...events: LarkMessageEvent[]): Promise<void> {
  for (const event of events) client.handlers.onMessage(event);
  await new Promise((r) => setTimeout(r, 20));
}

async function act(action: LarkCardAction): Promise<void> {
  client.handlers.onCardAction(action);
  await new Promise((r) => setTimeout(r, 20));
}

/** Open the chat gates and bind the test sender (a DM is bind-only). */
function openGates(): void {
  const config = store.get("lark");
  config.requireMention = false;
  config.requireBind = false;
  store.save("lark", config);
  bind();
}

function bind(): void {
  store.redeemBindCode("lark", store.issueBindCode("lark").code, { id: USER, name: "Q" });
}

/** All markdown bodies of a card, joined — most assertions only need text. */
const bodyText = (card: LarkCard): string =>
  card.body.elements.flatMap((el) => (el.tag === "markdown" ? [el.content] : [])).join("\n");

function fakeControl() {
  const state = {
    created: [] as { key: string; cwd?: string }[],
    model: { provider: "anthropic", id: "claude-opus-4-5" } as ModelRef | undefined,
    thinking: "medium" as ThinkingLevel,
    launchFor: () => ({}),
    knows: (key: ConversationKey) => known.has(key.conversationId),
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
        thinking: state.thinking,
        thinkingLevels: ["off", "medium", "high"] as ThinkingLevel[],
        tokens: 32_140,
        contextWindow: 200_000,
      }),
    models: () => Promise.resolve([state.model!]),
    setModel: () => Promise.resolve(),
    setThinking: () => Promise.resolve(),
    newSession: (key: ConversationKey, cwd?: string) => {
      state.created.push({ key: key.conversationId, cwd });
      return Promise.resolve("session-99887766");
    },
  };
  return state as unknown as typeof control;
}

beforeEach(async () => {
  store = new ChannelStore(openDb(":memory:"));
  client = new FakeClient();
  inbound = [];
  dropped = [];
  receipts = new ReceiptLedger("lark", openDb(":memory:"));
  aborted = [];
  known = new Set();
  control = fakeControl();
  channel = new LarkChannel({ store, client, receipts, log: (m) => dropped.push(m), control });
  await channel.start((msg) => inbound.push(msg));
});

afterEach(async () => {
  await channel.stop();
});

describe("threads are the conversation", () => {
  it("keys a chat message by itself and answers in its own topic", async () => {
    openGates();
    await feed(message({ text: "ship it", messageId: "om_1" }));
    expect(inbound).toEqual([{
      key: { channelId: "lark", conversationId: `${CHAT}/om_1` },
      senderId: USER,
      sender: { id: USER, name: "Q" },
      text: "ship it",
      mode: "steer",
    }]);

    await channel.send(`${CHAT}/om_1`, { text: "done", suggestions: [] });
    // The reply goes to the root message (reply_in_thread), never the chat.
    expect(client.replied[0]!.to).toBe("om_1");
    expect(bodyText(client.replied[0]!.card)).toBe("done");
  });

  it("keeps a topic reply inside its topic", async () => {
    openGates();
    await feed(message({ text: "and now?", messageId: "om_2", rootId: "om_1" }));
    expect(inbound[0]!.key.conversationId).toBe(`${CHAT}/om_1`);
  });

  it("refuses a conversation id without a root, loudly, and still settles receipts", async () => {
    await channel.send(CHAT, { text: "lost", suggestions: [] });
    expect(client.replied).toEqual([]);
    expect(dropped.some((m) => m.includes("refusing to answer"))).toBe(true);
  });
});

describe("gate", () => {
  it("drops an unmentioned group message when mention is required", async () => {
    bind();
    await feed(message({ text: "chatter" }));
    expect(inbound).toEqual([]);
    expect(dropped.some((m) => m.includes("not-addressed"))).toBe(true);
  });

  it("strips the bot mention and admits the message", async () => {
    bind();
    await feed(message({
      text: "@_user_1 deploy please",
      mentions: [{ key: "@_user_1", id: { open_id: ME }, name: "Pier" }],
    }));
    expect(inbound[0]!.text).toBe("deploy please");
  });

  it("resolves someone else's mention to their name", async () => {
    openGates();
    await feed(message({
      text: "@_user_1 ask @_user_2",
      mentions: [
        { key: "@_user_1", id: { open_id: ME }, name: "Pier" },
        { key: "@_user_2", id: { open_id: "ou_9" }, name: "Ana" },
      ],
    }));
    expect(inbound[0]!.text).toBe("ask @Ana");
  });

  it("admits an unmentioned reply inside a topic Pier owns", async () => {
    bind();
    known.add(`${CHAT}/om_1`);
    await feed(message({ text: "continue", rootId: "om_1" }));
    expect(inbound).toHaveLength(1);
  });

  it("ignores another app's messages", async () => {
    openGates();
    await feed(message({ text: "bot echo", senderType: "app" }));
    expect(inbound).toEqual([]);
  });

  it("deduplicates a redelivered event id", async () => {
    openGates();
    const event = message({ text: "once" });
    await feed(event, event);
    expect(inbound).toHaveLength(1);
    expect(dropped.some((m) => m.includes("duplicate event"))).toBe(true);
  });

  it("passes a command aimed at another bot through as ordinary text", async () => {
    openGates();
    await feed(message({ text: "/stop@otherbot" }));
    expect(aborted).toEqual([]);
    expect(inbound[0]!.text).toBe("/stop@otherbot");
  });

  it("hints an unbound DM sender instead of staying silent", async () => {
    await feed(message({ chatType: "p2p", text: "hello?" }));
    expect(inbound).toEqual([]);
    expect(bodyText(client.replied[0]!.card)).toContain("bind code");
  });

  it("binds with /bind in a DM and confirms", async () => {
    const { code } = store.issueBindCode("lark");
    await feed(message({ chatType: "p2p", text: `/bind ${code}` }));
    expect(store.isBound("lark", USER)).toBe(true);
    expect(bodyText(client.replied[0]!.card)).toContain("Bound as Q");
  });
});

describe("content shapes", () => {
  it("reads rich text (post) lines and title", async () => {
    openGates();
    await feed(message({
      messageType: "post",
      content: JSON.stringify({
        title: "Plan",
        content: [
          [{ tag: "text", text: "step one " }, { tag: "a", text: "docs", href: "https://x" }],
          [{ tag: "text", text: "step two" }],
        ],
      }),
    }));
    expect(inbound[0]!.text).toBe("Plan\nstep one docs\nstep two");
  });

  it("drops the bot's inline at from rich text and names everyone else's", async () => {
    openGates();
    await feed(message({
      messageType: "post",
      content: JSON.stringify({
        content: [[
          { tag: "at", user_id: ME, user_name: "Pier" },
          { tag: "text", text: " ask " },
          { tag: "at", user_id: "ou_9", user_name: "Ana" },
        ]],
      }),
      mentions: [{ key: "@_user_1", id: { open_id: ME }, name: "Pier" }],
    }));
    expect(inbound[0]!.text).toBe("ask @Ana");
  });

  it("downloads an image after the gate and rides it as a marker line", async () => {
    openGates();
    await feed(message({
      messageType: "image",
      messageId: "om_img",
      content: JSON.stringify({ image_key: "img_k1" }),
    }));
    expect(client.downloads).toEqual([{ messageId: "om_img", fileKey: "img_k1", type: "image" }]);
    const { paths } = splitInboundFiles(inbound[0]!.text);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/inbox\/lark\//);
  });

  it("never downloads for a sender the gate refused", async () => {
    await feed(message({
      messageType: "image",
      content: JSON.stringify({ image_key: "img_k1" }),
    }));
    expect(client.downloads).toEqual([]);
  });

  it("an oversized stream becomes a too-large lost marker, never silence", async () => {
    openGates();
    client.oversized = true;
    await feed(message({
      messageType: "file",
      content: JSON.stringify({ file_key: "f1", file_name: "movie.mp4" }),
    }));
    expect(inbound[0]!.text).toMatch(/attachment lost: movie\.mp4.*too large/);
  });

  it("reads a locale-wrapped post body", async () => {
    openGates();
    await feed(message({
      messageType: "post",
      content: JSON.stringify({
        zh_cn: { title: "计划", content: [[{ tag: "text", text: "第一步" }]] },
      }),
    }));
    expect(inbound[0]!.text).toBe("计划\n第一步");
  });

  it("drops an unreadable message type with a log line", async () => {
    openGates();
    await feed(message({ messageType: "sticker", content: "{}" }));
    expect(inbound).toEqual([]);
    expect(dropped.some((m) => m.includes("ignored message type sticker"))).toBe(true);
  });
});

describe("receipts", () => {
  it("marks 👀 (OnIt) on the inbound message and settles on turn-end", async () => {
    openGates();
    await feed(message({ text: "work", messageId: "om_w" }));
    expect(client.reactions).toEqual([{ messageId: "om_w", emoji: "OnIt", add: true }]);
    await channel.send(`${CHAT}/om_w`, { text: "done", suggestions: [] });
    expect(client.reactions[1]).toEqual({ messageId: "om_w", emoji: "OnIt", add: false });
  });

  it("still settles when the reply fails to send", async () => {
    openGates();
    await feed(message({ text: "work", messageId: "om_w" }));
    client.replyCard = () => Promise.reject(new Error("boom"));
    await expect(channel.send(`${CHAT}/om_w`, { text: "done", suggestions: [] })).rejects.toThrow();
    expect(client.reactions[1]).toEqual({ messageId: "om_w", emoji: "OnIt", add: false });
  });

  it("a turn ending during the sender lookup cannot consume the next message's receipt", async () => {
    openGates();
    // Park the name lookup so the message sits in the window where the old
    // code had already marked its receipt.
    let releaseName: (v: string) => void = () => {};
    client.userName = () => new Promise((r) => (releaseName = r));
    client.handlers.onMessage(message({ text: "next", messageId: "om_next" }));
    await new Promise((r) => setTimeout(r, 10));
    // A previous turn settles now: nothing may be on the books yet.
    await channel.send(`${CHAT}/om_next`, { text: "previous turn", suggestions: [] });
    expect(client.reactions).toEqual([]);
    releaseName("Q");
    await new Promise((r) => setTimeout(r, 10));
    // The receipt is booked after the lookup, still owned by its own turn.
    expect(client.reactions).toEqual([{ messageId: "om_next", emoji: "OnIt", add: true }]);
    expect(inbound.at(-1)!.text).toBe("next");
  });

  it("clears every receipt on the books at startup", async () => {
    // A receipt a dead process left behind — nothing in this process is its
    // owner, so start() must sweep it.
    receipts.add({ conversationId: `${CHAT}/om_old`, chatId: CHAT, messageId: "om_old" });
    const fresh = new FakeClient();
    const revived = new LarkChannel({ store, client: fresh, receipts, log: () => {}, control });
    await revived.start(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(fresh.reactions).toEqual([{ messageId: "om_old", emoji: "OnIt", add: false }]);
    await revived.stop();
  });
});

describe("outbound shapes", () => {
  it("an empty turn still posts one muted line saying which nothing it was", async () => {
    openGates();
    await feed(message({ text: "quiet please", messageId: "om_q" }));
    await channel.send(`${CHAT}/om_q`, {
      text: "",
      suggestions: [],
      silence: "not addressed to me",
      meta: { durationMs: 5000, tokens: 1200, completedAt: 1700000000000 },
    });
    const card = client.replied.at(-1)!.card;
    expect(bodyText(card)).toContain("stayed silent — not addressed to me");
    expect(bodyText(card)).toContain("5s · 1.2K tok");
  });

  it("the footer folds into the last body element — no element of its own, no gap", async () => {
    openGates();
    await feed(message({ text: "go", messageId: "om_f" }));
    await channel.send(`${CHAT}/om_f`, {
      text: "done",
      suggestions: [],
      meta: { durationMs: 5000, tokens: 1200, completedAt: 1700000000000 },
    });
    const card = client.replied.at(-1)!.card;
    expect(card.body.elements).toHaveLength(1);
    expect(bodyText(card)).toBe("done\n<font color='grey'>5s · 1.2K tok</font>");
  });

  it("footer and buttons ride the last chunk only, footer inside the body element", async () => {
    openGates();
    await feed(message({ text: "go", messageId: "om_g" }));
    const long = `${"a".repeat(6900)}\n\n${"b".repeat(6900)}`;
    await channel.send(`${CHAT}/om_g`, {
      text: long,
      suggestions: ["Run it"],
      meta: { durationMs: 60_000, tokens: 500, completedAt: 1700000000000 },
    });
    const cards = client.replied.map((r) => r.card);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.body.elements.some((el) => el.tag === "column_set")).toBe(false);
    expect(bodyText(cards[0]!)).not.toContain("1m0s");
    expect(bodyText(cards[1]!)).toContain("1m0s");
    expect(cards[1]!.body.elements.some((el) => el.tag === "column_set")).toBe(true);
  });

  it("posts a system note as a labelled quote without touching receipts", async () => {
    openGates();
    await feed(message({ text: "task", messageId: "om_t" }));
    const before = client.reactions.length;
    await channel.notify(`${CHAT}/om_t`, {
      text: "delegated: audit the logs",
      origin: { kind: "task-delegation", taskId: "t1", runId: "r1", sourceSessionId: null },
    });
    expect(bodyText(client.replied.at(-1)!.card)).toContain("> delegated: audit the logs");
    expect(client.reactions.length).toBe(before);
  });
});

describe("next-step buttons", () => {
  async function offer(): Promise<string> {
    openGates();
    await feed(message({ text: "go", messageId: "om_g" }));
    await channel.send(`${CHAT}/om_g`, { text: "which?", suggestions: ["Deploy", "Rollback"] });
    return [...client.cards.keys()].at(-1)!;
  }

  it("retires the row, echoes the pick, and steers the label in", async () => {
    const offerId = await offer();
    // The value carries the label — Lark echoes it back; nothing is read back.
    await act({
      messageId: offerId,
      chatId: CHAT,
      operatorId: USER,
      value: { key: "sg:1", root: "om_g", label: "Rollback" },
    });
    // The clicked card lost its buttons but kept its body.
    const patched = client.patched.at(-1)!;
    expect(patched.messageId).toBe(offerId);
    expect(bodyText(patched.card)).toBe("which?");
    expect(patched.card.body.elements.some((el) => el.tag === "column_set")).toBe(false);
    // The pick was echoed (a bot cannot post as the user) and carries the 👀.
    const echo = client.replied.at(-1)!;
    expect(bodyText(echo.card)).toBe("▸ Rollback");
    expect(client.reactions.at(-1)).toMatchObject({ emoji: "OnIt", add: true });
    expect(client.reactions.at(-1)!.messageId).not.toBe(offerId);
    expect(inbound.at(-1)).toMatchObject({
      key: { conversationId: `${CHAT}/om_g` },
      text: "Rollback",
      mode: "steer",
    });
  });

  it("a click on a card sent before this process still works; the row just stays", async () => {
    const offerId = await offer();
    // A fresh adapter (a restart): the retire cache is empty, the value is not.
    const fresh = new LarkChannel({ store, client, receipts, log: (m) => dropped.push(m), control });
    await fresh.start((msg) => inbound.push(msg));
    client.handlers.onCardAction({
      messageId: offerId,
      chatId: CHAT,
      operatorId: USER,
      value: { key: "sg:1", root: "om_g", label: "Rollback" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(inbound.at(-1)).toMatchObject({ text: "Rollback", mode: "steer" });
    expect(client.patched.filter((p) => p.messageId === offerId)).toEqual([]);
    expect(dropped.some((m) => m.includes("not retired"))).toBe(true);
    await fresh.stop();
  });

  it("drops a card action without a thread root, loudly", async () => {
    openGates();
    await act({ messageId: "om_x", chatId: CHAT, operatorId: USER, value: { key: "sg:0" } });
    expect(inbound).toEqual([]);
    expect(dropped.some((m) => m.includes("without a thread root"))).toBe(true);
  });

  it("answers a stale button (no label in the value) instead of doing nothing", async () => {
    const offerId = await offer();
    await act({
      messageId: offerId,
      chatId: CHAT,
      operatorId: USER,
      value: { key: "sg:1", root: "om_g" },
    });
    expect(inbound.filter((m) => m.text !== "go")).toEqual([]);
    expect(dropped.some((m) => m.includes("unknown or stale action"))).toBe(true);
    expect(bodyText(client.replied.at(-1)!.card)).toContain("no longer available");
  });
});

describe("commands and panel", () => {
  it("/stop aborts the running turn and says so", async () => {
    openGates();
    await feed(message({ text: "/stop", messageId: "om_s", rootId: "om_1" }));
    expect(aborted).toEqual([`${CHAT}/om_1`]);
    expect(bodyText(client.replied.at(-1)!.card)).toContain("Stopped");
  });

  it("opens the panel on /settings and closes it on cfg:close", async () => {
    openGates();
    await feed(message({ text: "/settings", messageId: "om_p" }));
    const panel = client.replied.at(-1)!;
    expect(panel.to).toBe("om_p");
    expect(bodyText(panel.card)).toContain("Session");
    const panelId = [...client.cards.keys()].at(-1)!;
    await act({
      messageId: panelId,
      chatId: CHAT,
      operatorId: USER,
      value: { key: "cfg:close", root: "om_p" },
    });
    expect(client.deleted).toEqual([panelId]);
  });

  it("a bare @bot mention opens the panel too", async () => {
    openGates();
    await feed(message({
      text: "@_user_1",
      messageId: "om_p2",
      mentions: [{ key: "@_user_1", id: { open_id: ME }, name: "Pier" }],
    }));
    expect(bodyText(client.replied.at(-1)!.card)).toContain("Session");
  });

  it("starts a session from a cwd form submit, even after a restart lost the panel", async () => {
    openGates();
    // No panel state exists for this conversation — the submit still works,
    // because the button's name carries the thread root.
    await act({
      messageId: "om_stale_panel",
      chatId: CHAT,
      operatorId: USER,
      name: "cwdgo:om_root",
      formValue: { cwd: "/srv/new" },
    });
    expect(control.created).toEqual([{ key: `${CHAT}/om_root`, cwd: "/srv/new" }]);
    // The outcome is drawn onto the panel card the user is looking at.
    expect(client.patched.at(-1)!.messageId).toBe("om_stale_panel");
  });

  it("rejects a relative path without starting anything", async () => {
    openGates();
    await act({
      messageId: "om_stale_panel",
      chatId: CHAT,
      operatorId: USER,
      name: "cwdgo:om_root",
      formValue: { cwd: "not/absolute" },
    });
    expect(control.created).toEqual([]);
    expect(bodyText(client.patched.at(-1)!.card)).toContain("not an absolute path");
  });
});

describe("discovery", () => {
  it("records a group with its name and a DM as dm", async () => {
    openGates();
    await feed(message({ text: "hi" }));
    await feed(message({ text: "yo", chatId: "oc_dm", chatType: "p2p" }));
    const chats = store.get("lark").chats;
    expect(chats.find((c) => c.id === CHAT)).toMatchObject({ name: "ops", kind: "group" });
    expect(chats.find((c) => c.id === "oc_dm")).toMatchObject({ name: "DM · Q", kind: "dm" });
  });
});

describe("lifecycle", () => {
  it("closes the socket on stop", async () => {
    await channel.stop();
    expect(client.socketClosed).toBe(true);
  });
});
