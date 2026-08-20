import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigScope } from "../core/types.js";
import { PiConfigStore } from "./config.js";

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
    expect(read.providers.anthropic.apiKey).toBe("sk-s…abcd");
    expect(read.providers.openai.apiKey).toBe("•••");
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

  it("stores a replaced key verbatim", async () => {
    const edited = JSON.parse(await store.readFile(GLOBAL, "models.json"));
    edited.providers.anthropic.apiKey = "sk-brand-new";
    await store.writeFile(GLOBAL, "models.json", JSON.stringify(edited));
    const onDisk = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(onDisk.providers.anthropic.apiKey).toBe("sk-brand-new");
  });

  it("rejects invalid JSON on write, passes broken files through on read", async () => {
    await expect(store.writeFile(GLOBAL, "models.json", "{oops")).rejects.toThrow(/valid JSON/);
    writeFileSync(join(agentDir, "models.json"), "{broken");
    expect(await store.readFile(GLOBAL, "models.json")).toBe("{broken");
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
      extensions: ["native-web/index.ts", "quiet.ts"],
      skills: [],
    });
    expect(await store.listResources(project)).toEqual({
      extensions: [],
      skills: ["greet/SKILL.md"],
    });
  });

  it("reads a resource and rejects path traversal", async () => {
    expect(await store.readResource(GLOBAL, "extensions", "quiet.ts")).toBe("export {}");
    expect(await store.readResource(project, "skills", "greet/SKILL.md")).toBe("# greet");
    await expect(store.readResource(GLOBAL, "extensions", "../models.json")).rejects.toThrow(
      /invalid resource path/,
    );
  });
});
