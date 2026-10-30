// The shared read and the bodiless write, whose whole reason to exist is the
// failures: fifteen views answer with what these functions decided.

import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesce, getJson, mustGetJson, refused } from "./api.js";

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
    expect(got).toEqual({ ok: false, error: "Could not load sessions: TypeError: Failed to fetch" });
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
        if (outcomes.shift() === "fail") throw new TypeError("Load failed");
      });
      // The first load fails while a second is asked for: that one runs, and succeeds.
      await Promise.all([load(), load()]);
      expect(loads).toBe(2);
      // Nothing else will ask: a failure retries itself, later after each failure in a row,
      // and rejects once for it — its repeat is the same failure, still being retried.
      await expect(load()).rejects.toThrow("Load failed");
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
