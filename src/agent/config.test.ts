import { mkdirSync, mkdtempSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pier system prompt", () => {
  it("puts Pier's baseline before the user-owned SYSTEM.md", () => {
    const prompt = pierSystemPrompt("# Tools\nUser rules");
    expect(prompt).toMatch(/^You are a general-purpose agent with a live workspace/);
    expect(prompt).toContain("read and change files and run shell commands");
    // The baseline carries the rules that hold on any machine; the user's file
    // follows it with the local ones, so its layer is the one that wins.
    expect(prompt).toContain("Never claim a test passed without running it");
    expect(prompt.indexOf("# Communication")).toBeLessThan(prompt.indexOf("# Working style"));
    expect(prompt.indexOf("# Working style")).toBeLessThan(prompt.indexOf("# Tools"));
    expect(pierSystemPrompt()).not.toContain("undefined");
  });
});

describe("config files", () => {
  it("lists the whitelist per scope, with existence", async () => {
    writeFileSync(join(agentDir, "SYSTEM.md"), "be nice");
    expect(await store.listFiles(GLOBAL)).toEqual([
      { name: "SYSTEM.md", exists: true, readonly: false },
      { name: "AGENTS.md", exists: false, readonly: false },
      { name: "settings.json", exists: false, readonly: true },
      { name: "models.json", exists: false, readonly: false },
    ]);
    expect(await store.listFiles(project)).toEqual([{ name: "AGENTS.md", exists: false, readonly: false }]);
  });

  it("shows settings.json but refuses to write it as a file", async () => {
    writeFileSync(join(agentDir, "settings.json"), '{"shellPath":"/bin/zsh"}');
    expect(await store.readFile(GLOBAL, "settings.json")).toBe('{"shellPath":"/bin/zsh"}');
    await expect(store.writeFile(GLOBAL, "settings.json", "{}", '{"shellPath":"/bin/zsh"}'))
      .rejects.toThrow(/written by Pier.*pier reload/);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe('{"shellPath":"/bin/zsh"}');
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

describe("session defaults", () => {
  const read = (): unknown => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

  it("reads Pi defaults from a missing or empty settings.json", async () => {
    expect(await store.readDefaults()).toEqual({ defaultModel: null, defaultThinkingLevel: null });
    writeFileSync(join(agentDir, "settings.json"), "");
    expect(await store.readDefaults()).toEqual({ defaultModel: null, defaultThinkingLevel: null });
  });

  it("writes the pair and the level around every other key, and clears them with null", async () => {
    writeFileSync(join(agentDir, "settings.json"), '{"shellPath":"/bin/zsh","defaultThinkingLevel":"low"}');
    await store.writeDefaults({ defaultModel: { provider: "proxy", id: "m" }, defaultThinkingLevel: "high" });
    expect(read()).toEqual({ shellPath: "/bin/zsh", defaultProvider: "proxy", defaultModel: "m", defaultThinkingLevel: "high" });
    expect(await store.readDefaults()).toEqual({
      defaultModel: { provider: "proxy", id: "m" }, defaultThinkingLevel: "high",
    });
    await store.writeDefaults({ defaultModel: null, defaultThinkingLevel: null });
    expect(read()).toEqual({ shellPath: "/bin/zsh" });
    expect(await store.readDefaults()).toEqual({ defaultModel: null, defaultThinkingLevel: null });
  });

  it("creates settings.json when there is none", async () => {
    await store.writeDefaults({ defaultModel: { provider: "proxy", id: "m" }, defaultThinkingLevel: null });
    expect(read()).toEqual({ defaultProvider: "proxy", defaultModel: "m" });
  });

  it("seeds a first boot's settings.json with exactly the keys Pier owns, and never an existing one", async () => {
    await store.seedSettings();
    expect(read()).toEqual({ packages: [], enableInstallTelemetry: false });
    expect(await store.readDefaults()).toEqual({ defaultModel: null, defaultThinkingLevel: null });
    // Pi's merge-write and Pier's defaults both find the list they write into.
    await store.writeDefaults({ defaultModel: { provider: "proxy", id: "m" }, defaultThinkingLevel: null });
    expect(read()).toEqual({ packages: [], enableInstallTelemetry: false, defaultProvider: "proxy", defaultModel: "m" });

    const theirs = '{"shellPath":"/bin/zsh",\n  "enableInstallTelemetry": true}';
    writeFileSync(join(agentDir, "settings.json"), theirs);
    await store.seedSettings();
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(theirs);
    // Not JSON is still theirs: the seed is for a file that is not there.
    writeFileSync(join(agentDir, "settings.json"), "not json");
    await store.seedSettings();
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe("not json");
  });

  it("refuses a settings.json it cannot read as a whole rather than reading no default", async () => {
    writeFileSync(join(agentDir, "settings.json"), "not json");
    await expect(store.readDefaults()).rejects.toThrow(/settings.json must be valid JSON/);
    await expect(store.writeDefaults({ defaultModel: null, defaultThinkingLevel: null }))
      .rejects.toThrow(/settings.json must be valid JSON/);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe("not json");
    writeFileSync(join(agentDir, "settings.json"), '{"defaultModel":"m"}');
    await expect(store.readDefaults()).rejects.toThrow(/defaultProvider and defaultModel together/);
    writeFileSync(join(agentDir, "settings.json"), '{"defaultThinkingLevel":"deep"}');
    await expect(store.readDefaults()).rejects.toThrow(/reasoning effort must be a level/);
  });

  it("queues behind a snapshot import so neither write lands on the other's bytes", async () => {
    writeFileSync(join(agentDir, "settings.json"), '{"defaultThinkingLevel":"low"}');
    const importing = store.applySnapshot({
      files: { "SYSTEM.md": null, "AGENTS.md": null }, providers: {},
      defaultModel: { provider: "proxy", id: "from-sync" },
    });
    const editing = store.writeDefaults({ defaultModel: { provider: "proxy", id: "m" }, defaultThinkingLevel: "high" });
    await Promise.all([importing, editing]);
    expect(read()).toEqual({ defaultProvider: "proxy", defaultModel: "m", defaultThinkingLevel: "high" });
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

  it.each([
    { state: "missing", before: null },
    { state: "empty", before: "" },
    { state: "populated", before: JSON.stringify({ providers: { anthropic: { headers: { route: "one" } } } }) },
  ])("restores $state models.json when post-write validation fails", async ({ before }) => {
    const path = join(agentDir, "models.json");
    if (before !== null) writeFileSync(path, before);
    const invalid = new Error("invalid composed provider");
    await expect(store.setupProvider(
      { kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1" },
      async () => { throw invalid; },
    )).rejects.toBe(invalid);
    if (before === null) await expect(fs.readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["missing", "populated"])("reports rollback failures for %s models.json with the validation error", async (state) => {
    const path = join(agentDir, "models.json");
    if (state === "populated") writeFileSync(path, "{}");
    const invalid = new Error("invalid composed provider");
    const rollback = new Error("restore failed");
    await expect(store.setupProvider(
      { kind: "builtin", id: "anthropic", endpoint: "https://proxy.example/v1" },
      async () => {
        if (state === "missing") vi.spyOn(fs, "unlink").mockRejectedValueOnce(rollback);
        else vi.spyOn(fs, "rename").mockRejectedValueOnce(rollback);
        throw invalid;
      },
    )).rejects.toMatchObject({
      name: "AggregateError", message: `failed to restore ${path}`, errors: [invalid, rollback],
    });
    expect(JSON.parse(readFileSync(path, "utf8")).providers.anthropic.baseUrl).toBe("https://proxy.example/v1");
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

  it("carries an effort ceiling into the model's level map and back out of it", async () => {
    // A map the operator wrote by hand: the ceiling owns xhigh and max, the
    // rest of it is none of the Console's business.
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { "my-proxy": { models: [{ id: "reasoner", thinkingLevelMap: { off: null } }] } },
    }));
    const save = (effort?: "high" | "xhigh" | "max") =>
      store.setupProvider({
        kind: "custom",
        id: "my-proxy",
        endpoint: "https://llm.example/v1",
        api: "openai-completions",
        models: [{ id: "reasoner", reasoning: true, ...(effort ? { effort } : {}) }],
      });
    const stored = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers["my-proxy"].models[0];

    await save("max");
    expect(stored().thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });
    expect((await store.providerStructures())["my-proxy"]?.models).toEqual([
      { id: "reasoner", reasoning: true, effort: "max" },
    ]);

    await save("xhigh");
    expect(stored().thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh" });
    expect((await store.providerStructures())["my-proxy"]?.models).toEqual([
      { id: "reasoner", reasoning: true, effort: "xhigh" },
    ]);

    // Back to the default ceiling: the two levels go, the hand-written rest stays.
    await save();
    expect(stored().thinkingLevelMap).toEqual({ off: null });
    expect((await store.providerStructures())["my-proxy"]?.models).toEqual([
      { id: "reasoner", reasoning: true },
    ]);
  });

  it("refuses an effort ceiling on a model that does not reason", async () => {
    await expect(store.setupProvider({
      kind: "custom",
      id: "my-proxy",
      endpoint: "https://llm.example/v1",
      api: "openai-completions",
      models: [{ id: "chat", reasoning: false, effort: "max" }],
    })).rejects.toThrow(/effort requires reasoning/);
  });
});
