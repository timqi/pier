// Channel lifecycle: which adapters are running; one call for the Console to
// apply a config change.

import type { MainChain } from "../core/chain.js";
import { Refused, type Router } from "../core/router.js";
import type { Channel, InboundMessage } from "../core/types.js";
import { logger } from "../log.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import { LarkChannel } from "./lark.js";
import { SlackChannel } from "./slack.js";
import { type ChannelPlatform, chatOf } from "./types.js";

const ADAPTERS: {
  platform: ChannelPlatform;
  build(deps: {
    store: ChannelStore;
    log: (m: string) => void;
    control: ChannelControl;
  }): Channel;
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
  private readonly running = new Map<ChannelPlatform, Channel>();
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: ChannelStore,
    private readonly router: Router,
    private readonly chain: MainChain,
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
    const { platform, build } = adapter;
    const existing = this.running.get(platform);
    if (existing) {
      this.running.delete(platform);
      this.router.unregisterChannel(platform);
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
    });
    try {
      await channel.start((msg) => {
        if (this.control.isHome(msg.key)) return this.toHead(channel, msg);
        void this.router.dispatch(msg).catch((err) => this.log(`dispatch failed: ${String(err)}`));
      });
    } catch (err) {
      this.log(`${platform} failed to start: ${String(err)}`);
      return;
    }
    // Running before registered: the router asks main.ts's chatKeyOf, which asks `live`.
    this.running.set(platform, channel);
    this.router.registerChannel(channel);
    log.info(`${platform} started`);
  }

  /** The home chat's every message, threaded or not, is the head's under the
   *  chat's key. A refusal is the chat's to see (§5): the adapter only logs. */
  private toHead(channel: Channel, msg: InboundMessage): void {
    const conversationId = chatOf(msg.key.conversationId);
    this.chain.send(msg, { channelId: msg.key.channelId, conversationId }).catch((err: unknown) => {
      this.log(`the conversation did not take a message: ${String(err)}`);
      if (err instanceof Refused) return;
      const text = err instanceof Error ? err.message : String(err);
      void channel.notify(conversationId, { text, origin: { kind: "error" } })
        .catch((e: unknown) => this.log(`could not report it to ${channel.id}: ${String(e)}`));
    });
  }

  live(platform: ChannelPlatform): boolean {
    return this.running.has(platform);
  }

  /** For restart-note delivery (src/drain.ts), which has no session to report
   *  through; false means the platform is not running. */
  async notify(platform: string, conversationId: string, text: string): Promise<boolean> {
    const channel = this.running.get(platform as ChannelPlatform);
    if (!channel) return false;
    await channel.notify(conversationId, { text, origin: { kind: "error" } });
    return true;
  }

  async stop(): Promise<void> {
    // An in-flight restart could otherwise register an adapter after `running`
    // was cleared — running, unstoppable.
    this.stopped = true;
    await this.reloading.catch(() => {});
    for (const channel of this.running.values()) {
      this.router.unregisterChannel(channel.id);
      await channel.stop().catch((err: unknown) =>
        this.log(`${channel.id} did not stop cleanly: ${String(err)}`));
    }
    this.running.clear();
  }
}
