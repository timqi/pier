// The settings panel, through Slack's rendering of the shared behaviour.
// Hermetic — in-memory store, a recording control, a fake client.

import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import type { ConversationKey, ModelRef } from "../core/types.js";
import { ChannelStore } from "./config.js";
import type { ChannelControl, ConversationStatus } from "./control.js";
import { SlackPanel } from "./slack-panel.js";
import type { SlackBlock, SlackClient, SlackInteraction } from "./slack-api.js";

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
  const vault = new Map<string, string>();
  store = new ChannelStore(openDb(":memory:"), { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  control = new FakeControl();
  logs = [];
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
    expect(text(blocks[1]!)).toContain("*Channel*");
    expect(text(blocks[1]!)).toContain("mention on · bind on");
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
