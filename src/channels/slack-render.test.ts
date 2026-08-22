// mrkdwn is markdown's near-miss: bold is the single star markdown uses for
// italic, so the translation has ordering hazards a golden test pins down.

import { describe, expect, it } from "vitest";
import {
  actions,
  chunk,
  MRKDWN_MAX,
  escapeMrkdwn,
  offeredLabel,
  sections,
  toMrkdwn,
} from "./slack-render.js";
import type { SlackBlock } from "./slack-api.js";

const textOf = (block: SlackBlock): string =>
  block.type === "section" ? block.text.text : "";

describe("toMrkdwn", () => {
  it("turns ** into one star without the italic pass eating it", () => {
    expect(toMrkdwn("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  it("keeps emphasis literal inside code", () => {
    expect(toMrkdwn("use `**not bold**` here")).toBe("use `**not bold**` here");
    expect(toMrkdwn("```\n**x**\n```")).toBe("```\n**x**\n```");
  });

  it("drops a fence's language hint rather than printing it", () => {
    expect(toMrkdwn("```ts\nconst a = 1;\n```")).toBe("```\nconst a = 1;\n```");
  });

  it("escapes the three characters Slack reserves, and only those", () => {
    expect(toMrkdwn("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    // Escaping happens before emphasis, so markup can only come from us.
    expect(toMrkdwn("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes inside code spans too, so a tag cannot leak", () => {
    expect(toMrkdwn("`<b>`")).toBe("`&lt;b&gt;`");
  });

  it("inverts a markdown link into Slack's order", () => {
    expect(toMrkdwn("[docs](https://example.com/a)")).toBe("<https://example.com/a|docs>");
  });

  it("renders headings as bold and list markers as bullets", () => {
    expect(toMrkdwn("## Title\n- one\n- two")).toBe("*Title*\n• one\n• two");
  });

  it("leaves a bare asterisk alone instead of opening emphasis", () => {
    expect(toMrkdwn("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("chunk", () => {
  it("keeps a short turn in one piece", () => {
    expect(chunk("hello", MRKDWN_MAX)).toEqual(["hello"]);
  });

  it("splits on a blank line and loses no text", () => {
    const body = `${"paragraph\n\n".repeat(400)}end`;
    const parts = chunk(body, MRKDWN_MAX);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 2800)).toBe(true);
    expect(parts.join("").replace(/\s/g, "")).toBe(body.replace(/\s/g, ""));
  });

  it("balances code fences across a cut, so a split block still renders", () => {
    // Slack does not auto-close a fence the way Telegram closes a tag: an odd
    // ``` swallows the rest of the message and the next chunk starts outside
    // the block, rendering code as prose.
    const code = "x".repeat(6000).replace(/(.{60})/g, "$1\n");
    const parts = chunk(toMrkdwn(`intro\n\n\`\`\`\n${code}\n\`\`\`\n\ntail`), MRKDWN_MAX);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect((part.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // The reopened fences are the only thing added; no code line is lost.
    expect(parts.join("\n").replace(/```/g, "").replace(/\s/g, ""))
      .toBe(`intro${"x".repeat(6000)}tail`);
  });

  it("leaves a balanced single chunk untouched", () => {
    const one = "```\ncode\n```";
    expect(chunk(one, MRKDWN_MAX)).toEqual([one]);
  });
});

describe("sections", () => {
  it("keeps a short reply in one block", () => {
    expect(sections("just one line")).toHaveLength(1);
  });

  it("gives each paragraph its own block, losing no text", () => {
    const body = Array.from({ length: 8 }, (_, i) => `paragraph ${i} ${"x".repeat(120)}`)
      .join("\n\n");
    const blocks = sections(body);
    expect(blocks).toHaveLength(8);
    expect(blocks.map(textOf).join("\n\n")).toBe(body);
  });

  it("does not pack paragraphs back into one tall block", () => {
    // Packing to fill a size budget is what reintroduces "Show more".
    expect(sections("one\n\ntwo\n\nthree")).toHaveLength(3);
  });

  it("folds the tail into the last block rather than dropping it", () => {
    const body = Array.from({ length: 60 }, (_, i) => `p${i}`).join("\n\n");
    const blocks = sections(body);
    expect(blocks.length).toBeLessThanOrEqual(45);
    // Every paragraph still reaches Slack; none is silently discarded.
    const joined = blocks.map(textOf).join("\n\n");
    for (let i = 0; i < 60; i++) expect(joined).toContain(`p${i}`);
  });

  it("returns nothing for empty text, so no empty block is sent", () => {
    expect(sections("")).toEqual([]);
    expect(sections("   ")).toEqual([]);
  });

  it("never splits a fenced block, even on the blank lines inside it", () => {
    const body = "intro\n\n```\nfirst\n\nsecond\n```\n\ntail";
    const blocks = sections(body);
    for (const block of blocks) {
      expect((textOf(block).match(/```/g) ?? []).length % 2).toBe(0);
    }
    // The blank line inside the fence is code, not a paragraph break.
    expect(blocks.some((b) => textOf(b).includes("first\n\nsecond"))).toBe(true);
  });

  it("keeps a long code block whole rather than capping it mid-fence", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const blocks = sections(`before\n\n\`\`\`\n${code}\n\`\`\``);
    const fenceBlock = blocks.find((b) => textOf(b).includes("```"))!;
    expect((textOf(fenceBlock).match(/```/g) ?? []).length).toBe(2);
    expect(textOf(fenceBlock)).toContain("line 39");
  });
});

describe("next-step buttons", () => {
  it("carries an index, never the label", () => {
    const row = actions(["取消部署并回滚到上一个版本", "Ship"]) as Extract<SlackBlock, { type: "actions" }>;
    expect(row.elements.map((e) => e.action_id)).toEqual(["sg:0", "sg:1"]);
  });

  it("reads a label back off the message's own blocks", () => {
    const row = actions(["Run it", "Show the diff"])!;
    expect(offeredLabel([row], "sg:1")).toBe("Show the diff");
  });

  it("returns nothing for a payload that is not ours, or no longer there", () => {
    const row = actions(["Run it"])!;
    expect(offeredLabel([row], "cfg:models:0")).toBeUndefined();
    expect(offeredLabel([row], "sg:9")).toBeUndefined();
    expect(offeredLabel(undefined, "sg:0")).toBeUndefined();
  });

  it("truncates a label past Slack's button cap instead of letting it cut mid-word", () => {
    const row = actions(["x".repeat(200)]) as Extract<SlackBlock, { type: "actions" }>;
    expect(row.elements[0]!.text.text).toHaveLength(75);
    expect(row.elements[0]!.text.text.endsWith("…")).toBe(true);
  });

  it("offers no row at all when the agent offered nothing", () => {
    expect(actions([])).toBeUndefined();
  });
});

describe("escapeMrkdwn", () => {
  it("is what every user-derived string reaching a send goes through", () => {
    expect(escapeMrkdwn('a <b> & "c"')).toBe('a &lt;b&gt; &amp; "c"');
  });
});
