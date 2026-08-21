// Channel lifecycle: which adapters are running, and where their sessions
// live. Keeps main.ts wiring-only and gives the Console one call to apply a
// config change. Slack and Lark are configurable but have no adapter yet.

import type { Router } from "../core/router.js";
import type { Channel } from "../core/types.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { TelegramChannel } from "./telegram.js";
import type { ChannelPlatform } from "./types.js";

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
    const existing = this.live.get("telegram");
    if (existing) {
      this.live.delete("telegram");
      await existing.stop().catch(() => {});
    }
    const config = this.store.get("telegram");
    if (!config.enabled || !config.token) return;
    const channel = new TelegramChannel({
      store: this.store,
      log: (m) => this.log(`telegram: ${m}`),
      // The runtime owns the router, so channel control (/stop, the settings
      // panel) is wired here instead of widening the Channel seam.
      control: this.control,
    });
    try {
      await channel.start((msg) => {
        void this.router.dispatch(msg).catch((err) => this.log(`dispatch failed: ${String(err)}`));
      });
    } catch (err) {
      this.log(`telegram failed to start: ${String(err)}`);
      return;
    }
    this.router.registerChannel(channel);
    this.live.set("telegram", channel);
  }

  async stop(): Promise<void> {
    for (const channel of this.live.values()) await channel.stop().catch(() => {});
    this.live.clear();
  }
}
