// At-least-once delivery, deduplicated: both push transports (Slack Socket
// Mode, Lark's long connection) redeliver an event the platform did not see
// acknowledged, so the same id can arrive twice. One implementation, because
// the second copy had already appeared and the map has an invariant that is
// easy to lose on a rewrite: it is fed by every message in every chat the bot
// is in, so it must be bounded and time-limited, never grow-only.

/** Fraction of `max` a full map is cut back to, so the eviction walk is paid
 *  once per that many messages instead of once per message. */
const KEEP = 0.9;

export class Dedup {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  /** True when this id was already delivered inside the TTL. */
  duplicate(eventId: string | undefined, now = Date.now()): boolean {
    if (!eventId) return false;
    if (this.seen.size >= this.max) {
      for (const [id, at] of this.seen) {
        if (now - at > this.ttlMs) this.seen.delete(id);
      }
      // Pruning expired entries is not enough under a burst of live ones —
      // `max` must be a real bound, so the oldest entries go next. The cost
      // is a forgotten id under extreme load (a redelivery slips through,
      // which downstream handling tolerates); unbounded memory is worse.
      // Map iterates in insertion order, so the front is the oldest.
      //
      // Evicting down to `KEEP` rather than to exactly `max` is what makes
      // the walk amortized: at the bound, freeing one slot per message meant
      // re-walking the whole map on every message from then on.
      const keep = Math.floor(this.max * KEEP);
      for (const [id] of this.seen) {
        if (this.seen.size <= keep) break;
        this.seen.delete(id);
      }
    }
    const at = this.seen.get(eventId);
    if (at !== undefined && now - at <= this.ttlMs) {
      this.log(`duplicate event ${eventId} ignored`);
      return true;
    }
    this.seen.set(eventId, now);
    return false;
  }
}
