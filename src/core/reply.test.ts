import { describe, expect, it } from "vitest";
import { compact, formatTurnMeta, openItemMarkers, originLabel, replyTopic, runModelLabel, silentReason, splitReply, saidText, stableBlockEnd, streamBody } from "./reply.js";

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

  it("still reads a tag the model salted with zero-width characters", () => {
    const mangled = "<s\u200B\u200Bilent>two humans</sil\uFEFFent>";
    expect(splitReply(mangled)).toMatchObject({ text: "", silence: "two humans" });
    expect(stableBlockEnd(`${mangled}\n\nOn it.\n\n`)).toBeGreaterThan(0);
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

describe("the CJK bold repair", () => {
  it("is applied by splitReply, so every surface benefits", () => {
    // Slack's parser and the web's `marked` fail on different halves of the
    // same rule; repairing it once here covers both.
    expect(splitReply('**"怎么做"**：x').text).toBe('"**怎么做**"：x');
  });

  it("closes a bold run whose quotes sit against CJK punctuation", () => {
    // The reported bug: rendered as literal ** on both sides.
    expect(streamBody('**"怎么做一个编程助手"**：')).toBe('"**怎么做一个编程助手**"：');
  });

  it("leaves a run that already closes alone", () => {
    expect(streamBody("**闲聊 + 边界**：")).toBe("**闲聊 + 边界**：");
    expect(streamBody("**bold** and more")).toBe("**bold** and more");
  });

  it("lifts fullwidth brackets too", () => {
    expect(streamBody("**（括号）**文字")).toBe("（**括号**）文字");
  });

  it("never rewrites asterisks inside code", () => {
    expect(streamBody('```\n**"x"**：\n```')).toBe('```\n**"x"**：\n```');
    expect(streamBody('`**"x"**：`')).toBe('`**"x"**：`');
  });

  it("leaves a run that is only punctuation", () => {
    expect(streamBody('**"**')).toBe('**"**');
  });

  it("handles several runs in one line", () => {
    expect(streamBody('**"a"**、**"b"**')).toBe('"**a**"、"**b**"');
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

  it("does not cut inside an open-item marker, and ignores one inside a fence", () => {
    const open = "before\n\n<open>a long\n\nproblem — stage\n";
    expect(stableBlockEnd(open)).toBe(open.indexOf("<open>"));
    expect(stableBlockEnd(`${open}</open>\n\nafter\n`)).toBe(`${open}</open>\n\n`.length);
    // A `</silent>` does not close an `<open>`.
    expect(stableBlockEnd("<done>x\n</silent>\n\nafter\n")).toBe(0);
    const fenced = "```\n<open> is code\n```\n\nafter\n";
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

describe("open-item markers", () => {
  it("strips both markers from what the user sees, zero-width characters included", () => {
    const raw = "Launched.\n<open>model menu — worker running (run r1)</open>\n<d\u200bone>60K rotation</done>\nMore.";
    expect(streamBody(raw)).toBe("Launched.\nMore.");
    expect(splitReply(`${raw}\n\n---\n[Ok]`)).toMatchObject({ text: "Launched.\nMore.", suggestions: ["Ok"] });
    expect(splitReply("<open>x — y</open>").text).toBe("");
  });

  it("parses an add with its runs, a replace, and a done, in reply order", () => {
    expect(openItemMarkers(
      "<open>open items 视图 — lead designing (run 1prwm) (RUN w2)</open>\n" +
      "<done>60K rotation</done>\n<open>open items 视图 — worker running</open>",
    )).toEqual({
      markers: [
        { op: "open", problem: "open items 视图", stage: "lead designing", runIds: ["1prwm", "w2"] },
        { op: "done", problem: "60K rotation" },
        { op: "open", problem: "open items 视图", stage: "worker running", runIds: [] },
      ],
      notes: [],
      dropped: [],
    });
  });

  it("a goal and its auto-continue count ride in the stage, text to the parser", () => {
    expect(openItemMarkers("<open>CI 修复 — worker running · until CI 绿并已合并 · auto 1/3 (run r2)</open>").markers).toEqual([
      { op: "open", problem: "CI 修复", stage: "worker running · until CI 绿并已合并 · auto 1/3", runIds: ["r2"] },
    ]);
  });

  it("reads a note as one line beside the items, stripped like them", () => {
    const raw = "Merged.\n<note>决定：审查默认用 balanced\n 不用 cheap</note>\n<done>CI 修复</done>";
    expect(openItemMarkers(raw)).toEqual({ markers: [{ op: "done", problem: "CI 修复" }], notes: ["决定：审查默认用 balanced 不用 cheap"], dropped: [] });
    expect(streamBody(raw)).toBe("Merged.");
  });

  it("keeps a parenthetical that is not a run token in the stage, and a stageless item", () => {
    expect(openItemMarkers("<open>review\n src/auth — proposed (not applied)</open><open>just a problem</open>").markers).toEqual([
      { op: "open", problem: "review src/auth", stage: "proposed (not applied)", runIds: [] },
      { op: "open", problem: "just a problem", stage: "", runIds: [] },
    ]);
  });

  it("drops a marker with no problem text and leaves the reply otherwise untouched", () => {
    const raw = "Hi.\n<open> — stage (run r1)</open><done> </done><note> </note>";
    expect(openItemMarkers(raw)).toEqual({ markers: [], notes: [], dropped: ["<open> — stage (run r1)</open>", "<done> </done>", "<note> </note>"] });
    expect(streamBody(raw)).toBe("Hi.");
  });

  it("never reads or strips a marker inside a fence or a code span", () => {
    const raw = "Syntax:\n\n```\n<open>problem — stage</open>\n```\n~~~\n<done>p</done>\n~~~\n<done>real</done>";
    expect(openItemMarkers(raw).markers).toEqual([{ op: "done", problem: "real" }]);
    expect(streamBody(raw)).toBe("Syntax:\n\n```\n<open>problem — stage</open>\n```\n~~~\n<done>p</done>\n~~~");
    // A fence still streaming is code until it closes.
    expect(streamBody("```\n<open>a — b</open>")).toBe("```\n<open>a — b</open>");
    const inline = "Write `<done>p</done>` when it lands.";
    expect(openItemMarkers(inline).markers).toEqual([]);
    expect(streamBody(inline)).toBe(inline);
    const holding = "<open>run `x` — stage</open>\nHi.";
    expect(openItemMarkers(holding).markers).toEqual([{ op: "open", problem: "run `x`", stage: "stage", runIds: [] }]);
    expect(streamBody(holding)).toBe("Hi.");
  });

  it("reads a reply's topic: the `<topic>` body, else the first item marker's problem", () => {
    const tagged = "Still running.\n<topic>CI 修复</topic>";
    expect(replyTopic(tagged)).toBe("CI 修复");
    expect(openItemMarkers(tagged)).toEqual({ markers: [], notes: [], topic: "CI 修复", dropped: [] });
    expect(streamBody(tagged)).toBe("Still running.");
    expect(saidText(tagged)).toBe("Still running.");
    expect(replyTopic("<done>60K rotation</done><open>menu — running</open>")).toBe("60K rotation");
    expect(replyTopic("<open>menu — running</open><topic>60K rotation</topic>")).toBe("60K rotation");
    expect(replyTopic("Hi.")).toBeUndefined();
    expect(openItemMarkers("<topic> </topic>")).toEqual({ markers: [], notes: [], dropped: ["<topic> </topic>"] });
    expect(replyTopic("Write `<topic>x</topic>` on it.")).toBeUndefined();
  });

  it("a lone tag in a code span does not pair with the real marker after it", () => {
    // The live reply: a quoted `<done>` early, the real marker on the last line.
    const done = "改好了，片段里已经没有 `<done>` 和按钮行了。\n\n<done>pier search 输出精简</done>";
    expect(openItemMarkers(done).markers).toEqual([{ op: "done", problem: "pier search 输出精简" }]);
    expect(streamBody(done)).toBe("改好了，片段里已经没有 `<done>` 和按钮行了。");
    expect(saidText(done)).toBe("改好了，片段里已经没有 `<done>` 和按钮行了。");
    const open = "用 `<open>` 记一项。\n<open>搜索精简 — worker running (run r1)</open>";
    expect(openItemMarkers(open).markers).toEqual([
      { op: "open", problem: "搜索精简", stage: "worker running", runIds: ["r1"] },
    ]);
    expect(streamBody(open)).toBe("用 `<open>` 记一项。");
  });
});

describe("originLabel", () => {
  it("names a seed by its reason and a chat command by its word, not as a task callback", () => {
    expect(originLabel({ kind: "session-seed", reason: "idle", previousSessionId: "h1" })).toBe("↺ new session · idle");
    expect(originLabel({ kind: "session-seed", reason: "first", previousSessionId: null })).toBe("↺ new session · first");
    expect(originLabel({ kind: "chat-command", command: "status" })).toBe("/status");
    expect(originLabel({ kind: "task-callback", taskId: "t", runId: "r", sourceSessionId: null })).toBe("↩ task callback");
  });

  it("names a run's tier, model and level apart from the label, each part only when recorded", () => {
    const model = { provider: "openai", id: "gpt-5" };
    const origin = { kind: "task-callback" as const, taskId: "t", runId: "r", sourceSessionId: null, source: { taskName: "x", tier: "balanced" as const, model } };
    expect(originLabel(origin)).toBe("↩ task callback");
    expect(runModelLabel({ tier: "balanced", model, thinking: "medium" })).toBe("balanced · gpt-5 · medium");
    expect(runModelLabel({ model, thinking: "high" })).toBe("gpt-5 · high");
    expect(runModelLabel({})).toBe("");
    expect(runModelLabel({ thinking: "low" })).toBe("low");
  });
});

describe("saidText", () => {
  it("takes off silent, open-item markers and the next-step block, and nothing else", () => {
    const reply = "<open>parser — worker running (run r1)</open>\nThe **“parser”** is fixed.<silent>noted</silent>\n<done>old thing</done>\n\n---\n[Run it] | [Show the diff]";
    expect(saidText(reply)).toBe("The **“parser”** is fixed.");
    expect(saidText("see `<done>x</done>`\n\n---\nnot [a] block here")).toBe("see `<done>x</done>`\n\n---\nnot [a] block here");
  });
});
