import { describe, expect, it } from "vitest";
import { cjkFriendly, compact, formatTurnMeta, silentReason, splitReply } from "./reply.js";

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
