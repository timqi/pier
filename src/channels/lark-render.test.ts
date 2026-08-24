// Renderer golden tests: what a reply's markdown, buttons and footer become as
// card elements, and the degenerate shapes (split fences, unknown keys) that
// broke other adapters.

import { describe, expect, it } from "vitest";
import { button, chunk, footer, markdown, withFooter } from "./lark-render.js";

describe("chunk", () => {
  it("returns short text whole", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  it("re-balances a code fence split across the cut", () => {
    const code = "```\n" + "line\n".repeat(30) + "```";
    const parts = chunk(code, 80);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Every chunk is fence-balanced on its own, so no chunk leaks a block.
      expect((part.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("prefers a paragraph break", () => {
    const text = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
    expect(chunk(text, 60)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("a four-backtick fence is not closed by the triple fence it quotes", () => {
    const outer = "````\n" + "```\ninner\n```\n" + "pad\n".repeat(20) + "````";
    const parts = chunk(outer, 60);
    expect(parts.length).toBeGreaterThan(1);
    // The first chunk must be re-closed with a four-backtick run — three
    // would leave the outer fence open and swallow the rest of the card.
    expect(parts[0]!.endsWith("````")).toBe(true);
    for (const part of parts.slice(1, -1)) {
      expect(part.startsWith("````")).toBe(true);
      expect(part.endsWith("````")).toBe(true);
    }
  });
});

describe("card shapes", () => {
  it("renders the footer as notation-sized grey markdown (schema 2.0 has no note)", () => {
    expect(footer("45s · 32K tok")).toEqual({
      tag: "markdown",
      content: "<font color='grey'>45s · 32K tok</font>",
      text_size: "notation",
    });
  });

  it("carries key, thread root and label in the value — the click's only memory", () => {
    const b = button("Run it", { key: "sg:0", root: "om_1", label: "Run it" });
    expect(b.behaviors).toEqual([
      { type: "callback", value: { key: "sg:0", root: "om_1", label: "Run it" } },
    ]);
    expect(b.text.content).toBe("Run it");
  });

  it("folds a footer into the body's own element, so no gap can render", () => {
    expect(withFooter("done", "45s · 1.2K tok")).toEqual(
      markdown("done\n<font color='grey'>45s · 1.2K tok</font>"),
    );
  });

  it("breaks out of a trailing list before the footer — lazy continuation glues it on", () => {
    for (const body of ["1. 麻辣烫：自由搭配", "- item", "> quoted", "| a | b |"]) {
      const el = withFooter(body, "11s · 8.3K tok");
      expect(el).toEqual(markdown(`${body}\n\n<font color='grey'>11s · 8.3K tok</font>`));
    }
  });

  it("truncates a long label rather than sending it whole", () => {
    const b = button("x".repeat(80), { key: "sg:0", root: "om_1" });
    expect(b.text.content.length).toBeLessThanOrEqual(60);
    expect(b.text.content.endsWith("…")).toBe(true);
  });
});

describe("truncation", () => {
  it("a truncated label still fits the value it travels in", () => {
    const long = "选".repeat(80);
    const b = button(long.slice(0, 59) + "…", { key: "sg:0", root: "om_1", label: long.slice(0, 59) + "…" });
    expect(JSON.stringify(b.behaviors![0]!.value).length).toBeLessThan(300);
  });
});
