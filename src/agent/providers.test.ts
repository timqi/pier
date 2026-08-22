import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
