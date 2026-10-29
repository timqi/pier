import { describe, expect, it } from "vitest";
import { DISPATCHER, lead, MODEL_TABLE, RUN_RESULT, surfacePrompt, WORKER } from "./roles.js";

// What code or the CLI parses back out of these prompts, not their sentences.
const instance = { publicUrl: "", skillsDir: "/opt/pier/skills" };
const tokens = (text: string): number => Math.ceil(text.length / 4);

describe("the dispatcher contract", () => {
  it("carries the launch lines the head fills each dispatch", () => {
    for (const line of [
      "`--role lead --worktree <branch> --cwd <repo>`",
      "`pier task run --role lead --model hardest --thinking medium --cwd <the design lead's worktree>",
      "`--worktree <branch> --cwd <repo>`",
      "`--rounds 0`",
      "`--review-model`",
      "`--design`",
      '`--name "<a few words>"`',
      '`pier task run --run <root> --prompt "<answer>" --rounds <n>`',
      "`git -C <worktree> rev-parse HEAD && git -C <worktree> status --porcelain`",
      "`wt -C <worktree> merge --no-squash <target>`",
      "`→ <target> in <worktree>`",
      "`--no-remove`",
      "`--cwd <its worktree>` (`--rounds <n>` for a goal)",
    ]) expect(DISPATCHER).toContain(line);
  });

  it("names the markers core/reply.ts strips and the lines the callbacks carry", () => {
    for (const syntax of ["<open>problem — stage (run <id>)</open>", "<done>problem</done>", "<done>old → new</done>", "`[item: <problem>]`", "<topic>problem</topic>", "<note>line</note>", "<silent>"]) {
      expect(DISPATCHER).toContain(syntax);
    }
    // tasks/open-items.ts reads an item as waiting on the user by this stage word.
    expect(DISPATCHER).toContain("`waiting on you: <question>`");
    expect(DISPATCHER).toContain("A dispatch is `<silent>` beside its `<open>` marker, its run tag the receipt; one line only for a choice made for the user (model, context, scope) or a run that is long or needs them. A callback that only moves the stage is `<silent>`.");
    for (const line of ["`Design final: <path>`", "`Goal:`", "`review clean at <sha7>, waiting on you to merge`", "`needs your decision`", "`still findings`"]) {
      expect(DISPATCHER).toContain(line);
    }
    // A clean review may still frame a P2/P3 list by the marker tasks/callbacks.ts extracts.
    expect(DISPATCHER).toContain("`P2/P3 begin` list");
    // The dispatcher filters that list rather than relaying it whole.
    for (const rule of ["drop wording, format, style; behavior, readability fixes: `--run <root> --rounds 0`, unasked, checks only. None or once green, you merge unasked.", "or past it only by that P2 or conflict fix or a wording fix the user named, else back to review", "1 for a small, follow-up or mechanical fix, `--rounds 0` for a pure mechanical edit", "an answer, a review fix, a small addition to the change", "`--run <id> --fresh` instead when a problem failed 2 fixes, the run is stuck", "what was tried, where it failed, the new direction", "the project's checks if HEAD was past its sha or the merge printed `Rebased onto`", "A small conflict: a run fixes it, the project's checks green, then you merge; only one choosing between approaches is the user's. A red check after the merge: a run fixes it on the target.", "Restart and deploy are each the user's, a prior authorization for this item answering once.", "Propose the simplest option; add complexity only when asked."]) expect(DISPATCHER).toContain(rule);
  });

  it("guards the regressions a rewording could bring back", () => {
    // A literal label would be copied verbatim into a reply in any language.
    expect(DISPATCHER).not.toContain("[Merge]");
    for (const contract of [DISPATCHER, WORKER, lead("build")]) {
      for (const gone of ["pier task finish", "Approved: merge", "--until", "wt switch -c"]) expect(contract).not.toContain(gone);
    }
    // The surface prompt owns the language rule, RUN_RESULT the status line.
    expect(DISPATCHER).not.toContain("Reply in the language");
    expect(DISPATCHER).not.toContain("Needs your decision");
    expect(MODEL_TABLE).not.toContain("finishing");
    // One word per concept (docs/design/10-continuous-session.md §Prompt vocabulary).
    for (const contract of [DISPATCHER, WORKER, lead("design"), lead("build")]) {
      for (const synonym of ["child", "the pin", "owed you", "delegated"]) expect(contract).not.toContain(synonym);
    }
  });
});

describe("the model table", () => {
  it("is carried once by each launching contract and by nothing else", () => {
    for (const contract of [DISPATCHER, lead("build")]) expect(contract.split(MODEL_TABLE)).toHaveLength(2);
    for (const contract of [lead("design"), WORKER]) expect(contract).not.toContain("`--model` is required");
    for (const tier of ["`hardest`", "`balanced`", "`cheap`", "`high`", "`medium`"]) expect(MODEL_TABLE).toContain(tier);
  });
});

describe("the lead contract", () => {
  it("gives a lead only its phase's section", () => {
    for (const phase of ["design", "build"] as const) expect(lead(phase)).toMatch(/^# You are a feature lead/);
    expect(lead("design")).toContain("## Design");
    expect(lead("design")).not.toContain("## Build");
    expect(lead("design")).toContain("`Design final: <absolute path of the doc>`");
    for (const rule of ["commit the doc, the tree clean, then end your reply", "After that line the worktree is the build lead's"]) expect(lead("design")).toContain(rule);
    expect(lead("build")).toContain("## Build");
    expect(lead("build")).not.toContain("## Design");
  });

  it("launches workers and its review goal, and integrates without merging into the target", () => {
    const build = lead("build");
    for (const line of ["`--worktree <branch>`", "`--rounds 0`", '`pier task run --rounds <n> --cwd <this worktree> --prompt "review …"`', "`git merge <branch>`", "`wt merge`/`wt remove`"]) {
      expect(build).toContain(line);
    }
    expect(build).not.toContain("Approved:");
  });
});

describe("the worker contract", () => {
  it("carries the run contract and the refusal it would otherwise learn from the CLI", () => {
    expect(WORKER).toContain(RUN_RESULT);
    expect(WORKER).toContain("`pier task` is refused");
    expect(WORKER).toContain("`wt merge`/`wt remove`");
    // The head merges with `--no-squash`: the worker's commits are the history that lands.
    expect(WORKER).toContain("Commits land unsquashed");
    expect(WORKER).not.toContain("Next-step buttons");
  });

  it("ends a result on the status lines tasks/goals.ts parses", () => {
    for (const line of ["`Needs your decision — <the question, one line>`", "`Verdict: clean`", "`Verdict: findings`", "`Verdict: blocked — <why>`"]) {
      expect(RUN_RESULT).toContain(line);
    }
    // The stop rule is Working style's; the run contract only points at it.
    expect(RUN_RESULT).toContain("Working style");
    expect(RUN_RESULT).not.toContain("Approved:");
  });
});

describe("the surface prompt", () => {
  it("names the instance's address", () => {
    const prompt = surfacePrompt({ ...instance, publicUrl: "https://test-pier.example.com" });
    for (const fact of ["https://test-pier.example.com", "apply_patch"]) {
      expect(prompt).toContain(fact);
    }
    // How to edit is the baseline's (agent/pi.ts); the surface only rules out apply_patch.
    expect(prompt).not.toContain("exact text replacement");
  });

  it("names where Pier's own skills are, so none is read from a guessed directory", () => {
    for (const role of [undefined, "worker"] as const) {
      expect(surfacePrompt(instance, role)).toContain("`/opt/pier/skills`");
    }
  });

  it("says an unset address is unset, so nothing invents one", () => {
    const prompt = surfacePrompt(instance);
    expect(prompt).toContain("No public address is configured");
    expect(prompt).not.toContain("http");
  });

  it("teaches the chat syntax core/reply.ts parses, and a worker only what an agent reader needs", () => {
    for (const role of [undefined, "lead"] as const) {
      const prompt = surfacePrompt(instance, role);
      for (const syntax of ["`---`", "`[label]`", "file:///abs/path/report.md", "<silent>why</silent>", "[name<id> time place lang=zh]", "[re assistant 2026-06-01 12:00]", "`[item: <problem>]`", "`lang=`"]) {
        expect(prompt).toContain(syntax);
      }
    }
    const worker = surfacePrompt(instance, "worker");
    for (const gone of ["Next-step buttons", "file://", "[re assistant", "name<id>", "[item:"]) expect(worker).not.toContain(gone);
    for (const kept of ["<silent>why</silent>", "[lang=zh]", "`lang=`", "apply_patch"]) expect(worker).toContain(kept);
  });
});

// Ceilings in the sense of AGENTS.md Budgets rule 5, chars/4 like the Console:
// crossing one asks what is in there, and is raised with a sentence.
describe("prompt sizes", () => {
  it.each([
    ["DISPATCHER", DISPATCHER, 1_650],
    ["WORKER", WORKER, 360],
    ['lead("build")', lead("build"), 530],
    ["surfacePrompt()", surfacePrompt({ ...instance, publicUrl: "https://pier.example.com" }), 700],
  ])("%s stays under its ceiling", (_name, text, ceiling) => {
    expect(tokens(text)).toBeLessThanOrEqual(ceiling);
  });
});
