// Channel lifecycle: which adapters are running; one call for the Console to
// apply a config change.

import type { Router } from "../core/router.js";
import type { Channel } from "../core/types.js";
import { logger } from "../log.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { LarkChannel } from "./lark.js";
import type { PanelHandoff } from "./panel.js";
import { SlackChannel } from "./slack.js";
import type { ChannelPlatform, HandoffNote } from "./types.js";

/** What an IM adapter has beyond the seam: opening a thread of its own is a
 *  channels-internal operation, so it stays out of `Channel`. */
export interface ImChannel extends Channel {
  /** Post the handoff root in `chatId`, return the new conversation id. */
  openThread(chatId: string, note: HandoffNote): Promise<string>;
}

const ADAPTERS: {
  platform: ChannelPlatform;
  build(deps: {
    store: ChannelStore;
    log: (m: string) => void;
    control: ChannelControl;
    handoff: PanelHandoff;
  }): ImChannel;
}[] = [
  { platform: "slack", build: (deps) => new SlackChannel(deps) },
  // Lark's "token" is the App ID and "appToken" the App Secret.
  { platform: "lark", build: (deps) => new LarkChannel(deps) },
];

// The injected sink is for warnings; "slack started" is not one.
const log = logger("channels");
// The parameter below shadows `log` inside its own default expression.
const warn = (m: string): void => log.warn(m);

export class ChannelRuntime {
  private readonly live = new Map<ChannelPlatform, ImChannel>();
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: ChannelStore,
    private readonly router: Router,
    private readonly control: ChannelControl,
    /** The pull half only; the push half needs this runtime, so main.ts closes the loop. */
    private readonly handoff: PanelHandoff,
    private readonly log: (message: string) => void = warn,
  ) {}

  /** Serialized: two concurrent Console saves would race into duplicate live
   *  adapters. Platforms restart in parallel so a hung start cannot stall another. */
  reload(): Promise<void> {
    const run = this.reloading.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const results = await Promise.allSettled(ADAPTERS.map((a) => this.restart(a)));
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          this.log(`${ADAPTERS[i]!.platform} reload failed: ${String(result.reason)}`);
        }
      });
    });
    this.reloading = run;
    return run;
  }

  private async restart(adapter: (typeof ADAPTERS)[number]): Promise<void> {
    const { platform, build } = adapter;
    const existing = this.live.get(platform);
    if (existing) {
      this.live.delete(platform);
      // Never fatal: the config still has to be applied.
      await existing.stop().catch((err: unknown) =>
        this.log(`${platform} did not stop cleanly: ${String(err)}`));
    }
    const config = this.store.get(platform);
    if (!config.enabled || !config.token) return;
    if (!config.appToken) {
      // "Enabled but nothing happens" is indistinguishable from a broken adapter.
      this.log(`${platform}: enabled but no app token, not starting`);
      return;
    }
    const channel = build({
      store: this.store,
      log: (m) => this.log(`${platform}: ${m}`),
      control: this.control,
      handoff: this.handoff,
    });
    try {
      await channel.start((msg) => {
        void this.router.dispatch(msg).catch((err) => this.log(`dispatch failed: ${String(err)}`));
      });
    } catch (err) {
      this.log(`${platform} failed to start: ${String(err)}`);
      return;
    }
    this.router.registerChannel(channel);
    this.live.set(platform, channel);
    log.info(`${platform} started`);
  }

  /** For restart-note delivery (src/drain.ts), which has no session to report
   *  through; false means the platform is not running. */
  async notify(platform: string, conversationId: string, text: string): Promise<boolean> {
    const channel = this.live.get(platform as ChannelPlatform);
    if (!channel) return false;
    await channel.notify(conversationId, { text, origin: { kind: "error" } });
    return true;
  }

  running(): ChannelPlatform[] {
    return [...this.live.keys()];
  }

  /** Throws by name when the platform is not running: the caller's answer is
   *  "enable it in Settings", not a silent no-op. */
  async openThread(platform: ChannelPlatform, chatId: string, note: HandoffNote): Promise<string> {
    const channel = this.live.get(platform);
    if (!channel) throw new Error(`${platform} is not running`);
    return channel.openThread(chatId, note);
  }

  async stop(): Promise<void> {
    // An in-flight restart could otherwise register an adapter after `live`
    // was cleared — running, unstoppable.
    this.stopped = true;
    await this.reloading.catch(() => {});
    for (const channel of this.live.values()) {
      await channel.stop().catch((err: unknown) =>
        this.log(`${channel.id} did not stop cleanly: ${String(err)}`));
    }
    this.live.clear();
  }
}
