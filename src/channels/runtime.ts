// Channel lifecycle: which adapters are running; one call for the Console to
// apply a config change.

import type { Router } from "../core/router.js";
import type { Channel } from "../core/types.js";
import { logger } from "../log.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { LarkChannel } from "./lark.js";
import { SlackChannel } from "./slack.js";
import { TelegramChannel } from "./telegram.js";
import type { ChannelPlatform } from "./types.js";

const ADAPTERS: {
  platform: ChannelPlatform;
  needsAppToken: boolean;
  build(deps: {
    store: ChannelStore;
    log: (m: string) => void;
    control: ChannelControl;
  }): Channel;
}[] = [
  { platform: "telegram", needsAppToken: false, build: (deps) => new TelegramChannel(deps) },
  { platform: "slack", needsAppToken: true, build: (deps) => new SlackChannel(deps) },
  // Lark's "token" is the App ID and "appToken" the App Secret.
  { platform: "lark", needsAppToken: true, build: (deps) => new LarkChannel(deps) },
];

// The injected sink is for warnings; "slack started" is not one.
const log = logger("channels");
// The parameter below shadows `log` inside its own default expression.
const warn = (m: string): void => log.warn(m);

export class ChannelRuntime {
  private readonly live = new Map<ChannelPlatform, Channel>();
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: ChannelStore,
    private readonly router: Router,
    private readonly control: ChannelControl,
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
    const { platform, needsAppToken, build } = adapter;
    const existing = this.live.get(platform);
    if (existing) {
      this.live.delete(platform);
      // Never fatal: the config still has to be applied.
      await existing.stop().catch((err: unknown) =>
        this.log(`${platform} did not stop cleanly: ${String(err)}`));
    }
    const config = this.store.get(platform);
    if (!config.enabled || !config.token) return;
    if (needsAppToken && !config.appToken) {
      // "Enabled but nothing happens" is indistinguishable from a broken adapter.
      this.log(`${platform}: enabled but no app token, not starting`);
      return;
    }
    const channel = build({
      store: this.store,
      log: (m) => this.log(`${platform}: ${m}`),
      control: this.control,
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
