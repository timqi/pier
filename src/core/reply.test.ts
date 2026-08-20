import { describe, expect, it } from "vitest";
import { splitReply } from "./reply.js";

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
