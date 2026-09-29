// The `--until merged` loop (docs/plans/18-goal-runtime.md): a worker run's
// work is reviewed by a run Pier launches, fixed by resuming the worker, and
// merged by it, driven from each step's settle with no model in the loop.

import { logger } from "../log.js";
import { runCwd } from "./callbacks.js";
import { newId, type TaskDefinitions } from "./definitions.js";
import { resolveModel } from "./operations.js";
import type { RunProvenance } from "./runs.js";
import type { TaskStore } from "./store.js";
import { isTerminal, type Goal, type GoalOutcome, type GoalStep, type TaskDefinition, type TaskRun } from "./types.js";

const log = logger("tasks");

/** Tolerant of markdown around the word: a reviewer bolds or bullets it. */
export const VERDICT = /^\W*Verdict:\W*(clean|findings)\b/im;
export const DECISION = /^Needs your decision/m;

export const fixPrompt = (round: number, cap: number, review: string): string =>
  `[Pier: review round ${String(round)}/${String(cap)} found issues; fix them in this worktree and end your turn without merging.]\n\n${review}`;

export const MERGE_PROMPT = "[Pier: review clean. Merge as your task instructs (wt merge …, last), then report the final state.]";

/** `round` counts the fix rounds before this review, so the first reads as review 1. */
export const reviewPrompt = (cwd: string, round: number, cap: number, task: string): string => [
  `[Pier: a goal's review, review ${String(round + 1)} (up to ${String(cap)} fix rounds). Review only: do not edit, commit or merge.]`,
  "",
  `The worktree is ${cwd}; the branch under review is the one checked out there. Its base is the branch the task below says it merges into; when it names none, the repository's default branch (\`git symbolic-ref --short refs/remotes/origin/HEAD\`, else \`main\`). Review the diff from \`git merge-base HEAD <base>\` to HEAD against that task, reading the changed files where the diff is not enough.`,
  "",
  "The task the branch was built for:",
  "",
  task,
  "",
  "List each issue worth a fix on one line: `file:line · issue · fix`.",
  "",
  "End your reply with exactly one line: `Verdict: clean` when nothing needs fixing, else `Verdict: findings`.",
].join("\n");

type MenuEntry = Parameters<typeof resolveModel>[1][number];

interface GoalHost {
  prepare(definition: TaskDefinition, source: TaskRun["triggerSource"], provenance: RunProvenance): TaskRun;
  start(run: TaskRun): void;
  cancelRun(id: string): void;
  models(): Promise<MenuEntry[]>;
  deliver(run: TaskRun): Promise<void>;
}

type Next = { outcome: GoalOutcome; reason: string | null } | { step: GoalStep; round: number };

export class TaskGoals {
  /** A boot pass and a settle may both reach the same goal; its next run is prepared once. */
  private readonly advancing = new Set<string>();

  constructor(
    private readonly store: TaskStore,
    private readonly definitions: TaskDefinitions,
    private readonly host: GoalHost,
  ) {}

  /** Inside the root run's prepare transaction. */
  open(root: TaskRun): Goal {
    const { action } = root.context.definition;
    const launch = action.type === "agent" ? action.launch : undefined;
    // A goal with nobody to tell the end to would run to nothing.
    if (!root.invokedBySessionId) throw new Error("--until merged needs a launching session");
    if (root.callbackSessionId === null) throw new Error("--until merged reports its end as a callback; callback none has nobody to tell");
    const goal: Goal = {
      id: newId(),
      rootRunId: root.id,
      supervisorSessionId: root.invokedBySessionId,
      cap: launch?.rounds ?? 3,
      round: 0,
      step: "work",
      currentRunId: root.id,
      outcome: null,
      reason: null,
      reviewModel: launch?.reviewModel ?? null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.store.saveGoal(goal);
    root.goalId = goal.id;
    this.store.saveRun(root);
    return goal;
  }

  /** The step `run` was settled: the next run, or the end. A throw ends the
   *  goal `failed` and still calls back — a broken loop must reach the chat. */
  async advance(run: TaskRun): Promise<void> {
    const goal = this.live(run);
    if (!goal || this.advancing.has(goal.id)) return;
    this.advancing.add(goal.id);
    let started: TaskRun | null = null;
    try {
      const next = this.next(goal, run);
      if ("outcome" in next) {
        this.end(goal.id, run, next.outcome, next.reason);
        return;
      }
      const root = this.store.getRun(goal.rootRunId);
      if (!root) throw new Error(`root run ${goal.rootRunId} is gone`);
      // `definitions.create` is async, so it cannot sit in the transaction below;
      // a definition the goal's end outran is archived, not left behind.
      const review = next.step === "review"
        ? await this.definitions.create(await this.reviewDraft(goal, root, next.round), `session:${goal.supervisorSessionId}`, "subagent")
        : undefined;
      const text = run.result?.type === "agent" ? run.result.text : "";
      started = this.store.transact(() => {
        // Re-read under the lock: a cancel may have ended it during the await.
        const current = this.live(run);
        if (!current) return null;
        const prepared = review
          ? this.host.prepare(review, "goal", this.provenance(current, root))
          : this.resumeWorker(current, root, next.step === "merge" ? MERGE_PROMPT : fixPrompt(next.round, current.cap, text));
        this.store.saveGoal({ ...current, step: next.step, round: next.round, currentRunId: prepared.id });
        return prepared;
      });
      if (!started && review) this.definitions.archive(review.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`goal ${goal.id}: could not advance past run ${run.id}; ended failed`, err);
      this.end(goal.id, run, "failed", reason.split("\n")[0]!);
    } finally {
      this.advancing.delete(goal.id);
    }
    // After the commit: a run is started only once its goal points at it.
    if (started) this.host.start(started);
  }

  /** Live goals whose current run settled but never advanced (a crash between the two). */
  recover(): void {
    for (const goal of this.store.liveGoals()) {
      const run = this.store.getRun(goal.currentRunId);
      if (run && isTerminal(run.state)) void this.advance(run);
    }
  }

  cancel(goal: Goal, by: string): void {
    const run = this.store.getRun(goal.currentRunId);
    const reason = `cancelled by ${by}`;
    // A current run the ledger lost has nobody to call back; the goal still ends.
    if (!run) {
      log.error(`goal ${goal.id}: its current run ${goal.currentRunId} is gone; ended failed`);
      this.finish(goal.id, "failed", `${reason}; its run ${goal.currentRunId} was gone`);
      return;
    }
    if (isTerminal(run.state)) {
      this.end(goal.id, run, "failed", reason);
      return;
    }
    // The run's own settle calls back, the goal already ended.
    this.finish(goal.id, "failed", reason);
    this.host.cancelRun(run.id);
  }

  private live(run: TaskRun): Goal | undefined {
    const goal = run.goalId ? this.store.getGoal(run.goalId) : undefined;
    return goal && goal.finishedAt === null && goal.currentRunId === run.id ? goal : undefined;
  }

  private next(goal: Goal, run: TaskRun): Next {
    if (run.state !== "succeeded") return { outcome: "failed", reason: run.error?.split("\n")[0] ?? run.state };
    const text = run.result?.type === "agent" ? run.result.text : "";
    if (DECISION.test(text)) return { outcome: "decision", reason: null };
    if (goal.step === "work") return { step: "review", round: goal.round };
    if (goal.step === "merge") return { outcome: "done", reason: null };
    const verdict = [...text.matchAll(new RegExp(VERDICT.source, VERDICT.flags + "g"))].at(-1)?.[1]?.toLowerCase();
    if (!verdict) return { outcome: "failed", reason: "no verdict" };
    if (verdict === "clean") return { step: "merge", round: goal.round };
    return goal.round >= goal.cap ? { outcome: "cap", reason: null } : { step: "work", round: goal.round + 1 };
  }

  private finish(id: string, outcome: GoalOutcome, reason: string | null): boolean {
    const goal = this.store.getGoal(id);
    if (!goal || goal.finishedAt !== null) return false;
    this.store.saveGoal({ ...goal, outcome, reason, finishedAt: Date.now() });
    return true;
  }

  /** `run` is the object execution.ts still holds: a `pending` it reads after
   *  the settle is delivered there too, and the outbox drops the second call. */
  private end(id: string, run: TaskRun, outcome: GoalOutcome, reason: string | null): void {
    const ended = this.store.transact(() => {
      if (!this.finish(id, outcome, reason)) return false;
      run.callbackState = "pending";
      run.callbackError = null;
      this.store.saveRun(run);
      return true;
    });
    if (!ended) return;
    log.info(`goal ${id} ended ${outcome}${reason ? ` — ${reason}` : ""} at run ${run.id}`);
    void this.host.deliver(run);
  }

  private provenance(goal: Goal, root: TaskRun): RunProvenance {
    return {
      invokedBySessionId: goal.supervisorSessionId,
      sourceSessionId: goal.supervisorSessionId,
      callbackSessionId: root.callbackSessionId,
      callbackMode: root.callbackMode,
      background: root.background,
      goalId: goal.id,
    };
  }

  private resumeWorker(goal: Goal, root: TaskRun, prompt: string): TaskRun {
    const worker = root.targetSessionId;
    if (!worker) throw new Error("the worker's session is unknown");
    return this.host.prepare(root.context.definition, "goal", {
      ...this.provenance(goal, root),
      targetSessionId: worker,
      sessionMode: "reuse",
      resumedFromRunId: this.store.latestRunForTarget(worker)?.id ?? root.id,
      resumePrompt: prompt,
    });
  }

  /** A fresh worker in the root's worktree, on the model the dispatcher named,
   *  else the root's tier, else its model, with the root's timeout. */
  private async reviewDraft(goal: Goal, root: TaskRun, round: number): Promise<unknown> {
    const cwd = runCwd(root);
    if (!cwd) throw new Error("the worker's worktree is unknown");
    const { action } = root.context.definition;
    const launch = action.type === "agent" ? action.launch : undefined;
    const model = launch?.model ?? root.context.model;
    const name = goal.reviewModel ?? launch?.tier ?? (model ? `${model.provider}/${model.id}` : undefined);
    if (!name) throw new Error("no model to review with: the root run named none");
    const pick = resolveModel(name, await this.host.models());
    return {
      name: `review ${String(round + 1)}: ${root.context.definition.name}`,
      trigger: { type: "manual" },
      callback: { type: "none" },
      timeoutSeconds: root.context.definition.timeoutSeconds,
      action: {
        type: "agent",
        session: { mode: "fresh", cwd },
        prompt: reviewPrompt(cwd, round, goal.cap, action.type === "agent" ? action.prompt : ""),
        launch: { model: pick.model, ...(pick.thinking ? { thinking: pick.thinking } : {}), ...(pick.tier ? { tier: pick.tier } : {}) },
      },
    };
  }
}
