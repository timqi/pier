// The two invariants a seen-set fed by strangers must hold: expiry by TTL,
// and `max` being a real bound even when nothing has expired.

import { describe, expect, it } from "vitest";
import { Dedup } from "./dedup.js";

describe("Dedup", () => {
  it("flags a repeat inside the TTL and forgets it after", () => {
    const seen = new Dedup(() => {}, 1000, 10);
    expect(seen.duplicate("a", 0)).toBe(false);
    expect(seen.duplicate("a", 500)).toBe(true);
    expect(seen.duplicate("a", 1600)).toBe(false);
  });

  it("never grows past max, even under a burst of live ids", () => {
    const logs: string[] = [];
    const seen = new Dedup((m) => logs.push(m), 60_000, 5);
    for (let i = 0; i < 20; i++) expect(seen.duplicate(`e${i}`, i)).toBe(false);
    // The oldest were evicted to keep the bound; the newest are still known.
    expect(seen.duplicate("e19", 30)).toBe(true);
    // An evicted id reads as new — the accepted cost of the bound.
    expect(seen.duplicate("e0", 40)).toBe(false);
  });

  it("frees a batch when full, so the walk is not paid per message", () => {
    const seen = new Dedup(() => {}, 60_000, 100);
    for (let i = 0; i < 100; i++) expect(seen.duplicate(`e${String(i)}`, i)).toBe(false);
    // Full: the next id trips one eviction pass, and the nine after it find
    // room without another — that is what makes the bound cheap to hold.
    for (let i = 100; i < 110; i++) expect(seen.duplicate(`e${String(i)}`, i)).toBe(false);
    // The pass frees a batch, not a slot: e10…e19 went together.
    expect(seen.duplicate("e0", 200)).toBe(false);
    expect(seen.duplicate("e15", 201)).toBe(false);
    // And what was kept is still a duplicate — the bound did not cost the job.
    expect(seen.duplicate("e50", 202)).toBe(true);
  });

  it("treats a missing id as never seen", () => {
    const seen = new Dedup(() => {}, 1000, 10);
    expect(seen.duplicate(undefined)).toBe(false);
    expect(seen.duplicate(undefined)).toBe(false);
  });
});
