// The settings panel, once for the shared behaviour and once per platform's
// rendering. Hermetic — in-memory store, a recording control, fake clients.

import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationKey, ModelRef } from "../core/types.js";
import { ChannelStore } from "./config.js";
import type { ChannelControl, ConversationStatus } from "./control.js";
import { SlackPanel } from "./slack-panel.js";
import { TelegramPanel } from "./telegram-panel.js";
import type { SlackBlock, SlackClient, SlackInteraction } from "./slack-api.js";
import type { TelegramClient, TgMessage } from "./telegram-api.js";

const KEY: ConversationKey = { channelId: "telegram", conversationId: "c1" };
const MODELS: ModelRef[] = Array.from({ length: 10 }, (_, i) => ({
  provider: "anthropic",
  id: `model-${i}`,
}));

const status = (over: Partial<ConversationStatus> = {}): ConversationStatus => ({
  sessionId: "0123456789abcdef",
  cwd: "/srv/pier",
  state: "idle",
  model: MODELS[0],
  thinking: "off",
  thinkingLevels: ["off", "high"],
  tokens: 1200,
  contextWindow: 200_000,
  ...over,
});

class FakeControl implements ChannelControl {
  current: ConversationStatus | null = status();
  readonly newSessions: (string | undefined)[] = [];
  readonly setModels: ModelRef[] = [];
  aborted = 0;
  launchFor = () => ({});
  knows = () => true;
  abort = (): Promise<void> => {
    this.aborted++;
    return Promise.resolve();
  };
  status = (): Promise<ConversationStatus | null> => Promise.resolve(this.current);
  models = (): Promise<ModelRef[]> => Promise.resolve(MODELS);
  setModel = (_k: ConversationKey, model: ModelRef): Promise<void> => {
    this.setModels.push(model);
    return Promise.resolve();
  };
  setThinking = (): Promise<void> => Promise.resolve();
  newSession = (_k: ConversationKey, cwd?: string): Promise<string> => {
    this.newSessions.push(cwd);
    return Promise.resolve("abcdef0123");
  };
}

let store: ChannelStore;
let control: FakeControl;
let logs: string[];

beforeEach(() => {
  store = new ChannelStore(":memory:");
  store.discoverChat("telegram", { id: "100", name: "Ops", kind: "group" });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  control = new FakeControl();
  logs = [];
});

// --- Telegram ------------------------------------------------------------------

class FakeTelegram {
  readonly sent: Record<string, unknown>[] = [];
  readonly edits: Record<string, unknown>[] = [];
  readonly deleted: string[] = [];
  private next = 1;

  sendMessage = (payload: Record<string, unknown>): Promise<TgMessage> => {
    this.sent.push(payload);
    return Promise.resolve({ message_id: this.next++, chat: { id: 100 } } as TgMessage);
  };
  editMessage = (payload: Record<string, unknown>): Promise<void> => {
    this.edits.push(payload);
    return Promise.resolve();
  };
  deleteMessage = (chatId: string, messageId: number): Promise<void> => {
    this.deleted.push(`${chatId}:${messageId}`);
    return Promise.resolve();
  };
}

const tgPanel = (api: FakeTelegram): TelegramPanel =>
  new TelegramPanel({
    api: api as unknown as Pick<
      TelegramClient,
      "sendMessage" | "editMessage" | "deleteMessage"
    >,
    control,
    store,
    log: (m) => logs.push(m),
  });

const tap = (panel: TelegramPanel, data: string): Promise<boolean> =>
  panel.onCallback({ id: "q", data, message: { message_id: 1, chat: { id: 100 } } } as never, KEY);

describe("telegram panel", () => {
  it("opens one message with the session, the chat and its buttons", async () => {
    const api = new FakeTelegram();
    await tgPanel(api).open(KEY, "100");
    const text = String(api.sent[0]!.text);
    expect(text).toContain("<b>Session</b>");
    expect(text).toContain("<code>01234567</code> · idle");
    expect(text).toContain("Directory: <code>/srv/pier</code>");
    expect(text).toContain("<b>Chat</b>");
    expect(text).toContain("Ops · group · <code>100</code>");
    expect(text).toContain("mention on · bind on");
    const rows = (api.sent[0]!.reply_markup as { inline_keyboard: { text: string }[][] })
      .inline_keyboard.map((r) => r.map((b) => b.text));
    expect(rows).toEqual([
      ["Model", "Reasoning"],
      ["New session", "New session in…"],
      ["Close"],
    ]);
  });

  it("offers Stop only while a turn is streaming", async () => {
    control.current = status({ state: "streaming" });
    const api = new FakeTelegram();
    await tgPanel(api).open(KEY, "100");
    const rows = (api.sent[0]!.reply_markup as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    expect(rows[2]!.map((b) => b.text)).toEqual(["⏹ Stop", "Close"]);
  });

  it("pages the model list one model per row, and picks by index", async () => {
    const api = new FakeTelegram();
    const panel = tgPanel(api);
    await panel.open(KEY, "100");
    await tap(panel, "cfg:models:1");
    const rows = (api.edits[0]!.reply_markup as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    // Page two of ten with eight per page: two models, then the nav row.
    expect(rows.slice(0, 2).map((r) => r.map((b) => b.text))).toEqual([
      ["model-8"],
      ["model-9"],
    ]);
    expect(rows[2]!.map((b) => b.text)).toEqual(["‹ Prev", "‹ Back"]);
    await tap(panel, "cfg:model:9");
    expect(control.setModels).toEqual([MODELS[9]]);
  });

  it("ignores a payload that is not the panel's", async () => {
    const panel = tgPanel(new FakeTelegram());
    expect(await tap(panel, "Run it")).toBe(false);
  });

  it("reopens instead of going dead when the panel outlived the process", async () => {
    const api = new FakeTelegram();
    // A fresh panel object has no state for this conversation, as after a restart.
    expect(await tap(tgPanel(api), "cfg:models:0")).toBe(true);
    expect(api.sent).toHaveLength(1);
  });

  it("closes by deleting its own message", async () => {
    const api = new FakeTelegram();
    const panel = tgPanel(api);
    await panel.open(KEY, "100");
    await tap(panel, "cfg:close");
    expect(api.deleted).toEqual(["100:1"]);
  });

  it("starts a session in a typed directory and says so in the chat", async () => {
    const api = new FakeTelegram();
    const panel = tgPanel(api);
    await panel.open(KEY, "100");
    await tap(panel, "cfg:cwd");
    const prompt = api.sent[1]!;
    expect((prompt.reply_markup as { force_reply: boolean }).force_reply).toBe(true);
    const reply = {
      chat: { id: 100 },
      text: "/srv/other",
      reply_to_message: { message_id: 2 },
    } as TgMessage;
    expect(await panel.consumeCwdReply(reply, KEY)).toBe(true);
    expect(control.newSessions).toEqual(["/srv/other"]);
    expect(String(api.sent[2]!.text)).toContain("<code>/srv/other</code>");
  });

  it("refuses a relative path without starting anything", async () => {
    const api = new FakeTelegram();
    const panel = tgPanel(api);
    await panel.open(KEY, "100");
    await tap(panel, "cfg:cwd");
    const reply = {
      chat: { id: 100 },
      text: "relative/path",
      reply_to_message: { message_id: 2 },
    } as TgMessage;
    await panel.consumeCwdReply(reply, KEY);
    expect(control.newSessions).toEqual([]);
    expect(String(api.sent[2]!.text)).toContain("not an absolute path");
  });

  it("shows the topics gate only on a forum", async () => {
    store.discoverChat("telegram", { id: "200", name: "Forum", kind: "forum" });
    const api = new FakeTelegram();
    await tgPanel(api).open({ channelId: "telegram", conversationId: "c2" }, "200");
    expect(String(api.sent[0]!.text)).toContain("topics");
  });
});

// --- Slack -----------------------------------------------------------------------

class FakeSlack {
  readonly posted: Record<string, unknown>[] = [];
  readonly updated: Record<string, unknown>[] = [];
  readonly views: unknown[] = [];

  postMessage = (payload: Record<string, unknown>): Promise<{ ts: string }> => {
    this.posted.push(payload);
    return Promise.resolve({ ts: "1717.0001" });
  };
  updateMessage = (payload: Record<string, unknown>): Promise<void> => {
    this.updated.push(payload);
    return Promise.resolve();
  };
  deleteMessage = (): Promise<void> => Promise.resolve();
  openView = (_trigger: string, view: unknown): Promise<void> => {
    this.views.push(view);
    return Promise.resolve();
  };
}

const SLACK_KEY: ConversationKey = { channelId: "slack", conversationId: "s1" };

const slackPanel = (api: FakeSlack): SlackPanel =>
  new SlackPanel({
    api: api as unknown as Pick<
      SlackClient,
      "postMessage" | "updateMessage" | "deleteMessage" | "openView"
    >,
    control,
    store,
    log: (m) => logs.push(m),
  });

const text = (block: SlackBlock): string =>
  (block as { text?: { text?: string } }).text?.text ?? "";
const labels = (block: SlackBlock): string[] =>
  ((block as { elements?: { text?: { text: string } }[] }).elements ?? [])
    .map((e) => e.text?.text ?? "");

describe("slack panel", () => {
  it("renders one section per group and takes the button rows as authored", async () => {
    const api = new FakeSlack();
    await slackPanel(api).open(SLACK_KEY, "C100", "1717.0000");
    const blocks = api.posted[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Session*");
    expect(text(blocks[0]!)).toContain("`01234567` · idle");
    // Slack has no topics gate, so the channel line says only what it has.
    expect(text(blocks[1]!)).toContain("*Channel*");
    expect(text(blocks[1]!)).toContain("mention on · bind on");
    expect(text(blocks[1]!)).not.toContain("topics");
    expect(labels(blocks[2]!)).toEqual(["Model", "Reasoning"]);
    expect(labels(blocks[4]!)).toEqual(["Close"]);
  });

  it("puts a whole page of models on one row", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({} as SlackInteraction, SLACK_KEY, "cfg:models:0");
    const blocks = api.updated[0]!.blocks as SlackBlock[];
    expect(text(blocks[0]!)).toContain("*Model* · page 1/2");
    expect(labels(blocks[1]!)).toHaveLength(8);
    // The current model is ticked, not repeated elsewhere.
    expect(labels(blocks[1]!)[0]).toBe("✓ model-0");
    expect(labels(blocks[2]!)).toEqual(["Next ›", "‹ Back"]);
  });

  it("asks for a directory in a modal carrying the conversation", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    await panel.onAction({ trigger_id: "t1" } as SlackInteraction, SLACK_KEY, "cfg:cwd");
    expect(api.views[0]).toMatchObject({ callback_id: "cfg_cwd", private_metadata: "s1" });
  });

  it("starts the session a submitted modal asked for", async () => {
    const api = new FakeSlack();
    const panel = slackPanel(api);
    await panel.open(SLACK_KEY, "C100", "1717.0000");
    const submission = {
      view: {
        callback_id: "cfg_cwd",
        private_metadata: "s1",
        state: { values: { cwd_block: { cwd_input: { value: "/srv/other" } } } },
      },
    } as unknown as SlackInteraction;
    expect(await panel.onViewSubmission(submission)).toBe(true);
    expect(control.newSessions).toEqual(["/srv/other"]);
  });

  it("leaves a submission from someone else's view alone", async () => {
    const panel = slackPanel(new FakeSlack());
    const other = { view: { callback_id: "other" } } as unknown as SlackInteraction;
    expect(await panel.onViewSubmission(other)).toBe(false);
  });
});
