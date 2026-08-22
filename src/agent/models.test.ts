import { describe, expect, it } from "vitest";
import { curateModels, pinFirst } from "./models.js";

const m = (id: string, reasoning = true, provider = "anthropic") => ({ provider, id, reasoning });

describe("pinFirst", () => {
  const a = { provider: "anthropic", id: "claude-opus-4-5" };
  const b = { provider: "anthropic", id: "claude-haiku-4-5" };
  const c = { provider: "openai", id: "gpt-5.2" };

  it("moves pins to the front in menu order, rest untouched", () => {
    expect(pinFirst([a, b, c], [c, b])).toEqual([c, b, a]);
  });

  it("skips a pin the catalog no longer has, and never invents entries", () => {
    expect(pinFirst([a, b], [{ provider: "openai", id: "gone" }, b])).toEqual([b, a]);
  });

  it("no pins, no change", () => {
    const list = [a, b];
    expect(pinFirst(list, [])).toBe(list);
  });
});

describe("curateModels", () => {
  it("drops non-reasoning legacy models", () => {
    expect(curateModels([m("claude-3-5-sonnet-20240620", false), m("claude-opus-4-5")])).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5" },
    ]);
  });

  it("drops -latest aliases", () => {
    expect(curateModels([m("claude-3-5-haiku-latest"), m("claude-haiku-4-5")])).toEqual([
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ]);
  });

  it("drops dated variants only when the undated alias exists", () => {
    expect(
      curateModels([m("claude-opus-4-5"), m("claude-opus-4-5-20251101"), m("claude-opus-4-20250514")]),
    ).toEqual([
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "anthropic", id: "claude-opus-4-20250514" },
    ]);
  });

  it("dedupes dated variants per provider, not across providers", () => {
    expect(
      curateModels([
        m("gpt-5.2", true, "openai"),
        m("gpt-5.2-20260101", true, "openai"), // dropped: undated exists on openai
        m("gpt-5.2-20260101", true, "azure"), // kept: no undated alias on azure
      ]),
    ).toEqual([
      { provider: "openai", id: "gpt-5.2" },
      { provider: "azure", id: "gpt-5.2-20260101" },
    ]);
  });
});
