// At-least-once delivery, deduplicated: Slack and Lark redeliver an event they
// did not see acknowledged. The map is fed by every message in every chat, so
// it must be bounded and time-limited, never grow-only.

/** A full map is cut back to this fraction of `max`, so the eviction walk is
 *  amortized instead of paid on every message at the bound. */
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
      // `max` must be a real bound, so under a burst of live entries the
      // oldest go too (Map iterates in insertion order); a redelivery slipping
      // through under extreme load is tolerated, unbounded memory is not.
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
