// The shared helpers whose output is a contract: the time wording two surfaces
// share (the age must read as a phrase beside a clock, not "now ago"), and
// chat markdown — CJK strong emphasis and the plain text an excerpt shows.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { agoLabel, markdownBox, plainText, stampTime } from "./dom.js";
import { installDom } from "./dom.testkit.js";

// The sanitizer wants a real DOM; what is under test is the parse in front of it.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

describe("stampTime", () => {
  // Built from local components, so the assertion holds in any TZ the suite runs in.
  const at = (...parts: [number, number, number, number, number, number]): number =>
    new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime();

  it("is a local wall clock, sortable and zero-padded", () => {
    expect(stampTime(at(2026, 7, 30, 19, 41, 7))).toBe("2026-08-30 19:41:07");
    expect(stampTime(at(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01 00:00:00");
  });
});

describe("agoLabel", () => {
  it("says the age as it reads beside a clock", () => {
    const ago = (ms: number): string => agoLabel(Date.now() - ms);
    expect(ago(0)).toBe("just now"); // not "now ago"
    expect(ago(12 * 60_000)).toBe("12m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("markdownBox's CJK strong emphasis", () => {
  beforeAll(() => installDom());
  const html = (md: string): string => markdownBox(md, false).innerHTML.replace(/^<p>|<\/p>\n?$/g, "");

  it("closes on CJK punctuation, which CommonMark's flanking rule refuses beside a letter", () => {
    expect(html("结论：**重要。**后面")).toBe("结论：<strong>重要。</strong>后面");
    expect(html("**加粗：**内容")).toBe("<strong>加粗：</strong>内容");
    expect(html("这是**“引用”**文字")).toBe("这是<strong>“引用”</strong>文字");
    expect(html("中文**（括号）**，后面")).toBe("中文<strong>（括号）</strong>，后面");
  });

  it("takes a code span as the run's edge, and keeps its asterisks", () => {
    expect(html("用**`code`**包")).toBe("用<strong><code>code</code></strong>包");
    expect(html("看**`x**y`**吧")).toBe("看<strong><code>x**y</code></strong>吧");
    expect(html("运行**`npm test`**")).toBe("运行<strong><code>npm test</code></strong>");
  });

  it("never touches code or escaped markers", () => {
    expect(html("`**中文：**内容`")).toBe("<code>**中文：**内容</code>");
    expect(html("\\*\\*不是粗体：\\*\\*文字")).toBe("**不是粗体：**文字");
    expect(markdownBox("```\n**中文：**内容\n```", false).querySelector("strong")).toBeNull();
  });

  it("leaves standard emphasis to the standard rule", () => {
    expect(html("a **b** c")).toBe("a <strong>b</strong> c");
    expect(html("**Note:**English")).toBe("**Note:**English");
    expect(html("2 ** 3 ** 4")).toBe("2 ** 3 ** 4");
    expect(html("***粗斜***文")).toBe("<em><strong>粗斜</strong></em>文");
    expect(html("**a *斜* 中**")).toBe("<strong>a <em>斜</em> 中</strong>");
  });
});

it("puts a chat table in its own scroll box and leaves a file's table as written", () => {
  installDom();
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const scroll = markdownBox(table, false).children[0]!;
  expect(scroll.className).toBe("table-scroll");
  // A scroll box a keyboard can reach and a screen reader can name.
  expect([scroll.getAttribute("tabindex"), scroll.getAttribute("role"), scroll.getAttribute("aria-label")]).toEqual(["0", "region", "Table"]);
  expect(markdownBox(table, false).children[0]!.querySelector("td")!.textContent).toBe("1");
  expect(markdownBox(table).children[0]!.localName).toBe("table");
});

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
