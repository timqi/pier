// The two inbound decisions every adapter makes identically: may this message
// through, and may this stranger be told how to bind.
//
// Both were written twice before landing here, and both have a rule that is
// easy to get subtly wrong on the second copy — a drop must always name its
// verdict, and the throttle map must prune rather than grow. Keeping them in
// one place is what makes "log every drop" and "bound every map fed by
// strangers" true of every platform instead of one.

import { type ChannelStore, gate } from "./config.js";
import type { ChannelPlatform } from "./types.js";

/** How often one unbound DM sender may be told how to bind. */
const BIND_HINT_EVERY_MS = 10 * 60_000;

/** What the gate needs to know about one inbound message. */
export interface AdmitRequest {
  isDm: boolean;
  /** Mentioned, replied to, or continuing a conversation we own. */
  addressed: boolean;
  userId: string;
  /** Bind requests must survive the bind gate, or nobody can ever bind. */
  bindRequest?: boolean;
}

export class Gatekeeper {
  /** Last time each unbound DM sender was told how to bind. */
  private readonly hints = new Map<string, number>();

  constructor(
    private readonly store: ChannelStore,
    private readonly platform: ChannelPlatform,
    private readonly log: (message: string) => void,
    /** What the platform calls a conversation, for the drop log. */
    private readonly noun = "chat",
  ) {}

  /**
   * The whole inbound permission decision, plus the log line every drop owes.
   * A silently skipped branch is indistinguishable from a bug, so the verdict
   * is always named.
   */
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

  /**
   * May this sender be told how to bind? Groups stay silent by contract, but a
   * DM that swallows every message looks broken rather than locked — and a bot
   * that answers every one is an echo amplifier.
   *
   * Anyone can DM a bot, so this map is fed by strangers: expired entries are
   * dropped on the way past instead of keeping one per sender forever.
   */
  mayHint(userId: string, now = Date.now()): boolean {
    if (now - (this.hints.get(userId) ?? 0) < BIND_HINT_EVERY_MS) return false;
    for (const [id, at] of this.hints) {
      if (now - at >= BIND_HINT_EVERY_MS) this.hints.delete(id);
    }
    this.hints.set(userId, now);
    return true;
  }
}
