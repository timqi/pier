import { describe, expect, it } from "vitest";
import { openItemMarkers } from "../core/reply.js";
import { DISPATCHER, lead, RUN_RESULT, surfacePrompt, WORKER } from "./roles.js";

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

  it("hands an approval down as the run contract's Approved: line and trusts the child's final state", () => {
    // The run contract honors exactly this line, so the lead that writes it names it the same;
    // the head reads it in skills/pier-tasks, which the dispatch bullet points at.
    expect(lead("build")).toContain("`Approved: <step>`");
    expect(RUN_RESULT).toContain("`Approved:` line");
    expect(DISPATCHER).toContain("skills/pier-tasks: flags, callbacks, approvals");
    expect(DISPATCHER).not.toContain("Approved:");
    expect(DISPATCHER).toContain("never re-check it with your own commands");
    expect(lead("build")).toContain("ending with the final state as verified");
  });

  it("leaves the language rule to the surface prompt every session gets", () => {
    expect(DISPATCHER).not.toContain("Reply in the language");
    expect(surfacePrompt({ boardsDir: "/b", publicUrl: "" })).toContain("Reply in the language of the\nmost recent `lang=`");
  });
});

describe("the role contracts", () => {
  it("gives a lead only its phase's section", () => {
    expect(lead("design")).toContain("## Design");
    expect(lead("design")).not.toContain("## Build");
    expect(lead("design")).toContain("[Finalize design]");
    expect(lead("build")).toContain("## Build");
    expect(lead("build")).not.toContain("## Design");
    expect(lead("build")).not.toContain("[Finalize design]");
    for (const phase of ["design", "build"] as const) expect(lead(phase)).toMatch(/^# You are a feature lead/);
  });

  it("gives a worker the run contract for its life, and the refusal it would otherwise learn from the CLI", () => {
    expect(WORKER).toContain(RUN_RESULT);
    expect(WORKER).toContain("`pier task` is refused");
    expect(WORKER).not.toContain("Next-step buttons");
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

  it("teaches a worker no button or attachment: an agent reads its replies", () => {
    const instance = { boardsDir: "/home/q/.pier/boards", publicUrl: "" };
    const worker = surfacePrompt(instance, "worker");
    expect(worker).not.toContain("Next-step buttons");
    expect(worker).not.toContain("file://");
    expect(worker).toContain("One optional markdown\nconvention");
    for (const kept of ["Staying silent", "lang=zh", "apply_patch", "/home/q/.pier/boards/<slug>/"]) expect(worker).toContain(kept);
    for (const role of [undefined, "lead"] as const) {
      const prompt = surfacePrompt(instance, role);
      expect(prompt).toContain("Next-step buttons");
      expect(prompt).toContain("file:///abs/path/report.md");
    }
  });
});
