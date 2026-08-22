import { describe, expect, it, vi } from "vitest";
import { isNewer, UpdateCheck } from "./update.js";

describe("isNewer", () => {
  it("compares fields as numbers, which is where a string compare fails", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // "0.10.0" < "0.9.0" as text
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.0.2", "0.0.1")).toBe(true);
    expect(isNewer("0.0.1", "0.0.1")).toBe(false);
    expect(isNewer("0.0.1", "0.0.2")).toBe(false);
  });

  it("puts a prerelease before the release it precedes", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1-rc.1", "1.0.0")).toBe(true);
  });
});

describe("UpdateCheck", () => {
  it("answers from cache and refreshes in the background", async () => {
    const fetchLatest = vi.fn(() => Promise.resolve("0.2.0"));
    const check = new UpdateCheck("0.1.0", fetchLatest);

    // First answer is honest about knowing nothing rather than blocking.
    expect(check.status()).toEqual({ current: "0.1.0", latest: null, available: false });
    await check.refresh();
    expect(check.status()).toEqual({ current: "0.1.0", latest: "0.2.0", available: true });
  });

  it("says nothing is available when it is running the latest", async () => {
    const check = new UpdateCheck("0.2.0", () => Promise.resolve("0.2.0"));
    await check.refresh();
    expect(check.status().available).toBe(false);
  });

  it("keeps serving after a failed check, and retries only when stale", async () => {
    const fetchLatest = vi.fn(() => Promise.reject(new Error("offline")));
    let now = 1_000_000;
    const check = new UpdateCheck("0.1.0", fetchLatest, () => now);

    await check.refresh();
    expect(check.status()).toEqual({ current: "0.1.0", latest: null, available: false });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    // Within the TTL the registry is left alone; every page load asks status().
    check.status();
    check.status();
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    now += 7 * 60 * 60_000;
    check.status();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent refreshes into one request", async () => {
    const fetchLatest = vi.fn(() => Promise.resolve("0.2.0"));
    const check = new UpdateCheck("0.1.0", fetchLatest);
    await Promise.all([check.refresh(), check.refresh(), check.refresh()]);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });
});
