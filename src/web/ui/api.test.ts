// The shared read, whose whole reason to exist is the failures: fifteen views
// answer with what these two functions decided.

import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesce, getJson, mustGetJson } from "./api.js";

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
    const got = await getJson("/api/x", "Could not load boards");
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.error.startsWith("Could not load boards:")).toBe(true);
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
});
