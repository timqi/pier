import { describe, expect, it } from "vitest";
import { DISPATCHER, lead, MODEL_TABLE, RUN_RESULT, surfacePrompt, WORKER } from "./roles.js";

// What code or the CLI parses back out of these prompts, not their sentences.
const instance = { boardsDir: "/home/q/.pier/boards", publicUrl: "" };
const tokens = (text: string): number => Math.ceil(text.length / 4);

describe("the dispatcher contract", () => {
  it("carries the launch lines the head fills each dispatch", () => {
    for (const line of [
      "`--role lead --worktree <branch> --cwd <repo>`",
      "`pier task run --role lead --model hardest --thinking medium --worktree <branch> --cwd <the design lead's worktree>",
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
    ]) expect(DISPATCHER).toContain(line);
  });

  it("names the markers core/reply.ts strips and the lines the callbacks carry", () => {
    for (const syntax of ["<open>problem — stage (run <id>)</open>", "<done>problem</done>", "<topic>problem</topic>", "<note>line</note>", "<silent>dispatched</silent>"]) {
      expect(DISPATCHER).toContain(syntax);
    }
    // tasks/open-items.ts reads an item as waiting on the user by this stage word.
    expect(DISPATCHER).toContain("`waiting on you: <question>`");
    for (const line of ["`Design final: <path>`", "`Goal:`", "`review clean at <sha7>, waiting on you to merge`", "`needs your decision`", "`still findings`"]) {
      expect(DISPATCHER).toContain(line);
    }
    // A clean review may still frame a P2/P3 list by the marker tasks/callbacks.ts extracts.
    expect(DISPATCHER).toContain("`P2/P3 begin` list");
    // The dispatcher filters that list rather than relaying it whole.
    for (const rule of ["drop wording, format, style", "≤100 lines become a post-merge fix run, unasked", "or past it only by a wording fix the user named, else back to review", "1 for a small or follow-up fix", "the project's checks if HEAD was past its sha or the merge printed `Rebased onto`", "at most 1–2", "ask only the merge"]) expect(DISPATCHER).toContain(rule);
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
  it("names the real boards folder and both board routes", () => {
    const prompt = surfacePrompt({ boardsDir: "/home/q/.pier_test/boards", publicUrl: "https://test-pier.example.com" });
    for (const fact of ["/home/q/.pier_test/boards/<slug>/", "https://test-pier.example.com", "/boards/<slug>/", "/p/<slug>-<token>/", "apply_patch"]) {
      expect(prompt).toContain(fact);
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
      for (const syntax of ["`---`", "`[label]`", "file:///abs/path/report.md", "<silent>why</silent>", "[name<id> time place lang=zh]", "[re assistant 2026-06-01 12:00]", "`lang=`"]) {
        expect(prompt).toContain(syntax);
      }
    }
    const worker = surfacePrompt(instance, "worker");
    for (const gone of ["Next-step buttons", "file://", "[re assistant", "name<id>"]) expect(worker).not.toContain(gone);
    for (const kept of ["<silent>why</silent>", "[lang=zh]", "`lang=`", "apply_patch", "/home/q/.pier/boards/<slug>/"]) expect(worker).toContain(kept);
  });
});

// Ceilings in the sense of AGENTS.md Budgets rule 5, chars/4 like the Console:
// crossing one asks what is in there, and is raised with a sentence.
describe("prompt sizes", () => {
  it.each([
    ["DISPATCHER", DISPATCHER, 1_310],
    ["WORKER", WORKER, 360],
    ['lead("build")', lead("build"), 530],
    ["surfacePrompt()", surfacePrompt({ boardsDir: "/home/q/.pier/boards", publicUrl: "https://pier.example.com" }), 700],
  ])("%s stays under its ceiling", (_name, text, ceiling) => {
    expect(tokens(text)).toBeLessThanOrEqual(ceiling);
  });
});
