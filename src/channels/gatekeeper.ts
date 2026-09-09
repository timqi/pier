// The two inbound decisions every adapter makes identically: may this message
// through, and may this stranger be told how to bind.

import { type ChannelStore, gate } from "./config.js";
import type { ChannelPlatform } from "./types.js";

const BIND_HINT_EVERY_MS = 10 * 60_000;

export interface AdmitRequest {
  isDm: boolean;
  /** Mentioned, replied to, or continuing a conversation we own. */
  addressed: boolean;
  userId: string;
  /** Bind requests must survive the bind gate, or nobody can ever bind. */
  bindRequest?: boolean;
}

export class Gatekeeper {
  private readonly hints = new Map<string, number>();

  constructor(
    private readonly store: ChannelStore,
    private readonly platform: ChannelPlatform,
    private readonly log: (message: string) => void,
    /** What the platform calls a conversation, for the drop log. */
    private readonly noun = "chat",
  ) {}

  /** Every drop names its verdict: a silently skipped branch is
   *  indistinguishable from a bug. */
  admit(what: string, chatId: string, req: AdmitRequest): boolean {
    const verdict = gate({
      policy: this.store.policy(this.platform, chatId),
      isDm: req.isDm,
      addressed: req.addressed,
      bound: this.store.isBound(this.platform, req.userId),
      bindRequest: req.bindRequest ?? false,
    });
    if (verdict === "allow") return true;
    this.log(`dropped ${what} in ${this.noun} ${chatId}: ${verdict}`);
    return false;
  }

  /** A bot that answers every stranger is an echo amplifier. The map is fed by
   *  strangers, so expired entries are pruned on the way past. */
  mayHint(userId: string, now = Date.now()): boolean {
    if (now - (this.hints.get(userId) ?? 0) < BIND_HINT_EVERY_MS) return false;
    for (const [id, at] of this.hints) {
      if (now - at >= BIND_HINT_EVERY_MS) this.hints.delete(id);
    }
    this.hints.set(userId, now);
    return true;
  }
}
