// The shared read and the bodiless write, whose whole reason to exist is the
// failures: fifteen views answer with what these functions decided.

import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesce, cutShort, getJson, mustGetJson, passing, persist, refused, wakeRetries } from "./api.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** One canned answer, as a route would send it. */
const answering = (body: unknown, status = 200, contentType = "application/json"): void => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": contentType },
      }),
    ),
  ) as unknown as typeof fetch;
};

describe("getJson", () => {
  it("answers with the parsed value", async () => {
    answering([{ id: "a" }]);
    await expect(getJson<{ id: string }[]>("/api/sessions", "Could not load")).resolves.toEqual({
      ok: true,
      value: [{ id: "a" }],
    });
  });

  it("prefers the server's own sentence over the status", async () => {
    answering({ error: "busy — stop the turn first" }, 409);
    const got = await getJson("/api/x", "Could not compact");
    expect(got).toEqual({ ok: false, error: "busy — stop the turn first" });
  });

  it("names the status when the refusal carried no sentence", async () => {
    answering("<html>502 Bad Gateway</html>", 502, "text/html");
    const got = await getJson("/api/x", "Could not load providers");
    expect(got).toEqual({ ok: false, error: "Could not load providers (502)" });
  });

  it("says so when a 200 is not JSON at all", async () => {
    // A proxy's login page answering 200 used to reach a view as a
    // SyntaxError quoting "<html…", or as nothing at all.
    answering("<html>hello</html>", 200, "text/html");
    const got = await getJson("/api/x", "Could not load tasks");
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.error.startsWith("Could not load tasks:")).toBe(true);
  });

  it("says so when the request never answered", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const got = await getJson("/api/x", "Could not load sessions");
    expect(got).toEqual({ ok: false, error: "Could not load sessions: TypeError: Failed to fetch", cause: new TypeError("Failed to fetch") });
  });

  it("passes the caller's request options through", async () => {
    answering({});
    await getJson("/api/settings", "nope", { cache: "no-store" });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings", { cache: "no-store" });
  });
});

describe("mustGetJson", () => {
  it("returns the value a caller inside a try wanted", async () => {
    answering({ branch: "main" });
    await expect(mustGetJson<{ branch: string }>("/api/explorer/git", "no repo")).resolves.toEqual({
      branch: "main",
    });
  });

  it("throws a read cut short under its sentence, caused by what the request threw", async () => {
    const timedOut = new DOMException("signal timed out", "TimeoutError");
    globalThis.fetch = vi.fn(() => Promise.reject(timedOut)) as unknown as typeof fetch;
    const err: unknown = await mustGetJson("/api/sessions", "Could not load sessions").catch((e: unknown) => e);
    expect(String(err)).toBe("Error: Could not load sessions: TimeoutError: signal timed out");
    expect((err as Error).cause).toBe(timedOut);
    expect(cutShort(err)).toBe(true);
  });

  it("throws a request the network dropped under its sentence, caused by what the request threw", async () => {
    const dropped = new TypeError("Load failed");
    globalThis.fetch = vi.fn(() => Promise.reject(dropped)) as unknown as typeof fetch;
    const err: unknown = await mustGetJson("/api/sessions", "Could not load sessions").catch((e: unknown) => e);
    expect(String(err)).toBe("Error: Could not load sessions: TypeError: Load failed");
    expect(cutShort(err)).toBe(true);
  });

  it("throws the sentence, not the response", async () => {
    answering({ error: "not a directory" }, 400);
    await expect(mustGetJson("/api/fs/ls", "could not list this folder")).rejects.toThrow(
      "not a directory",
    );
  });
});

describe("coalesce", () => {
  it("collapses a burst into two loads, never twenty", async () => {
    let loads = 0;
    const load = coalesce(async () => {
      loads++;
      await Promise.resolve();
    });
    await Promise.all([load(), load(), load(), load()]);
    expect(loads).toBe(2); // the one in flight, then one for everything asked during it
  });

  it("still runs a request asked for during a failed load, and retries a failure with backoff", async () => {
    vi.useFakeTimers();
    try {
      const outcomes = ["fail", "ok", "fail", "fail", "ok"];
      let loads = 0;
      const load = coalesce(async () => {
        loads++;
        await Promise.resolve();
        if (outcomes.shift() === "fail") throw new Error("HTTP 503");
      });
      // The first load fails while a second is asked for: that one runs, and succeeds.
      await Promise.all([load(), load()]);
      expect(loads).toBe(2);
      // Nothing else will ask: a failure retries itself, later after each failure in a row,
      // and rejects once for it — its repeat is the same failure, still being retried.
      await expect(load()).rejects.toThrow("HTTP 503");
      await expect(load()).resolves.toBeUndefined();
      expect(loads).toBe(4);
      await vi.advanceTimersByTimeAsync(1999);
      expect(loads).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(loads).toBe(5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(loads).toBe(5); // succeeded: no more retries
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a request asked for while a cut-short read waits for its retry, without waiting", async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const load = coalesce(async () => {
        if (++loads === 1) throw new DOMException("Fetch is aborted", "AbortError");
      });
      const first = load();
      await vi.advanceTimersByTimeAsync(0);
      await load();
      await first;
      expect(loads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles reads cut short with their retries, and rejects once they waited fifteen seconds", async () => {
    vi.useFakeTimers();
    try {
      const outcomes = ["abort", "abort", "ok", "abort", "abort", "abort", "abort", "abort"];
      let loads = 0;
      const load = coalesce(async () => {
        loads++;
        if (outcomes.shift() === "abort") throw new DOMException("signal timed out", "TimeoutError");
      });
      let settled = false;
      const first = load().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2999);
      expect([loads, settled]).toEqual([2, false]); // not a success: the caller waits for the data
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(loads).toBe(3);
      // A success starts the wait over: 1 + 2 + 4 + 8 seconds between five reads.
      const second = load();
      const caught = expect(second).rejects.toThrow("signal timed out");
      await vi.advanceTimersByTimeAsync(14_999);
      expect(loads).toBe(7);
      await vi.advanceTimersByTimeAsync(1);
      await caught;
      expect(loads).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a request the network dropped with its retry, and rejects for one still dropped after the retries", async () => {
    vi.useFakeTimers();
    try {
      const dropped = () => new Error("Could not load sessions: TypeError: Load failed", { cause: new TypeError("Load failed") });
      let drops = 1;
      let loads = 0;
      const load = coalesce(async () => {
        loads++;
        if (drops-- > 0) throw dropped();
      });
      const first = load();
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      expect(loads).toBe(2);
      drops = Infinity;
      const second = load();
      const caught = expect(second).rejects.toThrow("Could not load sessions: TypeError: Load failed");
      await vi.advanceTimersByTimeAsync(15_000);
      await caught;
      expect(loads).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes back a dropped request it rejected with once one succeeds, and never a refusal", async () => {
    vi.useFakeTimers();
    try {
      let next: () => void = () => { throw new TypeError("Load failed"); };
      const load = coalesce(async () => next());
      const dropped: unknown = await Promise.all([load().catch((e: unknown) => e), vi.advanceTimersByTimeAsync(15_000)]).then(([e]) => e);
      expect(String(dropped)).toBe("TypeError: Load failed");
      let back = false;
      void passing.get(dropped as object)!.then(() => { back = true; });
      next = () => { throw new Error("HTTP 503"); };
      const refusal: unknown = await load().catch((e: unknown) => e);
      expect(passing.has(refusal as object)).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(back).toBe(false);
      next = () => {};
      await load();
      expect(back).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a cut-short read's wait when it is asked for again", async () => {
    vi.useFakeTimers();
    try {
      let drops = 3;
      let loads = 0;
      const load = coalesce(async () => {
        loads++;
        if (drops-- > 0) throw new TypeError("Load failed");
      });
      const first = load();
      await vi.advanceTimersByTimeAsync(3000);
      expect(loads).toBe(3); // now waiting 4s
      const again = load();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([first, again]);
      expect(loads).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects again for a different failure, and for the same one after a success", async () => {
    vi.useFakeTimers();
    try {
      const outcomes = ["Load failed", "Load failed", "HTTP 503", "ok", "Load failed"];
      const load = coalesce(async () => {
        const next = outcomes.shift();
        if (next !== "ok") throw new Error(next);
      });
      await expect(load()).rejects.toThrow("Load failed");
      await expect(load()).resolves.toBeUndefined();
      await expect(load()).rejects.toThrow("HTTP 503");
      await expect(load()).resolves.toBeUndefined();
      await expect(load()).rejects.toThrow("Load failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("persist", () => {
  const timedOut = { ok: false as const, error: "Could not load", cause: new DOMException("signal timed out", "TimeoutError") };

  it("counts its fifteen seconds from the first failure, not in waits: a read that hangs is news after three", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const hang = () => new Promise<typeof timedOut>((resolve) => {
        reads++;
        setTimeout(() => resolve(timedOut), 10_000);
      });
      let got: unknown;
      void persist(hang, () => true).then((g) => { got = g; });
      await vi.advanceTimersByTimeAsync(32_999);
      expect([reads, got]).toEqual([3, undefined]);
      await vi.advanceTimersByTimeAsync(1);
      expect(got).toBe(timedOut);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads again at once when the network is back, and stops once nobody wants the answer", async () => {
    vi.useFakeTimers();
    try {
      const answers: { ok: boolean; cause?: unknown }[] = [timedOut, timedOut, { ok: true }];
      let reads = 0;
      let live = true;
      const read = () => Promise.resolve(answers[reads++]!);
      const got = persist(read, () => live);
      await vi.advanceTimersByTimeAsync(0);
      wakeRetries();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(2);
      live = false;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(got).resolves.toBe(timedOut);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a refusal at once", async () => {
    const refusal = { ok: false, error: "no session" };
    let reads = 0;
    await expect(persist(() => { reads++; return Promise.resolve(refusal); }, () => true)).resolves.toBe(refusal);
    expect(reads).toBe(1);
  });
});

describe("cutShort", () => {
  it("knows each engine's dropped request and a signal's abort, directly or as a cause", () => {
    for (const message of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."]) {
      expect(cutShort(new TypeError(message))).toBe(true);
      expect(cutShort(new Error("Could not load", { cause: new TypeError(message) }))).toBe(true);
    }
    expect(cutShort(new DOMException("Fetch is aborted", "AbortError"))).toBe(true);
  });

  it("leaves a bug's TypeError, a refusal and a non-error alone", () => {
    expect(cutShort(new TypeError("x is not a function"))).toBe(false);
    expect(cutShort(new Error("Load failed"))).toBe(false);
    expect(cutShort(new Error("Could not load sessions (503)"))).toBe(false);
    expect(cutShort("Load failed")).toBe(false);
  });
});

describe("refused", () => {
  it("answers nothing when the write took", async () => {
    answering({});
    await expect(refused("/api/vault/x", "DELETE", "Could not remove it")).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/vault/x", { method: "DELETE" });
  });

  it("answers the server's sentence for a refusal", async () => {
    answering({ error: "run already finished" }, 409);
    await expect(refused("/api/runs/r/cancel", "POST", "could not stop the run")).resolves.toBe(
      "run already finished",
    );
  });

  it("answers a sentence, not a rejection, when the request never answered", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    await expect(refused("/api/passkeys/p", "DELETE", "Could not remove it")).resolves.toBe(
      "Could not remove it: TypeError: Failed to fetch",
    );
  });
});
