// What the panel may do to a thread's session: act on the real one, resume an
// evicted one, refuse when there is none — never confirm a no-op. Real Router
// and store, fake Pi.

import { beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type {
  AgentFactory,
  AgentLaunchOptions,
  AgentSession,
  ChatTurn,
  ConversationKey,
  ModelRef,
  SessionSummary,
} from "../core/types.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { ConversationStore, resolveConversation } from "./conversations.js";
import { type ChannelControl, createControl, HAS_SESSION, NO_SESSION } from "./control.js";

const KEY: ConversationKey = { channelId: "slack", conversationId: "C100/1717.7" };
const SONNET: ModelRef = { provider: "anthropic", id: "sonnet" };

const fake = (id: string, history: ChatTurn[] = []): FakeSession => fakeSession(id, { model: SONNET, history });

/** Like Pi: a created session is an object, and on disk — resumable,
 *  findable — only once written. `created` records every launch. */
function fakeFactory(onDisk: FakeSession[] = []) {
  const created: AgentLaunchOptions[] = [];
  const resumed: string[] = [];
  const written = new Map(onDisk.map((s) => [s.id, s]));
  let next = 0;
  const factory = {
    created,
    resumed,
    written,
    availableModels: () => Promise.resolve([SONNET]),
    create(opts: AgentLaunchOptions) {
      created.push(opts);
      return Promise.resolve(fake(`new${String(++next)}`));
    },
    resume(id: string) {
      resumed.push(id);
      const s = written.get(id);
      return s ? Promise.resolve(s) : Promise.reject(new Error(`unknown session: ${id}`));
    },
    listed: [] as SessionSummary[],
    list() {
      return Promise.resolve(factory.listed);
    },
    find: (id: string) =>
      Promise.resolve(written.has(id) ? { id, cwd: `/srv/${id}`, createdAt: 1 } : undefined),
    search: () => Promise.resolve([]),
  };
  return factory;
}

let hub: EventHub;
let router: Router;
let conversations: ConversationStore;
let factory: ReturnType<typeof fakeFactory>;
let control: ChannelControl;
let store: ChannelStore;
let stale: [ConversationKey, string][];

function wire(f: ReturnType<typeof fakeFactory>): void {
  factory = f;
  hub = new EventHub();
  const db = openDb(":memory:");
  conversations = new ConversationStore(db);
  const vault = new Map<string, string>();
  store = new ChannelStore(db, { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  stale = [];
  let resolveIm: (key: ConversationKey) => Promise<AgentSession> = () => Promise.reject(new Error("unwired"));
  router = new Router(hub, (key) => resolveIm(key), (key) => conversations.get(key));
  control = createControl({ router, factory: factory as unknown as AgentFactory, conversations, store, modelMenu: () => [] });
  resolveIm = resolveConversation(conversations, factory as unknown as AgentFactory, control.launchFor, (k, m) => stale.push([k, m]));
}

beforeEach(() => wire(fakeFactory()));

describe("status", () => {
  it("is null for a thread without a row, and opens nothing", async () => {
    expect(await control.status(KEY)).toBeNull();
    expect(factory.created).toEqual([]);
    expect(factory.resumed).toEqual([]);
  });

  it("resumes an evicted session instead of answering null", async () => {
    const s = fake("s1", [{ role: "user", text: "hi" }]);
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    // Nothing attached in the router: the eviction already happened.
    expect(router.sessionOf(KEY)).toBeUndefined();
    const status = await control.status(KEY);
    expect(status).toMatchObject({ sessionId: "s1", cwd: "/srv/s1", empty: false, model: SONNET });
    expect(factory.resumed).toEqual(["s1"]);
    expect(router.sessionOf(KEY)?.id).toBe("s1");
  });

  it("reports a session with no turn as empty", async () => {
    wire(fakeFactory([fake("s1")]));
    conversations.set(KEY, "s1");
    expect((await control.status(KEY))?.empty).toBe(true);
  });
});

describe("working", () => {
  it("is the attached session's turn, and asking resumes nothing", () => {
    const s = fake("s1");
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    // Evicted, so idle: the sweep must not open a session to find that out.
    expect(control.working(KEY)).toBe(false);
    router.attach(KEY, s);
    expect(control.working(KEY)).toBe(false);
    s.setState("streaming");
    expect(control.working(KEY)).toBe(true);
    expect(factory.resumed).toEqual([]);
  });
});

describe("setModel / setThinking", () => {
  it("setModel on a thread without a row rejects with NO_SESSION and touches no session", async () => {
    await expect(control.setModel(KEY, SONNET)).rejects.toThrow(NO_SESSION);
    expect(factory.created).toEqual([]);
    expect(factory.resumed).toEqual([]);
  });

  it("setThinking resumes then applies", async () => {
    const s = fake("s1");
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    await control.setThinking(KEY, "high");
    expect(s.calls).toEqual(["setThinkingLevel:high"]);
    expect(factory.resumed).toEqual(["s1"]);
  });

  it("setModel applies to the live session without a second open", async () => {
    const s = fake("s1");
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    router.attach(KEY, s);
    await control.setModel(KEY, SONNET);
    expect(s.calls).toEqual(["setModel:anthropic/sonnet"]);
    expect(factory.resumed).toEqual([]);
  });
});

describe("the launch record", () => {
  it("newSession records the launch it used", async () => {
    const id = await control.newSession(KEY, { cwd: "/srv/pier" });
    expect(id).toBe("new1");
    expect(factory.created).toEqual([{ cwd: "/srv/pier" }]);
    expect(conversations.launchOf(KEY)).toEqual({ cwd: "/srv/pier" });
    // Attached at once: the panel's next look finds it without a resume.
    expect(router.sessionOf(KEY)?.id).toBe("new1");
    expect(factory.resumed).toEqual([]);
  });

  it("a row written while Pi was opening wins; the session nobody routes to is let go", async () => {
    // A message already inside resolveConversation when Start was tapped.
    let born: FakeSession | undefined;
    factory.create = () => {
      conversations.set(KEY, "raced");
      born = fake("loser");
      return Promise.resolve(born);
    };
    await expect(control.newSession(KEY, { cwd: "/srv/pier" })).rejects.toThrow(HAS_SESSION);
    expect(conversations.get(KEY)).toBe("raced");
    expect(born!.calls).toEqual(["dispose"]);
    // Nothing attached: the thread keeps answering from the row that won.
    expect(router.sessionOf(KEY)).toBeUndefined();
  });

  it("a draft's model and reasoning are created with and recorded; the chat defaults fill the rest", async () => {
    const config = store.get("slack");
    Object.assign(config.chats[0]!, { cwd: "/srv/default", thinking: "low" });
    store.save("slack", config);
    await control.newSession(KEY, { model: SONNET, thinking: "high" });
    expect(factory.created).toEqual([{ cwd: "/srv/default", model: SONNET, thinking: "high" }]);
    expect(conversations.launchOf(KEY)).toEqual({ cwd: "/srv/default", model: SONNET, thinking: "high" });
  });

  it("setModel and setThinking amend the record", async () => {
    await control.newSession(KEY, { cwd: "/srv/pier" });
    await control.setModel(KEY, SONNET);
    await control.setThinking(KEY, "high");
    expect(conversations.launchOf(KEY)).toEqual({ cwd: "/srv/pier", model: SONNET, thinking: "high" });
  });

  it("a created session that Pi never wrote is re-created from the record after an eviction", async () => {
    await control.newSession(KEY, { cwd: "/srv/pier" });
    await control.setThinking(KEY, "high");
    // Eviction, then the transcript is not there: Pi wrote nothing.
    await router.evictIdle(0);
    const status = await control.status(KEY);
    expect(status?.sessionId).toBe("new2");
    expect(factory.created[1]).toEqual({ cwd: "/srv/pier", thinking: "high" });
    expect(stale[0]![1]).toBe(`Session ${"new1".slice(0, 8)} had no messages yet — continuing as new2.`);
  });

  it("the directory of a session not yet on disk comes from the record", async () => {
    await control.newSession(KEY, { cwd: "/srv/pier" });
    expect((await control.status(KEY))?.cwd).toBe("/srv/pier");
  });
});

describe("recentDirs", () => {
  it("dedupes, newest first, chat cwd first", async () => {
    const at = (id: string, cwd: string, createdAt: number): SessionSummary => ({ id, cwd, createdAt });
    // Listed in none of the orders asserted below: only the sort can produce them.
    factory.listed = [at("d", "/srv/older", 1), at("b", "/srv/old", 3), at("c", "/srv/new", 2), at("a", "/srv/new", 4)];
    expect(await control.recentDirs(KEY)).toEqual(["/srv/new", "/srv/old", "/srv/older"]);
    expect(await control.recentDirs(KEY, 2)).toEqual(["/srv/new", "/srv/old"]);
  });

  it("puts the chat's own directory first when the Console set one", async () => {
    const at = (id: string, cwd: string): SessionSummary => ({ id, cwd, createdAt: 1 });
    factory.listed = [at("a", "/srv/new"), at("b", "/srv/ops")];
    const config = store.get("slack");
    config.chats[0]!.cwd = "/srv/ops";
    store.save("slack", config);
    expect(await control.recentDirs(KEY)).toEqual(["/srv/ops", "/srv/new"]);
  });
});

describe("a row whose transcript is gone", () => {
  it("re-creates and tells the thread", async () => {
    conversations.set(KEY, "vanished");
    const status = await control.status(KEY);
    expect(status?.sessionId).toBe("new1");
    expect(conversations.get(KEY)).toBe("new1");
    expect(stale).toHaveLength(1);
    expect(stale[0]![0]).toEqual(KEY);
    expect(stale[0]![1]).toMatch(/^Session vanished is gone from disk/);
  });
});

describe("claimBot", () => {
  const DM: ConversationKey = { channelId: "slack", conversationId: "D1/1717.7" };

  beforeEach(() => {
    store.discoverChat("slack", { id: "D1", name: "DM · qiqi", kind: "dm" });
    conversations.set(DM, "s-dm");
    conversations.set(KEY, "s-group");
  });

  it("records the first identity and forgets nothing", () => {
    expect(control.claimBot("slack", "U1")).toEqual([]);
    expect(store.get("slack").botId).toBe("U1");
    expect(store.chat("slack", "D1")).toBeDefined();
    expect(conversations.get(DM)).toBe("s-dm");
  });

  it("is a no-op on every later start under the same bot", () => {
    control.claimBot("slack", "U1");
    expect(control.claimBot("slack", "U1")).toEqual([]);
    expect(store.chat("slack", "D1")).toBeDefined();
  });

  it("drops the previous bot's DMs and their threads, keeping groups", () => {
    control.claimBot("slack", "U1");
    expect(control.claimBot("slack", "U2")).toEqual(["D1"]);
    expect(store.get("slack").botId).toBe("U2");
    expect(store.chat("slack", "D1")).toBeUndefined();
    expect(conversations.get(DM)).toBeUndefined();
    // A group keeps its id across the swap, so its threads keep their sessions.
    expect(store.chat("slack", "C100")).toBeDefined();
    expect(conversations.get(KEY)).toBe("s-group");
  });

  it("ignores an identity the platform did not give", () => {
    control.claimBot("slack", "U1");
    expect(control.claimBot("slack", "")).toEqual([]);
    expect(store.get("slack").botId).toBe("U1");
  });
});
