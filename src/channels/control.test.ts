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
  SessionEventPayload,
  SessionSummary,
  ThinkingLevel,
} from "../core/types.js";
import { openDb } from "../db.js";
import { ChannelStore } from "./config.js";
import { ConversationStore, resolveConversation } from "./conversations.js";
import { type ChannelControl, createControl, NO_SESSION } from "./control.js";

const KEY: ConversationKey = { channelId: "slack", conversationId: "C100/1717.7" };
const SONNET: ModelRef = { provider: "anthropic", id: "sonnet" };

/** The members control and the router read; the rest of the seam is unused. */
function fakeSession(id: string, turns: ChatTurn[] = []) {
  const listeners = new Set<(e: SessionEventPayload) => void>();
  const session = {
    id,
    state: "idle" as const,
    model: SONNET,
    thinkingLevel: "medium" as ThinkingLevel,
    contextUsage: undefined,
    models: [] as ModelRef[],
    levels: [] as ThinkingLevel[],
    history: () => Promise.resolve(turns),
    setModel(model: ModelRef) {
      session.models.push(model);
      return Promise.resolve();
    },
    availableThinkingLevels: () => ["off", "medium", "high"] as ThinkingLevel[],
    setThinkingLevel(level: ThinkingLevel) {
      session.levels.push(level);
    },
    subscribe(fn: (e: SessionEventPayload) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    pendingQueue: () => Promise.resolve({ steering: [], followUp: [] }),
    dispose: () => Promise.resolve(),
  };
  return session;
}

type Fake = ReturnType<typeof fakeSession>;

/** Sessions "on disk": resumable and findable. `created` records every launch. */
function fakeFactory(onDisk: Fake[] = []) {
  const created: AgentLaunchOptions[] = [];
  const resumed: string[] = [];
  const live = new Map(onDisk.map((s) => [s.id, s]));
  let next = 0;
  const factory = {
    created,
    resumed,
    live,
    availableModels: () => Promise.resolve([SONNET]),
    create(opts: AgentLaunchOptions) {
      created.push(opts);
      const s = fakeSession(`new${String(++next)}`);
      live.set(s.id, s);
      return Promise.resolve(s as unknown as AgentSession);
    },
    resume(id: string) {
      resumed.push(id);
      const s = live.get(id);
      return s ? Promise.resolve(s as unknown as AgentSession) : Promise.reject(new Error(`unknown session: ${id}`));
    },
    list: () => Promise.resolve([] as SessionSummary[]),
    find: (id: string) =>
      Promise.resolve(live.has(id) ? { id, cwd: `/srv/${id}`, createdAt: 1 } : undefined),
    search: () => Promise.resolve([]),
  };
  return factory;
}

let hub: EventHub;
let router: Router;
let conversations: ConversationStore;
let factory: ReturnType<typeof fakeFactory>;
let control: ChannelControl;
let stale: [ConversationKey, string][];

function wire(f: ReturnType<typeof fakeFactory>): void {
  factory = f;
  hub = new EventHub();
  const db = openDb(":memory:");
  conversations = new ConversationStore(db);
  const vault = new Map<string, string>();
  const store = new ChannelStore(db, { get: (n) => vault.get(n), seal: (n, v) => void vault.set(n, v), remove: (n) => vault.delete(n) });
  store.discoverChat("slack", { id: "C100", name: "#ops", kind: "group" });
  stale = [];
  let resolveIm: (key: ConversationKey) => Promise<AgentSession> = () => Promise.reject(new Error("unwired"));
  router = new Router(hub, (key) => resolveIm(key), (key) => conversations.get(key));
  control = createControl({ router, factory: factory as unknown as AgentFactory, conversations, store });
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
    const s = fakeSession("s1", [{ role: "user", text: "hi" }]);
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
    wire(fakeFactory([fakeSession("s1")]));
    conversations.set(KEY, "s1");
    expect((await control.status(KEY))?.empty).toBe(true);
  });
});

describe("setModel / setThinking", () => {
  it("setModel on a thread without a row rejects with NO_SESSION and touches no session", async () => {
    await expect(control.setModel(KEY, SONNET)).rejects.toThrow(NO_SESSION);
    expect(factory.created).toEqual([]);
    expect(factory.resumed).toEqual([]);
  });

  it("setThinking resumes then applies", async () => {
    const s = fakeSession("s1");
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    await control.setThinking(KEY, "high");
    expect(s.levels).toEqual(["high"]);
    expect(factory.resumed).toEqual(["s1"]);
  });

  it("setModel applies to the live session without a second open", async () => {
    const s = fakeSession("s1");
    wire(fakeFactory([s]));
    conversations.set(KEY, "s1");
    router.attach(KEY, s as unknown as AgentSession);
    await control.setModel(KEY, SONNET);
    expect(s.models).toEqual([SONNET]);
    expect(factory.resumed).toEqual([]);
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
