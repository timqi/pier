// Backend resolution, the audit rule, HTTP policy, the OpenAI wire format and
// artifact housekeeping — the four places this extension can be wrong without
// anyone noticing until a search comes back in the wrong language, twice.
//
// Every module here reads its configuration at import time, so the env is set
// before the imports and the imports are dynamic.

import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const artifactDir = await mkdtemp(join(tmpdir(), "web-artifacts-"));
process.env.PIER_WEB_ARTIFACT_DIR = artifactDir;
process.env.PIER_WEB_ARTIFACT_DAYS = "30";
process.env.PIER_WEB_TIMEOUT_MS = "150";

const { resolveTarget } = await import("./provider.js");
const { webSearchViaResponses } = await import("./openai.js");
const { postJson } = await import("./http.js");
const { preservesLanguage } = await import("./language.js");
const { saveArtifact } = await import("./artifacts.js");

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Headers(),
  text: async () => JSON.stringify(body),
});
const fail = (status: number, message: string, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  statusText: "Error",
  headers: new Headers(headers),
  text: async () => JSON.stringify({ error: { message } }),
});

const model = (over: Record<string, unknown>) => ({
  id: "m",
  name: "m",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.example.com",
  reasoning: false,
  input: ["text"],
  cost: {},
  contextWindow: 1000,
  maxTokens: 4096,
  ...over,
});

const ctx = (models: unknown[], active?: unknown) =>
  ({
    model: active,
    modelRegistry: {
      getAll: () => models,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async (m: { provider: string }) => ({
        ok: true,
        apiKey: m.provider === "openai" ? "sk-oai" : "sk-ant-abc",
        baseUrl: "https://sub2api.example.com",
      }),
    },
  }) as never;

const gpt = model({ id: "gpt-5.6", api: "openai-responses", provider: "openai" });
const haiku = model({ id: "claude-haiku-4-5-20251001" });

describe("backend resolution", () => {
  it("reaches Anthropic's tools from a session running on GPT", async () => {
    const target = await resolveTarget(ctx([gpt, haiku], gpt), 900);
    expect(target.backend).toBe("anthropic");
    expect(target.model).toBe("claude-haiku-4-5-20251001");
    expect(target.url).toBe("https://sub2api.example.com/v1/messages");
    expect(target.headers.get("x-api-key")).toBe("sk-ant-abc");
    expect(target.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("falls through to Responses when the registry has only OpenAI", async () => {
    const target = await resolveTarget(ctx([gpt], gpt), 900);
    expect(target.backend).toBe("openai");
    expect(target.url).toBe("https://sub2api.example.com/v1/responses");
    expect(target.headers.get("authorization")).toBe("Bearer sk-oai");
    expect(target.headers.get("anthropic-version")).toBeNull();
  });

  it("says which backend a tool needs, and what to configure, instead of failing later", async () => {
    // web_fetch is Anthropic-only.
    await expect(resolveTarget(ctx([gpt], gpt), 900, ["anthropic"]))
      .rejects.toThrow(/authenticate claude-haiku-4-5-20251001 on an anthropic-messages provider/);
    await expect(resolveTarget(ctx([gpt, haiku], gpt), 900, ["anthropic"], "openai"))
      .rejects.toThrow(/backend="openai" cannot serve this tool \(needs anthropic\)/);
  });

  it("never falls back to a model nobody named", async () => {
    // An endpoint listing only its own ids: the search does not quietly run on
    // whatever came back first (which is how it ended up on an unreleased id).
    const stranger = model({ id: "gateway-mystery-1" });
    await expect(resolveTarget(ctx([stranger]), 900, ["anthropic"]))
      .rejects.toThrow(/set PIER_WEB_MODEL to a model you have there/);
    // Named through the session it is running in, it is a candidate again.
    expect((await resolveTarget(ctx([stranger], stranger), 900, ["anthropic"])).model)
      .toBe("gateway-mystery-1");
  });

  it("takes the caller's backend over the default order, and clamps maxTokens", async () => {
    const both = ctx([gpt, haiku], gpt);
    expect((await resolveTarget(both, 900, ["anthropic", "openai"], "openai")).backend).toBe("openai");
    expect((await resolveTarget(both, 900, ["anthropic", "openai"], "anthropic")).backend)
      .toBe("anthropic");
    expect((await resolveTarget(ctx([haiku], haiku), 99_999)).maxTokens).toBe(4096);
  });

  it("asks Responses for double, and never past the model's own limit", async () => {
    // Reasoning tokens come out of max_output_tokens; Anthropic's max_tokens
    // is prose only, so only one of the two is doubled.
    expect((await resolveTarget(ctx([gpt], gpt), 1_000)).maxTokens).toBe(2_000);
    expect((await resolveTarget(ctx([haiku], haiku), 1_000)).maxTokens).toBe(1_000);
    expect((await resolveTarget(ctx([gpt], gpt), 3_000)).maxTokens).toBe(4_096);
  });
});

describe("the audit rule", () => {
  it("passes a rewording in the same language and catches a translation", () => {
    expect(preservesLanguage("阿里巴巴 股价", "阿里巴巴 9988 实时股价")).toBe(true);
    expect(preservesLanguage("阿里巴巴 股价", "alibaba stock price")).toBe(false);
    expect(preservesLanguage("rust async traits", "rust async trait 2026")).toBe(true);
    // Nothing to audit is not a pass.
    expect(preservesLanguage("q", undefined)).toBe(false);
  });
});

describe("HTTP policy", () => {
  it("retries a 429 and honours retry-after", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts < 3 ? fail(429, "slow down", { "retry-after": "0" }) : ok({ fine: true });
    }) as never;
    expect(await postJson("X", "https://x", new Headers(), {})).toEqual({ fine: true });
    expect(attempts).toBe(3);
  });

  it("does not retry a 400, and reports the provider's own message", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return fail(400, "bad model");
    }) as never;
    await expect(postJson("X", "https://x", new Headers(), {})).rejects.toThrow("X 400: bad model");
    expect(attempts, "4xx is final").toBe(1);
  });

  it("times out a hung endpoint instead of hanging the tool", async () => {
    globalThis.fetch = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })) as never;
    // AbortSignal.timeout's timer is unref'd; hold the loop open like a socket.
    const keepAlive = setInterval(() => {}, 50);
    await expect(postJson("X", "https://x", new Headers(), {}))
      .rejects.toThrow(/timed out after 150ms/);
    clearInterval(keepAlive);
  });

  it("treats the caller's abort as final, not as a timeout to retry", async () => {
    await expect(postJson("X", "https://x", new Headers(), {}, AbortSignal.abort())).rejects.toThrow();
  });
});

describe("the OpenAI Responses shape", () => {
  const payload = {
    output: [
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "深圳 天气",
          sources: ["https://a.example/x", { url: "https://b.example/y", title: "B page" }],
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "It is sunny.",
            annotations: [
              { type: "url_citation", url: "https://a.example/x", title: "A page", start_index: 0, end_index: 3 },
            ],
          },
        ],
      },
    ],
  };
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  let bodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    target = await resolveTarget(ctx([gpt], gpt), 900);
  });

  it("reads back the queries, the briefing and both spellings of a source", async () => {
    bodies = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return ok(payload);
    }) as never;
    const outcome = await webSearchViaResponses(target, "find the weather", {
      allowedDomains: ["a.example"],
    });
    expect(outcome.queries).toEqual([{ query: "深圳 天气", language: "Chinese" }]);
    expect(outcome.text).toBe("It is sunny.");
    expect(outcome.results).toEqual([
      { title: "A page", url: "https://a.example/x" },
      { title: "B page", url: "https://b.example/y" },
    ]);
    expect(outcome.backend).toBe("openai");
    expect(bodies[0]?.tools).toEqual([
      { type: "web_search", filters: { allowed_domains: ["a.example"] } },
    ]);
    expect(bodies[0]?.tool_choice).toEqual({ type: "web_search" });
    expect(bodies[0]?.include).toEqual(["web_search_call.action.sources"]);
    // Doubled on the way out: Responses bills reasoning against the same
    // allowance, so 900 of prose asked for is 1800 of budget sent.
    expect(bodies[0]?.max_output_tokens).toBe(1800);
  });

  it("retries with auto when a gateway rejects a forced hosted tool", async () => {
    bodies = [];
    let attempts = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      attempts++;
      bodies.push(JSON.parse(init.body));
      return attempts === 1 ? fail(400, "unsupported tool_choice") : ok(payload);
    }) as never;
    const retried = await webSearchViaResponses(target, "find the weather", {});
    expect(attempts).toBe(2);
    expect(bodies.at(-1)?.tool_choice).toBe("auto");
    expect(retried.text).toBe("It is sunny.");
  });

  it("keeps the first rejection when the retry fails too", async () => {
    globalThis.fetch = (async () => fail(400, "model not found")) as never;
    await expect(webSearchViaResponses(target, "q", {}))
      .rejects.toThrow(/model not found[\s\S]*forced tool_choice also failed/);
  });

  it("calls no search at all an error, not an empty result", async () => {
    globalThis.fetch = (async () => ok({ output: [] })) as never;
    await expect(webSearchViaResponses(target, "q", {})).rejects.toThrow(/did not invoke web_search/);
  });
});

describe("artifacts", () => {
  it("redacts the URL, keeps the body, and prunes what expired", async () => {
    globalThis.fetch = realFetch;
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    const stale = join(artifactDir, "stale-0000000000000000.md");
    await writeFile(stale, "old");
    await utimes(stale, longAgo, longAgo);
    // What a crashed run leaves behind.
    const leftover = join(artifactDir, "page-1111111111111111.md.abc.tmp");
    await writeFile(leftover, "crashed");
    await utimes(leftover, longAgo, longAgo);

    const saved = await saveArtifact(new URL("https://x.example/a?token=hunter2"), "body text");
    expect(await readdir(artifactDir)).toEqual([saved.split("/").pop()]);
    const written = await readFile(saved, "utf8");
    expect(written).toMatch(/token=REDACTED/);
    expect(written).not.toMatch(/hunter2/);
    expect(written).toMatch(/body text$/);
  });
});

describe("the search tool end to end", () => {
  it("reports a briefing that stopped at the output limit, and what it cost", async () => {
    const { webSearch } = await import("./tools.js");
    globalThis.fetch = (async () =>
      ok({
        model: "claude-haiku-4-5-20251001",
        stop_reason: "max_tokens",
        usage: { input_tokens: 11, output_tokens: 900 },
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "pier docs" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [{ type: "web_search_result", url: "https://a.example/x", title: "A page" }],
          },
          { type: "text", text: "A briefing that ends mid-sen" },
        ],
      })) as never;

    const notes: string[] = [];
    const result = await webSearch.execute(
      "call-1",
      { query: "pier docs" },
      undefined as never,
      ((update: { content: { text?: string }[] }) => {
        notes.push(update.content[0]?.text ?? "");
      }) as never,
      ctx([haiku], haiku),
    );
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    expect(text).toContain("hit the search model's output limit");
    expect(text).toContain("A briefing that ends mid-sen");
    expect(text).toContain("[A page](https://a.example/x)");
    expect(result.details).toMatchObject({
      backend: "anthropic",
      truncated: true,
      usage: { input: 11, output: 900 },
    });
    // Which model is being paid, before the wait rather than after it.
    expect(notes).toEqual([
      "Searching: pier docs",
      "anthropic · claude-haiku-4-5-20251001 · searching",
    ]);
  });
});

describe("the fetch tool end to end", () => {
  it("in full mode pays for no digest and returns the document", async () => {
    const { webFetch } = await import("./tools.js");
    const document = "THE WHOLE DOCUMENT".repeat(20);
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return ok({
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        usage: { input_tokens: 40, output_tokens: 2 },
        content: [
          { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://x.example/a" } },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "f1",
            content: {
              type: "web_fetch_result",
              url: "https://x.example/a",
              retrieved_at: "2026-01-01T00:00:00Z",
              content: { type: "document", source: { type: "text", data: document } },
            },
          },
          { type: "text", text: "OK" },
        ],
      });
    }) as never;

    const result = await webFetch.execute(
      "call-2",
      { url: "https://x.example/a", mode: "full" },
      undefined as never,
      (() => {}) as never,
      ctx([haiku], haiku),
    );
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    // The document, not a summary of it — and not the "OK" that acknowledged it.
    expect(text).toContain(document);
    expect(text).not.toMatch(/^OK/);
    expect(text).toContain("Full document artifact:");
    // 256 tokens is what an acknowledgement costs; a digest nobody reads is
    // what the old 900 paid for.
    expect(bodies[0]?.max_tokens).toBe(256);
    expect(String(bodies[0]?.messages)).not.toContain("digest");
    expect(result.details).toMatchObject({ mode: "full", usage: { input: 40, output: 2 } });
  });
});

describe("a call that partly failed", () => {
  const searchBody = (blocks: unknown[]) => ({
    model: "claude-haiku-4-5-20251001",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 20 },
    content: blocks,
  });
  const refused = {
    type: "web_search_tool_result",
    tool_use_id: "s2",
    content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
  };

  it("keeps the answer and reports what failed beside it", async () => {
    const { webSearch } = await import("./tools.js");
    globalThis.fetch = (async () =>
      ok(searchBody([
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "pier docs" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "s1",
          content: [{ type: "web_search_result", url: "https://a.example/x", title: "A page" }],
        },
        refused,
        { type: "text", text: "A briefing." },
      ]))) as never;

    const result = await webSearch.execute(
      "c",
      { query: "pier docs" },
      undefined as never,
      (() => {}) as never,
      ctx([haiku], haiku),
    );
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    expect(text).toContain("A briefing.");
    expect(text).toContain("max_uses_exceeded");
    expect(result.details).toMatchObject({
      providerErrors: ["web_search_tool_result: max_uses_exceeded"],
    });
  });

  it("fails by throwing when nothing usable came back", async () => {
    const { webSearch } = await import("./tools.js");
    globalThis.fetch = (async () =>
      ok(searchBody([
        { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "pier docs" } },
        refused,
      ]))) as never;

    // Throwing is the only thing Pi records as a failed tool call; a returned
    // isError is dropped, and this used to return one.
    await expect(webSearch.execute(
      "c",
      { query: "pier docs" },
      undefined as never,
      (() => {}) as never,
      ctx([haiku], haiku),
    )).rejects.toThrow("max_uses_exceeded");
  });

  it("keeps the first search when the language retry does not fix the language", async () => {
    const { webSearch } = await import("./tools.js");
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const query = call === 1 ? "alibaba stock price" : "alibaba shares";
      return ok(searchBody([
        { type: "server_tool_use", id: `s${call}`, name: "web_search", input: { query } },
        {
          type: "web_search_tool_result",
          tool_use_id: `s${call}`,
          content: [{ type: "web_search_result", url: `https://a.example/${call}`, title: "A" }],
        },
        { type: "text", text: call === 1 ? "THREE ROUNDS" : "ONE ROUND" },
      ]));
    }) as never;

    const result = await webSearch.execute(
      "c",
      { query: "阿里巴巴 股价" },
      undefined as never,
      (() => {}) as never,
      ctx([haiku], haiku),
    );
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    expect(call).toBe(2);
    // The retry ran, did not preserve Chinese either, and was discarded: a
    // narrowed single search is not an upgrade on three rounds.
    expect(text).toContain("THREE ROUNDS");
    expect(text).not.toContain("ONE ROUND");
    expect(text).toContain("translated the query out of Chinese");
    expect(result.details).toMatchObject({ queryLanguagePreserved: false });
  });
});

describe("a deadline during backoff", () => {
  it("stops sleeping and reports what caused the retry", async () => {
    globalThis.fetch = (async () => fail(429, "slow down", { "retry-after": "5" })) as never;
    const started = Date.now();
    await expect(
      postJson("X", "https://x", new Headers(), {}, AbortSignal.timeout(80)),
    ).rejects.toThrow("X 429: slow down");
    // Not five seconds later, and not with a bare "aborted".
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("a rejected URL", () => {
  it("throws rather than answering with an apology", async () => {
    const { webFetch } = await import("./tools.js");
    for (const url of ["ftp://x.example/a", "https://user:pw@x.example/a", "not a url"]) {
      await expect(webFetch.execute(
        "c",
        { url },
        undefined as never,
        (() => {}) as never,
        ctx([haiku], haiku),
      )).rejects.toThrow();
    }
  });
});
