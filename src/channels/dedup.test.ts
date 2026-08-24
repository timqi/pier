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

  it("treats a missing id as never seen", () => {
    const seen = new Dedup(() => {}, 1000, 10);
    expect(seen.duplicate(undefined)).toBe(false);
    expect(seen.duplicate(undefined)).toBe(false);
  });
});
