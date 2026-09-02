import { describe, expect, it } from "vitest";
import { cjkFriendly, compact, formatTurnMeta, silentReason, splitReply, stableBlockEnd, streamBody, surfacePrompt } from "./reply.js";

describe("next-step block", () => {
  it("splits a separated button row off the text", () => {
    expect(splitReply("Done.\n\n---\n[Ship it] | [Review first] | [Undo]")).toEqual({
      text: "Done.",
      suggestions: ["Ship it", "Review first", "Undo"],
    });
  });

  it("accepts a full-width pipe and stray whitespace", () => {
    expect(splitReply("ok\n---\n  [ 好的 ] ｜ [算了]  \n").suggestions).toEqual(["好的", "算了"]);
  });

  it("caps at five options", () => {
    const row = "[a] | [b] | [c] | [d] | [e] | [f]";
    expect(splitReply(`x\n---\n${row}`).suggestions).toHaveLength(5);
  });

  it("leaves plain text, reference links and horizontal rules alone", () => {
    for (const text of [
      "just an answer",
      "see\n\n---\n[the docs](https://example.com)",
      "a\n\n---\n\nb",
      "note [bracketed] words",
    ]) {
      expect(splitReply(text)).toEqual({ text, suggestions: [] });
    }
  });
});

describe("an options-only turn", () => {
  it("parses a block that is the whole message", () => {
    expect(splitReply("---\n[土豆火腿焖饭] | [韩式拌饭] | [酸辣粉]")).toEqual({
      text: "",
      suggestions: ["土豆火腿焖饭", "韩式拌饭", "酸辣粉"],
      meta: undefined,
    });
  });

  it("still needs the rule line, so a bare bracket row is content", () => {
    expect(splitReply("[not an option]").suggestions).toEqual([]);
  });
});

describe("turn stats", () => {
  it("is worded once for every surface", () => {
    expect(formatTurnMeta({ completedAt: 0, durationMs: 1240, tokens: 940 })).toBe("1s · 940 tok");
    expect(formatTurnMeta({ completedAt: 0, durationMs: 45_000, tokens: 4560 })).toBe("45s · 4.6K tok");
    expect(formatTurnMeta({ completedAt: 0, durationMs: 74_300, tokens: 32_140 })).toBe("1m14s · 32K tok");
    // Floored at a second: a turn is never reported as "0s".
    expect(formatTurnMeta({ completedAt: 0, durationMs: 40, tokens: 0 })).toBe("1s · 0 tok");
  });
});

describe("compact counts", () => {
  it("never claims a decimal it does not have", () => {
    expect(compact(940)).toBe("940");
    expect(compact(1200)).toBe("1.2K");
    expect(compact(4560)).toBe("4.6K");
    // 9_990 rounds to 10; "10.0K" would be a fake decimal.
    expect(compact(9990)).toBe("10K");
    expect(compact(12_000)).toBe("12K");
    expect(compact(32_140)).toBe("32K");
  });
});

describe("staying silent", () => {
  it("drops a silent-only turn to nothing, so adapters post nothing", () => {
    // The adapters already treat an empty turn as "settled with nothing to
    // say", so silence needs no new concept below this line.
    expect(splitReply("<silent>two humans talking</silent>")).toMatchObject({
      text: "",
      suggestions: [],
    });
  });

  it("keeps the visible part when the agent both spoke and annotated", () => {
    expect(splitReply("<silent>noted</silent>\n\nOn it.").text).toBe("On it.");
  });

  it("strips several blocks, case-insensitively", () => {
    expect(splitReply("<SILENT>a</SILENT>x<silent>b</silent>").text).toBe("x");
  });

  it("still finds the options block after stripping", () => {
    const reply = splitReply("<silent>ctx</silent>\nPick one\n\n---\n[Yes] | [No]");
    expect(reply.text).toBe("Pick one");
    expect(reply.suggestions).toEqual(["Yes", "No"]);
  });

  it("leaves an unclosed tag alone rather than eating the reply", () => {
    expect(splitReply("<silent>oops").text).toBe("<silent>oops");
  });
});

describe("silentReason", () => {
  it("hands the reason to the workbench, which is the operator's own view", () => {
    expect(silentReason("<silent>two humans talking</silent>")).toBe("two humans talking");
  });

  it("joins several blocks", () => {
    expect(silentReason("<silent>a</silent>x<silent>b</silent>")).toBe("a · b");
  });

  it("is undefined when there is nothing to explain", () => {
    expect(silentReason("hello")).toBeUndefined();
    expect(silentReason("<silent>  </silent>")).toBeUndefined();
  });

  it("does not leave regex state behind between calls", () => {
    // A /g regex reused with exec would skip every other call.
    const raw = "<silent>why</silent>";
    expect(silentReason(raw)).toBe("why");
    expect(silentReason(raw)).toBe("why");
    expect(splitReply(raw).text).toBe("");
  });
});

describe("cjkFriendly", () => {
  it("is applied by splitReply, so every surface benefits", () => {
    // Slack's parser and the web's `marked` fail on different halves of the
    // same rule; repairing it once here covers both.
    expect(splitReply('**"怎么做"**：x').text).toBe('"**怎么做**"：x');
  });

  it("closes a bold run whose quotes sit against CJK punctuation", () => {
    // The reported bug: rendered as literal ** on both sides.
    expect(cjkFriendly('**"怎么做一个编程助手"**：')).toBe('"**怎么做一个编程助手**"：');
  });

  it("leaves a run that already closes alone", () => {
    expect(cjkFriendly("**闲聊 + 边界**：")).toBe("**闲聊 + 边界**：");
    expect(cjkFriendly("**bold** and more")).toBe("**bold** and more");
  });

  it("lifts fullwidth brackets too", () => {
    expect(cjkFriendly("**（括号）**文字")).toBe("（**括号**）文字");
  });

  it("never rewrites asterisks inside code", () => {
    expect(cjkFriendly('```\n**"x"**：\n```')).toBe('```\n**"x"**：\n```');
    expect(cjkFriendly('`**"x"**：`')).toBe('`**"x"**：`');
  });

  it("leaves a run that is only punctuation", () => {
    expect(cjkFriendly('**"**')).toBe('**"**');
  });

  it("handles several runs in one line", () => {
    expect(cjkFriendly('**"a"**、**"b"**')).toBe('"**a**"、"**b**"');
  });
});

describe("the instance facts in the surface prompt", () => {
  it("names the real boards folder and both board routes", () => {
    const prompt = surfacePrompt({
      boardsDir: "/home/q/.pier_test/boards",
      publicUrl: "https://test-pier.example.com",
    });
    expect(prompt).toContain("/home/q/.pier_test/boards/<slug>/");
    expect(prompt).toContain("https://test-pier.example.com");
    // Both routes, named once each — the host is not repeated per route.
    expect(prompt).toContain("/boards/<slug>/");
    expect(prompt).toContain("/p/<slug>-<token>/");
    // The contract itself is still there — the facts are an appendix to it.
    expect(prompt).toContain("Pier chat surface");
  });

  it("says an unset address is unset, so nothing invents one", () => {
    const prompt = surfacePrompt({ boardsDir: "/home/q/.pier/boards", publicUrl: "" });
    expect(prompt).toContain("No public address is configured");
    expect(prompt).not.toContain("http");
  });
});

describe("the stable block boundary a streaming render keeps", () => {
  /** Replay `md` as a stream, collecting the prefixes that went stable. */
  function stream(md: string, step = 7): { chunks: string[]; tail: string } {
    let stable = 0;
    const chunks: string[] = [];
    for (let n = step; n <= md.length; n += step) {
      const cut = stableBlockEnd(md.slice(0, n), stable);
      if (cut > stable) {
        chunks.push(md.slice(stable, cut));
        stable = cut;
      }
    }
    return { chunks, tail: md.slice(stable) };
  }

  it("does not cut on a blank line inside a code fence", () => {
    const md = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter the block\nmore\n";
    // The only boundary is the blank line after the closing fence.
    expect(stableBlockEnd(md)).toBe(md.indexOf("after the block"));
    for (const chunk of stream(md).chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("does not cut a four-backtick fence on the triple fence it quotes", () => {
    const md = "````\n```\nx\n\ny\n```\n````\n\ntail\nmore\n";
    expect(stableBlockEnd(md)).toBe(md.indexOf("tail"));
  });

  it("does not cut tilde fences or close a fence on a code line", () => {
    for (const md of ["~~~js\na\n\nb\n~~~\n\ntail\n", "```js\na\n```not a close\n\nb\n```\n\ntail\n"]) {
      expect(stream(md, 1).chunks[0]).toBe(md.slice(0, md.indexOf("tail")));
    }
  });

  it("does not keep DOM from inside a silent block", () => {
    const open = "before\n\n<silent>private\n\nreason\n";
    expect(stableBlockEnd(open)).toBe(open.indexOf("<silent>"));
    const md = `${open}</silent>\n\nafter\n`;
    for (const chunk of stream(md, 1).chunks) {
      expect((chunk.match(/<silent>/gi) ?? []).length).toBe((chunk.match(/<\/silent>/gi) ?? []).length);
    }
    const fenced = "```\n<silent> is code\n```\n\nafter\n";
    expect(stableBlockEnd(fenced)).toBe(fenced.indexOf("after"));
  });

  it("claims nothing until a block is closed by a line that follows it", () => {
    expect(stableBlockEnd("a paragraph that is still growing")).toBe(0);
    expect(stableBlockEnd("a paragraph\n\n")).toBe(0); // the next block hasn't arrived
    expect(stableBlockEnd("a paragraph\n\nthe next one\n")).toBe("a paragraph\n\n".length);
  });

  it("keeps a loose list, a split quote and an indented block whole", () => {
    for (const md of ["- one\n\n- two\n\n- three\n", "> a\n\n> b\n", "    code\n\n    more\n", "- item\n\n  its second paragraph\n"]) {
      expect(stableBlockEnd(md)).toBe(0);
    }
  });

  it("cuts where a list really ends", () => {
    const md = "- one\n- two\n\nA paragraph after the list.\n";
    expect(stableBlockEnd(md)).toBe(md.indexOf("A paragraph"));
  });

  it("loses no text, and never moves a boundary back", () => {
    const md = "# Title\n\nIntro para.\n\n```py\nx = 1\n\ny = 2\n```\n\n- a\n- b\n\nEnd.\n";
    const { chunks, tail } = stream(md, 3);
    expect(chunks.join("") + tail).toBe(md);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("renders as one piece: the chunks' markdown equals the whole text's", async () => {
    // The contract is exactly this — a boundary may only be claimed where
    // parsing the two sides separately renders what parsing them together
    // does — so the test parses, with the renderer the web chat uses.
    const { marked } = await import("marked");
    const md = "# Title\n\nIntro **para** with `code`.\n\n```py\nx = 1\n\ny = 2\n```\n\n- a\n- b\n\n> quote\n\nEnd.\n";
    const { chunks, tail } = stream(md, 5);
    const piecewise = [...chunks, tail].map((p) => marked.parse(p, { async: false })).join("");
    const whole = marked.parse(md, { async: false });
    expect(piecewise.replace(/\s+/g, " ")).toBe(whole.replace(/\s+/g, " "));
  });

  it("leaves a next-step row that is not the turn's end as body text", () => {
    // splitReply would strip it, and it would come back on the final paint —
    // text that vanishes and returns mid-stream is worse than either.
    expect(streamBody("---\n[a] | [b]")).toBe("---\n[a] | [b]");
    expect(splitReply("---\n[a] | [b]").text).toBe("");
    expect(streamBody("said it\n<silent>nothing to add</silent>")).toBe("said it");
  });
});
