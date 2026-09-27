// Where a chat reference opens the Files dialog: the rule that decides whether
// the tree around a file is the project's or only its own folder; and a
// Markdown file shown rendered, its own links and images kept in Files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, installPage, type FakeDocument } from "./dom.testkit.js";
import { pathTarget, resolveRef } from "./explorer.js";

// The sanitizer and the highlighter want a real DOM; what they add is theirs to test.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("./highlight.js", () => ({ highlightCode: async () => {}, langFor: async () => null, lineEl: (t: string) => Object.assign(document.createElement("span"), { textContent: t }) }));

describe("pathTarget", () => {
  it("opens a path under the session's cwd in the project, the path selected", () => {
    expect(pathTarget("/work/pier", "/work/pier/src/a.ts")).toEqual({ root: "/work/pier", select: "src/a.ts" });
    expect(pathTarget("/work/pier", "/work/pier/src")).toEqual({ root: "/work/pier", select: "src" });
    expect(pathTarget("/work/pier", "/work/pier")).toEqual({ root: "/work/pier" });
  });

  it("opens anything else in its own folder", () => {
    expect(pathTarget("/work/pier", "/work/pier-other/a.ts")).toEqual({ root: "/work/pier-other", select: "a.ts" }); // a sibling, not a child
    expect(pathTarget("", "/tmp/run.log")).toEqual({ root: "/tmp", select: "run.log" });
    expect(pathTarget("/work", "/etc")).toEqual({ root: "/", select: "etc" });
  });
});

describe("resolveRef", () => {
  const ref = (r: string) => resolveRef("/w", "/w/docs", r);

  it("resolves a document's own paths from its folder, a leading / from the project", () => {
    expect(ref("img/a.png")).toBe("/w/docs/img/a.png");
    expect(ref("./b.md#usage")).toBe("/w/docs/b.md");
    expect(ref("../src/x.ts?plain=1")).toBe("/w/src/x.ts");
    expect(ref("/README.md")).toBe("/w/README.md");
    expect(ref("/w/docs/c.md")).toBe("/w/docs/c.md"); // already under the project
    expect(ref("my%20notes.md")).toBe("/w/docs/my notes.md");
    expect(ref("../../../../etc/hosts")).toBe("/etc/hosts");
    expect(resolveRef("/", "//etc", "hosts")).toBe("/etc/hosts"); // a tree rooted at /
    expect(resolveRef("/", "/", "/etc/hosts")).toBe("/etc/hosts");
    expect(ref("\\\\evil.dev/x.png")).toBe("/w/docs/\\\\evil.dev/x.png"); // a backslash host stays a path
  });

  it("leaves URLs and anchors alone", () => {
    for (const r of ["https://x.dev/a.png", "mailto:a@b", "data:image/png;base64,AA", "//cdn/x", "#usage", ""]) {
      expect(ref(r)).toBeNull();
    }
  });
});

describe("a Markdown file in Files", () => {
  const files: Record<string, string> = {
    "docs/guide.md": "# Guide\n\n## Set up\n\n![shot](img/a.png) [next](next.md) [site](https://x.dev) [up](#set-up)\n\n```ts\nconst a = 1;\n```\n",
    "docs/next.md": "# Next\n",
  };
  let doc: FakeDocument;
  let explorer: typeof import("./explorer.js");
  const urls: string[] = [];
  let repo = false;
  const settled = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0)); };
  const viewer = () => doc.querySelector("#files-dialog")!.querySelector(".md");

  beforeEach(async () => {
    vi.resetModules();
    urls.length = 0;
    repo = false;
    doc = installPage();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => f());
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      if (url.startsWith("/api/explorer/git")) return Response.json({ branch: repo ? "main" : null, refs: [], commits: [], worktrees: [] });
      if (url.startsWith("/api/explorer/diff")) {
        return q.get("file")
          ? Response.json({ diff: "--- a/docs/next.md\n+++ b/docs/next.md\n@@ -1,2 +1,2 @@\n-# Old\n+# Next\n more\n" })
          : Response.json({ files: [{ status: "M", path: "docs/next.md", add: 1, del: 1 }] });
      }
      if (url.startsWith("/api/fs/ls")) {
        const dir = q.get("path") ?? "";
        const names = Object.keys(files).filter((p) => p.startsWith(dir ? `${dir}/` : "")).map((p) => p.slice(dir ? dir.length + 1 : 0));
        const entries = [...new Set(names.map((n) => n.split("/")[0]!))].map((n) => ({ name: n, dir: names.includes(n) ? false : true }));
        return Response.json({ entries });
      }
      const body = files[q.get("path") ?? ""];
      return body === undefined ? Response.json({ error: "no" }, { status: 404 }) : new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }));
    explorer = await import("./explorer.js");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders by default, its image from disk beside it, its link opening in Files", async () => {
    explorer.openFiles({ id: "s", cwd: "/w" }, "/w", "docs/guide.md");
    await settled();
    const md = viewer()!;
    expect(md.querySelector("h1")!.textContent).toBe("Guide");
    expect(md.querySelector("img")!.getAttribute("src")).toBe(`/api/fs/file?${new URLSearchParams({ root: "/w", path: "docs/img/a.png" })}`);
    expect(md.querySelector("pre")!.parentNode!.querySelector("button")!.textContent).toBe("Copy");
    const [next, site, anchor] = md.querySelectorAll("a");
    expect((site as unknown as HTMLAnchorElement).target).toBe("_blank");
    expect(next!.getAttribute("href")).toBe(`/api/fs/file?${new URLSearchParams({ root: "/w", path: "docs/next.md" })}`);
    const click = () => ({ button: 0, preventDefault: vi.fn() });
    const hash = click();
    anchor!.onclick!(hash as never); // the page's hash is the router's
    expect(hash.preventDefault).toHaveBeenCalled();
    next!.onclick!(click() as never);
    await settled();
    expect(viewer()!.querySelector("h1")!.textContent).toBe("Next");
  });

  it("shows the numbered source on Source, and stays there for the next file", async () => {
    explorer.openFiles({ id: "s", cwd: "/w" }, "/w", "docs/guide.md");
    await settled();
    const dialog = doc.querySelector("#files-dialog")!;
    button(dialog, "Source")!.onclick!(null as never);
    await settled();
    expect(viewer()).toBeNull();
    expect(dialog.querySelector('[data-line="1"]')!.textContent).toContain("# Guide");
    explorer.openFiles({ id: "s", cwd: "/w" }, "/w", "docs/next.md");
    await settled();
    expect(viewer()).toBeNull();
    expect(button(dialog, "Source")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens on the source when a reference names a line", async () => {
    explorer.openFiles({ id: "s", cwd: "/w" }, "/w", "docs/guide.md", 3);
    await settled();
    expect(viewer()).toBeNull();
    expect(doc.querySelector("#files-dialog")!.querySelector('[data-line="3"]')).not.toBeNull();
  });

  it("renders a changed file at the diff's head, and Source is the toned diff", async () => {
    repo = true;
    explorer.openFiles({ id: "s", cwd: "/w" }, "/w", "docs/next.md");
    await settled();
    const md = viewer()!;
    expect(md.querySelectorAll("h1").map((el) => el.textContent)).toEqual(["Next"]);
    expect(urls.some((u) => u.startsWith("/api/explorer/diff") && u.includes("file="))).toBe(true);
    const dialog = doc.querySelector("#files-dialog")!;
    button(dialog, "Source")!.onclick!(null as never);
    await settled();
    expect(viewer()).toBeNull();
    expect(dialog.querySelectorAll(".bg-red-50").map((el) => el.textContent)).toEqual([expect.stringContaining("# Old")]);
  });
});
