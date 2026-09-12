// Adapter golden test: fake Socket Mode envelopes in, normalized messages and
// recorded API calls out. Hermetic — no network, no $HOME (in-memory store).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitInboundFiles } from "../core/inbound-file.js";
import { openDb } from "../db.js";
import type { ConversationKey, InboundMessage, ModelRef, ThinkingLevel } from "../core/types.js";
import { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { ReceiptLedger } from "./receipts.js";
import { SlackChannel } from "./slack.js";
import type {
  SlackAttachment,
  SlackBlock,
  SlackClient,
  SlackEnvelope,
  SlackFile,
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
    if (userId === "U42") return Promise.resolve("Q");
    return Promise.resolve(userId === "U7" ? "Dana" : userId);
  }

  downloadFile(): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return Promise.resolve({ bytes: new TextEncoder().encode("fo"), mimeType: "image/png" });
  }

  /** The adapter never calls it — an inbound event already carries the file. */
  filesInfo(id: string): Promise<SlackFile> {
    return Promise.reject(new Error(`unexpected files.info for ${id}`));
  }

  readonly uploads: { channel: string; threadTs: string | undefined; name: string; size: number }[] = [];

  uploadFile(
    channel: string,
    threadTs: string | undefined,
    file: { name: string; bytes: Uint8Array },
  ): Promise<{ id: string }> {
    this.uploads.push({ channel, threadTs, name: file.name, size: file.bytes.length });
    return Promise.resolve({ id: `F${this.uploads.length}` });
  }

  // Only the agent-facing tool reads a channel; the adapter never does.
  history(): Promise<SlackHistoryPage> {
    return Promise.resolve({ messages: [] });
  }

  /** A shared thread the adapter reads eagerly; scripted per test. */
  threadReplies: SlackMessageEvent[] = [];
  readonly repliesCalls: { channel: string; ts: string }[] = [];

  replies(channel: string, ts: string): Promise<SlackHistoryPage> {
    this.repliesCalls.push({ channel, ts });
    return Promise.resolve({ messages: this.threadReplies });
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

/** Wait for the handlers the adapter has in flight, reaching for its chains
 *  because a fixed sleep is a race: saving a file share's bytes is real I/O
 *  with no upper bound on a loaded machine. */
async function settled(): Promise<void> {
  const chains = (channel as unknown as { chains: { size: number } }).chains;
  await vi.waitFor(() => expect(chains.size).toBe(0), { interval: 1, timeout: 5_000 });
}

/** Push envelopes and let the per-channel chains drain. */
async function feed(...envelopes: SlackEnvelope[]): Promise<void> {
  for (const env of envelopes) client.emit(env);
  await settled();
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
        empty: false,
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
    recentDirs: () => Promise.resolve(["/srv/ops"]),
    newSession: (key: ConversationKey, cwd?: string) => {
      state.created.push({ key: key.conversationId, cwd });
      return Promise.resolve("session-99887766");
    },
  };
  return state as unknown as typeof control;
}

beforeEach(async () => {
  const vault = new Map<string, string>();
  store = new ChannelStore(openDb(":memory:"), { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  client = new FakeClient();
  inbound = [];
  dropped = [];
  receipts = new ReceiptLedger("slack", openDb(":memory:"));
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
        files: [{ id: "F1", name: "x.png", mimetype: "image/png", url_private_download: "https://files/x.png" }],
      }),
    );
    expect(dropped).toContain("ignored message subtype channel_join");
    expect(inbound).toHaveLength(1);
    // The bytes land in the inbox; the prompt carries the marker line.
    const { text, paths } = splitInboundFiles(inbound[0]!.text);
    expect(text).toBe("look");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.startsWith(join(process.env.PIER_HOME!, "inbox", "slack"))).toBe(true);
    expect(readFileSync(paths[0]!, "utf8")).toBe("fo");
  });

  it("reads a non-image upload too — nothing is silently dropped", async () => {
    openGates();
    await feed(
      message({
        text: "",
        ts: "1702.000200",
        subtype: "file_share",
        files: [{ id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private_download: "https://files/notes.pdf" }],
      }),
    );
    expect(inbound).toHaveLength(1);
    expect(splitInboundFiles(inbound[0]!.text).paths[0]).toMatch(/-notes\.pdf$/);
  });

  it("a failed or oversized file becomes a lost line, never silence", async () => {
    openGates();
    client.downloadFile = () => Promise.reject(new Error("slack file download: 403"));
    await feed(
      message({
        text: "two",
        ts: "1702.000300",
        subtype: "file_share",
        files: [
          { id: "F3", name: "a.png", mimetype: "image/png", url_private_download: "https://files/a.png" },
          { id: "F4", name: "movie.mp4", size: 33 * 1024 * 1024, url_private_download: "https://files/movie.mp4" },
        ],
      }),
    );
    expect(inbound[0]!.text).toBe(
      "two\n[attachment lost: a.png — download failed]\n[attachment lost: movie.mp4 — too large]",
    );
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

describe("shared messages", () => {
  /** A forward as Slack sends one: both flags, the original flattened on. */
  const share = (over: Partial<SlackAttachment> = {}): SlackAttachment => ({
    is_share: true,
    // A real share carries the unfurl flag too, which is why it cannot be the
    // test for one.
    is_msg_unfurl: true,
    author_id: "U7",
    author_name: "Dana",
    channel_id: "C900",
    channel_name: "alerts",
    ts: "1699.000100",
    text: "the db is on fire",
    ...over,
  });

  it("appends the shared message after the sharer's own comment", async () => {
    openGates();
    await feed(message({
      text: "have a look at this",
      ts: "1710.000100",
      subtype: "message_share",
      attachments: [share()],
    }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe(
      "have a look at this\n"
        + "[shared message from Dana<U7> in #alerts<C900> at 1699.000100]\n"
        + "the db is on fire",
    );
  });

  it("reads the other shape too: a plain message carrying is_share", async () => {
    openGates();
    // Slack sends a forward either with the `message_share` subtype or with no
    // subtype at all; the flag on the attachment is the only thing in common.
    await feed(message({ text: "", ts: "1720.000100", attachments: [share()] }));
    expect(inbound[0]!.text).toBe(
      "[shared message from Dana<U7> in #alerts<C900> at 1699.000100]\nthe db is on fire",
    );
  });

  it("logs a share it could not read instead of dropping it silently", async () => {
    openGates();
    // A `message_share` whose only attachment is ruled out as an unfurl, and no
    // comment of its own: nothing reaches the agent, so the drop log is the
    // only place it can be seen at all (5b).
    await feed(message({
      text: "",
      ts: "1721.000100",
      subtype: "message_share",
      attachments: [{ is_msg_unfurl: true, author_name: "Dana", text: "the db is on fire" }],
    }));
    expect(inbound).toEqual([]);
    expect(dropped).toContain("message_share with nothing readable in it, dropped");
  });

  it("dispatches a forward with no comment instead of opening the panel", async () => {
    openGates();
    // The subtype path: `is_share` is absent, so the subtype is the only flag.
    await feed(message({
      text: "",
      ts: "1711.000100",
      subtype: "message_share",
      attachments: [share({ is_share: undefined, is_msg_unfurl: undefined })],
    }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe(
      "[shared message from Dana<U7> in #alerts<C900> at 1699.000100]\nthe db is on fire",
    );
    // An empty text used to read as "show me the settings", which is the worst
    // possible answer to somebody forwarding a message.
    expect(client.sent).toEqual([]);
  });

  it("does not read a link unfurl as a share", async () => {
    openGates();
    // Slack previewed a permalink somebody pasted; the sender did not forward
    // that message, so quoting it would put words in their mouth.
    await feed(message({
      text: "what is this about",
      ts: "1712.000100",
      attachments: [{
        is_msg_unfurl: true,
        author_name: "Grafana Alerts",
        channel_name: "alerts",
        text: "[FIRING:12] LedgerAdapterNotParsedLogs",
      }],
    }));
    expect(inbound[0]!.text).toBe("what is this about");
  });

  const shared = (over: Partial<SlackMessageEvent> = {}): SlackEnvelope =>
    message({ text: "", ts: "1713.000100", subtype: "message_share", ...over });

  it("inlines a small shared thread as transcript lines", async () => {
    openGates();
    client.threadReplies = [
      { type: "message", user: "U7", ts: "1699.000100", text: "the db is on fire", reply_count: 5 },
      { type: "message", user: "U42", ts: "1699.000200", thread_ts: "1699.000100", text: "restarting it" },
    ];
    await feed(shared({ attachments: [share({ reply_count: 5 })] }));
    const lines = inbound[0]!.text.split("\n");
    expect(lines[0]).toBe("[shared message from Dana<U7> in #alerts<C900> at 1699.000100]");
    // The transcript opens with the shared message itself, so its text is not
    // repeated above the thread.
    expect(lines[1]).toBe(
      "[thread: 5 replies, oldest first \u2014 <ts> HH:MM name[id]: text, local time,"
        + " a date line when the day changes; [thread N \u00b7 <ts>] marks a parent,"
        + " [file <name> <F\u2026> <size>] an upload]",
    );
    // The one format `pier slack` prints, with ts and ids on: a date line, then
    // the lines the skill describes.
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lines[3]).toMatch(/^1699\.000100 \d\d:\d\d Dana\[U7\]: the db is on fire \[thread 5 \u00b7 1699\.000100\]$/);
    expect(lines[4]).toMatch(/^1699\.000200 \d\d:\d\d Q\[U42\]: restarting it$/);
    // At the shared message's coordinates, not the current channel's.
    expect(client.repliesCalls).toEqual([{ channel: "C900", ts: "1699.000100" }]);
  });

  it("does not read a big thread, and says where it is instead", async () => {
    openGates();
    await feed(shared({ attachments: [share({ reply_count: 200 })] }));
    // Two hundred replies is not worth the tokens uninvited; the coordinates
    // are what the pier-slack script takes.
    expect(client.repliesCalls).toEqual([]);
    expect(inbound[0]!.text.split("\n").at(-1)).toBe(
      "[thread: 200 replies \u2014 channel C900, thread_ts 1699.000100]",
    );
  });

  it("says why a thread is missing rather than dropping it silently", async () => {
    openGates();
    client.replies = () =>
      Promise.reject(new Error("slack conversations.replies: not_in_channel"));
    await feed(shared({ attachments: [share({ reply_count: 5 })] }));
    // The turn still runs, and the reason is the action it implies.
    expect(inbound).toHaveLength(1);
    const lines = inbound[0]!.text.split("\n");
    expect(lines[1]).toBe("the db is on fire");
    expect(lines[2]).toBe(
      "[thread not read: Pier's bot is not in that channel; someone has to run `/invite @Pier` there before it can read]",
    );
    // Still told where to look, and the drop is logged too.
    expect(lines[3]).toContain("thread_ts 1699.000100");
    expect(dropped.some((d) => d.includes("shared thread C900/1699.000100 not read"))).toBe(true);
  });

  it("reads nothing for a shared reply, which is not a thread parent", async () => {
    openGates();
    await feed(shared({
      attachments: [share({ ts: "1699.000900", thread_ts: "1699.000100", reply_count: 5 })],
    }));
    expect(client.repliesCalls).toEqual([]);
    expect(inbound[0]!.text).not.toContain("thread");
  });

  it("says an inlined thread was cut rather than reading as complete", async () => {
    openGates();
    // `reply_count` undercounted: more came back than the budget allows, so the
    // transcript has to admit it stops short of the end.
    client.threadReplies = Array.from({ length: 40 }, (_, i) => ({
      type: "message",
      user: "U7",
      ts: `1699.0001${String(i).padStart(2, "0")}`,
      text: `line ${i}`,
    }));
    await feed(shared({ attachments: [share({ reply_count: 5 })] }));
    expect(inbound[0]!.text.split("\n").at(-1)).toBe("[thread partly read: cut at 32 lines]");
  });

  it("saves the share's files in the same loop as the event's own", async () => {
    openGates();
    await feed(message({
      text: "",
      ts: "1715.000100",
      subtype: "message_share",
      files: [{ id: "F8", name: "own.png", mimetype: "image/png", url_private_download: "https://files/own.png" }],
      attachments: [share({
        text: "logs",
        files: [
          { id: "F9", name: "log.txt", mimetype: "text/plain", url_private_download: "https://files/log.txt" },
          { id: "F10", name: "dump.bin", size: 33 * 1024 * 1024, url_private_download: "https://files/dump.bin" },
        ],
      })],
    }));
    const lines = inbound[0]!.text.split("\n");
    // One save loop over both sources, so a share's files get the size gate and
    // the lost marker an upload's already had.
    const markers = lines.filter((line) => line.includes("file://"));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatch(/-own\.png\]/);
    expect(markers[1]).toMatch(/-log\.txt\]/);
    expect(lines.at(-1)).toBe("[attachment lost: dump.bin \u2014 too large]");
  });

  it("does not download a share's files for an unauthorized sender", async () => {
    // Default policy: not addressed, so the gate closes before any bytes move.
    await feed(message({
      text: "",
      subtype: "message_share",
      attachments: [share({
        files: [{ id: "F9", name: "log.txt", mimetype: "text/plain", url_private_download: "https://files/log.txt" }],
      })],
    }));
    expect(inbound).toEqual([]);
    expect(dropped).toEqual(["dropped message in channel C100: not-addressed"]);
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

  it("uploads a file the agent linked into the same thread", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pier-slack-out-")), "report.md");
    writeFileSync(path, "hi");
    await channel.send("C100/1700.000100", {
      text: `here [report.md](file://${path})`,
      suggestions: [],
    });
    // The link is dead on every machine but this one, so the bytes go instead.
    expect(JSON.stringify(client.sent[0]!.blocks)).toContain("here report.md");
    expect(client.uploads).toEqual([{
      channel: "C100",
      threadTs: "1700.000100",
      name: "report.md",
      size: 2,
    }]);
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
    // The turn began when that message arrived and ran 3s: `meta` is also what
    // scopes the clear to this turn's own receipts (receipts.ts `settle`).
    await channel.send("C100/1704.000100", {
      text: "",
      suggestions: [],
      silence: "two humans talking",
      meta: { completedAt: Date.now() + 3000, durationMs: 3000, tokens: 7900 },
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

  it("renders a system note as a quote, and hands it the eyes for the turn", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1705.000100" }));
    // The typed message's own receipt, settled by the turn it started — what
    // follows is the turn nobody typed anything for.
    await channel.send("C100/1705.000100", { text: "on it", suggestions: [] });
    client.reactions.length = 0;
    const noteTs = `${client.nextTs}.000100`;
    await channel.notify("C100/1705.000100", {
      text: "subagent says hi",
      origin: { kind: "task-delegation", taskId: "t", runId: "r", sourceSessionId: null },
    });
    expect(client.sent.at(-1)!.text).toContain("> subagent says hi");
    expect(client.reactions).toEqual([{ channel: CHANNEL, ts: noteTs, name: "eyes", add: true }]);
    // Cleared by the turn-end, like a receipt on a message someone typed.
    await channel.send("C100/1705.000100", { text: "answered", suggestions: [] });
    expect(client.reactions.at(-1))
      .toEqual({ channel: CHANNEL, ts: noteTs, name: "eyes", add: false });
  });

  it("leaves an error note unmarked — no turn is coming to clear it", async () => {
    openGates();
    await feed(message({ text: "go", ts: "1706.000100" }));
    await channel.send("C100/1706.000100", { text: "on it", suggestions: [] });
    client.reactions.length = 0;
    await channel.notify("C100/1706.000100", { text: "it broke", origin: { kind: "error" } });
    expect(client.sent.at(-1)!.text).toContain("> it broke");
    expect(client.reactions).toEqual([]);
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
    await feed(click("cfg:cwdtype"));
    const view = client.views[0] as { private_metadata: string; callback_id: string };
    expect(view.callback_id).toBe("cfg_cwd");
    // No adapter-side state: the submission is understood from the modal alone.
    expect(view.private_metadata).toBe("C100/1710.000100");
  });

  it("starts a new session from the modal submission", async () => {
    await open();
    await feed(click("cfg:cwdtype"));
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
    // The startup sweep is a detached promise: wait for what it does, not for
    // however long a loaded machine needs to get around to it.
    await vi.waitFor(
      () => expect(client.reactions).toEqual([{ channel: "C100", ts: "5.5", name: "eyes", add: false }]),
      { interval: 1, timeout: 5_000 },
    );
    await reborn.stop();
  });

  it("a turn ending during the name lookup cannot consume the next message's receipt", async () => {
    openGates();
    // Park the lookup so the message sits in the window where the old code
    // had already marked its receipt.
    let releaseName: ((v: string) => void) | null = null;
    client.userName = () => new Promise((r) => (releaseName = r));
    client.emit(message({ text: "next", ts: "1799.000100" }));
    // The window opens when the handler enters the parked lookup, which is the
    // fact to wait for; feed() cannot be used, the chain stays open until then.
    await vi.waitFor(() => expect(releaseName).not.toBeNull(), { interval: 1, timeout: 5_000 });
    // A previous turn settles now: nothing may be on the books yet.
    await channel.send("C100/1799.000100", { text: "previous turn", suggestions: [] });
    expect(client.reactions).toEqual([]);
    releaseName!("Q");
    await settled();
    expect(client.reactions).toEqual([{ channel: "C100", ts: "1799.000100", name: "eyes", add: true }]);
    expect(inbound.at(-1)!.text).toBe("next");
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
