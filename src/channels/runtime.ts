// Channel lifecycle: which adapters are running; one call for the Console to
// apply a config change.

import type { MainChain } from "../core/chain.js";
import { splitReply } from "../core/reply.js";
import { Refused, type Router } from "../core/router.js";
import type { Channel, InboundMessage, NoteOrigin, OpenItemsView } from "../core/types.js";
import { logger } from "../log.js";
import type { ChannelStore } from "./config.js";
import type { ChannelControl } from "./control.js";
import type { ConversationStore } from "./conversations.js";
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

/** A design lead's settled run, as main.ts hands it over: the session the
 *  user talks to, what the root under it says, and the turn's text (its reply,
 *  or the error). */
export interface LeadTurn {
  sessionId: string;
  name: string;
  origin: NoteOrigin;
  text: string;
}
export type LeadState = "waiting" | "final" | "failed";

const rootLine = (lead: LeadTurn, state: LeadState): string =>
  state === "waiting" ? `▷ ${lead.name} · design — waiting for you`
    : state === "final" ? `✓ ${lead.name} · design final`
    : `⚠ ${lead.name} · design — ${lead.text}`;

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
    private readonly conversations: Pick<ConversationStore, "keyOf" | "set">,
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
        // A thread of the home chat bound to a child (§Child threads) is that session's.
        if (this.control.isHome(msg.key) && !this.control.knows(msg.key)) return this.toHead(channel, msg);
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

  /** A design lead waiting on the user gets a thread in the home DM bound to
   *  its session (docs/design/11 §Child threads); its later states edit the
   *  root. No home, its adapter down, or the session already in a chat: nothing
   *  — the web's needs-you carries it. Every failure is a note in the chat. */
  async designLead(lead: LeadTurn, state: LeadState): Promise<void> {
    const home = this.store.home();
    const channel = home && this.running.get(home.platform);
    if (!home || !channel) return;
    const note = { text: rootLine(lead, state), origin: lead.origin };
    const bound = this.conversations.keyOf(lead.sessionId);
    if (state === "waiting") {
      if (bound) return;
      let thread: string | undefined;
      try {
        thread = await channel.openThread(home.chatId, note);
        // The row first: `ensure` resolves the thread through it, as any thread's message would.
        this.conversations.set({ channelId: home.platform, conversationId: thread }, lead.sessionId);
        await this.router.ensure({ channelId: home.platform, conversationId: thread });
        await channel.send(thread, splitReply(lead.text));
      } catch (err) {
        // A root already posted is the thread's failure to report; none, the main flow's.
        await this.report(channel, thread ?? home.chatId, `"${lead.name}" waits for you on the web; ${
          thread ? "its turn did not reach this thread" : "its thread could not be opened"}: ${String(err)}`);
      }
      return;
    }
    // Only a thread of the home chat has a root of ours to edit.
    if (!bound || bound.channelId !== home.platform || chatOf(bound.conversationId) !== home.chatId) return;
    await channel.editRoot(bound.conversationId, note).catch((err: unknown) =>
      this.report(channel, bound.conversationId, `the thread's root could not be updated to "${note.text}": ${String(err)}`));
  }

  /** The home chat's status message (docs/design/11 §Status), while its adapter
   *  is live; nothing otherwise. A failure is logged, never thrown. */
  async openItems(view: OpenItemsView): Promise<void> {
    const home = this.store.home();
    const channel = home && this.running.get(home.platform);
    if (!home || !channel) return;
    await channel.status(home.chatId, view).catch((err: unknown) =>
      this.log(`status: ${home.platform} did not take the open items: ${String(err)}`));
  }

  private async report(channel: Channel, conversationId: string, text: string): Promise<void> {
    this.log(text);
    await channel.notify(conversationId, { text, origin: { kind: "error" } })
      .catch((e: unknown) => this.log(`could not report it to ${channel.id}: ${String(e)}`));
  }

  /** For restart-note delivery (src/stop.ts), which has no session to report
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
