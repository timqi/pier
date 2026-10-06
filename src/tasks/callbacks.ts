// What a finished run says to the session that delegated it. Delivery itself
// belongs to outbox.ts; this file owns the run vocabulary and the batching.

import { modelKey, type LedgerRun, type RunModel, type SystemInputSource } from "../core/types.js";
import type { Router } from "../core/router.js";
import { Outbox, type Milestone } from "./outbox.js";
import type { TaskStore } from "./store.js";
import { GOAL_STEP, type Goal, type TaskCallback, type TaskRun } from "./types.js";

/** The run id and the session that did the work: a relayer's next move is a
 *  deep link to it, and without this that costs a second call. */
export const runRef = (run: TaskRun): string =>
  `Run: ${run.id}${run.targetSessionId ? ` / Session: ${run.targetSessionId}` : ""}`;

/** What the home chat is told of a child run's abnormal end (service.ts `owesNotice`). */
export const abnormalNote = (run: TaskRun): string => {
  const why = run.error?.split("\n")[0]?.slice(0, 200);
  return `"${run.context.definition.name}" ended ${run.state}${why && why !== run.state ? ` — ${why}` : ""}\n${runRef(run)}`;
};

/** What a run worked on: the session's record once it opened, the launch's
 *  before; the tier only while the model is the pin it named. */
export const runModel = ({ context }: TaskRun): RunModel => {
  const action = context.definition.action;
  const launch = action.type === "agent" ? action.launch : undefined;
  const model = context.model ?? launch?.model;
  const thinking = context.thinking ?? launch?.thinking;
  const tier = launch?.tier && model && launch.model && modelKey(model) === modelKey(launch.model) ? launch.tier : undefined;
  return { ...(tier ? { tier } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
};

/** What the card in the recipient's transcript says the input came from. */
export const runSource = (run: TaskRun): SystemInputSource => ({ taskName: run.context.definition.name, ...runModel(run) });

/** The directory a run worked in: the one its session opened on, else the one its action names. */
export const runCwd = (run: TaskRun): string | null => {
  const action = run.context.definition.action;
  return run.context.cwd ??
    (action.type === "bash" ? action.cwd : action.type === "agent" && action.session.mode === "fresh" ? action.session.cwd : null);
};

/** A run as `pier task runs` prints it. */
export const ledgerRun = (run: TaskRun): LedgerRun => ({ runId: run.id, name: run.context.definition.name, state: run.state, targetSessionId: run.targetSessionId, cwd: runCwd(run), queuedAt: run.queuedAt, finishedAt: run.finishedAt });

/** What a callback's card says about the one run it carries. */
const oneRun = (run: TaskRun): { source: SystemInputSource; state: TaskRun["state"]; cwd?: string } => {
  const cwd = runCwd(run);
  return { source: runSource(run), state: run.state, ...(cwd ? { cwd } : {}) };
};

/** Heads a milestone resume's prompt: the lead's reply is what its supervisor reads. */
export const MILESTONE = "[Pier: the last result owed you follows; nothing else is running. Your reply is the milestone your supervisor reads.]";

/** The line a design lead ends on once the user confirms: its milestone, whether a run's or a turn outside any. */
export const DESIGN_FINAL = /^Design final:/m;

/** On the record of a lead run that owed its supervisor nothing, so the run says why. */
export const LEAD_TURN = "a lead's turn, not a milestone";

/** What heads a goal's end callback: the head reads it without parsing the result;
 *  `cwd` is the root run's, the worktree the head merges from into `base`. */
export const goalLine = (goal: Goal, cwd: string | null): string => {
  if (goal.outcome === "done" && goal.step === "merge") {
    return goal.round ? `Goal: merged after ${String(goal.round)} review round${goal.round === 1 ? "" : "s"}` : "Goal: merged, review clean";
  }
  const n = goal.round + (goal.step === "review" ? 1 : 0);
  const reviews = `${String(n)} review${n === 1 ? "" : "s"}`;
  const root = `(run ${goal.rootRunId}${goal.branch && cwd ? `, ${goal.branch}${goal.base ? ` → ${goal.base}` : ""} in ${cwd}` : ""})`;
  if (goal.outcome === "done") return `Goal: review clean${goal.reviewed ? ` at ${goal.reviewed.slice(0, 7)}` : ""}${n > 1 ? ` after ${reviews}` : ""} ${root}, waiting on you to merge`;
  if (goal.outcome === "decision") return `Goal: needs your decision${n ? ` after ${reviews}` : ""} ${root}`;
  if (goal.outcome === "cap") return `Goal: ${reviews}, still findings ${root}`;
  return `Goal: failed at ${goal.step} — ${goal.reason ?? "unknown"} ${root}`;
};

/** Decided once, as the run finishes. A live goal's step calls nobody back:
 *  the goal's end does (goals.ts). A lead reports milestones only: any
 *  other turn of its the user reads in its session, and settles as `--callback none`.
 *  A build lead's turn that leaves nothing coming to it is its milestone: it
 *  declares its own completion, where only the user finalizes a design.
 *  A turn that did not succeed is not a turn the user read: it calls back. */
export function settleCallback(run: TaskRun, store: Pick<TaskStore, "leadPhaseOf" | "awaitsResults" | "getGoal">): void {
  if (!run.callbackSessionId) return;
  if (run.goalId && store.getGoal(run.goalId)?.finishedAt === null) {
    run.callbackError = GOAL_STEP;
    return;
  }
  // A watch probe that did not match is the interval passing, not a result.
  if (run.matched === false && run.state === "succeeded") return;
  // The session's creator fixes its role: a `--session` or `--run` turn on a lead's session is a lead's.
  const lead = run.targetSessionId;
  const phase = lead === null ? undefined : store.leadPhaseOf(lead);
  const milestone = (): boolean => run.context.resumePrompt?.startsWith(MILESTONE) === true ||
    (run.result?.type === "agent" && DESIGN_FINAL.test(run.result.text)) ||
    (phase === "build" && lead !== null && !store.awaitsResults(lead));
  if (phase !== undefined && run.state === "succeeded" && !milestone()) run.callbackError = LEAD_TURN;
  else run.callbackState = "pending";
}

export function runResultText(run: TaskRun, max = 8000): string {
  let result = run.error ?? "No result";
  if (run.result?.type === "agent" || run.result?.type === "system") result = run.result.text;
  if (run.result?.type === "bash") result = run.result.stdout || run.result.stderr || `exit ${String(run.result.exitCode)}`;
  if (run.result?.type === "task") result = JSON.stringify(run.result.result);
  if (run.result?.type === "watch") result = "Watch condition did not match";
  return clipResult(result, max, run.id);
}

/** A result over `max` keeps its head and its tail — the contract puts the
 *  verified final state and `Needs your decision` last — and names what recovers the middle. */
export function clipResult(text: string, max: number, runId: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 3 / 4);
  const omitted = `[… ${String(text.length - max)} chars omitted — pier task recover --run ${runId} --reason … returns the full text]`;
  return `${text.slice(0, head)}\n${omitted}\n${text.slice(text.length - (max - head))}`;
}

/** The plain lines a clean review frames its P2/P3 list in (`reviewPrompt`); matched whole, never by wording. */
export const PICKS = { begin: "P2/P3 begin", end: "P2/P3 end" } as const;

/** The first framed P2/P3 list, its marker lines included; an unclosed frame is none. */
export function picks(text: string): string | null {
  const lines = text.split("\n");
  const begin = lines.findIndex((line) => line.trim() === PICKS.begin);
  const end = begin < 0 ? -1 : lines.findIndex((line, i) => i > begin && line.trim() === PICKS.end);
  return end < 0 ? null : lines.slice(begin, end + 1).join("\n");
}

export class TaskCallbacks {
  private readonly outbox: Outbox<TaskRun>;

  constructor(
    private readonly store: TaskStore,
    router: Router,
    changed: (run: TaskRun) => void,
    unreachable: (sessionId: string, what: string, why: string) => void,
    /** Where a result owed to a session goes now: the continuous conversation's head, for a member. */
    private readonly headOf: (sessionId: string) => string = (id) => id,
    milestone?: Milestone,
    /** The continuous conversation's head, null before its first message. */
    private readonly conversation: () => string | null = () => null,
  ) {
    this.outbox = new Outbox<TaskRun>(router, {
      id: (run) => run.id,
      reload: (id) => this.store.getRun(id),
      save: (run) => { this.store.saveRun(run); },
      changed,
      input: (runs) => ({
        text: this.text(runs),
        origin: {
          kind: "task-callback",
          taskId: runs[0]!.taskId,
          runId: runs[0]!.id,
          sourceSessionId: runs[0]!.targetSessionId,
          runIds: runs.map((run) => run.id),
          // Only for one run: a batch's caption would attribute every result
          // to the first run's name, model and directory.
          ...(runs.length === 1 ? oneRun(runs[0]!) : {}),
        },
      }),
      abandoned: (run, sessionId, why) => unreachable(sessionId, `the result of "${run.context.definition.name}"`, why),
      milestone,
    });
  }

  target(callback: TaskCallback, origin: string | null): string | null {
    if (callback.type === "session") return callback.sessionId;
    if (callback.type === "origin") return origin;
    if (callback.type === "conversation") return this.conversation();
    return null;
  }

  recover(now = Date.now()): void {
    for (const run of this.store.listPendingCallbacks(now)) void this.deliver(run);
  }

  /** Delivers the candidate together with every other deliverable callback
   * aimed at the same session. */
  async deliver(candidate: TaskRun): Promise<void> {
    const first = this.store.getRun(candidate.id);
    if (!first?.callbackSessionId || (first.callbackState !== "pending" && first.callbackState !== "failed")) return;
    const sessionId = this.headOf(first.callbackSessionId);
    // Once one callback is deliverable, everything pending for the session rides along.
    const batch = this.store.listPendingCallbacks(Number.MAX_SAFE_INTEGER)
      .filter((run) => run.callbackSessionId !== null && this.headOf(run.callbackSessionId) === sessionId);
    if (!batch.some((run) => run.id === first.id)) return;
    await this.outbox.deliver(sessionId, batch);
  }

  private text(runs: TaskRun[]): string {
    const sections = runs.map((run) => {
      const goal = run.goalId ? this.store.getGoal(run.goalId) : undefined;
      const root = goal?.outcome ? this.store.getRun(goal.rootRunId) : undefined;
      return [
        ...(goal?.outcome ? [goalLine(goal, root ? runCwd(root) : null)] : []),
        `Task "${run.context.definition.name}" finished with state: ${run.state}`,
        runRef(run),
        "",
        this.goalBody(run, root, goal?.outcome === "done") ?? runResultText(run),
      ].join("\n");
    });
    if (sections.length === 1) return sections[0]!;
    return [`${String(sections.length)} task callbacks`, "", sections.join("\n\n---\n\n")].join("\n");
  }

  /** A goal a review ended: the worker's conclusion is what the head relays, the review beneath it;
   *  a clean one's opening, what it checked and found, then its framed P2/P3 list, the points the head filters. */
  private goalBody(run: TaskRun, root: TaskRun | undefined, clean: boolean): string | undefined {
    const worker = root?.targetSessionId;
    if (!worker || run.targetSessionId === worker) return undefined;
    const latest = this.store.latestRunForTarget(worker);
    const text = run.result?.type === "agent" ? run.result.text : "";
    const framed = clean ? picks(text) : null;
    const opening = framed ? text.slice(0, text.indexOf(framed)).trim() : "";
    const review = framed ? `${opening ? `${clipResult(opening, 300, run.id)}\n\n` : ""}${clipResult(framed, 3000, run.id)}` : runResultText(run, 1000);
    return latest ? `${runResultText(latest, clean ? 1500 : 3000)}\n\nReview:\n${review}` : undefined;
  }
}
