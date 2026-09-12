// Web ↔ IM handoff: every refusal by status and sentence, the push's happy
// path — post first, then the row, then the live attach — and the pull, which
// shares the guards and the binding. Hermetic: in-memory stores, a scripted
// runtime, a fake Pi.

import { beforeEach, describe, expect, it } from "vitest";
import type { Router } from "../core/router.js";
import type { AgentSession, ConversationKey, SessionSummary, WorkspaceEvent } from "../core/types.js";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { ConversationStore } from "./conversations.js";
import { createHandoff, HandoffError } from "./handoff.js";
import type { ChannelPlatform, HandoffNote } from "./types.js";

let store: ChannelStore;
let conversations: ConversationStore;
let running: ChannelPlatform[];
let opened: { platform: string; chatId: string; note: HandoffNote }[];
let openFails: Error | undefined;
let onDisk: Map<string, SessionSummary>;
let taskOwned: Set<string>;
let ranks: Map<string, { rank?: number }>;
let loaded: Map<string, AgentSession>;
let attached: [ConversationKey, AgentSession][];
let events: WorkspaceEvent[];
let logs: string[];
let publicUrl: string;

const SLACK_OPS = { platform: "slack" as const, chatId: "C100" };

function handoff() {
  return createHandoff({
    store,
    runtime: {
      running: () => running,
      openThread: (platform, chatId, note) => {
        opened.push({ platform, chatId, note });
        return openFails ? Promise.reject(openFails) : Promise.resolve(`${chatId}/1717.1`);
      },
    },
    conversations,
    factory: {
      find: (id) => Promise.resolve(onDisk.get(id)),
      list: () => Promise.resolve([...onDisk.values()]),
    },
    router: {
      sessionOf: (key) => (key.channelId === "web" ? loaded.get(key.conversationId) : undefined),
      attach: (key, session) => void attached.push([key, session]),
    } as Pick<Router, "sessionOf" | "attach">,
    hub: { emitWorkspace: (e) => void events.push(e) },
    publicUrl: () => publicUrl,
    taskSessions: () => taskOwned,
    workingSet: () => ranks,
    log: (m) => void logs.push(m),
  });
}

beforeEach(() => {
  taskOwned = new Set();
  ranks = new Map();
  const db = openDb(":memory:");
  const vault = new Map<string, string>();
  store = new ChannelStore(db, { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  store.discoverChat("lark", { id: "oc_1", name: "DM · Qi", kind: "dm" });
  conversations = new ConversationStore(db);
  running = ["slack", "lark"];
  opened = [];
  openFails = undefined;
  onDisk = new Map([["s1", { id: "s1", cwd: "/srv/parser", createdAt: 1, title: "Fix the parser" }]]);
  loaded = new Map();
  attached = [];
  events = [];
  logs = [];
  publicUrl = "https://pier.example";
});

const refused = async (req: Parameters<ReturnType<typeof handoff>["continueIn"]>[0]): Promise<HandoffError> => {
  try {
    await handoff().continueIn(req);
  } catch (err) {
    if (err instanceof HandoffError) return err;
    throw err;
  }
  throw new Error("was not refused");
};

describe("targets", () => {
  it("lists running platforms × enabled chats", () => {
    expect(handoff().targets()).toEqual([
      { platform: "slack", chatId: "C100", name: "#ops", kind: "group" },
      { platform: "lark", chatId: "oc_1", name: "DM · Qi", kind: "dm" },
    ]);
    running = ["lark"];
    const lark = store.get("lark");
    lark.chats[0]!.enabled = false;
    store.save("lark", lark);
    expect(handoff().targets()).toEqual([]);
  });
});

describe("continueIn refuses", () => {
  it("a platform that is not running", async () => {
    running = ["lark"];
    const err = await refused({ sessionId: "s1", ...SLACK_OPS });
    expect(err.status).toBe(409);
    expect(err.message).toBe("Slack is not running — enable it in Settings → Channels.");
    expect(opened).toEqual([]);
  });

  it("a chat it has never seen (404) or one switched off (409)", async () => {
    expect(await refused({ sessionId: "s1", platform: "slack", chatId: "C999" })).toMatchObject({
      status: 404, message: "That chat is not enabled for the bot.",
    });
    const slack = store.get("slack");
    slack.chats[0]!.enabled = false;
    store.save("slack", slack);
    expect(await refused({ sessionId: "s1", ...SLACK_OPS })).toMatchObject({ status: 409 });
    expect(opened).toEqual([]);
  });

  it("a session not on disk — never prompted", async () => {
    const err = await refused({ sessionId: "nascent1", ...SLACK_OPS });
    expect(err.status).toBe(404);
    expect(err.message).toBe("Session nascent1 has no transcript yet — send it one message first.");
  });

  it("a session that already answers in a chat, naming it", async () => {
    conversations.set({ channelId: "lark", conversationId: "oc_1/om_9" }, "s1");
    const err = await refused({ sessionId: "s1", ...SLACK_OPS });
    expect(err.status).toBe(409);
    expect(err.message).toBe("Already answers in lark · DM · Qi.");
    expect(opened).toEqual([]);
  });

  it("with the platform's message when the post fails, and writes no row", async () => {
    openFails = new Error("lark message.create: 99991672 permission denied");
    const err = await refused({ sessionId: "s1", platform: "lark", chatId: "oc_1" });
    expect(err.status).toBe(502);
    expect(err.message).toBe("Error: lark message.create: 99991672 permission denied");
    expect(conversations.keyOf("s1")).toBeUndefined();
    expect(attached).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("continueIn", () => {
  it("posts once, writes the row, attaches when loaded, emits sessions-changed", async () => {
    const session = { id: "s1" } as AgentSession;
    loaded.set("s1", session);
    const result = await handoff().continueIn({ sessionId: "s1", ...SLACK_OPS });
    expect(result).toEqual({ conversationId: "C100/1717.1" });
    expect(opened).toEqual([{
      platform: "slack", chatId: "C100",
      note: { title: "Fix the parser", url: "https://pier.example/#/session/s1" },
    }]);
    const key = { channelId: "slack", conversationId: "C100/1717.1" };
    expect(conversations.keyOf("s1")).toEqual(key);
    expect(conversations.launchOf(key)).toBeUndefined();
    expect(attached).toEqual([[key, session]]);
    expect(events).toEqual([{ type: "sessions-changed" }]);
    expect(logs[0]).toContain("s1 continued in slack:C100/1717.1");
    // Bound now: a second handoff is refused by the first chat's name.
    expect(await refused({ sessionId: "s1", platform: "lark", chatId: "oc_1" })).toMatchObject({
      status: 409, message: "Already answers in slack · #ops.",
    });
  });

  it("a session not loaded gets its row and nothing else — the row is enough", async () => {
    await handoff().continueIn({ sessionId: "s1", ...SLACK_OPS });
    expect(attached).toEqual([]);
    expect(conversations.keyOf("s1")?.channelId).toBe("slack");
  });

  it("title falls back to the directory name", async () => {
    onDisk.set("s2", { id: "s2", cwd: "/srv/parser", createdAt: 1 });
    await handoff().continueIn({ sessionId: "s2", ...SLACK_OPS });
    expect(opened[0]!.note.title).toBe("parser");
  });

  it("a speaker header on the title is not announced", async () => {
    onDisk.set("s3", { id: "s3", cwd: "/srv/parser", createdAt: 1, title: "[qi<U1> 12:01 slack:C1/2]\nfix it" });
    await handoff().continueIn({ sessionId: "s3", ...SLACK_OPS });
    expect(opened[0]!.note.title).toBe("fix it");
  });

  it("a multi-line title is announced on one line", async () => {
    // The root wraps it in `*…*` / `**…**`: a newline inside breaks the markup.
    onDisk.set("s4", { id: "s4", cwd: "/srv/parser", createdAt: 1, title: "fix the parser\nthen the tests" });
    await handoff().continueIn({ sessionId: "s4", ...SLACK_OPS });
    expect(opened[0]!.note.title).toBe("fix the parser then the tests");
  });

  it("no public URL → empty link", async () => {
    publicUrl = "";
    await handoff().continueIn({ sessionId: "s1", ...SLACK_OPS });
    expect(opened[0]!.note.url).toBe("");
  });
});

describe("continueHere (pull from the panel)", () => {
  const THREAD: ConversationKey = { channelId: "slack", conversationId: "C100/1717.5" };

  it("binds the thread, attaches when loaded, emits, and posts nothing", async () => {
    const session = { id: "s1" } as AgentSession;
    loaded.set("s1", session);
    await handoff().continueHere(THREAD, "s1");
    expect(conversations.keyOf("s1")).toEqual(THREAD);
    expect(attached).toEqual([[THREAD, session]]);
    expect(events).toEqual([{ type: "sessions-changed" }]);
    expect(opened).toEqual([]);
    expect(logs[0]).toContain("s1 continued in slack:C100/1717.5");
  });

  it("refuses with the push's sentences: not on disk, already bound", async () => {
    await expect(handoff().continueHere(THREAD, "nascent1")).rejects.toMatchObject({
      status: 404, message: "Session nascent1 has no transcript yet — send it one message first.",
    });
    conversations.set({ channelId: "lark", conversationId: "oc_1/om_9" }, "s1");
    await expect(handoff().continueHere(THREAD, "s1")).rejects.toMatchObject({
      status: 409, message: "Already answers in lark · DM · Qi.",
    });
    expect(conversations.get(THREAD)).toBeUndefined();
  });

  it("refuses a thread that already has a session rather than orphaning it", async () => {
    conversations.set(THREAD, "s0");
    await expect(handoff().continueHere(THREAD, "s1")).rejects.toMatchObject({
      status: 409, message: "This thread already has a session.",
    });
    expect(conversations.get(THREAD)).toBe("s0");
  });
});

describe("unbound", () => {
  it("lists what the web rail lists: working set first, then newest, minus bound and task-owned, capped", async () => {
    onDisk.set("s2", { id: "s2", cwd: "/srv/b", createdAt: 2 });
    onDisk.set("s3", { id: "s3", cwd: "/srv/c", createdAt: 3 });
    onDisk.set("s4", { id: "s4", cwd: "/srv/d", createdAt: 4 });
    onDisk.set("s5", { id: "s5", cwd: "/srv/e", createdAt: 5 });
    taskOwned.add("s4");
    conversations.set({ channelId: "lark", conversationId: "oc_1/om_9" }, "s2");
    ranks.set("s1", { rank: 1 });
    ranks.set("s3", { rank: 0 });
    expect((await handoff().unbound(10)).map((s) => s.id)).toEqual(["s3", "s1", "s5"]);
    expect((await handoff().unbound(1)).map((s) => s.id)).toEqual(["s3"]);
  });
});
