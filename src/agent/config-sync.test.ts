import { existsSync, mkdtempSync, promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigSnapshot } from "../core/types.js";
import { PiConfigStore } from "./config.js";
import { normalizeAgentSnapshot } from "./config-sync.js";

let dir: string;
let store: PiConfigStore;
const empty = (): AgentConfigSnapshot => ({ files: { "SYSTEM.md": null, "AGENTS.md": null }, providers: {}, defaultModel: null });
const read = (name: string): string => readFileSync(join(dir, name), "utf8");
const write = (name: string, content: string): void => writeFileSync(join(dir, name), content);
const saveModels = (providers: object): void => write("models.json", JSON.stringify({ version: 1, providers }));
const models = () => JSON.parse(read("models.json"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pier-config-sync-"));
  store = new PiConfigStore(dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("snapshot export", () => {
  it("keeps direct SDK file reads on one version while a sync waits", async () => {
    write("SYSTEM.md", "before");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const opened = store.withSnapshot(async () => {
      entered = true;
      const first = read("SYSTEM.md");
      await held;
      return [first, read("SYSTEM.md")];
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const applied = store.applySnapshot({ ...empty(), files: { "SYSTEM.md": "after", "AGENTS.md": null } });
    release();
    expect(await opened).toEqual(["before", "before"]);
    await applied;
    expect(read("SYSTEM.md")).toBe("after");
  });

  it("distinguishes missing and empty global files without reading auth", async () => {
    expect(await store.exportSnapshot()).toEqual(empty());
    write("SYSTEM.md", "");
    write("AGENTS.md", "global rules");
    write("settings.json", "   ");
    write("auth.json", "private auth");
    expect(await store.exportSnapshot()).toEqual({
      files: { "SYSTEM.md": "", "AGENTS.md": "global rules" }, providers: {}, defaultModel: null,
    });
  });

  it("shares the default model pair and nothing else settings.json holds", async () => {
    write("settings.json", JSON.stringify({
      defaultProvider: "proxy", defaultModel: "m", defaultThinkingLevel: "high", shellPath: "/bin/local-zsh",
    }));
    expect(await store.exportSnapshot()).toEqual({ ...empty(), defaultModel: { provider: "proxy", id: "m" } });
  });

  it("fails closed on a settings.json it cannot read a default out of", async () => {
    write("settings.json", "not even JSON");
    await expect(store.exportSnapshot()).rejects.toThrow(/settings.json must be valid JSON/);
    write("settings.json", "[]");
    await expect(store.exportSnapshot()).rejects.toThrow(/settings.json must be valid JSON/);
    write("settings.json", JSON.stringify({ defaultModel: "m" }));
    await expect(store.exportSnapshot()).rejects.toThrow(/defaultProvider and defaultModel together/);
    write("settings.json", JSON.stringify({ defaultProvider: "proxy", defaultModel: " " }));
    await expect(store.exportSnapshot()).rejects.toThrow(/model id must be a non-empty trimmed string/);
  });

  it("shares metadata at any depth while dropping credentials and endpoints", async () => {
    const metadata = {
      id: "m", name: "Model", api: "openai-completions", reasoning: true,
      input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
      thinkingLevelMap: { off: null, high: "high" }, samplingParams: { temperature: 0.7 },
      compat: { forceAdaptiveThinking: true, allowedFallbackModels: [] },
      cost: {
        input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
        tiers: [{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 200000 }],
      },
    };
    saveModels({
      proxy: {
        name: "Proxy", api: "openai-completions", authHeader: true,
        baseUrl: "https://private-provider-url", apiKey: "!private-provider-secret",
        headers: { Authorization: "private-provider-header" },
        modelOverrides: { built: { reasoning: true, headers: { secret: "private-override" } } },
        models: [{
          ...metadata, baseUrl: "https://private-model-base-url",
          apiKey: "!private-model-key", headers: { Authorization: "private-model-header" },
          compat: { ...metadata.compat, nested: { headers: { secret: "private-compat" }, apiKey: "private-key" } },
        }],
      },
      "credential-only": { apiKey: "private-credential-only", baseUrl: "https://private-credential-only" },
    });
    const snapshot = await store.exportSnapshot();
    expect(snapshot).toEqual({ ...empty(), providers: { proxy: {
      name: "Proxy", api: "openai-completions", authHeader: true,
      modelOverrides: { built: { reasoning: true } },
      models: [{ ...metadata, compat: { ...metadata.compat, nested: {} } }],
    } } });
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(JSON.stringify(snapshot)).not.toContain("apiKey");
    expect(JSON.stringify(snapshot)).not.toContain("headers");
  });

  it("refuses to share a credential or endpoint that a metadata field repeats", async () => {
    saveModels({ proxy: { apiKey: "supersecretkey", models: [{ id: "m", name: "supersecretkey" }] } });
    await expect(store.exportSnapshot()).rejects.toThrow(/repeats a credential or endpoint/);
    saveModels({ proxy: { baseUrl: "https://gateway.example", models: [{ id: "m", docs: "see https://gateway.example" }] } });
    await expect(store.exportSnapshot()).rejects.toThrow(/repeats a credential or endpoint/);
    // Short dropped values are metadata everywhere; only long ones are a leak.
    saveModels({ proxy: { headers: { accept: "json" }, models: [{ id: "m", name: "json" }] } });
    expect((await store.exportSnapshot()).providers.proxy).toEqual({ models: [{ id: "m", name: "json" }] });
  });

  it("fails closed on malformed models.json and an unaddressable catalog", async () => {
    write("models.json", "{broken");
    await expect(store.exportSnapshot()).rejects.toThrow(/valid JSON/);
    saveModels({ proxy: { models: [{ name: "no id" }] } });
    await expect(store.exportSnapshot()).rejects.toThrow(/model id must be a non-empty trimmed string/);
    saveModels({ proxy: { models: { m: {} } } });
    await expect(store.exportSnapshot()).rejects.toThrow(/models must be an array/);
  });
});

describe("snapshot validation", () => {
  it("returns a detached value for valid snapshots", () => {
    const source = { ...empty(), providers: { proxy: { models: [{ id: "m", input: ["text"] as "text"[] }] } } };
    const normalized = normalizeAgentSnapshot(source);
    source.providers.proxy.models[0]!.input.push("text");
    expect(normalized.providers.proxy).toEqual({ models: [{ id: "m", input: ["text"] }] });
  });

  it.each([
    null, [], {}, { ...empty(), settings: {} },
    { ...empty(), files: { "SYSTEM.md": null } },
    { ...empty(), files: { ...empty().files, "settings.json": "secret" } },
    { ...empty(), files: { ...empty().files, "SYSTEM.md": 1 } },
    { ...empty(), providers: [] },
    { ...empty(), providers: { proxy: { models: [], apiKey: "masked" } } },
    { ...empty(), providers: { proxy: { models: [], headers: { Authorization: "masked" } } } },
    { ...empty(), providers: { proxy: { models: [], baseUrl: "https://local" } } },
    { ...empty(), providers: { proxy: { models: [], modelOverrides: { m: "bad" } } } },
    { ...empty(), providers: { proxy: { models: "bad" } } },
    { ...empty(), providers: { "../escape": { models: [] } } },
    JSON.parse('{"files":{"SYSTEM.md":null,"AGENTS.md":null},"providers":{"__proto__":{"models":[]}}}'),
  ])("rejects invalid envelope %#", (value) => {
    expect(() => normalizeAgentSnapshot(value)).toThrow();
  });

  it.each([
    {}, { provider: "proxy" }, { id: "m" }, { provider: "proxy", id: " " }, { provider: "proxy", id: 1 },
    { provider: "../escape", id: "m" }, { provider: "proxy", id: "m", thinking: "high" },
  ])("rejects an invalid default model %#", (value) => {
    expect(() => normalizeAgentSnapshot({ ...empty(), defaultModel: value })).toThrow();
  });

  it("keeps a stated default model and distinguishes it from an unstated one", () => {
    expect(normalizeAgentSnapshot({ ...empty(), defaultModel: { provider: "proxy", id: "m" } }).defaultModel)
      .toEqual({ provider: "proxy", id: "m" });
    expect(normalizeAgentSnapshot({ ...empty(), defaultModel: null }).defaultModel).toBeNull();
    const { files, providers } = empty();
    expect(normalizeAgentSnapshot({ files, providers })).not.toHaveProperty("defaultModel");
  });

  it.each([
    {}, { id: " " }, { id: 1 }, { id: "m", name: undefined },
    { id: "m", input: ["text", { apiKey: "secret" }] },
    { id: "m", apiKey: "masked" }, { id: "m", headers: { Authorization: "masked" } },
    { id: "m", baseUrl: "https://url" },
    { id: "m", compat: { headers: { secret: "value" } } },
    { id: "m", compat: { nested: [{ baseUrl: "https://url" }] } },
    { id: "m", cost: { input: { headers: "secret" }, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ])("rejects invalid model metadata %#", (model) => {
    expect(() => normalizeAgentSnapshot({ ...empty(), providers: { proxy: { models: [model] } } })).toThrow();
  });

  it("rejects duplicate model ids", () => {
    expect(() => normalizeAgentSnapshot({ ...empty(), providers: { proxy: { models: [{ id: "m" }, { id: "m" }] } } }))
      .toThrow(/duplicate/);
  });
});

describe("snapshot apply", () => {
  it("replaces the catalog, retains local credentials, and leaves settings/auth untouched", async () => {
    const transport = { baseUrl: "https://local-model", apiKey: "!local-key", headers: { token: "local-header" } };
    const provider = { name: "Local", api: "anthropic-messages", baseUrl: "https://local", apiKey: "local-key", headers: { token: "local" } };
    saveModels({ proxy: { ...provider,
      modelOverrides: { built: { reasoning: true, headers: { token: "local-override" } } },
      models: [{ id: "m", name: "old", reasoning: true, compat: { supportsStore: true }, ...transport }, { id: "removed" }],
    } });
    write("settings.json", '{"shellPath":"local-only"}');
    write("auth.json", '{"apiKey":"local-auth"}');
    await store.applySnapshot({
      files: { "SYSTEM.md": "new system", "AGENTS.md": "new agents" },
      providers: { proxy: {
        authHeader: true, modelOverrides: { built: { reasoning: false } },
        models: [{ id: "m", name: "New", maxTokens: 12 }, { id: "new" }],
      } },
    });
    // The source states authHeader and the catalog; name/api it never states
    // stay, credentials stay, and a model arrives whole (no local compat).
    expect(models()).toEqual({ version: 1, providers: { proxy: { ...provider, authHeader: true,
      modelOverrides: { built: { reasoning: false, headers: { token: "local-override" } } },
      models: [{ ...transport, id: "m", name: "New", maxTokens: 12 }, { id: "new" }],
    } } });
    expect(read("SYSTEM.md")).toBe("new system");
    expect(read("AGENTS.md")).toBe("new agents");
    expect(read("settings.json")).toBe('{"shellPath":"local-only"}');
    expect(read("auth.json")).toBe('{"apiKey":"local-auth"}');
  });

  it("imports the default model beside the local settings, and clears it on request", async () => {
    write("settings.json", JSON.stringify({ shellPath: "/bin/local-zsh", defaultProvider: "old", defaultModel: "old-m" }, null, 2));
    await store.applySnapshot({ ...empty(), defaultModel: { provider: "proxy", id: "m" } });
    expect(JSON.parse(read("settings.json"))).toEqual({
      shellPath: "/bin/local-zsh", defaultProvider: "proxy", defaultModel: "m",
    });
    // A source that states nothing leaves the pair as it is; `null` removes it.
    const { files, providers } = empty();
    const unchanged = read("settings.json");
    await store.applySnapshot({ files, providers });
    expect(read("settings.json")).toBe(unchanged);
    await store.applySnapshot(empty());
    expect(JSON.parse(read("settings.json"))).toEqual({ shellPath: "/bin/local-zsh" });
  });

  it("creates settings.json for an imported default and refuses to read a broken one", async () => {
    await store.applySnapshot({ ...empty(), defaultModel: { provider: "proxy", id: "m" } });
    expect(JSON.parse(read("settings.json"))).toEqual({ defaultProvider: "proxy", defaultModel: "m" });
    write("settings.json", "{broken");
    await expect(store.applySnapshot(empty())).rejects.toThrow(/settings.json must be valid JSON/);
    expect(read("settings.json")).toBe("{broken");
  });

  it("removes explicitly absent files and catalogs without removing local credentials", async () => {
    write("SYSTEM.md", "delete me");
    write("AGENTS.md", "delete me too");
    saveModels({
      proxy: { apiKey: "keep", baseUrl: "https://keep", name: "Keep", modelOverrides: { m: {} }, models: [{ id: "m" }] },
      onlymodels: { models: [{ id: "m" }] },
    });
    await store.applySnapshot(empty());
    expect(existsSync(join(dir, "SYSTEM.md"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(models()).toEqual({ version: 1, providers: { proxy: { apiKey: "keep", baseUrl: "https://keep", name: "Keep" }, onlymodels: {} } });
    await store.applySnapshot({ ...empty(), providers: { onlymodels: { models: [{ id: "restored" }] } } });
    expect(models().providers.onlymodels.models).toEqual([{ id: "restored" }]);
  });

  it("replaces model arrays with empty arrays", async () => {
    saveModels({ proxy: { apiKey: "keep", models: [{ id: "m" }] } });
    await store.applySnapshot({ ...empty(), providers: { proxy: { models: [] } } });
    expect(models().providers.proxy).toEqual({ apiKey: "keep", models: [] });
  });

  it("rejects missing local providers before changing any file", async () => {
    write("SYSTEM.md", "original");
    const commit = vi.fn();
    await expect(store.applySnapshot({
      files: { "SYSTEM.md": "replacement", "AGENTS.md": null },
      providers: { missing: { models: [{ id: "m" }] } },
    }, commit)).rejects.toThrow(/provider missing must be configured locally/);
    expect(read("SYSTEM.md")).toBe("original");
    expect(existsSync(join(dir, "models.json"))).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("validates typed callers too, without importing masks", async () => {
    const snapshot = { ...empty(), providers: { proxy: { models: [{ id: "m", apiKey: "masked" }] } } };
    await expect(store.applySnapshot(snapshot)).rejects.toThrow(/must not carry apiKey/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("calls commit once after all writes, including no-op imports", async () => {
    const snapshot = { ...empty(), files: { "SYSTEM.md": "new", "AGENTS.md": "agents" } };
    const commit = vi.fn(() => {
      expect(read("SYSTEM.md")).toBe("new");
      expect(read("AGENTS.md")).toBe("agents");
    });
    await store.applySnapshot(snapshot, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith(true);
    const writing = vi.spyOn(fs, "writeFile");
    const renaming = vi.spyOn(fs, "rename");
    await store.applySnapshot(snapshot, commit);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(false);
    expect(writing).not.toHaveBeenCalled();
    expect(renaming).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "models.json"))).toBe(false);
  });

  it("restores content and file absence after synchronous commit failure", async () => {
    write("SYSTEM.md", "old");
    saveModels({ proxy: { apiKey: "local", models: [{ id: "old" }] } });
    const raw = read("models.json");
    const commit = vi.fn(() => { throw new Error("DB commit failed"); });
    await expect(store.applySnapshot({
      files: { "SYSTEM.md": null, "AGENTS.md": "created" },
      providers: { proxy: { models: [{ id: "new" }] } },
    }, commit)).rejects.toThrow("DB commit failed");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(read("SYSTEM.md")).toBe("old");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(read("models.json")).toBe(raw);
    expect(readdirSync(dir).sort()).toEqual(["SYSTEM.md", "models.json"]);
  });

  it("restores prior writes when a later rename fails", async () => {
    write("SYSTEM.md", "old");
    write("AGENTS.md", "old agents");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(rename).mockRejectedValueOnce(new Error("rename failed"));
    const commit = vi.fn();
    await expect(store.applySnapshot({ ...empty(), files: { "SYSTEM.md": "new", "AGENTS.md": "new agents" } }, commit))
      .rejects.toThrow("rename failed");
    expect(read("SYSTEM.md")).toBe("old");
    expect(read("AGENTS.md")).toBe("old agents");
    expect(commit).not.toHaveBeenCalled();
    expect(readdirSync(dir).sort()).toEqual(["AGENTS.md", "SYSTEM.md"]);
  });

  it("does not change live files when staging fails", async () => {
    write("SYSTEM.md", "old");
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(writeFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(store.applySnapshot({ ...empty(), files: { "SYSTEM.md": "new", "AGENTS.md": "new agents" } }))
      .rejects.toThrow("disk full");
    expect(read("SYSTEM.md")).toBe("old");
    expect(readdirSync(dir)).toEqual(["SYSTEM.md"]);
  });

  it("reports rollback failures together with the original error", async () => {
    write("SYSTEM.md", "old");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(rename).mockRejectedValueOnce(new Error("restore failed"));
    const result = store.applySnapshot({ ...empty(), files: { "SYSTEM.md": "new", "AGENTS.md": null } }, () => {
      throw new Error("commit failed");
    });
    await expect(result).rejects.toMatchObject({
      message: "configuration import rollback failed",
      errors: [expect.objectContaining({ message: "commit failed" }), expect.objectContaining({ message: "restore failed" })],
    });
    await expect(store.withSnapshot(async () => "SDK read")).rejects.toThrow("rollback failed");
    await expect(store.exportSnapshot()).rejects.toThrow("rollback failed");
  });

  it("serializes imports, exports and existing writes through commit and rollback", async () => {
    write("SYSTEM.md", "old");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const setup = store.setupProvider({ kind: "builtin", id: "openai", endpoint: "https://local" }, async () => {
      entered();
      await gate;
    });
    await started;
    const commit = vi.fn(() => { throw new Error("rollback"); });
    const applying = store.applySnapshot({ ...empty(), files: { "SYSTEM.md": "bad", "AGENTS.md": null } }, commit);
    const rejected = expect(applying).rejects.toThrow("rollback");
    const editing = store.writeFile({ kind: "global" }, "SYSTEM.md", "after", "old");
    const exporting = store.exportSnapshot();
    expect(commit).not.toHaveBeenCalled();
    expect(read("SYSTEM.md")).toBe("old");
    release();
    await Promise.all([setup, rejected, editing]);
    expect((await exporting).files["SYSTEM.md"]).toBe("after");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(models().providers.openai.baseUrl).toBe("https://local");
  });
});
