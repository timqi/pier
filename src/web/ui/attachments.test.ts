// What counts as a file reference in a reply, and how the existence check is
// batched. The rest of the plumbing needs a browser; these decide whether prose
// turns into a wrong link or every link goes plain, so they are worth pinning.

import { describe, expect, it, vi } from "vitest";
import { installDom, type FakeElement } from "./dom.testkit.js";

// The module wires the lightbox at import; a stub element
// takes those assignments so the rule can be imported without a DOM.
vi.mock("./dom.js", async (orig) => ({
  ...(await orig<typeof import("./dom.js")>()),
  $: () => ({}) as HTMLElement,
}));

const report = vi.fn();
vi.mock("./report.js", () => ({ report }));

const { parseFileRef, renderFileRefs } = await import("./attachments.js");

describe("parseFileRef", () => {
  it("reads the path and the line it names", () => {
    expect(parseFileRef("src/web/ui/chat.ts:481")).toEqual({ path: "src/web/ui/chat.ts", line: 481 });
    expect(parseFileRef("chat.ts:481:12")).toEqual({ path: "chat.ts", line: 481 }); // column dropped
    expect(parseFileRef("AGENTS.md")).toEqual({ path: "AGENTS.md", line: undefined });
    expect(parseFileRef("/tmp/run.log")).toEqual({ path: "/tmp/run.log", line: undefined });
  });

  it("takes a filesystem root without an extension — a folder is browsable", () => {
    expect(parseFileRef("~/.pier/boards")).toEqual({ path: "~/.pier/boards", line: undefined });
    expect(parseFileRef("~")).toEqual({ path: "~", line: undefined });
    expect(parseFileRef("/home/qiqi/code/dev")).toEqual({ path: "/home/qiqi/code/dev", line: undefined });
    expect(parseFileRef("/etc/hosts")).toEqual({ path: "/etc/hosts", line: undefined });
    expect(parseFileRef("/api/fs/ls")).toBeNull(); // a route, not a directory
    expect(parseFileRef("~foo")).toBeNull();
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

describe("the existence check", () => {
  it("asks in slices the route accepts, and a failed slice plains only its own paths", async () => {
    const doc = installDom();
    const asked: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const { paths } = JSON.parse(String(init?.body)) as { paths: string[] };
      asked.push(paths.length);
      if (asked.length === 2) return Response.json({ error: "paths required" }, { status: 400 });
      return Response.json({ exists: paths.map(() => true) });
    }));
    const codes = Array.from({ length: 1500 }, (_, i) => {
      const code = doc.createElement("code");
      code.textContent = `/w/f${String(i)}.ts`;
      return code;
    });
    renderFileRefs(codes as unknown as HTMLElement[], "h1", ["/w"]);
    const linked = () => codes.filter((c: FakeElement) => c.classList.contains("fileref")).length;
    await vi.waitFor(() => expect(linked()).toBe(1000));
    expect(asked).toEqual([1000, 500]);
    expect(codes.slice(1000).some((c) => c.classList.contains("fileref"))).toBe(false);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith("paths required");
    vi.unstubAllGlobals();
  });
});
