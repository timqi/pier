import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { Secrets } from "../secrets.js";
import { PiConfigStore } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { PiAgentFactory } from "./pi.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let dir: string;
let factory: PiAgentFactory;
let credentials: CredentialStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pier-providers-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const secrets = new Secrets(join(dir, "master.key"));
  await secrets.unlock();
  credentials = new CredentialStore(openDb(":memory:"), secrets, dir);
  factory = new PiAgentFactory([], () => "", [], credentials, new PiConfigStore(dir));
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

/** A provider endpoint on loopback: whatever the test says, once. */
async function endpoint(
  reply: () => { status: number; type: string; body: string },
): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push(body);
      const answer = reply();
      res.writeHead(answer.status, { "content-type": answer.type });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Configured and authenticated against `url`, ready to be probed. */
async function probeable(id: string, url: string): Promise<void> {
  await factory.setup({
    kind: "custom",
    id,
    endpoint: url,
    api: "openai-completions",
    models: [{ id: "probe-model", reasoning: false }],
  });
  await factory.login(id, "api_key", {
    signal: AbortSignal.timeout(5_000),
    prompt: async () => "sk-probe",
    notify: () => {},
  });
}

describe("a provider probe", () => {
  it("makes one small real request and reports which model answered", async () => {
    // The adapter streams, so the endpoint speaks SSE like a real one.
    const chunk = (over: Record<string, unknown>) =>
      `data: ${
        JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "probe-model",
          ...over,
        })
      }\n\n`;
    const server = await endpoint(() => ({
      status: 200,
      type: "text/event-stream",
      body: chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) + "data: [DONE]\n\n",
    }));
    await probeable("probe-ok", server.url);

    const result = await factory.check("probe-ok", "probe-model");
    expect(result).toMatchObject({ ok: true, model: "probe-model", response: "hi" });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    // What was sent is reported verbatim, and it is what went over the wire.
    expect(JSON.parse(result.request)).toEqual(JSON.parse(server.seen[0] ?? "{}"));
    expect(JSON.parse(result.request)).toMatchObject({
      model: "probe-model",
      max_completion_tokens: 8192,
      messages: [{ role: "user", content: "hi" }],
    });
    await server.close();
  });

  it("answers a refusal in the provider's own words instead of throwing", async () => {
    const server = await endpoint(() => ({
      status: 401,
      type: "application/json",
      body: JSON.stringify({ error: { message: "invalid_api_key", type: "authentication_error" } }),
    }));
    await probeable("probe-401", server.url);

    const result = await factory.check("probe-401", "probe-model");
    expect(result.ok).toBe(false);
    // The refusal is the endpoint's own body, not a summary of it.
    expect(result.response).toBe(JSON.stringify({
      error: { message: "invalid_api_key", type: "authentication_error" },
    }));
    expect(result.request).toContain("probe-model");
    await server.close();
  });

  it("picks no model of its own when the one named is not there", async () => {
    expect(await factory.check("probe-401", "not-a-model")).toMatchObject({
      ok: false,
      model: "not-a-model",
      request: "",
      response: "unknown model: probe-401/not-a-model",
    });
  });
});

describe("provider setup", () => {
  it("reloads the catalog and authenticates a custom provider without a restart", async () => {
    expect((await factory.providers()).some((provider) => provider.id === "my-proxy")).toBe(false);

    await factory.setup({
      kind: "custom",
      id: "my-proxy",
      name: "My Proxy",
      endpoint: "https://llm.example/v1",
      api: "openai-completions",
      models: [{ id: "reasoner", reasoning: true }],
    });
    const provider = (await factory.providers()).find((entry) => entry.id === "my-proxy");
    expect(provider).toMatchObject({
      name: "My Proxy",
      builtin: false,
      endpoint: "https://llm.example/v1",
      api: "openai-completions",
      models: [{ id: "reasoner", reasoning: true }],
      configured: false,
    });

    const rollback = await factory.login("my-proxy", "api_key", {
      signal: AbortSignal.timeout(5_000),
      prompt: async (prompt) => {
        expect(prompt.type).toBe("secret");
        return "sk-test-secret";
      },
      notify: () => {},
    });
    expect(await credentials.read("my-proxy")).toEqual({ type: "api_key", key: "sk-test-secret" });
    expect((await factory.providers()).find((entry) => entry.id === "my-proxy")).toMatchObject({
      configured: true,
      stored: "api_key",
    });
    await rollback();
    expect(await credentials.read("my-proxy")).toBeUndefined();

    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    models.providers["external-proxy"] = {
      name: "External Proxy",
      baseUrl: "https://external.example/v1",
      api: "openai-completions",
      models: [{ id: "external-model" }],
    };
    writeFileSync(join(dir, "models.json"), JSON.stringify(models));
    expect((await factory.providers()).find((entry) => entry.id === "external-proxy")).toMatchObject({
      name: "External Proxy",
      endpoint: "https://external.example/v1",
      models: [{ id: "external-model", reasoning: false }],
    });
  });

  it("rejects an invalid composed config and restores the file", async () => {
    const path = join(dir, "models.json");
    const before = JSON.stringify({ providers: { anthropic: { headers: { invalid: 1 } } } });
    writeFileSync(path, before);
    await expect(factory.setup({
      kind: "builtin",
      id: "anthropic",
      endpoint: "https://proxy.example/v1",
    })).rejects.toThrow(/Invalid models.json schema/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
