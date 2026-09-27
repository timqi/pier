// Where a chat reference opens the Files dialog: the rule that decides whether
// the tree around a file is the project's or only its own folder.

import { describe, expect, it } from "vitest";
import { pathTarget } from "./explorer.js";

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
