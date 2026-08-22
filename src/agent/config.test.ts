import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigScope } from "../core/types.js";
import { PiConfigStore } from "./config.js";
import { pierSystemPrompt } from "./pi.js";

const GLOBAL: ConfigScope = { kind: "global" };

let agentDir: string;
let cwd: string;
let store: PiConfigStore;
let project: ConfigScope;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pier-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "pier-proj-"));
  store = new PiConfigStore(agentDir);
  project = { kind: "project", cwd };
});

describe("Pier system prompt", () => {
  it("puts Pier's baseline before the user-owned SYSTEM.md", () => {
    const prompt = pierSystemPrompt("# Working style\nUser rules");
    expect(prompt).toMatch(/^You are a general-purpose agent with a live workspace/);
    expect(prompt).toContain("read and change files and run shell commands");
    expect(prompt.indexOf("# Communication")).toBeLessThan(prompt.indexOf("# Working style"));
    expect(pierSystemPrompt()).not.toContain("undefined");
  });
});

describe("config files", () => {
  it("lists the whitelist per scope, with existence", async () => {
    writeFileSync(join(agentDir, "SYSTEM.md"), "be nice");
    expect(await store.listFiles(GLOBAL)).toEqual([
      { name: "SYSTEM.md", exists: true },
      { name: "AGENTS.md", exists: false },
      { name: "settings.json", exists: false },
      { name: "models.json", exists: false },
    ]);
    expect(await store.listFiles(project)).toEqual([{ name: "AGENTS.md", exists: false }]);
  });

  it("round-trips global and project files; missing reads as empty", async () => {
    expect(await store.readFile(GLOBAL, "SYSTEM.md")).toBe("");
    await store.writeFile(GLOBAL, "SYSTEM.md", "be nice");
    expect(await store.readFile(GLOBAL, "SYSTEM.md")).toBe("be nice");
    await store.writeFile(project, "AGENTS.md", "project rules");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("project rules");
  });

  it("rejects anything outside the whitelist", async () => {
    await expect(store.readFile(GLOBAL, "auth.json")).rejects.toThrow(/not an editable/);
    await expect(store.readFile(GLOBAL, "../secret")).rejects.toThrow(/not an editable/);
    // models.json is global-only; the project whitelist is AGENTS.md alone.
    await expect(store.writeFile(project, "models.json", "{}")).rejects.toThrow(/not an editable/);
  });

  it("does not mistake filesystem failures for missing files", async () => {
    mkdirSync(join(agentDir, "SYSTEM.md"));
    await expect(store.readFile(GLOBAL, "SYSTEM.md")).rejects.toMatchObject({ code: "EISDIR" });

    mkdirSync(join(agentDir, "models.json"));
    await expect(store.providerStructures()).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.writeFile(GLOBAL, "models.json", "{}")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("serializes compare-and-write for ordinary config files", async () => {
    await store.writeFile(GLOBAL, "SYSTEM.md", "before");
    const writes = await Promise.allSettled([
      store.writeFile(GLOBAL, "SYSTEM.md", "first", "before"),
      store.writeFile(GLOBAL, "SYSTEM.md", "second", "before"),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["first", "second"]).toContain(await store.readFile(GLOBAL, "SYSTEM.md"));
  });
});

describe("models.json masking", () => {
  const models = {
    providers: {
      anthropic: { baseUrl: "https://x", apiKey: "sk-secret-1234567890abcd" },
      openai: { apiKey: "short" },
    },
  };

  beforeEach(() => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  });

  it("masks api keys on read", async () => {
    const read = JSON.parse(await store.readFile(GLOBAL, "models.json"));
    expect(read.providers.anthropic.apiKey).toBe("••••••••");
    expect(read.providers.openai.apiKey).toBe("••••••••");
    expect(read.providers.anthropic.baseUrl).toBe("https://x");
  });

  it("keeps stored keys when the mask comes back unchanged", async () => {
    const edited = JSON.parse(await store.readFile(GLOBAL, "models.json"));
    edited.providers.anthropic.baseUrl = "https://y"; // user edit, mask untouched
    await store.writeFile(GLOBAL, "models.json", JSON.stringify(edited));
    const onDisk = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(onDisk.providers.anthropic.apiKey).toBe("sk-secret-1234567890abcd");
    expect(onDisk.providers.openai.apiKey).toBe("short");
    expect(onDisk.providers.anthropic.baseUrl).toBe("https://y");
  });

  it("rejects new plaintext credentials from the advanced editor", async () => {
    const edited = JSON.parse(await store.readFile(GLOBAL, "models.json"));
    edited.providers.anthropic.apiKey = "sk-brand-new";
    await expect(store.writeFile(GLOBAL, "models.json", JSON.stringify(edited)))
      .rejects.toThrow(/configured under Providers/);
    edited.providers.anthropic.apiKey = "••••••••";
    edited.providers.anthropic.baseUrl = "https://user:secret@example.com/v1";
    await expect(store.writeFile(GLOBAL, "models.json", JSON.stringify(edited)))
      .rejects.toThrow(/must not contain credentials/);
    expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")))
      .toEqual(models);
  });

  it("keeps header values and malformed JSON out of the browser", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        proxy: {
          headers: { Authorization: "Bearer provider-secret" },
          models: [{
            id: "m",
            baseUrl: "https://model.example/v1",
            headers: { "x-api-key": "model-secret" },
          }],
          modelOverrides: {
            builtin: { headers: { "x-route-key": "override-secret" } },
          },
        },
      },
    }));
    const visible = JSON.parse(await store.readFile(GLOBAL, "models.json"));
    expect(JSON.stringify(visible)).not.toContain("provider-secret");
    expect(JSON.stringify(visible)).not.toContain("model-secret");
    expect(JSON.stringify(visible)).not.toContain("override-secret");
    visible.providers.proxy.name = "Proxy";
    await store.writeFile(GLOBAL, "models.json", JSON.stringify(visible));
    const stored = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(stored.providers.proxy.headers.Authorization).toBe("Bearer provider-secret");
    expect(stored.providers.proxy.models[0].headers["x-api-key"]).toBe("model-secret");
    expect(stored.providers.proxy.modelOverrides.builtin.headers["x-route-key"])
      .toBe("override-secret");

    visible.providers.proxy.headers.Authorization = "Bearer replacement";
    await expect(store.writeFile(GLOBAL, "models.json", JSON.stringify(visible)))
      .rejects.toThrow(/configured on disk/);
    await expect(store.writeFile(GLOBAL, "models.json", "{oops")).rejects.toThrow(/valid JSON/);
    stored.providers.proxy.models[0].baseUrl = "https://user:secret@model.example/v1?key=secret";
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(stored));
    await expect(store.readFile(GLOBAL, "models.json")).rejects.toThrow(/must not contain credentials/);
    writeFileSync(join(agentDir, "models.json"), "{broken");
    await expect(store.readFile(GLOBAL, "models.json")).rejects.toThrow(/repair it on disk/);
  });
});

describe("provider setup", () => {
  it("sets and clears a built-in endpoint without disturbing advanced config", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      version: 1,
      providers: { anthropic: { headers: { "x-route": "proxy" } } },
    }));
    await store.setupProvider({ kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1" });
    expect(await store.providerStructures()).toMatchObject({
      anthropic: { endpoint: "https://proxy.example/v1" },
    });
    await store.setupProvider({ kind: "builtin", id: "anthropic" });
    const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(after).toEqual({
      version: 1,
      providers: { anthropic: { headers: { "x-route": "proxy" } } },
    });
  });

  it("rejects endpoint credentials without creating models.json", async () => {
    for (const endpoint of [
      "https://user@example.com/v1",
      "https://user:secret@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://example.com/v1#secret",
    ]) {
      await expect(store.setupProvider({ kind: "builtin", id: "anthropic", endpoint }))
        .rejects.toThrow(/must not contain credentials/);
    }
    expect(await store.readFile(GLOBAL, "models.json")).toBe("");
  });

  it("serializes provider updates and rejects a stale full-file edit", async () => {
    const setup = (id: string) => store.setupProvider({
      kind: "custom",
      id,
      endpoint: `https://${id}.example/v1`,
      api: "openai-completions",
      models: [{ id: "model", reasoning: false }],
    });
    const expected = await store.readFile(GLOBAL, "models.json");
    await Promise.all([setup("first"), setup("second")]);
    expect(Object.keys(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers).sort())
      .toEqual(["first", "second"]);
    await expect(store.writeFile(GLOBAL, "models.json", "{}", expected)).rejects.toThrow(/changed on disk/);
  });

  it("restores models.json when post-write validation fails", async () => {
    const before = JSON.stringify({ providers: { anthropic: { headers: { route: "one" } } } });
    writeFileSync(join(agentDir, "models.json"), before);
    await expect(store.setupProvider(
      { kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1" },
      async () => { throw new Error("invalid composed provider"); },
    )).rejects.toThrow(/invalid composed provider/);
    expect(readFileSync(join(agentDir, "models.json"), "utf8")).toBe(before);
  });

  it("does not roll back over an external edit made during validation", async () => {
    const path = join(agentDir, "models.json");
    writeFileSync(path, JSON.stringify({ providers: { anthropic: { baseUrl: "https://old.example" } } }));
    const concurrent = JSON.stringify({
      providers: { anthropic: { baseUrl: "https://concurrent.example" } },
    });
    await expect(store.setupProvider(
      { kind: "builtin", id: "anthropic", endpoint: "https://candidate.example" },
      async () => {
        writeFileSync(path, concurrent);
        throw new Error("invalid composed provider");
      },
    // Named as what happened — a concurrent edit — not as a failed restore.
    )).rejects.toThrow(/changed while provider setup was being validated/);
    expect(readFileSync(path, "utf8")).toBe(concurrent);
  });

  it("writes a custom provider structurally, preserving advanced model fields", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "my-proxy": {
          models: [{ id: "reasoner", contextWindow: 200000, cost: { input: 1, output: 2 } }],
        },
      },
    }));
    await store.setupProvider({
      kind: "custom",
      id: "my-proxy",
      name: "My Proxy",
      endpoint: "https://llm.example/v1",
      api: "openai-completions",
      models: [{ id: "reasoner", reasoning: true }, { id: "chat", reasoning: false }],
    });
    const raw = readFileSync(join(agentDir, "models.json"), "utf8");
    expect(raw).not.toContain("apiKey");
    expect(JSON.parse(raw).providers["my-proxy"].models[0]).toMatchObject({
      id: "reasoner",
      reasoning: true,
      contextWindow: 200000,
      cost: { input: 1, output: 2 },
    });
    expect(await store.providerStructures()).toEqual({
      "my-proxy": {
        name: "My Proxy",
        endpoint: "https://llm.example/v1",
        api: "openai-completions",
        models: [{ id: "reasoner", reasoning: true }, { id: "chat", reasoning: false }],
      },
    });
  });
});

describe("resources", () => {
  beforeEach(() => {
    mkdirSync(join(agentDir, "extensions", "native-web"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "quiet.ts"), "export {}");
    writeFileSync(join(agentDir, "extensions", "native-web", "index.ts"), "// ext");
    mkdirSync(join(cwd, ".pi", "skills", "greet"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", "greet", "SKILL.md"), "# greet");
  });

  it("lists relative paths per scope; missing dirs are empty", async () => {
    expect(await store.listResources(GLOBAL)).toEqual({
      extensions: [
        { name: "native-web/index.ts", link: false },
        { name: "quiet.ts", link: false },
      ],
      skills: [],
    });
    expect(await store.listResources(project)).toEqual({
      extensions: [],
      skills: [{ name: "greet/SKILL.md", link: false }],
    });
  });

  it("follows symlinked resources and flags them, skipping dangling ones", async () => {
    const elsewhere = join(cwd, "shared-skills", "review");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "SKILL.md"), "# review");
    const skills = join(agentDir, "skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync(elsewhere, join(skills, "review")); // linked directory
    symlinkSync(join(elsewhere, "SKILL.md"), join(skills, "solo.md")); // linked file
    symlinkSync(join(cwd, "gone.md"), join(skills, "dangling.md"));

    expect(await store.listResources(GLOBAL)).toMatchObject({
      skills: [
        { name: "review/SKILL.md", link: true },
        { name: "solo.md", link: true },
      ],
    });
    // A link is still readable through its listed path.
    expect(await store.readResource(GLOBAL, "skills", "review/SKILL.md")).toBe("# review");
  });

  it("reads a resource and rejects path traversal", async () => {
    expect(await store.readResource(GLOBAL, "extensions", "quiet.ts")).toBe("export {}");
    expect(await store.readResource(project, "skills", "greet/SKILL.md")).toBe("# greet");
    await expect(store.readResource(GLOBAL, "extensions", "../models.json")).rejects.toThrow(
      /invalid resource path/,
    );
  });
});
