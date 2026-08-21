import { describe, expect, it } from "vitest";
import { compact, formatTurnMeta, splitReply } from "./reply.js";

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
