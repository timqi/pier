// Channel lifecycle: which adapters are running, and where their sessions
// live. Keeps main.ts wiring-only and gives the Console one call to apply a
// config change. Lark is configurable but has no adapter yet.

import type { Router } from "../core/router.js";
import type { Channel } from "../core/types.js";
import { logger } from "../log.js";
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

// Lifecycle news, which is not what the injected sink below is for: that one
// is a warning sink the adapters share, and "slack started" is not a warning.
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

  /** (Re)start every platform whose config says it should run. Idempotent.
   *  Serialized — two concurrent Console saves raced into duplicate live
   *  adapters; platforms restart in parallel so a hung start on one cannot
   *  stall the other, and a failure is logged, never swallowed. */
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
      // Never fatal — the config still has to be applied — but a socket that
      // refuses to close is exactly what makes the next start behave oddly.
      await existing.stop().catch((err: unknown) =>
        this.log(`${platform} did not stop cleanly: ${String(err)}`));
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
    log.info(`${platform} started`);
  }

  async stop(): Promise<void> {
    // Join the reload queue first: an in-flight restart could otherwise
    // register an adapter after `live` was cleared — running, unstoppable.
    this.stopped = true;
    await this.reloading.catch(() => {});
    for (const channel of this.live.values()) {
      await channel.stop().catch((err: unknown) =>
        this.log(`${channel.id} did not stop cleanly: ${String(err)}`));
    }
    this.live.clear();
  }
}
