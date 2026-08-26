import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIBRARIAN_CRON, LIBRARIAN_NAME, librarianPrompt } from "./librarian.js";

describe("the librarian's identity", () => {
  it("reads the prompt from the markdown beside the module, not from a copy", () => {
    const prompt = librarianPrompt();
    expect(prompt.startsWith("# Bus librarian")).toBe(true);
    // The .md is the only canonical copy — this is the assertion that fails if
    // someone inlines a second one and lets the two drift.
    expect(prompt).toBe(readFileSync(new URL("librarian-prompt.md", import.meta.url), "utf8"));
    // The three rules docs/bus.md promises the prompt carries.
    for (const rule of ["peek: true", "librarian-summary", ".librarian/proposals/"]) {
      expect(prompt).toContain(rule);
    }
  });

  it("is shipped by the build, not only by tsc", () => {
    // tsc copies no .md into dist/, so without this line an installed Pier has
    // a librarian whose prompt is missing — and the first sign of it would be a
    // failed click in production.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:assets"]).toContain("src/bus/librarian-prompt.md dist/bus/");
  });

  it("names a five-field cron the task layer accepts", () => {
    expect(LIBRARIAN_CRON.split(" ")).toHaveLength(5);
    // The marker detection is keyed on: a rename is a migration, not an edit.
    expect(LIBRARIAN_NAME).toBe("bus-librarian");
  });
});
