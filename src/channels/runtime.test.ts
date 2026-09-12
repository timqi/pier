import { describe, expect, it, vi } from "vitest";
import type { Router } from "../core/router.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { ChannelRuntime } from "./runtime.js";

// Fake adapters: the runtime's contract with them is start/stop only.
const events: string[] = [];
let startGate: Promise<void> = Promise.resolve();
let generation = 0;

vi.mock("./slack.js", () => ({
  SlackChannel: class {
    readonly id = "slack";
    private readonly n = ++generation;
    async start(): Promise<void> {
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
    async openThread(chatId: string, note: { title: string }): Promise<string> {
      events.push(`open ${chatId}: ${note.title}`);
      return `${chatId}/1.0`;
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

function runtime(config: Record<string, unknown>, log: (m: string) => void = () => {}): ChannelRuntime {
  const store = {
    get: (platform: string) => {
      const c = config[platform];
      if (c instanceof Error) throw c;
      return c ?? { enabled: false, token: "" };
    },
  } as unknown as ChannelStore;
  const router = { registerChannel: vi.fn(), dispatch: vi.fn() } as unknown as Router;
  return new ChannelRuntime(store, router, {} as ChannelControl, log);
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

  it("running() lists live adapters, and openThread reaches one or throws by name", async () => {
    events.length = 0;
    generation = 0;
    startGate = Promise.resolve();
    const rt = runtime({ slack: { enabled: true, token: "t", appToken: "a" } });
    expect(rt.running()).toEqual([]);
    await rt.reload();
    expect(rt.running()).toEqual(["slack"]);
    await expect(rt.openThread("slack", "C42", { title: "Fix it", url: "" })).resolves.toBe("C42/1.0");
    expect(events).toContain("open C42: Fix it");
    await expect(rt.openThread("lark", "oc_1", { title: "Fix it", url: "" })).rejects.toThrow("lark is not running");
    await rt.stop();
    expect(rt.running()).toEqual([]);
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
});
