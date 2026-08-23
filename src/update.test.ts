import { describe, expect, it, vi } from "vitest";
import { isNewer, isValidVersion, startAutoUpdate, UpdateCheck } from "./update.js";

describe("isValidVersion", () => {
  it("accepts semver and rejects text that cannot enter a unit or npm argument", () => {
    expect(isValidVersion("1.2.3")).toBe(true);
    expect(isValidVersion("1.2.3-rc.1+build.5")).toBe(true);
    expect(isValidVersion("1.2.3\nExecStart=bad")).toBe(false);
    expect(isValidVersion("01.2.3")).toBe(false);
  });
});

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

    now += 31 * 60_000;
    check.status();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent refreshes into one request", async () => {
    const fetchLatest = vi.fn(() => Promise.resolve("0.2.0"));
    const check = new UpdateCheck("0.1.0", fetchLatest);
    await Promise.all([check.refresh(), check.refresh(), check.refresh()]);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("waits for the very first check rather than answering 'no idea'", async () => {
    // The bug this exists for: a browser loading seconds after a restart was
    // told latest: null, so a published release looked undetected.
    const check = new UpdateCheck("0.1.0", () => Promise.resolve("0.2.0"));
    expect(await check.statusNow()).toEqual({ current: "0.1.0", latest: "0.2.0", available: true });
  });

  it("serves the cache on every later call, without asking again", async () => {
    const fetchLatest = vi.fn(() => Promise.resolve("0.2.0"));
    const check = new UpdateCheck("0.1.0", fetchLatest);
    await check.statusNow();
    await check.statusNow();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });
});

describe("startAutoUpdate", () => {
  const setup = (over: Partial<{ enabled: boolean; idle: boolean; latest: string }> = {}) => {
    const apply = vi.fn(() => Promise.resolve("started" as const));
    const check = new UpdateCheck("0.1.0", () => Promise.resolve(over.latest ?? "0.2.0"));
    const stop = startAutoUpdate(
      check,
      { enabled: () => over.enabled ?? true, idle: () => over.idle ?? true, apply },
      10,
    );
    return { apply, check, stop };
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

  it("hands over only once all three conditions hold", async () => {
    const { apply, check, stop } = setup();
    await check.refresh(); // a warm cache, as a running instance would have
    await tick();
    expect(apply).toHaveBeenCalled();
    stop();
  });

  it("never applies while the operator has it off", async () => {
    const { apply, check, stop } = setup({ enabled: false });
    await check.refresh();
    await tick();
    expect(apply).not.toHaveBeenCalled();
    stop();
  });

  it("never applies while something is running — the updater's stop is hard", async () => {
    const { apply, check, stop } = setup({ idle: false });
    await check.refresh();
    await tick();
    expect(apply).not.toHaveBeenCalled();
    stop();
  });

  it("leaves an up-to-date instance alone, and stops when told", async () => {
    const { apply, check, stop } = setup({ latest: "0.1.0" });
    await check.refresh();
    await tick();
    expect(apply).not.toHaveBeenCalled();
    stop();
    await tick();
    expect(apply).not.toHaveBeenCalled();
  });
});
