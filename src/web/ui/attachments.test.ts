// What counts as a file reference in a reply. The rest of the plumbing needs a
// browser; this rule decides whether prose turns into a wrong link, so it is
// the part worth pinning.

import { describe, expect, it, vi } from "vitest";

// The module wires the lightbox and preview dialog at import; a stub element
// takes those assignments so the rule can be imported without a DOM.
vi.mock("./dom.js", async (orig) => ({
  ...(await orig<typeof import("./dom.js")>()),
  $: () => ({}) as HTMLElement,
}));

const { parseFileRef } = await import("./attachments.js");

describe("parseFileRef", () => {
  it("reads the path and the line it names", () => {
    expect(parseFileRef("src/web/ui/chat.ts:481")).toEqual({ path: "src/web/ui/chat.ts", line: 481 });
    expect(parseFileRef("chat.ts:481:12")).toEqual({ path: "chat.ts", line: 481 }); // column dropped
    expect(parseFileRef("AGENTS.md")).toEqual({ path: "AGENTS.md", line: undefined });
    expect(parseFileRef("/tmp/run.log")).toEqual({ path: "/tmp/run.log", line: undefined });
  });

  it("leaves code that only looks like a path alone", () => {
    expect(parseFileRef("marked.parse")).toBeNull(); // bare name, not a file extension
    expect(parseFileRef("res.text")).toBeNull();
    expect(parseFileRef("npm run build")).toBeNull();
    expect(parseFileRef("src/web/ui")).toBeNull(); // no extension: as likely a directory
    expect(parseFileRef("https://example.com/a.ts")).toBeNull();
    expect(parseFileRef("")).toBeNull();
  });
});
