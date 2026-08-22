import { describe, expect, it } from "vitest";
import { decide } from "./queue.js";

describe("queue policy", () => {
  it("idle → prompt regardless of mode", () => {
    expect(decide({ text: "hi", mode: "auto" }, "idle")).toEqual({ action: "prompt", text: "hi" });
    expect(decide({ text: "hi", mode: "steer" }, "idle")).toEqual({ action: "prompt", text: "hi" });
    expect(decide({ text: "hi", mode: "followUp" }, "idle")).toEqual({ action: "prompt", text: "hi" });
  });

  it("idle strips the ! prefix", () => {
    expect(decide({ text: "! do it", mode: "auto" }, "idle")).toEqual({ action: "prompt", text: "do it" });
  });

  it("streaming + auto → followUp", () => {
    expect(decide({ text: "later", mode: "auto" }, "streaming")).toEqual({ action: "followUp", text: "later" });
  });

  it("streaming + ! prefix → steer with prefix stripped", () => {
    expect(decide({ text: "!stop that", mode: "auto" }, "streaming")).toEqual({ action: "steer", text: "stop that" });
  });

  it("an explicit mode takes the text verbatim — a leading ! is content", () => {
    expect(decide({ text: "now", mode: "steer" }, "streaming")).toEqual({ action: "steer", text: "now" });
    expect(decide({ text: "!now", mode: "followUp" }, "streaming")).toEqual({ action: "followUp", text: "!now" });
    // IM sends steer for every message; "!important" must arrive as typed.
    expect(decide({ text: "!important", mode: "steer" }, "streaming")).toEqual({ action: "steer", text: "!important" });
    expect(decide({ text: "!important", mode: "steer" }, "idle")).toEqual({ action: "prompt", text: "!important" });
  });
});
