import { describe, expect, it } from "vitest";
import { openItemMarkers } from "../core/reply.js";
import { DISPATCHER, surfacePrompt } from "./roles.js";

describe("the dispatcher contract", () => {
  it("shows the goal in a marker the parser reads back, the goal in the stage", () => {
    const example = /`(<open>[^`]*until[^`]*<\/open>)`/.exec(DISPATCHER)?.[1];
    expect(example).toBeDefined();
    expect(openItemMarkers(example!).markers).toEqual([
      { op: "open", problem: "CI \u4fee\u590d", stage: expect.stringMatching(/^worker running \u00b7 until /), runIds: ["<id>"] },
    ]);
    // The cap is a number the head counts against; the contract names it once.
    expect(DISPATCHER).toMatch(/auto 1\/3/);
  });

  it("names the three tiers once, in one line, and leaves the skill's prose to the skill", () => {
    // The skill is read on demand only, so the table the head fills every dispatch is here.
    const line = DISPATCHER.split("\n").filter((l) => l.includes("`hardest`") && l.includes("`cheap`"));
    expect(line).toHaveLength(1);
    for (const owned of ["follows the change's difficulty", "for orientation, never for waiting", "substring of provider"]) {
      expect(DISPATCHER).not.toContain(owned);
    }
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
    // The editing fact: named because a model that assumes otherwise spends a
    // failed shell call finding out.
    expect(prompt).toContain("apply_patch");
  });

  it("says an unset address is unset, so nothing invents one", () => {
    const prompt = surfacePrompt({ boardsDir: "/home/q/.pier/boards", publicUrl: "" });
    expect(prompt).toContain("No public address is configured");
    expect(prompt).not.toContain("http");
  });
});
