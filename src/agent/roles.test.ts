import { describe, expect, it } from "vitest";
import { DISPATCHER, lead, MODEL_TABLE, RUN_RESULT, surfacePrompt, WORKER } from "./roles.js";

describe("the dispatcher contract", () => {
  it("defaults code workers to a worktree and reviews, and leaves the stage uncounted", () => {
    expect(DISPATCHER).toContain("`--worktree <branch> --cwd <repo>`: its own `wt` worktree and 3 reviews");
    expect(DISPATCHER).toContain("`--rounds 0` for none");
    for (const gone of ["--until", "wt switch -c"]) {
      expect(DISPATCHER).not.toContain(gone);
      expect(lead("build")).not.toContain(gone);
    }
    expect(DISPATCHER).not.toContain("· auto");
    expect(DISPATCHER).toContain("callback opens with a `Goal:` line");
    expect(DISPATCHER).toContain("stage is written once at dispatch with nothing to count");
  });

  it("leaves the merge and the worktree's removal to the user, and asks first beyond it only for a seam or design", () => {
    expect(DISPATCHER).toContain("The merge and the worktree's removal are the user's decision, never yours or a child's");
    expect(DISPATCHER).toContain("`review clean at <sha7>, waiting on you to merge`");
    expect(DISPATCHER).toContain("Beyond the merge, ask the user first only for a seam or a design");
    expect(DISPATCHER).toContain("restart after the merge is still theirs");
  });

  it("sends a decision or leftover findings back through the loop, and a doubtful result to a child", () => {
    expect(DISPATCHER).toContain('`pier task run --run <root> --prompt "<answer>" --rounds <n>`, never a review by hand');
    expect(DISPATCHER).toContain("goes to a child to check, never re-run by you");
    expect(DISPATCHER).toContain("A child does: any edit outside this directory, any implementation, any review of a diff");
  });

  it("merges through `pier task finish` on the user's yes, a button being one, the removal only when they said so", () => {
    expect(DISPATCHER).toContain("`[Merge] | [Merge, remove worktree] | [Show the review]`");
    expect(DISPATCHER).toContain("a click on the first two is one — `pier task finish --run <root>` — or `--run <lead run>` for a lead's milestone — `--remove-worktree` only when they said so");
    expect(DISPATCHER).toContain("build → review → wait for the user → finish");
    // The finish is assembled in code; no contract carries its recipe.
    for (const contract of [DISPATCHER, WORKER, lead("build")]) {
      expect(contract).not.toContain("finishing run");
      expect(contract).not.toContain("Approved: merge");
    }
    expect(MODEL_TABLE).not.toContain("finishing");
  });

  it("seeds memory once and tags a callback's answer by its item", () => {
    expect(DISPATCHER).toContain("seeded in full at every session open, never re-read");
    expect(DISPATCHER).toContain("or answering a callback of its run, is tagged by it already");
  });

  it("carries the one model table in both launching contracts, and leaves the skill's prose to the skill", () => {
    // The skill is read on demand only, so the table the head fills every dispatch is here.
    for (const contract of [DISPATCHER, lead("build")]) {
      expect(contract).toContain(MODEL_TABLE);
      expect(contract.split(MODEL_TABLE)).toHaveLength(2);
    }
    expect(MODEL_TABLE).toContain("A model the user names wins over the table");
    for (const gone of ["`--thinking high` for", "the lead's own, never a worker's"]) {
      expect(DISPATCHER).not.toContain(gone);
      expect(lead("build")).not.toContain(gone);
    }
    for (const owned of ["follows the change's difficulty", "for orientation, never for waiting", "substring of provider"]) {
      expect(DISPATCHER).not.toContain(owned);
    }
  });

  it("hands an approval down as the run contract's Approved: line and trusts the child's final state", () => {
    // The run contract honors exactly this line; the skill both the head and a
    // lead read names it the same, and neither contract repeats the contract.
    expect(RUN_RESULT).toContain("`Approved:` line");
    expect(DISPATCHER).toContain("(skills/pier-tasks for `--member`, `--bash`, schedules, `recover`, `stats`)");
    expect(lead("build")).toContain("in the same two parts as a worker's result (skills/pier-tasks)");
    expect(lead("build")).not.toContain("Approved:");
    for (const contract of [DISPATCHER, lead("build")]) expect(contract).not.toContain("Needs your decision");
    expect(DISPATCHER).toContain("never re-check it with your own commands");
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
    expect(lead("build")).toContain("Before the milestone that declares the build done");
    expect(lead("build")).toContain("one review worker (`--model balanced`, `hardest` for a seam or a risk)");
    expect(lead("build")).toContain("its end arriving as a callback counted among the results owed");
    expect(lead("build")).toContain("--model balanced --worktree <branch> --rounds 0 --prompt …` from here, each worktree branching off yours");
    expect(lead("build")).toContain("a worker launched with its reviews like the head's (no `--rounds 0`)");
    expect(lead("build")).toContain("`git merge <branch>` in this worktree, never into the target, so its worktree stays");
    expect(lead("build")).toContain("carried out by your supervisor: you never run `wt merge` or `wt remove`");
    expect(lead("build")).toContain("names the worktrees left for the user to decide on");
    expect(lead("build")).not.toContain("[Finalize design]");
    for (const phase of ["design", "build"] as const) expect(lead(phase)).toMatch(/^# You are a feature lead/);
  });

  it("gives a worker the run contract for its life, and the refusal it would otherwise learn from the CLI", () => {
    expect(WORKER).toContain(RUN_RESULT);
    expect(WORKER).toContain("`pier task` is refused");
    expect(WORKER).toContain("never merges into the target branch, never removes a worktree, and is never resumed to do either");
    expect(WORKER).toContain("commit before you end your turn");
    expect(WORKER).not.toContain("is the last command run in the worktree");
  });

  it("ends a result on one plain status line, a review on its verdict", () => {
    expect(RUN_RESULT).toContain("the status line `Needs your decision — <the question, one line>` as the very last line, its details above it");
    expect(RUN_RESULT).toContain("`Verdict: clean`, `Verdict: findings` or `Verdict: blocked — <why>`");
    expect(RUN_RESULT).toContain("never inside a code block");
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
    expect(worker).not.toContain("[re assistant"); // no human quotes a worker
    expect(worker).toContain("One optional markdown\nconvention");
    for (const kept of ["Staying silent", "lang=zh", "apply_patch", "/home/q/.pier/boards/<slug>/"]) expect(worker).toContain(kept);
    for (const role of [undefined, "lead"] as const) {
      const prompt = surfacePrompt(instance, role);
      expect(prompt).toContain("Next-step buttons");
      expect(prompt).toContain("except a button that is the user's decision itself");
      expect(prompt).toContain("file:///abs/path/report.md");
      expect(prompt).toContain("callbacks.\n\nA message opening with `[re assistant 2026-06-01 12:00]`");
    }
  });
});
