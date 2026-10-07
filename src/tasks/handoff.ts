// A `--run` continuation's handoff to a new session: when one is owed, what the
// new session reads first (docs/design/09-tasks-cli.md §Continuing a run).

import { modelKey } from "../core/types.js";
import { logger } from "../log.js";
import { runCwd, runResultText } from "./callbacks.js";
import type { TaskStore } from "./store.js";
import { isTerminal, type TaskDefinition, type TaskRun } from "./types.js";

const log = logger("tasks");

/** A continuation in a new session: the run's definition, the message it opens with, the record it carries. */
export interface Handoff {
  definition: TaskDefinition;
  text: string;
  record: NonNullable<TaskRun["handoff"]>;
}

/** Past this share of its compaction point a session is continued in a new one. */
export const WORN_SHARE = 0.7;

/** Why a session whose runs are `runs` is not continued in place, or undefined. */
export function wornOut(runs: TaskRun[]): string | undefined {
  const compactions = runs.reduce((n, run) => n + (run.compactions ?? 0), 0);
  if (compactions) return `the old session compacted ${String(compactions)} time${compactions === 1 ? "" : "s"}`;
  const share = Math.max(0, ...runs.map((run) => run.peakTokens && run.compactAt ? run.peakTokens / run.compactAt : 0));
  return share > WORN_SHARE ? `the old session's context peaked at ${String(Math.round(share * 100))}% of its compaction point` : undefined;
}

/** Refuses to continue `session` once a run continued it in a new one: continuing both would fork the work. */
export function assertNotReplaced(store: Pick<TaskStore, "replacing">, session: string | null | undefined): void {
  const successor = session && store.replacing(session);
  if (successor) throw new Error(`session ${session} was continued in a new session by run ${successor.id}; continue the newest run of that session instead`);
}

/** The handoff `--run` owes `prior`'s session: when `forced` (`--fresh`) or the session is worn out, and only
 *  for a session a run created, every run of it ended, no result owed to it; undefined resumes it in place.
 *  A session already replaced is refused either way (assertNotReplaced). `branch` renders the worktree's
 *  commits since its target. */
export async function planHandoff(
  store: Pick<TaskStore, "runsForTarget" | "goalOf" | "getRun" | "countOwedTo" | "replacing">,
  branch: (cwd: string) => Promise<string>,
  prior: TaskRun,
  prompt: string,
  forced: boolean,
): Promise<Handoff | undefined> {
  const session = prior.targetSessionId;
  assertNotReplaced(store, session);
  const runs = session ? store.runsForTarget(session) : [];
  const reason = forced ? "the supervisor passed --fresh" : wornOut(runs);
  if (!reason || !session) return undefined;
  const created = runs[0]?.sessionMode === "fresh" ? runs[0] : undefined;
  const cwd = created && runCwd(created);
  const action = created?.context.definition.action;
  const busy = runs.find((run) => !isTerminal(run.state));
  // A lead's workers call back into its session: a new one beside it would integrate the same worktree twice.
  const owed = store.countOwedTo(session);
  if (!created || !cwd || action?.type !== "agent" || busy || owed) {
    if (!forced) return undefined;
    throw new Error(busy ? `run ${busy.id} is ${busy.state} in session ${session}; --fresh waits for its end`
      : owed ? `${String(owed)} run(s) still owe session ${session} a result; --fresh waits for them (pier task runs)`
        : `--fresh continues a session a run created; session ${session} is not one`);
  }
  const last = [...runs].reverse().find((run) => isTerminal(run.state))!;
  const goal = store.goalOf(session);
  const review = goal?.step === "review" ? store.getRun(goal.currentRunId) : undefined;
  const summary = await branch(cwd).catch((err: unknown) => {
    log.warn(`handoff of run ${prior.id}: no branch summary for ${cwd}`, err);
    return `unavailable: ${err instanceof Error ? err.message : String(err)}`;
  });
  // The model and effort the session settled on; a tier names only the model it resolved.
  const { model, thinking } = last.context;
  const { tier, ...launch } = { ...action.launch, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  const keepTier = tier && action.launch?.model && launch.model && modelKey(action.launch.model) === modelKey(launch.model);
  return {
    definition: { ...created.context.definition, action: { ...action, session: { mode: "fresh", cwd }, launch: { ...launch, ...(keepTier ? { tier } : {}) } } },
    text: handoffText({ prior, reason, task: action.prompt, last, branch: summary, review: review && isTerminal(review.state) ? review : undefined, prompt }),
    record: { fromSessionId: session, reason, prompt },
  };
}

/** The new session's first message: everything it needs that the old transcript held, the prompt last. */
export function handoffText(parts: {
  prior: TaskRun;
  reason: string;
  task: string;
  last: TaskRun;
  branch: string;
  review?: TaskRun;
  prompt: string;
}): string {
  const { prior, reason, task, last, branch, review, prompt } = parts;
  return [
    `[Pier: this continues run ${prior.id} in a new session, because ${reason}. Its transcript is not here; the worktree as it is now is the truth, so read a file's latest version before you change it.]`,
    `## Original task\n\n${task}`,
    `## Last report (run ${last.id})\n\n${runResultText(last, 4000)}`,
    `## Branch\n\n${branch}`,
    ...(review ? [`## Latest review (run ${review.id})\n\n${runResultText(review, 4000)}`] : []),
    `## Continue with\n\n${prompt}`,
  ].join("\n\n");
}
