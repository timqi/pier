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
    async send(): Promise<void> {}
    async notify(conversationId: string, note: { text: string }): Promise<void> {
      events.push(`notify ${conversationId}: ${note.text}`);
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

function runtime(config: Record<string, unknown>, log: (m: string) => void = () => {}): ChannelRuntime {
  const store = {
    get: (platform: string) => {
      const c = config[platform];
      if (c instanceof Error) throw c;
      return c ?? { enabled: false, token: "" };
    },
  } as unknown as ChannelStore;
  const router = {
    registerChannel: vi.fn(),
    unregisterChannel: vi.fn(),
    dispatch: (msg: InboundMessage) => {
      dispatched.push(msg);
      return Promise.resolve({ sessionId: "s" });
    },
  } as unknown as Router;
  const chain = {
    send: (msg: InboundMessage, key?: ConversationKey) => {
      headSent.push([msg.text, key]);
      return headFails ? Promise.reject(headFails) : Promise.resolve({ sessionId: "head" });
    },
  } as unknown as MainChain;
  const control = { isHome: (key: ConversationKey) => key.conversationId.startsWith("D1") } as unknown as ChannelControl;
  return new ChannelRuntime(store, router, chain, control, log);
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
      headFails = undefined;
      startGate = Promise.resolve();
      const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
      await rt.reload();
      return rt;
    }

    it("goes to the head under the chat's key, threaded or not; any other chat to the router", async () => {
      const rt = await live();
      expect(rt.live("slack")).toBe(true);
      deliver(say("D1", "hi"));
      deliver(say("D1/1717.1", "in a thread"));
      deliver(say("C9/1717.2", "elsewhere"));
      const home = { channelId: "slack", conversationId: "D1" };
      expect(headSent).toEqual([["hi", home], ["in a thread", home]]);
      expect(dispatched.map((m) => m.text)).toEqual(["elsewhere"]);
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
});
