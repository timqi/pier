// The agent-facing Slack tool: live reads, and the gates in front of them.
// Hermetic — in-memory store, a scripted client.

import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { SlackDirectory } from "./slack-directory.js";
import type { SlackClient, SlackHistoryPage, SlackHistoryQuery, SlackSend } from "./slack-api.js";
import {
  handleSlackTool,
  slackToolAvailable,
  slackToolSpec,
  type SlackToolDeps,
  toTs,
} from "./slack-tool.js";

const T = (seconds: number): string => `${seconds}.000100`;

type FakeMessage = {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
};

class FakeClient {
  readonly historyCalls: { channel: string; query: SlackHistoryQuery }[] = [];
  readonly repliesCalls: { channel: string; ts: string; cursor?: string }[] = [];
  readonly posted: SlackSend[] = [];
  readonly deleted: { channel: string; ts: string }[] = [];
  readonly updated: (SlackSend & { ts: string })[] = [];
  /** What Slack refuses with, when a test is about the refusal. */
  deleteError: string | null = null;
  updateError: string | null = null;
  /**
   * What `conversations.history` will answer with, in Slack's own order:
   * newest first. Anything that reverses it is the code under test.
   */
  timeline: FakeMessage[] = [];
  threadReplies: FakeMessage[] = [];
  /** Cursored pages, when a test is about paging rather than a window. */
  pages: FakeMessage[][] | null = null;
  /** Never runs out of pages — for the MAX_PAGES / MAX_MESSAGES caps. */
  endless = false;
  /** Page index from which Slack refuses, as it does mid-walk. */
  failFrom: number | null = null;

  private page(cursor: string | undefined, fallback: FakeMessage[]): SlackHistoryPage {
    const index = Number(cursor ?? "0");
    if (this.failFrom !== null && index >= this.failFrom) {
      throw new Error("slack conversations.history: not_in_channel");
    }
    if (this.endless) {
      const n = Number(cursor ?? "0");
      return {
        messages: [{ type: "message", ts: T(1000 + n), text: `m${n}` }],
        nextCursor: String(n + 1),
      };
    }
    if (!this.pages) return { messages: fallback.map((m) => ({ type: "message", ...m })) };
    return {
      messages: (this.pages[index] ?? []).map((m) => ({ type: "message", ...m })),
      nextCursor: index + 1 < this.pages.length ? String(index + 1) : undefined,
    };
  }

  history(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    this.historyCalls.push({ channel, query });
    const from = query.oldest ? Number(query.oldest) : 0;
    const to = query.latest ? Number(query.latest) : Number.MAX_SAFE_INTEGER;
    // Slack's bounds are inclusive-ish: the boundary message comes back.
    const window = this.timeline.filter((m) => Number(m.ts) >= from && Number(m.ts) <= to);
    return Promise.resolve(this.page(query.cursor, window));
  }

  replies(channel: string, ts: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    this.repliesCalls.push({ channel, ts, cursor: query.cursor });
    // Pier asks Slack for `inclusive`, so the boundary comes back.
    const from = query.oldest ? Number(query.oldest) : 0;
    const window = this.threadReplies.filter((m) => Number(m.ts) >= from);
    return Promise.resolve(this.page(query.cursor, window));
  }

  postMessage(payload: SlackSend): Promise<{ ts: string }> {
    this.posted.push(payload);
    return Promise.resolve({ ts: T(9000) });
  }

  updateMessage(payload: SlackSend & { ts: string }): Promise<void> {
    this.updated.push(payload);
    if (this.updateError) return Promise.reject(new Error(this.updateError));
    return Promise.resolve();
  }

  deleteMessage(channel: string, ts: string): Promise<void> {
    this.deleted.push({ channel, ts });
    if (this.deleteError) return Promise.reject(new Error(this.deleteError));
    return Promise.resolve();
  }

  userName(userId: string): Promise<string> {
    return Promise.resolve(userId === "U1" ? "Ada" : userId);
  }
}

let store: ChannelStore;
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

/** A transcript is `<ts> | <time> | <who> | <text>`; these read one column. */
const column = (out: unknown, index: number): string[] =>
  (out as { messages: string[] }).messages.map((line) => line.split(" | ")[index]!);
const texts = (out: unknown): string[] =>
  (out as { messages: string[] }).messages.map((line) => line.split(" | ").slice(3).join(" | "));

beforeEach(() => {
  store = new ChannelStore(openDb(":memory:"));
  client = new FakeClient();
  logs = [];
  at = null;
  deps = {
    store,
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

  it("is not handed to a session at all until Slack is usable", () => {
    // An unconfigured tool is not a disabled tool: its schema and description
    // would sit in the prompt of every turn and could answer nothing.
    expect(slackToolAvailable(store)).toBe(false);
    configure({ token: "" });
    expect(slackToolAvailable(store)).toBe(false);
    configure({ enabled: false });
    expect(slackToolAvailable(store)).toBe(false);
    configure({ agentTool: false });
    expect(slackToolAvailable(store)).toBe(false);
    configure();
    expect(slackToolAvailable(store)).toBe(true);
  });

  it("asks that question per session open, through the spec", () => {
    const spec = slackToolSpec(() => Promise.resolve(null), () => slackToolAvailable(store));
    expect(spec.available?.()).toBe(false);
    configure();
    expect(spec.available?.()).toBe(true);
  });

  it("still refuses with a reason when a live session outlives the switch", async () => {
    // The session was opened while Slack was on; the operator switched it off
    // mid-turn. Silence here reads as a broken tool.
    configure();
    configure({ agentTool: false });
    await expect(call({ operation: "channels" })).rejects.toThrow(/switched off/);
  });
});

describe("the advertised contract", () => {
  beforeEach(() => configure());

  /** What the model is actually offered — the schema, not the TS union. */
  const advertised = (): string[] => {
    const spec = slackToolSpec(() => Promise.resolve(null), () => true);
    return (spec.parameters as { properties: { operation: { enum: string[] } } })
      .properties.operation.enum;
  };

  it("offers every operation the handler answers, and nothing it does not", async () => {
    expect(advertised()).toEqual([
      "context",
      "read_channel",
      "read_thread",
      "read_message",
      "post",
      "edit",
      "delete",
      "channels",
    ]);
    for (const operation of advertised()) {
      // Called bare: a missing argument is the expected refusal. "unknown
      // operation" is not — it means the schema offers a word the handler
      // never answers, which no test of a single operation can catch.
      const outcome = await call({ operation }).catch((err: Error) => err.message);
      expect(String(outcome)).not.toMatch(/unknown slack operation/);
    }
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

  it("turns Slack's newest-first answer into a transcript", async () => {
    // Slack's own order. Nothing between here and the agent re-sorts it now
    // that no SQL `ORDER BY` does.
    client.timeline = [
      { ts: T(150), user: "U2", text: "second" },
      { ts: T(100), user: "U1", text: "first" },
    ];
    const out = await call({
      operation: "read_channel",
      channel: "C100",
      since: T(50),
      until: T(200),
    }) as { count: number };
    expect(out.count).toBe(2);
    expect(texts(out)).toEqual(["first", "second"]);
  });

  it("fetches every time, because only Slack knows about an edit", async () => {
    client.timeline = [{ ts: T(100), user: "U1", text: "first" }];
    const window = { operation: "read_channel", channel: "C100", since: T(50), until: T(200) };
    expect(await call(window)).toMatchObject({ count: 1 });
    expect(await call(window)).toMatchObject({ count: 1 });
    expect(client.historyCalls).toHaveLength(2);
  });

  it("walks the cursor and keeps one copy of a message repeated on the seam", async () => {
    client.pages = [
      [{ ts: T(150), text: "second" }, { ts: T(100), text: "first" }],
      [{ ts: T(100), text: "first" }, { ts: T(50), text: "zeroth" }],
    ];
    const out = await call({ operation: "read_channel", channel: "C100", until: T(200) });
    expect(texts(out)).toEqual(["zeroth", "first", "second"]);
    // Slack's exact string, trailing zeros and all: it is the id a reply has
    // to match. The retired archive stored it as REAL and rounded it off.
    expect(column(out, 0)).toEqual([T(50), T(100), T(150)]);
    expect(client.historyCalls).toHaveLength(2);
  });

  it("stops walking pages instead of following an endless cursor", async () => {
    client.endless = true;
    const out = await call({ operation: "read_channel", channel: "C100" }) as {
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(client.historyCalls).toHaveLength(10);
    expect(logs.some((l) => /truncated at 10 messages/.test(l))).toBe(true);
  });

  it("accepts ISO times, and reports the window and each message in UTC", async () => {
    client.timeline = [{ ts: "1717243800.000100", user: "U1", text: "hi" }];
    const out = await call({
      operation: "read_channel",
      channel: "C100",
      since: "2024-06-01T00:00:00Z",
      until: "2024-06-02T00:00:00Z",
    }) as { range: string };
    expect(out.range).toBe("2024-06-01T00:00Z → 2024-06-02T00:00Z");
    expect(column(out, 1)).toEqual(["2024-06-01T12:10Z"]);
  });

  it("names the speaker and keeps the id a mention needs", async () => {
    client.timeline = [
      { ts: T(100), user: "U1", text: "hi" },
      { ts: T(110), user: "U9", text: "who am i" },
    ];
    const out = await call({ operation: "read_channel", channel: "C100", until: T(200) });
    // An unresolved id is not printed twice.
    expect(column(out, 2)).toEqual(["Ada[U1]", "[U9]"]);
  });

  it("says how many replies a thread parent has, so opening it is a choice", async () => {
    client.timeline = [
      { ts: T(100), user: "U1", text: "deploy?", reply_count: 4 },
      { ts: T(110), user: "U1", text: "unrelated" },
    ];
    const out = await call({ operation: "read_channel", channel: "C100", until: T(200) });
    expect(texts(out)).toEqual(["deploy? [thread: 4 replies]", "unrelated"]);
  });

  it("reads only what is newer than a ts the agent already saw", async () => {
    client.timeline = [
      { ts: T(100), text: "seen" },
      { ts: T(150), text: "new" },
    ];
    const out = await call({ operation: "read_channel", channel: "C100", after: T(100) });
    // Strictly after: Slack's own bounds would have included the boundary.
    expect(texts(out)).toEqual(["new"]);
    expect(client.historyCalls[0]!.query.oldest).toBe(T(100));
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
    // The oldest five: a transcript is read forwards.
    expect(texts(out)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("hands back the pages it got when a later one fails, and says why", async () => {
    client.pages = [[{ ts: T(100), text: "first" }], []];
    client.failFrom = 1;
    const out = await call({ operation: "read_channel", channel: "C100" }) as {
      count: number;
      incomplete: string;
    };
    // A thrown error here is indistinguishable from a quiet channel.
    expect(out.count).toBe(1);
    expect(out.incomplete).toMatch(/\/invite @Pier/);
  });

  it("turns a Slack error code into something the agent can act on", async () => {
    client.failFrom = 0;
    await expect(call({ operation: "read_channel", channel: "C100" }))
      .rejects.toThrow(/\/invite @Pier` there before it can read/);
  });
});

describe("one message", () => {
  beforeEach(() => configure());

  it("returns just the message at a ts, as one line", async () => {
    client.timeline = [
      { ts: T(100), user: "U1", text: "the one" },
      { ts: T(150), user: "U2", text: "not this" },
    ];
    const out = await call({ operation: "read_message", channel: "C100", ts: T(100) }) as {
      message: string;
    };
    expect(out.message).toBe(`${T(100)} | 1970-01-01T00:01Z | Ada[U1] | the one`);
    // Asked for exactly one, with the boundary included on both sides.
    expect(client.historyCalls[0]!.query).toMatchObject({
      oldest: T(100),
      latest: T(100),
      limit: 1,
    });
  });

  it("reads a reply through its thread, and says so", async () => {
    client.threadReplies = [
      { ts: T(100), text: "parent" },
      { ts: T(110), user: "U1", text: "the reply", thread_ts: T(100) },
    ];
    const out = await call({
      operation: "read_message",
      channel: "C100",
      ts: T(110),
      thread_ts: T(100),
    }) as { message: string; threadTs: string };
    expect(out.message).toContain("the reply");
    expect(out.threadTs).toBe(T(100));
    expect(client.repliesCalls).toHaveLength(1);
  });

  it("points at thread_ts when a channel read cannot see the message", async () => {
    await expect(call({ operation: "read_message", channel: "C100", ts: T(110) }))
      .rejects.toThrow(/needs thread_ts/);
  });

  it("requires a ts", async () => {
    await expect(call({ operation: "read_message", channel: "C100" }))
      .rejects.toThrow(/ts is required/);
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
      threadTs: string;
    };
    expect(out.count).toBe(2);
    // Hoisted once instead of repeated on every line.
    expect(out.threadTs).toBe(T(100));
    expect(texts(out)).toEqual(["parent", "reply"]);
  });

  it("caps a long thread and says so, instead of reading as if it were whole", async () => {
    client.threadReplies = Array.from(
      { length: 20 },
      (_, i) => ({ ts: T(100 + i), text: `r${i}`, thread_ts: T(100) }),
    );
    const out = await call({
      operation: "read_thread",
      channel: "C100",
      thread_ts: T(100),
      limit: 5,
    }) as { count: number; truncated: boolean };
    expect(out).toMatchObject({ count: 5, truncated: true });
    expect(texts(out)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("returns only the replies newer than the last one the agent saw", async () => {
    client.threadReplies = [
      { ts: T(100), text: "parent" },
      { ts: T(110), text: "seen", thread_ts: T(100) },
      { ts: T(120), text: "new", thread_ts: T(100) },
    ];
    const out = await call({
      operation: "read_thread",
      channel: "C100",
      thread_ts: T(100),
      after: T(110),
    });
    expect(texts(out)).toEqual(["new"]);
    // Slack narrows the fetch; the boundary is dropped here.
    expect(client.repliesCalls).toHaveLength(1);
  });

  it("re-reads the thread every time, so a new reply is never missed", async () => {
    client.threadReplies = [{ ts: T(100), text: "parent" }];
    const q = { operation: "read_thread", channel: "C100", thread_ts: T(100) };
    expect(await call(q)).toMatchObject({ count: 1 });
    client.threadReplies = [{ ts: T(100), text: "parent" }, { ts: T(110), text: "late reply" }];
    expect(await call(q)).toMatchObject({ count: 2 });
    expect(client.repliesCalls).toHaveLength(2);
  });

  it("walks a paged thread", async () => {
    client.pages = [[{ ts: T(100), text: "parent" }], [{ ts: T(110), text: "reply" }]];
    const out = await call({ operation: "read_thread", channel: "C100", thread_ts: T(100) });
    expect(texts(out)).toEqual(["parent", "reply"]);
    expect(client.repliesCalls.map((c) => c.cursor)).toEqual([undefined, "1"]);
  });

  it("keeps two threads in one channel apart", async () => {
    client.threadReplies = [
      { ts: T(100), text: "a-parent" },
      { ts: T(105), text: "a-reply", thread_ts: T(100) },
    ];
    await call({ operation: "read_thread", channel: "C100", thread_ts: T(100) });
    client.threadReplies = [{ ts: T(200), text: "b-parent" }];
    const b = await call({ operation: "read_thread", channel: "C100", thread_ts: T(200) });
    expect(texts(b)).toEqual(["b-parent"]);
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

  it("reports a mention that posted as plain text and notified nobody", async () => {
    const out = await call({ operation: "post", channel: "C100", text: "@alice ready?" });
    expect(out).toMatchObject({ hint: expect.stringMatching(/@alice.*<@U/) });
    // Reported, not refused: the message is on Slack either way.
    expect(client.posted).toHaveLength(1);

    const group = await call({ operation: "post", channel: "C100", text: "@here deploy" });
    expect(group).toMatchObject({ hint: expect.stringMatching(/<!here>/) });
  });

  it("stays quiet when the syntax is already Slack's, or is only code", async () => {
    for (const text of ["<@U04B7Q2> ready?", "see <#C100>", "run `git log @{u}`", "mail a@b.com"]) {
      expect(await call({ operation: "post", channel: "C100", text })).not.toHaveProperty("hint");
    }
  });

  it("requires the fields it cannot invent", async () => {
    await expect(call({ operation: "post", channel: "C100" })).rejects.toThrow(/text is required/);
    await expect(call({ operation: "read_thread", channel: "C100" }))
      .rejects.toThrow(/thread_ts is required/);
  });
});

describe("editing", () => {
  beforeEach(() => configure());

  it("replaces the text of the named message, as markdown", async () => {
    client.timeline = [{ ts: T(100), user: "U1", text: "before" }];
    expect(await call({ operation: "edit", channel: "#ops", ts: T(100), text: "## fixed" }))
      .toMatchObject({ channel: "C100", ts: T(100), edited: true });
    expect(client.updated[0]).toMatchObject({
      channel: "C100",
      ts: T(100),
      text: "## fixed",
      blocks: [{ type: "markdown", text: "## fixed" }],
    });
    // The previous text is gone from Slack, so the log is the only record —
    // and a record that says only "something changed" is not one.
    expect(logs.some((l) => l.includes(`edited ${T(100)}`) && l.includes("was: before"))).toBe(true);
  });

  it("finds the old text of a reply in the thread it is standing in", async () => {
    // `conversations.history` cannot see inside a thread: without the default
    // from `here`, every correction to its own reply would log "not captured".
    at = { channel: "C100", threadTs: T(100) };
    client.threadReplies = [{ ts: T(110), user: "U1", text: "typo", thread_ts: T(100) }];
    await call({ operation: "edit", ts: T(110), text: "fixed" });
    expect(client.repliesCalls[0]).toMatchObject({ channel: "C100", ts: T(100) });
    expect(logs.some((l) => l.includes("was: typo"))).toBe(true);
  });

  it("still edits when the old text cannot be read back, and says it was not kept", async () => {
    client.failFrom = 0; // history refuses; the correction must not be lost with it
    await call({ operation: "edit", channel: "C100", ts: T(100), text: "fixed" });
    expect(client.updated).toHaveLength(1);
    expect(logs.some((l) => l.includes("(not captured)"))).toBe(true);
  });

  it("reports an inert mention in a correction too", async () => {
    expect(await call({ operation: "edit", channel: "C100", ts: T(100), text: "@alice ping" }))
      .toMatchObject({ hint: expect.stringMatching(/@alice/) });
  });

  it("never guesses the target, even inside a thread", async () => {
    at = { channel: "C100", threadTs: T(100) };
    await expect(call({ operation: "edit", text: "x" })).rejects.toThrow(/ts is required/);
    await expect(call({ operation: "edit", ts: T(100) })).rejects.toThrow(/text is required/);
    expect(client.updated).toEqual([]);
  });

  it("refuses text past Slack's per-message limit instead of truncating it", async () => {
    await expect(call({ operation: "edit", channel: "C100", ts: T(100), text: "x".repeat(12_000) }))
      .rejects.toThrow(/11000 per message/);
    expect(client.updated).toEqual([]);
  });

  it("turns Slack's refusal into what it means", async () => {
    client.updateError = "slack chat.update: cant_update_message";
    await expect(call({ operation: "edit", channel: "C100", ts: T(100), text: "x" }))
      .rejects.toThrow(/own bot posted/);
  });
});

describe("deleting", () => {
  beforeEach(() => configure());

  it("removes the named message and says so", async () => {
    expect(await call({ operation: "delete", channel: "#ops", ts: T(100) }))
      .toMatchObject({ channel: "C100", ts: T(100), deleted: true });
    expect(client.deleted).toEqual([{ channel: "C100", ts: T(100) }]);
    // Nothing is left to read afterwards, so the log is the only record.
    expect(logs.some((l) => l.includes(T(100)))).toBe(true);
  });

  it("never guesses the target, even inside a thread", async () => {
    at = { channel: "C100", threadTs: T(100) };
    await expect(call({ operation: "delete" })).rejects.toThrow(/ts is required/);
    expect(client.deleted).toEqual([]);
  });

  it("turns Slack's refusal into what it means", async () => {
    client.deleteError = "slack chat.delete: cant_delete_message";
    await expect(call({ operation: "delete", channel: "C100", ts: T(100) }))
      .rejects.toThrow(/own bot posted/);
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
    const out = await call({ operation: "read_thread" });
    // Both: the name to read, the id to mention.
    expect(column(out, 2)).toEqual(["Ada[U1]"]);
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

  it("refuses milliseconds instead of reading a channel that looks empty", () => {
    // Taken as seconds this is the year 56387: Slack finds nothing there and
    // the read is indistinguishable from a quiet channel.
    expect(() => toTs("1717200000000")).toThrow(/epoch seconds, not milliseconds/);
    expect(() => toTs(1717200000000)).toThrow(/epoch seconds, not milliseconds/);
    // The number path still takes a real time.
    expect(toTs(1717200000)).toBe("1717200000");
  });
});
