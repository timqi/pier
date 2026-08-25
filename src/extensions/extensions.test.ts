// The list loads. Everything else here is unit-tested next to its own code;
// this is the one thing only Pi's real loader can answer — that a bundled
// extension imports, registers its tools and reports no error, which is how a
// broken import or a schema Pi refuses shows up before a session does.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BUNDLED, bundledInfo, inlineExtensions } from "./index.js";

describe("the bundled extensions", () => {
  it("load through Pi's own loader and register their tools", async () => {
    // Hermetic: an empty agent dir, so nothing on this machine is loaded too.
    const dir = mkdtempSync(join(tmpdir(), "pier-extensions-"));
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      extensionFactories: inlineExtensions(BUNDLED.map((ext) => ext.name)),
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((ext) => [ext.path, [...ext.tools.keys()]])).toEqual([
      ["<inline:web>", ["web_search", "web_fetch"]],
    ]);
    // The Console tells the operator which tools a switch adds and what each
    // needs; a renamed tool must not leave that page quietly lying.
    for (const ext of BUNDLED) {
      const registered = loaded.extensions.find((e) => e.path === `<inline:${ext.name}>`);
      expect([...(registered?.tools.keys() ?? [])].sort())
        .toEqual(ext.tools.map((tool) => tool.name).sort());
    }
  });

  it("hands surfaces names and summaries, and loads only what is switched on", () => {
    expect(bundledInfo([])).toEqual([
      {
        name: "web",
        summary: expect.stringContaining("hosted web tools"),
        tools: [
          { name: "web_search", needs: expect.stringContaining("Anthropic or OpenAI") },
          { name: "web_fetch", needs: expect.stringContaining("Anthropic") },
        ],
        enabled: false,
      },
    ]);
    expect(bundledInfo(["web"])[0]?.enabled).toBe(true);
    expect(inlineExtensions([])).toEqual([]);
    // A name from another release is not ours to load.
    expect(inlineExtensions(["something-else"])).toEqual([]);
  });
});
