import { describe, expect, it, vi } from "vitest";
import type { MainChain } from "../core/chain.js";
import { type Router, SkillAmbiguous } from "../core/router.js";
import type { ConversationKey, InboundMessage } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { ChannelRuntime } from "./runtime.js";

// Fake adapters: the runtime's contract with them is start/stop only.
const events: string[] = [];
/** What the fake Slack adapter's start was handed, so a test can speak through it. */
let deliver: (msg: InboundMessage) => void = () => {};
let startGate: Promise<void> = Promise.resolve();
let generation = 0;

vi.mock("./slack.js", () => ({
  SlackChannel: class {
    readonly id = "slack";
    private readonly n = ++generation;
    async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
      deliver = onMessage;
      await startGate;
      events.push(`start ${this.n}`);
    }
    async stop(): Promise<void> {
      events.push(`stop ${this.n}`);
    }
    async send(conversationId: string, reply: { text: string; suggestions: string[] }): Promise<void> {
      if (sendFails) throw sendFails;
      events.push(`send ${conversationId}: ${reply.text}${reply.suggestions.length ? ` [${reply.suggestions.join("|")}]` : ""}`);
    }
    async notify(conversationId: string, note: { text: string }): Promise<void> {
      events.push(`notify ${conversationId}: ${note.text}`);
    }
    async openThread(chatId: string, note: { text: string }): Promise<string> {
      if (openFails) throw openFails;
      events.push(`root ${chatId}: ${note.text}`);
      return `${chatId}/1900.1`;
    }
    async editRoot(conversationId: string, note: { text: string }): Promise<void> {
      if (openFails) throw openFails;
      events.push(`edit ${conversationId}: ${note.text}`);
    }
    async status(chatId: string, view: { text: string }): Promise<void> {
      if (openFails) throw openFails;
      events.push(`status ${chatId}: ${view.text}`);
    }
  },
}));
vi.mock("./lark.js", () => ({
  LarkChannel: class {
    readonly id = "lark";
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

const dispatched: InboundMessage[] = [];
const headSent: [string, ConversationKey | undefined][] = [];
let headFails: Error | undefined;
let openFails: Error | undefined;
let sendFails: Error | undefined;
/** The child threads the fake store knows, thread id → session. */
const bound = new Map<string, string>();
/** The keys the fake router was asked to resolve, with the session the store bound them to. */
const attached: [ConversationKey, string | undefined][] = [];
let home: { platform: "slack"; chatId: string } | undefined;

function runtime(config: Record<string, unknown>, log: (m: string) => void = () => {}): ChannelRuntime {
  const store = {
    get: (platform: string) => {
      const c = config[platform];
      if (c instanceof Error) throw c;
      return c ?? { enabled: false, token: "" };
    },
    home: () => home,
  } as unknown as ChannelStore;
  const router = {
    registerChannel: vi.fn(),
    unregisterChannel: vi.fn(),
    dispatch: (msg: InboundMessage) => {
      dispatched.push(msg);
      return Promise.resolve({ sessionId: "s" });
    },
    ensure: (key: ConversationKey) => {
      attached.push([key, bound.get(key.conversationId)]);
      return Promise.resolve({ id: bound.get(key.conversationId) ?? key.conversationId });
    },
  } as unknown as Router;
  const chain = {
    send: (msg: InboundMessage, key?: ConversationKey) => {
      headSent.push([msg.text, key]);
      return headFails ? Promise.reject(headFails) : Promise.resolve({ sessionId: "head" });
    },
  } as unknown as MainChain;
  const control = {
    isHome: (key: ConversationKey) => key.conversationId.startsWith("D1"),
    knows: (key: ConversationKey) => bound.has(key.conversationId),
  } as unknown as ChannelControl;
  const conversations = {
    keyOf: (sessionId: string) => {
      const thread = [...bound].find(([, s]) => s === sessionId)?.[0];
      return thread === undefined ? undefined : { channelId: "slack", conversationId: thread };
    },
    set: (key: ConversationKey, sessionId: string) => { bound.set(key.conversationId, sessionId); },
  };
  return new ChannelRuntime(store, router, chain, control, conversations, log);
}

describe("ChannelRuntime", () => {
  it("two concurrent reloads never produce two live adapters", async () => {
    events.length = 0;
    generation = 0;
    let release = (): void => {};
    startGate = new Promise((r) => (release = r));
    const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });

    const first = rt.reload();
    const second = rt.reload(); // must queue behind, not interleave
    release();
    await first;
    await second;

    // Serialized: the first generation starts and is stopped before the
    // second starts — never two live at once, never an orphan.
    expect(events).toEqual(["start 1", "stop 1", "start 2"]);
    await rt.stop();
    expect(events).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
  });

  it("a rejected restart is logged, not thrown, and does not stall the other platform", async () => {
    events.length = 0;
    generation = 0;
    startGate = Promise.resolve();
    const said: string[] = [];
    const rt = runtime(
      { slack: new Error("sealed token"), lark: { enabled: false, token: "" } },
      (m) => said.push(m),
    );
    await expect(rt.reload()).resolves.toBeUndefined();
    expect(said.join(" ")).toMatch(/slack reload failed.*sealed token/);
  });

  it("notify reaches a live adapter, and says so when there is none", async () => {
    events.length = 0;
    generation = 0;
    startGate = Promise.resolve();
    const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
    await rt.reload();
    await expect(rt.notify("slack", "C42", "cut off")).resolves.toBe(true);
    expect(events).toContain("notify C42: cut off");
    await expect(rt.notify("lark", "oc_1", "cut off")).resolves.toBe(false);
    await rt.stop();
  });

  it("a reload after stop() is refused — shutdown wins", async () => {
    events.length = 0;
    generation = 0;
    startGate = Promise.resolve();
    const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
    await rt.stop();
    await rt.reload();
    expect(events).toEqual([]);
  });

  describe("the home chat", () => {
    const say = (conversationId: string, text: string): InboundMessage =>
      ({ key: { channelId: "slack", conversationId }, senderId: "U1", sender: { id: "U1", name: "q" }, text, mode: "steer" });

    async function live(): Promise<ChannelRuntime> {
      events.length = 0;
      dispatched.length = 0;
      headSent.length = 0;
      attached.length = 0;
      bound.clear();
      headFails = undefined;
      openFails = sendFails = undefined;
      home = { platform: "slack", chatId: "D1" };
      startGate = Promise.resolve();
      const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
      await rt.reload();
      return rt;
    }

    it("goes to the head under the chat's key, threaded or not; any other chat to the router", async () => {
      const rt = await live();
      expect(rt.live("slack")).toBe(true);
      bound.set("D1/1717.3", "lead");
      deliver(say("D1", "hi"));
      deliver(say("D1/1717.1", "in a thread"));
      deliver(say("C9/1717.2", "elsewhere"));
      deliver(say("D1/1717.3", "to the child"));
      const home = { channelId: "slack", conversationId: "D1" };
      expect(headSent).toEqual([["hi", home], ["in a thread", home]]);
      expect(dispatched.map((m) => m.text)).toEqual(["elsewhere", "to the child"]);
      await rt.stop();
      expect(rt.live("slack")).toBe(false);
    });

    it("a refused send is an error note in the chat — once, when the router already said it", async () => {
      const rt = await live();
      headFails = new Error("the conversation is replying — /stop first");
      deliver(say("D1/1717.1", "/new"));
      await vi.waitFor(() => expect(events).toContain("notify D1: the conversation is replying — /stop first"));
      headFails = new SkillAmbiguous("/pier- matches a, b — say more");
      deliver(say("D1", "/pier- x"));
      await new Promise((r) => setTimeout(r, 5));
      expect(events.filter((e) => e.startsWith("notify"))).toHaveLength(1);
      await rt.stop();
    });
  });

  // docs/design/11-im-conversation.md §Child threads
  describe("a design lead's thread", () => {
    const origin = { kind: "task-callback" as const, taskId: "t", runId: "r", sourceSessionId: "lead" };
    const lead = (text = "Which storage?\n\n---\n[Finalize design]") => ({ sessionId: "lead", name: "storage", origin, text });

    async function live(): Promise<ChannelRuntime> {
      events.length = 0; attached.length = 0; bound.clear();
      openFails = sendFails = undefined; home = { platform: "slack", chatId: "D1" }; startGate = Promise.resolve();
      const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
      await rt.reload();
      return rt;
    }
    const posted = (): string[] => events.filter((e) => !e.startsWith("start") && !e.startsWith("stop"));

    it("opens under a root in the main flow, binds and attaches the session, and posts the turn that ended nowhere", async () => {
      const rt = await live();
      await rt.designLead(lead(), "waiting");
      expect(posted()).toEqual([
        "root D1: ▷ storage · design — waiting for you",
        "send D1/1900.1: Which storage? [Finalize design]",
      ]);
      expect(bound.get("D1/1900.1")).toBe("lead");
      expect(attached).toEqual([[{ channelId: "slack", conversationId: "D1/1900.1" }, "lead"]]);
      // Bound: a later turn of the user's is the thread's; the root follows the design.
      await rt.designLead(lead("more"), "waiting");
      await rt.designLead(lead("Design final: /d.md"), "final");
      await rt.designLead(lead("provider down"), "failed");
      expect(posted().slice(2)).toEqual([
        "edit D1/1900.1: ✓ storage · design final",
        "edit D1/1900.1: ⚠ storage · design — provider down",
      ]);
      await rt.stop();
    });

    it("does nothing without a live home or when the session already has a chat; a failure is a note", async () => {
      const rt = await live();
      home = undefined;
      await rt.designLead(lead(), "waiting");
      home = { platform: "slack", chatId: "D1" };
      bound.set("C9/1.1", "lead");
      await rt.designLead(lead(), "waiting");
      await rt.designLead(lead(), "final");
      expect(posted()).toEqual([]);
      bound.clear();
      openFails = new Error("ratelimited");
      await rt.designLead(lead(), "waiting");
      expect(events.at(-1)).toBe(`notify D1: "storage" waits for you on the web; its thread could not be opened: Error: ratelimited`);
      expect(attached).toEqual([]);
      // The root posted and bound, the turn lost: the thread says so, and stays the lead's.
      openFails = undefined;
      sendFails = new Error("ratelimited");
      await rt.designLead(lead(), "waiting");
      expect(events.at(-1)).toBe(`notify D1/1900.1: "storage" waits for you on the web; its turn did not reach this thread: Error: ratelimited`);
      expect(bound.get("D1/1900.1")).toBe("lead");
      await rt.stop();
      // Adapter down: nothing, and never later.
      bound.clear(); events.length = 0;
      await rt.designLead(lead(), "waiting");
      expect(events).toEqual([]);
    });
  });

  // docs/design/11-im-conversation.md §Status
  it("open items go to the live home adapter only; a refusal is logged", async () => {
    events.length = 0; openFails = undefined; startGate = Promise.resolve();
    const logged: string[] = [];
    const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } }, (m) => logged.push(m));
    const view = { text: "storage — running", items: [{ problem: "storage", status: "running" }] };
    home = { platform: "slack", chatId: "D1" };
    await rt.openItems(view);
    expect(events).toEqual([]);
    await rt.reload();
    home = undefined;
    await rt.openItems(view);
    home = { platform: "slack", chatId: "D1" };
    await rt.openItems(view);
    expect(events.filter((e) => e.startsWith("status"))).toEqual(["status D1: storage — running"]);
    openFails = new Error("ratelimited");
    await rt.openItems(view);
    expect(logged.at(-1)).toBe("status: slack did not take the open items: Error: ratelimited");
    openFails = undefined;
    await rt.stop();
    await rt.openItems(view);
    expect(events.filter((e) => e.startsWith("status"))).toHaveLength(1);
  });
});
