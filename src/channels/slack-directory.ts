// User display names and channel kind/name, cached for the process so a name
// is looked up once. Failures fall back to the id and
// are logged: without `users:read` every lookup fails, and the symptom is
// otherwise a scope problem wearing a product problem's clothes.

import type { SlackClient, SlackMessageEvent } from "./slack-api.js";
import type { ChatKind } from "./types.js";

export interface ChannelFacts {
  kind: ChatKind;
  /** Absent for a DM, whose name is its member. */
  name?: string;
}

export class SlackDirectory {
  private readonly channels = new Map<string, ChannelFacts>();
  private readonly users = new Map<string, string>();

  constructor(private readonly log: (message: string) => void) {}

  /** The event usually settles the kind for free (`channel_type`, or a
   *  `D`-prefixed id); only the lookup knows the name. */
  async channel(
    api: Pick<SlackClient, "channelInfo">,
    channel: string,
    event?: SlackMessageEvent,
  ): Promise<ChannelFacts> {
    const cached = this.channels.get(channel);
    if (cached) return cached;
    const fromEvent: ChatKind | undefined = event?.channel_type
      ? event.channel_type === "im" || event.channel_type === "mpim" ? "dm" : "group"
      : channel.startsWith("D")
      ? "dm"
      : undefined;
    if (fromEvent === "dm") {
      const facts: ChannelFacts = { kind: fromEvent };
      this.channels.set(channel, facts);
      return facts;
    }
    const info = await api.channelInfo(channel).catch((err) => {
      this.log(`conversations.info failed for ${channel}: ${String(err)}`);
      return undefined;
    });
    // Uncached on failure, so the next message retries.
    if (!info) return { kind: fromEvent ?? "group" };
    const facts: ChannelFacts = {
      kind: info.isIm ? "dm" : "group",
      name: info.name ? `#${info.name}` : undefined,
    };
    this.channels.set(channel, facts);
    return facts;
  }

  async user(api: Pick<SlackClient, "userName">, userId: string): Promise<string> {
    const hit = this.users.get(userId);
    if (hit !== undefined) return hit;
    const name = await api.userName(userId).catch((err) => {
      this.log(`users.info failed for ${userId} (is users:read granted?): ${String(err)}`);
      return userId;
    });
    this.users.set(userId, name);
    return name;
  }

  async names(
    api: Pick<SlackClient, "userName">,
    userIds: Iterable<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of userIds) {
      if (!out.has(id)) out.set(id, await this.user(api, id));
    }
    return out;
  }
}
