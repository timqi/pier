// Channel lifecycle: which adapters are running, and where their sessions
// live. Keeps main.ts wiring-only and gives the Console one call to apply a
// config change. Lark is configurable but has no adapter yet.

import type { Router } from "../core/router.js";
import type { Channel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { SlackChannel } from "./slack.js";
import { TelegramChannel } from "./telegram.js";
import type { ChannelPlatform } from "./types.js";

/** Platforms with an adapter, and what each needs before it can start. */
const ADAPTERS: {
  platform: ChannelPlatform;
  /** Slack authenticates its event socket separately from its Web API. */
  needsAppToken: boolean;
  build(deps: {
    store: ChannelStore;
    log: (m: string) => void;
    control: ChannelControl;
  }): Channel;
}[] = [
  { platform: "telegram", needsAppToken: false, build: (deps) => new TelegramChannel(deps) },
  { platform: "slack", needsAppToken: true, build: (deps) => new SlackChannel(deps) },
];

export class ChannelRuntime {
  private readonly live = new Map<ChannelPlatform, Channel>();

  constructor(
    private readonly store: ChannelStore,
    private readonly router: Router,
    private readonly control: ChannelControl,
    private readonly log: (message: string) => void = (m) => console.warn(`channels: ${m}`),
  ) {}

  /** (Re)start every platform whose config says it should run. Idempotent. */
  async reload(): Promise<void> {
    for (const adapter of ADAPTERS) await this.restart(adapter);
  }

  private async restart(adapter: (typeof ADAPTERS)[number]): Promise<void> {
    const { platform, needsAppToken, build } = adapter;
    const existing = this.live.get(platform);
    if (existing) {
      this.live.delete(platform);
      await existing.stop().catch(() => {});
    }
    const config = this.store.get(platform);
    if (!config.enabled || !config.token) return;
    if (needsAppToken && !config.appToken) {
      // Named, not silent: "enabled but nothing happens" is otherwise
      // indistinguishable from a broken adapter.
      this.log(`${platform}: enabled but no app token, not starting`);
      return;
    }
    const channel = build({
      store: this.store,
      log: (m) => this.log(`${platform}: ${m}`),
      // The runtime owns the router, so channel control (stop, the settings
      // panel) is wired here instead of widening the Channel seam.
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
  }

  async stop(): Promise<void> {
    for (const channel of this.live.values()) await channel.stop().catch(() => {});
    this.live.clear();
  }
}
