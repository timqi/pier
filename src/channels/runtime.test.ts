import { describe, expect, it, vi } from "vitest";
import type { Router } from "../core/router.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { ChannelRuntime } from "./runtime.js";

// Fake adapters: the runtime's contract with them is start/stop only.
const events: string[] = [];
let startGate: Promise<void> = Promise.resolve();
let generation = 0;

vi.mock("./telegram.js", () => ({
  TelegramChannel: class {
    readonly id = "telegram";
    private readonly n = ++generation;
    async start(): Promise<void> {
      await startGate;
      events.push(`start ${this.n}`);
    }
    async stop(): Promise<void> {
      events.push(`stop ${this.n}`);
    }
    async send(): Promise<void> {}
  },
}));
vi.mock("./slack.js", () => ({
  SlackChannel: class {
    readonly id = "slack";
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
    const rt = runtime({ telegram: { enabled: true, token: "t" } });

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
      { telegram: new Error("sealed token"), slack: { enabled: false, token: "" } },
      (m) => said.push(m),
    );
    await expect(rt.reload()).resolves.toBeUndefined();
    expect(said.join(" ")).toMatch(/telegram reload failed.*sealed token/);
  });

  it("a reload after stop() is refused — shutdown wins", async () => {
    events.length = 0;
    generation = 0;
    startGate = Promise.resolve();
    const rt = runtime({ telegram: { enabled: true, token: "t" } });
    await rt.stop();
    await rt.reload();
    expect(events).toEqual([]);
  });
});
