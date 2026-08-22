// Adapter golden test: fake Socket Mode envelopes in, normalized messages and
// recorded API calls out. Hermetic — no network, no $HOME (in-memory store).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationKey, InboundMessage, ModelRef, ThinkingLevel } from "../core/types.js";
import { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { ReceiptLedger } from "./receipts.js";
import { SlackChannel } from "./slack.js";
import type {
  SlackBlock,
  SlackClient,
  SlackEnvelope,
  SlackHistoryPage,
  SlackInteraction,
  SlackMessageEvent,
  SlackSend,
  SlackSocket,
} from "./slack-api.js";

const ME = "UBOT";

class FakeClient implements SlackClient {
  readonly sent: SlackSend[] = [];
  readonly updated: (SlackSend & { ts: string })[] = [];
  readonly deleted: string[] = [];
  readonly reactions: { channel: string; ts: string; name: string; add: boolean }[] = [];
  readonly views: unknown[] = [];
  /** Set by start(); the test pushes envelopes through it. */
  emit: (env: SlackEnvelope) => void = () => {};
  socketClosed = false;
  nextTs = 900;

  authTest(): Promise<{ userId: string }> {
    return Promise.resolve({ userId: ME });
  }

  connect(onEnvelope: (env: SlackEnvelope) => void): Promise<SlackSocket> {
    this.emit = onEnvelope;
    return Promise.resolve({
      close: () => {
        this.socketClosed = true;
        return Promise.resolve();
      },
    });
  }

  /** Stand in for a workspace whose Slack predates the markdown block. */
  rejectMarkdown = false;
  /** The error it answers with; anything not block-shaped must propagate. */
  rejectWith = "invalid_blocks";
  attempts = 0;

  postMessage(payload: SlackSend): Promise<{ ts: string }> {
    this.attempts++;
    if (this.rejectMarkdown && payload.blocks?.some((b) => b.type === "markdown")) {
      return Promise.reject(new Error(`slack chat.postMessage: ${this.rejectWith}`));
    }
    this.sent.push(payload);
    return Promise.resolve({ ts: `${this.nextTs++}.000100` });
  }

  updateMessage(payload: SlackSend & { ts: string }): Promise<void> {
    this.updated.push(payload);
    return Promise.resolve();
  }

  deleteMessage(_channel: string, ts: string): Promise<void> {
    this.deleted.push(ts);
    return Promise.resolve();
  }

  setBlocks(channel: string, ts: string, text: string, blocks: SlackBlock[]): Promise<void> {
    this.updated.push({ channel, ts, text, blocks });
    return Promise.resolve();
  }

  addReaction(channel: string, ts: string, name: string): Promise<void> {
    this.reactions.push({ channel, ts, name, add: true });
    return Promise.resolve();
  }

  removeReaction(channel: string, ts: string, name: string): Promise<void> {
    this.reactions.push({ channel, ts, name, add: false });
    return Promise.resolve();
  }

  openView(_triggerId: string, view: unknown): Promise<void> {
    this.views.push(view);
    return Promise.resolve();
  }

  infoCalls = 0;

  channelInfo(channel: string): Promise<{ name?: string; isIm: boolean }> {
    this.infoCalls++;
    return Promise.resolve({ name: channel === CHANNEL ? "ops" : undefined, isIm: channel.startsWith("D") });
  }

  userName(userId: string): Promise<string> {
    return Promise.resolve(userId === "U42" ? "Q" : userId);
  }

  downloadFile(): Promise<{ data: string; mimeType: string }> {
    return Promise.resolve({ data: "Zm8=", mimeType: "image/png" });
  }

  // Only the agent-facing tool reads history; the adapter never does.
  history(): Promise<SlackHistoryPage> {
    return Promise.resolve({ messages: [] });
  }

  replies(): Promise<SlackHistoryPage> {
    return Promise.resolve({ messages: [] });
  }
}

const CHANNEL = "C100";
const DM = "D42";

let store: ChannelStore;
let client: FakeClient;
let channel: SlackChannel;
let inbound: InboundMessage[];
let dropped: string[];
let receipts: ReceiptLedger;
let aborted: string[];
let known: Set<string>;
let control: ChannelControl & {
  created: { key: string; cwd?: string }[];
  models_: ModelRef[];
  thinking?: ThinkingLevel;
  model?: ModelRef;
};

let eventSeq = 0;

/** One `message` event, wrapped as the envelope the transport hands over. */
const message = (over: Partial<SlackMessageEvent>): SlackEnvelope => ({
  type: "events_api",
  envelope_id: `env-${++eventSeq}`,
  payload: {
    event_id: `Ev${eventSeq}`,
    event: { type: "message", user: "U42", ts: "1700.000100", channel: CHANNEL, ...over },
  },
});

const interaction = (over: Partial<SlackInteraction>): SlackEnvelope => ({
  type: "interactive",
  envelope_id: `env-${++eventSeq}`,
  payload: { type: "block_actions", user: { id: "U42" }, trigger_id: "TRIG", ...over },
});

/** Push envelopes and let the per-channel chains drain. */
async function feed(...envelopes: SlackEnvelope[]): Promise<void> {
  for (const env of envelopes) client.emit(env);
  await new Promise((r) => setTimeout(r, 20));
}

/** Open the channel gates and bind the test sender (a DM is bind-only). */
function openGates(): void {
  const config = store.get("slack");
  config.requireMention = false;
  config.requireBind = false;
  store.save("slack", config);
  bind();
}

function bind(): void {
  store.redeemBindCode("slack", store.issueBindCode("slack").code, { id: "U42", name: "Q" });
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

beforeEach(async () => {
  store = new ChannelStore(":memory:");
  client = new FakeClient();
  inbound = [];
  dropped = [];
  receipts = new ReceiptLedger("slack", ":memory:");
  aborted = [];
  known = new Set();
  control = fakeControl();
  channel = new SlackChannel({ store, client, receipts, log: (m) => dropped.push(m), control });
  await channel.start((msg) => inbound.push(msg));
});

afterEach(async () => {
  await channel.stop();
});

describe("threads are the conversation", () => {
  it("answers a channel message in its own thread, keyed by that message's ts", async () => {
    openGates();
    await feed(message({ text: "ship it", ts: "1700.000100" }));
    // The thread does not exist yet; its root is the message itself, so the
    // conversation id is stable from the very first reply.
    expect(inbound).toEqual([{
      key: { channelId: "slack", conversationId: "C100/1700.000100" },
      senderId: "U42",
      sender: { id: "U42", name: "Q" },
      text: "ship it",
      images: [],
      mode: "steer",
    }]);

    await channel.send("C100/1700.000100", { text: "done", suggestions: [] });
    expect(client.sent[0]).toMatchObject({ channel: "C100", thread_ts: "1700.000100" });
  });

  it("keeps a thread reply inside its own thread", async () => {
    openGates();
    await feed(message({ text: "and now?", ts: "1800.000200", thread_ts: "1700.000100" }));
    expect(inbound[0]!.key.conversationId).toBe("C100/1700.000100");
  });

  it("gives two channel messages two separate sessions", async () => {
    openGates();
    await feed(
      message({ text: "first", ts: "1700.000100" }),
      message({ text: "second", ts: "1701.000100" }),
    );
    expect(inbound.map((m) => m.key.conversationId))
      .toEqual(["C100/1700.000100", "C100/1701.000100"]);
  });

  it("round-trips a ts that no float could hold", async () => {
    openGates();
    // 16 significant digits: the reason receipts key on a string.
    await feed(message({ text: "hi", ts: "1761234567.123456" }));
    expect(client.reactions).toEqual([
      { channel: "C100", ts: "1761234567.123456", name: "eyes", add: true },
    ]);
    await channel.send("C100/1761234567.123456", { text: "ok", suggestions: [] });
    expect(client.reactions.at(-1))
      .toEqual({ channel: "C100", ts: "1761234567.123456", name: "eyes", add: false });
  });
});

describe("DM session identity", () => {
  it("keeps a threaded DM reply in the thread's session", async () => {
    bind();
    await feed(
      message({ channel: DM, channel_type: "im", text: "first", ts: "10.1" }),
      message({ channel: DM, channel_type: "im", text: "reply", ts: "10.9", thread_ts: "10.1" }),
    );
    expect(inbound.map((m) => m.key.conversationId)).toEqual(["D42/10.1", "D42/10.1"]);
  });
});

describe("gating", () => {
  it("drops an unmentioned channel message under the default policy", async () => {
    await feed(message({ text: "hello there" }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in channel C100: not-addressed"]);
    // Discovery still happened: the operator can now configure the channel.
    expect(store.chat("slack", "C100")).toMatchObject({ name: "#ops", kind: "group", enabled: true });
  });

  it("accepts a mention and strips it", async () => {
    bind();
    await feed(message({ text: `<@${ME}> ship it` }));
    expect(inbound).toEqual([{
      key: { channelId: "slack", conversationId: "C100/1700.000100" },
      senderId: "U42",
      sender: { id: "U42", name: "Q" },
      text: "ship it",
      images: [],
      mode: "steer",
    }]);
  });

  it("treats a reply in a thread Pier owns as addressed, with no mention", async () => {
    bind();
    known.add("C100/1700.000100");
    await feed(message({ text: "carry on", ts: "1800.000200", thread_ts: "1700.000100" }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe("carry on");
  });

  it("still requires a mention in a thread Pier does not own", async () => {
    bind();
    await feed(message({ text: "two humans talking", ts: "1800.1", thread_ts: "1700.000100" }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in channel C100: not-addressed"]);
  });

  it("drops a mentioned message from an unbound sender", async () => {
    await feed(message({ text: `<@${ME}> ship it` }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in channel C100: not-bound"]);
  });

  it("answers an unbound DM with the bind hint, once", async () => {
    await feed(
      message({ channel: DM, channel_type: "im", text: "hello", ts: "10.1" }),
      message({ channel: DM, channel_type: "im", text: "hello again", ts: "10.2" }),
    );
    expect(inbound).toEqual([]);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain("not bound yet");
  });

  it("lets a bind request through the bind gate, in a DM", async () => {
    const code = store.issueBindCode("slack").code;
    await feed(message({ channel: DM, channel_type: "im", text: `bind ${code}`, ts: "10.1" }));
    expect(store.isBound("slack", "U42")).toBe(true);
    expect(client.sent[0]!.text).toBe("Bound as Q.");
  });
});

describe("inbound hygiene", () => {
  it("ignores its own messages and other apps'", async () => {
    openGates();
    await feed(
      message({ text: "mine", user: ME }),
      message({ text: "another app", bot_id: "B9", user: undefined }),
    );
    expect(inbound).toEqual([]);
  });

  it("ignores an app_mention, which duplicates the message event", async () => {
    openGates();
    await feed({
      type: "events_api",
      envelope_id: "e1",
      payload: { event_id: "Ev9", event: { type: "app_mention", user: "U42", channel: CHANNEL, ts: "1.1" } },
    });
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["ignored event type app_mention"]);
  });

  it("ignores a join/leave subtype but reads a file share", async () => {
    openGates();
    await feed(
      message({ text: "joined", subtype: "channel_join" }),
      message({
        text: "look",
        ts: "1702.000100",
        subtype: "file_share",
        files: [{ id: "F1", mimetype: "image/png", url_private_download: "https://files/x.png" }],
      }),
    );
    expect(dropped).toContain("ignored message subtype channel_join");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.images).toEqual([{ data: "Zm8=", mimeType: "image/png" }]);
  });

  it("deduplicates a redelivered event_id", async () => {
    openGates();
    const env = message({ text: "once", ts: "1703.000100" });
    await feed(env, env);
    expect(inbound).toHaveLength(1);
    expect(dropped.some((d) => d.includes("duplicate event"))).toBe(true);
  });

  it("resolves a channel name once, not once per message", async () => {
    openGates();
    await feed(
      message({ text: "one", ts: "1720.000100" }),
      message({ text: "two", ts: "1721.000100" }),
      message({ text: "three", ts: "1722.000100" }),
    );
    expect(inbound).toHaveLength(3);
    // Slack's message event carries no channel name, so discovery costs an API
    // call. Once per process, never per message.
    expect(client.infoCalls).toBe(1);
    expect(store.chat("slack", "C100")).toMatchObject({ name: "#ops" });
  });

  it("does not download a file for an unauthorized sender", async () => {
    // Default policy: not addressed, so the gate closes before any bytes move.
    await feed(message({
      text: "look",
      subtype: "file_share",
      files: [{ id: "F1", mimetype: "image/png", url_private_download: "https://files/x.png" }],
    }));
    expect(inbound).toEqual([]);
  });
});

describe("outbound", () => {
  it("hands the body to Slack's own markdown renderer, unconverted", async () => {
    await channel.send("C100/1700.000100", {
      text: "## Title\n\n**bold** and `code`\n\n| a | b |\n| - | - |\n\n---\n[Run it] | [Show the diff]",
      suggestions: ["Run it", "Show the diff"],
      meta: { completedAt: Date.now(), durationMs: 45_000, tokens: 32_000 },
    });
    const blocks = client.sent[0]!.blocks!;
    expect(blocks[0]).toMatchObject({ type: "markdown" });
    // Unmodified: the heading and the table stay markdown, which mrkdwn cannot
    // express at all, and Slack renders them itself.
    const body = (blocks[0] as { text: string }).text;
    expect(body).toContain("## Title");
    expect(body).toContain("**bold**");
    expect(body).toContain("| a | b |");
    // Slack has real muted text, so the footer is a context block, not italics.
    expect(blocks.at(-2)).toMatchObject({ type: "context" });
    expect(blocks.at(-1)).toMatchObject({
      type: "actions",
      elements: [
        { action_id: "sg:0", text: { text: "Run it" } },
        { action_id: "sg:1", text: { text: "Show the diff" } },
      ],
    });
  });

  it("keeps a long reply in one message and one block", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `**Point ${i}**\n${"detail ".repeat(20)}`)
      .join("\n\n");
    await channel.send("C100/1700.000100", { text: body, suggestions: [] });
    // A markdown block is not collapsed behind "Show more", so there is nothing
    // to split: one message, one block, 11K of headroom.
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.blocks!.filter((b) => b.type === "markdown")).toHaveLength(1);
  });

  it("falls back to mrkdwn sections when Slack refuses the markdown block", async () => {
    client.rejectMarkdown = true;
    await channel.send("C100/1700.000100", {
      text: "**bold**\n\nsecond paragraph",
      suggestions: ["Go"],
      meta: { completedAt: Date.now(), durationMs: 1000, tokens: 10 },
    });
    const blocks = client.sent.at(-1)!.blocks!;
    expect(blocks.some((b) => b.type === "markdown")).toBe(false);
    // Translated on the way down, and still carrying the footer and the row.
    expect(JSON.stringify(blocks)).toContain("*bold*");
    expect(blocks.some((b) => b.type === "context")).toBe(true);
    expect(blocks.some((b) => b.type === "actions")).toBe(true);
    expect(dropped.some((d) => d.includes("markdown block refused"))).toBe(true);
  });

  it("retires the receipts even when the send fails outright", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1740.000100" }));
    client.rejectMarkdown = true;
    client.rejectWith = "invalid_arguments";
    await expect(channel.send("C100/1740.000100", { text: "x", suggestions: [] }))
      .rejects.toThrow();
    // Otherwise the 👀 sits on the user's message until the 30-minute sweep,
    // looking like the agent is still working on it.
    expect(client.reactions.at(-1))
      .toEqual({ channel: "C100", ts: "1740.000100", name: "eyes", add: false });
  });

  it("does not downgrade the renderer over an unrelated bad argument", async () => {
    client.rejectMarkdown = true;
    // invalid_arguments means the call was wrong, not that markdown blocks are
    // unsupported. Latching on it would cost the whole process its rendering.
    client.rejectWith = "invalid_arguments";
    await expect(channel.send("C100/1700.000100", { text: "x", suggestions: [] }))
      .rejects.toThrow(/invalid_arguments/);
    client.rejectMarkdown = false;
    await channel.send("C100/1700.000100", { text: "y", suggestions: [] });
    // Still the good path: nothing was latched off.
    expect(client.sent.at(-1)!.blocks!.some((b) => b.type === "markdown")).toBe(true);
  });

  it("stops retrying the markdown block once it has been refused", async () => {
    client.rejectMarkdown = true;
    await channel.send("C100/1700.000100", { text: "one", suggestions: [] });
    const attempts = client.attempts;
    await channel.send("C100/1700.000100", { text: "two", suggestions: [] });
    // One failed round trip per process, not per message.
    expect(client.attempts - attempts).toBe(1);
  });

  it("sends a turn that is nothing but its options", async () => {
    await channel.send("C100/1700.000100", { text: "", suggestions: ["Yes", "No"] });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.blocks!.at(-1)).toMatchObject({ type: "actions" });
  });

  it("says which kind of nothing an empty turn was, and clears the receipts", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1704.000100" }));
    client.sent.length = 0;
    // Total silence is indistinguishable from a crash, so an empty turn still
    // posts one muted line. A deliberate silence names its reason; a turn that
    // simply produced nothing says so.
    await channel.send("C100/1704.000100", {
      text: "",
      suggestions: [],
      silence: "two humans talking",
      meta: { completedAt: Date.now(), durationMs: 3000, tokens: 7900 },
    });
    const line = JSON.stringify(client.sent.at(-1)!.blocks);
    expect(line).toContain("stayed silent");
    expect(line).toContain("two humans talking");
    expect(client.sent.at(-1)!.blocks!.every((b) => b.type === "context")).toBe(true);

    client.sent.length = 0;
    await channel.send("C100/1704.000100", {
      text: "",
      suggestions: [],
      meta: { completedAt: Date.now(), durationMs: 3000, tokens: 7900 },
    });
    expect(JSON.stringify(client.sent.at(-1)!.blocks)).toContain("no reply");
    expect(client.reactions.at(-1))
      .toEqual({ channel: "C100", ts: "1704.000100", name: "eyes", add: false });
  });

  it("puts buttons on the last chunk only", async () => {
    await channel.send("C100/1700.000100", {
      // Past the markdown block's 11K budget, so it really does span messages.
      text: `${"paragraph\n\n".repeat(1500)}end`,
      suggestions: ["Go"],
    });
    expect(client.sent.length).toBeGreaterThan(1);
    expect(client.sent[0]!.blocks!.some((b) => b.type === "actions")).toBe(false);
    expect(client.sent.at(-1)!.blocks!.some((b) => b.type === "actions")).toBe(true);
  });

  it("refuses a conversation id with no thread rather than posting in the channel", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1730.000100" }));
    client.sent.length = 0;
    // Never minted by this adapter; posting it would land in the channel's main
    // flow, which is the one thing the design forbids.
    await channel.send("C100", { text: "orphan", suggestions: [] });
    await channel.notify("C100", {
      text: "orphan note",
      origin: { kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null },
    });
    expect(client.sent).toEqual([]);
    expect(dropped.filter((d) => d.includes("no thread in the conversation id"))).toHaveLength(2);
  });

  it("renders a system note as a quote, without retiring the receipts", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1705.000100" }));
    const before = client.reactions.length;
    await channel.notify("C100/1705.000100", {
      text: "subagent says hi",
      origin: { kind: "task-delegation", taskId: "t", runId: "r", sourceSessionId: null },
    });
    expect(client.sent.at(-1)!.text).toContain("> subagent says hi");
    // The turn this input triggers has not ended, so the 👀 stays up.
    expect(client.reactions).toHaveLength(before);
  });
});

describe("next-step buttons", () => {
  /** The message Slack echoes back with a click on the reply above. */
  const withOptions = (): SlackBlock[] => [
    { type: "section", text: { type: "mrkdwn", text: "Ready?" } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "sg:0", text: { type: "plain_text", text: "Run it", emoji: true } },
      ],
    },
  ];

  it("reads the label off the clicked message, echoes it, and steers", async () => {
    openGates();
    await feed(interaction({
      channel: { id: CHANNEL },
      message: { ts: "1900.000100", thread_ts: "1700.000100", blocks: withOptions() },
      actions: [{ action_id: "sg:0" }],
    }));
    // A bot cannot post as the user, so the pick is echoed and marked.
    expect(client.sent[0]).toMatchObject({ thread_ts: "1700.000100", text: "▸ Run it" });
    expect(inbound).toEqual([{
      key: { channelId: "slack", conversationId: "C100/1700.000100" },
      senderId: "U42",
      sender: { id: "U42", name: "Q" },
      text: "Run it",
      mode: "steer",
    }]);
  });

  it("retires the row, keeping the reply text", async () => {
    openGates();
    await feed(interaction({
      channel: { id: CHANNEL },
      message: { ts: "1900.000100", thread_ts: "1700.000100", blocks: withOptions() },
      actions: [{ action_id: "sg:0" }],
    }));
    const edit = client.updated.find((u) => u.ts === "1900.000100")!;
    expect(edit.blocks!.some((b) => b.type === "actions")).toBe(false);
    expect(edit.blocks).toHaveLength(1);
  });

  it("marks the echo, not the bot message that held the buttons", async () => {
    openGates();
    await feed(interaction({
      channel: { id: CHANNEL },
      message: { ts: "1900.000100", thread_ts: "1700.000100", blocks: withOptions() },
      actions: [{ action_id: "sg:0" }],
    }));
    const marked = client.reactions.filter((r) => r.add);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.ts).not.toBe("1900.000100");
  });

  it("retires a turn that was nothing but its options, leaving a muted line", async () => {
    openGates();
    // No section to keep: Slack rejects a message with neither text nor blocks,
    // so the row must be replaced rather than merely removed.
    await feed(interaction({
      channel: { id: CHANNEL },
      message: {
        ts: "1900.000100",
        thread_ts: "1700.000100",
        blocks: [{
          type: "actions",
          elements: [{
            type: "button",
            action_id: "sg:0",
            text: { type: "plain_text", text: "Run it", emoji: true },
          }],
        }],
      },
      actions: [{ action_id: "sg:0" }],
    }));
    const edit = client.updated.find((u) => u.ts === "1900.000100")!;
    expect(edit.blocks!.some((b) => b.type === "actions")).toBe(false);
    expect(edit.blocks).toHaveLength(1);
    expect(edit.text).toBeTruthy();
    expect(inbound).toHaveLength(1);
  });

  it("declines an option that is no longer on the message", async () => {
    openGates();
    await feed(interaction({
      channel: { id: CHANNEL },
      message: { ts: "1900.000100", thread_ts: "1700.000100", blocks: [] },
      actions: [{ action_id: "sg:3" }],
    }));
    expect(inbound).toEqual([]);
    expect(dropped).toContain("unknown action sg:3 in channel C100");
  });
});

describe("commands", () => {
  it("stops the turn on a bare `stop` after a mention", async () => {
    openGates();
    await feed(message({ text: `<@${ME}> stop`, ts: "1706.000100" }));
    expect(aborted).toEqual(["C100/1706.000100"]);
    expect(client.sent.at(-1)!.text).toBe("⏹ Stopped.");
    expect(inbound).toEqual([]);
  });

  it("does not treat an ordinary sentence starting with a command word as one", async () => {
    openGates();
    await feed(message({ text: "settings are broken, please help", ts: "1707.000100" }));
    expect(inbound).toHaveLength(1);
    expect(client.sent).toEqual([]);
  });

  it("opens the panel on `settings`, and on a bare mention", async () => {
    openGates();
    await feed(message({ text: `<@${ME}> settings`, ts: "1708.000100" }));
    await feed(message({ text: `<@${ME}>`, ts: "1709.000100" }));
    expect(client.sent).toHaveLength(2);
    expect(client.sent.every((s) => s.text === "Settings")).toBe(true);
    expect(inbound).toEqual([]);
  });

});

describe("settings panel", () => {
  const open = async (): Promise<void> => {
    openGates();
    await feed(message({ text: `<@${ME}>`, ts: "1710.000100" }));
    client.sent.length = 0;
  };

  const click = (action: string): SlackEnvelope =>
    interaction({
      channel: { id: CHANNEL },
      message: { ts: "900.000100", thread_ts: "1710.000100", blocks: [] },
      actions: [{ action_id: action }],
    });

  it("reads out the session and the channel policy", async () => {
    openGates();
    await feed(message({ text: `<@${ME}>`, ts: "1710.000100" }));
    const body = JSON.stringify(client.sent[0]!.blocks);
    expect(body).toContain("session-");
    expect(body).toContain("/srv/ops");
    expect(body).toContain("claude-opus-4-5");
  });

  it("edits one message in place instead of posting a new one", async () => {
    await open();
    await feed(click("cfg:models:0"));
    expect(client.sent).toEqual([]);
    expect(client.updated).toHaveLength(1);
  });

  it("sets a model by index, not by name", async () => {
    await open();
    await feed(click("cfg:models:0"));
    await feed(click("cfg:model:1"));
    expect(control.model).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it("asks for a working directory in a modal, carrying the conversation with it", async () => {
    await open();
    await feed(click("cfg:cwd"));
    const view = client.views[0] as { private_metadata: string; callback_id: string };
    expect(view.callback_id).toBe("cfg_cwd");
    // No adapter-side state: the submission is understood from the modal alone.
    expect(view.private_metadata).toBe("C100/1710.000100");
  });

  it("starts a new session from the modal submission", async () => {
    await open();
    await feed(click("cfg:cwd"));
    await feed({
      type: "interactive",
      envelope_id: "sub-1",
      payload: {
        type: "view_submission",
        user: { id: "U42" },
        view: {
          callback_id: "cfg_cwd",
          private_metadata: "C100/1710.000100",
          state: { values: { cwd_block: { cwd_input: { value: "/srv/new" } } } },
        },
      },
    });
    expect(control.created).toEqual([{ key: "C100/1710.000100", cwd: "/srv/new" }]);
  });

  it("rejects a relative path without changing anything", async () => {
    await open();
    await feed({
      type: "interactive",
      envelope_id: "sub-2",
      payload: {
        type: "view_submission",
        user: { id: "U42" },
        view: {
          callback_id: "cfg_cwd",
          private_metadata: "C100/1710.000100",
          state: { values: { cwd_block: { cwd_input: { value: "relative/path" } } } },
        },
      },
    });
    expect(control.created).toEqual([]);
    expect(JSON.stringify(client.updated)).toContain("not an absolute path");
  });

  it("reopens a panel a previous process left behind, on the first click", async () => {
    // No open() first: this adapter has no panel state, exactly like a restart.
    openGates();
    await feed(click("cfg:models:0"));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toBe("Settings");
  });
});

describe("receipts", () => {
  it("marks with a short name, because Slack rejects the codepoint", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1711.000100" }));
    expect(client.reactions).toEqual([
      { channel: "C100", ts: "1711.000100", name: "eyes", add: true },
    ]);
  });

  it("clears receipts a dead process left behind, at startup", async () => {
    receipts.add({ conversationId: "C100/1.1", chatId: "C100", messageId: "5.5" });
    const reborn = new SlackChannel({ store, client, receipts, log: (m) => dropped.push(m), control });
    await reborn.start(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(client.reactions).toEqual([{ channel: "C100", ts: "5.5", name: "eyes", add: false }]);
    await reborn.stop();
  });

  it("keeps two threads' receipts apart", async () => {
    openGates();
    await feed(
      message({ text: "one", ts: "1712.000100" }),
      message({ text: "two", ts: "1713.000100" }),
    );
    await channel.send("C100/1712.000100", { text: "done", suggestions: [] });
    const cleared = client.reactions.filter((r) => !r.add);
    expect(cleared).toEqual([{ channel: "C100", ts: "1712.000100", name: "eyes", add: false }]);
  });
});

describe("lifecycle", () => {
  it("closes the socket on stop", async () => {
    await channel.stop();
    expect(client.socketClosed).toBe(true);
  });

  it("stops handling envelopes once stopped", async () => {
    openGates();
    await channel.stop();
    await feed(message({ text: "too late", ts: "1714.000100" }));
    expect(inbound).toEqual([]);
  });
});
