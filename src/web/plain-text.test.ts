import { describe, expect, it } from "vitest";
import { plainText } from "./plain-text.js";

describe("plainText", () => {
  it("drops the marks and keeps the words, one line per block", () => {
    expect(plainText("## 结论\n\n**Fileball** 用 `pier web` 打开 [链接](https://x.test)。\n\n- 一\n- 二")).toBe(
      "结论\nFileball 用 pier web 打开 链接。\n一\n二",
    );
  });

  it("reads a table as its rows, an image as its alt, and keeps escapes and code literal", () => {
    expect(plainText("| a | b |\n|---|---|\n| **1** | 2 |")).toBe("a · b\n1 · 2");
    expect(plainText("![图](/tmp/x.png) \\*not\\*")).toBe("图 *not*");
    expect(plainText("```\n**x**\n```")).toBe("**x**");
  });
});
