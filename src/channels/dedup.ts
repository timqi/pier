// At-least-once delivery, deduplicated: both push transports (Slack Socket
// Mode, Lark's long connection) redeliver an event the platform did not see
// acknowledged, so the same id can arrive twice. One implementation, because
// the second copy had already appeared and the map has an invariant that is
// easy to lose on a rewrite: it is fed by every message in every chat the bot
// is in, so it must be bounded and time-limited, never grow-only.

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
      for (const [id] of this.seen) {
        if (this.seen.size < this.max) break;
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
