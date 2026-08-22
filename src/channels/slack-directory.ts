// Who and where, cached: user display names and channel kind/name.
//
// Every inbound message needs the sender's name, and every transcript the tool
// returns needs one per speaker — so without a cache this is one `users.info`
// per message and per read. Neither answer changes in practice, so the cache is
// process-lifetime and shared: the adapter and the agent-facing tool ask the
// same instance, which is why a repeated `read_thread` costs no lookups at all.
//
// Failures are logged and fall back to the id, never swallowed: without
// `users:read` this fails for every message, and the only symptom used to be an
// agent telling the human "Slack does not expose your display name" — a scope
// problem wearing a product problem's clothes.

import type { SlackClient, SlackMessageEvent } from "./slack-api.js";
import type { ChatKind } from "./types.js";

/** What one lookup settles about a conversation. */
export interface ChannelFacts {
  kind: ChatKind;
  /** `#name` for a channel; absent for a DM, whose name is its member. */
  name?: string;
}

export class SlackDirectory {
  private readonly channels = new Map<string, ChannelFacts>();
  private readonly users = new Map<string, string>();

  constructor(private readonly log: (message: string) => void) {}

  /**
   * Kind and display name together, because one `conversations.info` answers
   * both. The event usually settles the kind for free (`channel_type`), and a
   * `D`-prefixed id is always a DM — but only the lookup knows the name.
   */
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
    // A DM's name comes from its member, not from the channel, so a DM settled
    // by the event needs no lookup at all.
    if (fromEvent === "dm") {
      const facts: ChannelFacts = { kind: fromEvent };
      this.channels.set(channel, facts);
      return facts;
    }
    const info = await api.channelInfo(channel).catch((err) => {
      this.log(`conversations.info failed for ${channel}: ${String(err)}`);
      return undefined;
    });
    // Uncached on failure, so the next message retries rather than pinning a
    // guess for the life of the process.
    if (!info) return { kind: fromEvent ?? "group" };
    const facts: ChannelFacts = {
      kind: info.isIm ? "dm" : "group",
      name: info.name ? `#${info.name}` : undefined,
    };
    this.channels.set(channel, facts);
    return facts;
  }

  /** Display name for a user id; the id itself when Slack will not say. */
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

  /** Names for every speaker in a transcript, in one pass. */
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
