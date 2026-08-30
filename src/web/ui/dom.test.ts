// The time wording two surfaces share. A stamp under the newest reply and the
// Session info field are the same fact, so the only thing worth asserting is
// that the string does not drift — and that the age reads as a phrase beside
// it, which is the half `relTime` alone gets wrong ("now ago").

import { describe, expect, it } from "vitest";
import { agoLabel, stampTime } from "./dom.js";

describe("stampTime", () => {
  // Built from local components, so the assertion holds in any TZ the suite runs in.
  const at = (...parts: [number, number, number, number, number, number]): number =>
    new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime();

  it("is a local wall clock, sortable and zero-padded", () => {
    expect(stampTime(at(2026, 7, 30, 19, 41, 7))).toBe("2026-08-30 19:41:07");
    expect(stampTime(at(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01 00:00:00");
  });
});

describe("agoLabel", () => {
  it("says the age as it reads beside a clock", () => {
    const ago = (ms: number): string => agoLabel(Date.now() - ms);
    expect(ago(0)).toBe("just now"); // not "now ago"
    expect(ago(12 * 60_000)).toBe("12m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
  });
});
