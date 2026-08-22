// The agent-facing Slack tool: cache-first reads, and the gates in front of
// them. Hermetic — in-memory store and archive, a scripted client.

import { beforeEach, describe, expect, it } from "vitest";
import { ChannelStore } from "./config.js";
import { SlackArchive, toTs } from "./slack-archive.js";
import { SlackDirectory } from "./slack-directory.js";
import type { SlackClient, SlackHistoryPage, SlackHistoryQuery, SlackSend } from "./slack-api.js";
import { handleSlackTool, type SlackToolDeps } from "./slack-tool.js";

const T = (seconds: number): string => `${seconds}.000100`;

class FakeClient {
  readonly historyCalls: { channel: string; query: SlackHistoryQuery }[] = [];
  readonly repliesCalls: { channel: string; ts: string }[] = [];
  readonly posted: SlackSend[] = [];
  /** What `conversations.history` will answer with. */
  timeline: { ts: string; user?: string; text?: string; thread_ts?: string }[] = [];
  threadReplies: { ts: string; user?: string; text?: string; thread_ts?: string }[] = [];

  history(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    this.historyCalls.push({ channel, query });
    const from = query.oldest ? Number(query.oldest) : 0;
    const to = query.latest ? Number(query.latest) : Number.MAX_SAFE_INTEGER;
    return Promise.resolve({
      messages: this.timeline
        .filter((m) => Number(m.ts) >= from && Number(m.ts) <= to)
        .map((m) => ({ type: "message", ...m })),
    });
  }

  replies(channel: string, ts: string): Promise<SlackHistoryPage> {
    this.repliesCalls.push({ channel, ts });
    return Promise.resolve({
      messages: this.threadReplies.map((m) => ({ type: "message", ...m })),
    });
  }

  postMessage(payload: SlackSend): Promise<{ ts: string }> {
    this.posted.push(payload);
    return Promise.resolve({ ts: T(9000) });
  }

  userName(userId: string): Promise<string> {
    return Promise.resolve(userId === "U1" ? "Ada" : userId);
  }
}

let store: ChannelStore;
let archive: SlackArchive;
let client: FakeClient;
let deps: SlackToolDeps;
let logs: string[];
/** What `here()` answers — the Slack thread the calling session is in. */
let at: { channel: string; threadTs: string } | null;

/** A configured, enabled Slack channel with one discovered public channel. */
function configure(over: { agentTool?: boolean; enabled?: boolean; token?: string } = {}): void {
  const config = store.get("slack");
  config.enabled = over.enabled ?? true;
  config.token = over.token ?? "xoxb-test";
  config.agentTool = over.agentTool ?? true;
  store.save("slack", config);
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
}

const call = (params: Record<string, unknown>): Promise<unknown> => handleSlackTool(deps, params);

beforeEach(() => {
  store = new ChannelStore(":memory:");
  archive = new SlackArchive(":memory:");
  client = new FakeClient();
  logs = [];
  at = null;
  deps = {
    store,
    archive,
    directory: new SlackDirectory((m) => logs.push(m)),
    client: () => client as unknown as SlackClient,
    here: () => at,
    log: (m) => logs.push(m),
  };
});

describe("gates", () => {
  it("refuses when the channel is not configured", async () => {
    await expect(call({ operation: "channels" })).rejects.toThrow(/not configured/);
  });

  it("refuses when the operator switched agent access off", async () => {
    configure({ agentTool: false });
    // Named explicitly: "it does nothing" is the most expensive failure for a
    // model to diagnose.
    await expect(call({ operation: "channels" })).rejects.toThrow(/switched off/);
  });

  it("is on by default for a configured channel", async () => {
    configure();
    await expect(call({ operation: "channels" })).resolves.toBeTruthy();
  });
});

describe("channel resolution", () => {
  beforeEach(() => configure());

  it("accepts a #name as well as an id", async () => {
    client.timeline = [{ ts: T(100), user: "U1", text: "hi" }];
    const byName = await call({ operation: "read_channel", channel: "#ops", until: T(200) }) as {
      channel: string;
    };
    expect(byName.channel).toBe("C100");
  });

  it("lists what it can reach, and says so when a name is unknown", async () => {
    await expect(call({ operation: "read_channel", channel: "#nope" }))
      .rejects.toThrow(/unknown channel #nope.*#ops/s);
  });

  it("reports whether each channel answers inbound messages", async () => {
    const channels = await call({ operation: "channels" }) as { respondsToMessages: boolean }[];
    expect(channels[0]).toMatchObject({ id: "C100", name: "#ops", respondsToMessages: true });
  });
});

describe("channel history", () => {
  beforeEach(() => configure());

  it("fetches, caches, and serves the second identical read from the cache", async () => {
    client.timeline = [
      { ts: T(100), user: "U1", text: "first" },
      { ts: T(150), user: "U2", text: "second" },
    ];
    const window = { operation: "read_channel", channel: "C100", since: T(50), until: T(200) };
    const first = await call(window) as { source: string; count: number };
    expect(first).toMatchObject({ source: "slack", count: 2 });
    expect(client.historyCalls).toHaveLength(1);

    const second = await call(window) as { source: string; count: number };
    // History is immutable, so a synced window never needs Slack again.
    expect(second).toMatchObject({ source: "cache", count: 2 });
    expect(client.historyCalls).toHaveLength(1);
  });

  it("remembers that a window was empty instead of re-asking forever", async () => {
    const window = { operation: "read_channel", channel: "C100", since: T(50), until: T(200) };
    expect(await call(window)).toMatchObject({ source: "slack", count: 0 });
    // The fact a message table cannot record: fetched, and there was nothing.
    expect(await call(window)).toMatchObject({ source: "cache", count: 0 });
    expect(client.historyCalls).toHaveLength(1);
  });

  it("always goes to Slack for an open-ended window", async () => {
    client.timeline = [{ ts: T(100), user: "U1", text: "hi" }];
    await call({ operation: "read_channel", channel: "C100", since: T(50) });
    await call({ operation: "read_channel", channel: "C100", since: T(50) });
    // "Up to now" cannot be satisfied by anything already on disk.
    expect(client.historyCalls).toHaveLength(2);
  });

  it("accepts ISO times and reports them back as ISO", async () => {
    client.timeline = [{ ts: "1717243800.000100", user: "U1", text: "hi" }];
    const out = await call({
      operation: "read_channel",
      channel: "C100",
      since: "2024-06-01T00:00:00Z",
      until: "2024-06-02T00:00:00Z",
    }) as { messages: { at: string }[]; since: string };
    expect(out.since).toBe("2024-06-01T00:00:00.000Z");
    expect(out.messages[0]!.at).toBe("2024-06-01T12:10:00.000Z");
  });

  it("resolves user ids to names, so the transcript is readable", async () => {
    client.timeline = [{ ts: T(100), user: "U1", text: "hi" }];
    const out = await call({ operation: "read_channel", channel: "C100", until: T(200) }) as {
      messages: { user: string }[];
    };
    expect(out.messages[0]!.user).toBe("Ada");
  });

  it("caps the result and says it was truncated", async () => {
    client.timeline = Array.from({ length: 20 }, (_, i) => ({ ts: T(100 + i), text: `m${i}` }));
    const out = await call({
      operation: "read_channel",
      channel: "C100",
      until: T(500),
      limit: 5,
    }) as { count: number; truncated: boolean };
    expect(out).toMatchObject({ count: 5, truncated: true });
  });

  it("does not claim coverage across a gap it never fetched", async () => {
    client.timeline = [{ ts: T(900), text: "late" }, { ts: T(100), text: "early" }];
    await call({ operation: "read_channel", channel: "C100", since: T(800), until: T(1000) });
    await call({ operation: "read_channel", channel: "C100", since: T(50), until: T(150) });
    // The two windows are disjoint; the middle was never asked for, so a read
    // spanning it must go back to Slack rather than serve a hole.
    const before = client.historyCalls.length;
    await call({ operation: "read_channel", channel: "C100", since: T(50), until: T(1000) });
    expect(client.historyCalls.length).toBe(before + 1);
  });
});

describe("threads", () => {
  beforeEach(() => configure());

  it("returns the parent and its replies, oldest first", async () => {
    client.threadReplies = [
      { ts: T(100), user: "U1", text: "parent" },
      { ts: T(110), user: "U2", text: "reply", thread_ts: T(100) },
    ];
    const out = await call({ operation: "read_thread", channel: "C100", thread_ts: T(100) }) as {
      count: number;
      messages: { text: string }[];
    };
    expect(out.count).toBe(2);
    expect(out.messages.map((m) => m.text)).toEqual(["parent", "reply"]);
  });

  it("serves a fresh thread from the cache", async () => {
    client.threadReplies = [{ ts: T(100), text: "parent" }];
    const q = { operation: "read_thread", channel: "C100", thread_ts: T(100) };
    expect(await call(q)).toMatchObject({ source: "slack" });
    expect(await call(q)).toMatchObject({ source: "cache" });
    expect(client.repliesCalls).toHaveLength(1);
  });

  it("keeps two threads in one channel apart", async () => {
    client.threadReplies = [
      { ts: T(100), text: "a-parent" },
      { ts: T(105), text: "a-reply", thread_ts: T(100) },
    ];
    await call({ operation: "read_thread", channel: "C100", thread_ts: T(100) });
    client.threadReplies = [{ ts: T(200), text: "b-parent" }];
    const b = await call({ operation: "read_thread", channel: "C100", thread_ts: T(200) }) as {
      messages: { text: string }[];
    };
    expect(b.messages.map((m) => m.text)).toEqual(["b-parent"]);
  });
});

describe("posting", () => {
  beforeEach(() => configure());

  it("starts a new thread when thread_ts is omitted, and reports its ts", async () => {
    const out = await call({ operation: "post", channel: "#ops", text: "**hi**" }) as {
      ts: string;
      threadTs: string;
    };
    expect(client.posted[0]).toMatchObject({ channel: "C100", thread_ts: undefined });
    // The new message's own ts is the thread to reply under.
    expect(out.threadTs).toBe(out.ts);
  });

  it("replies inside a thread when given one", async () => {
    await call({ operation: "post", channel: "C100", thread_ts: T(100), text: "in thread" });
    expect(client.posted[0]).toMatchObject({ thread_ts: T(100) });
  });

  it("sends the text as a markdown block, unconverted", async () => {
    await call({ operation: "post", channel: "C100", text: "## Title\n\n| a |\n| - |" });
    // The agent writes markdown; Slack renders it. No mrkdwn translation.
    expect(client.posted[0]!.blocks).toEqual([
      { type: "markdown", text: "## Title\n\n| a |\n| - |" },
    ]);
  });

  it("refuses text past Slack's per-message limit instead of truncating it", async () => {
    await expect(call({ operation: "post", channel: "C100", text: "x".repeat(12_000) }))
      .rejects.toThrow(/11000 per message/);
  });

  it("requires the fields it cannot invent", async () => {
    await expect(call({ operation: "post", channel: "C100" })).rejects.toThrow(/text is required/);
    await expect(call({ operation: "read_thread", channel: "C100" }))
      .rejects.toThrow(/thread_ts is required/);
  });
});

describe("the current conversation", () => {
  beforeEach(() => configure());

  it("reports where it is, and how to act there", async () => {
    at = { channel: "C100", threadTs: T(100) };
    expect(await call({ operation: "context" })).toMatchObject({
      inSlack: true,
      channel: "C100",
      channelName: "#ops",
      kind: "group",
      threadTs: T(100),
    });
  });

  it("says plainly when the session did not come from Slack", async () => {
    // A task or subagent session is attached to no conversation.
    expect(await call({ operation: "context" })).toMatchObject({ inSlack: false });
  });

  it("reads the current thread with no arguments", async () => {
    at = { channel: "C100", threadTs: T(100) };
    client.threadReplies = [{ ts: T(100), user: "U1", text: "hi" }];
    const out = await call({ operation: "read_thread" }) as { threadTs: string };
    expect(out.threadTs).toBe(T(100));
    expect(client.repliesCalls[0]).toMatchObject({ channel: "C100", ts: T(100) });
  });

  it("posts into the current thread with no arguments", async () => {
    at = { channel: "C100", threadTs: T(100) };
    await call({ operation: "post", text: "replying here" });
    expect(client.posted[0]).toMatchObject({ channel: "C100", thread_ts: T(100) });
  });

  it("starts a new top-level message only when asked explicitly", async () => {
    at = { channel: "C100", threadTs: T(100) };
    await call({ operation: "post", text: "announcement", thread_ts: "none" });
    expect(client.posted[0]).toMatchObject({ thread_ts: undefined });
  });

  it("does not leak the current thread onto a different channel", async () => {
    at = { channel: "C100", threadTs: T(100) };
    store.discoverChat("slack", { id: "C200", name: "#other", kind: "group" });
    await call({ operation: "post", channel: "#other", text: "hi" });
    // A ts from one channel means nothing in another.
    expect(client.posted[0]).toMatchObject({ channel: "C200", thread_ts: undefined });
  });

  it("explains the missing channel instead of failing obscurely", async () => {
    await expect(call({ operation: "read_channel" }))
      .rejects.toThrow(/not reached through Slack/);
  });

  it("gives every message a userId, which is what a mention needs", async () => {
    at = { channel: "C100", threadTs: T(100) };
    client.threadReplies = [{ ts: T(100), user: "U1", text: "hi" }];
    const out = await call({ operation: "read_thread" }) as {
      messages: { user: string; userId: string }[];
    };
    // Both: the name to read, the id to mention.
    expect(out.messages[0]).toMatchObject({ user: "Ada", userId: "U1" });
  });
});

describe("time parsing", () => {
  it("accepts ISO, epoch seconds and a raw ts; rejects nonsense", () => {
    expect(toTs("2024-06-01T00:00:00Z")).toBe("1717200000");
    expect(toTs("1717200000")).toBe("1717200000");
    expect(toTs("1717200000.000100")).toBe("1717200000.000100");
    expect(toTs(undefined)).toBeUndefined();
    expect(() => toTs("last tuesday")).toThrow(/not a time/);
  });
});
