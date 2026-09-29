// The vocabulary every file in this area shares: what a task, a run, a group
// and a control message *are*, plus the delivery constants the outbox and the
// messenger must agree on. Owner-defined and browser-importable type-only
// (architecture.md), so nothing here may reach for a runtime or a node builtin.

import type { AgentRole, LeadPhase, LedgerRun, ModelRef, ModelTier, TaskRunState, ThinkingLevel } from "../core/types.js";

export type TaskTrigger =
  | { type: "manual" }
  | { type: "cron"; expression: string; timezone: string }
  | { type: "watch"; script: string; cwd: string; intervalSeconds: number; mode: "once" | "repeat" };

export type AgentSessionPolicy =
  | { mode: "reuse"; sessionId: string }
  | { mode: "fresh"; cwd: string };

export interface AgentLaunchPolicy {
  model?: ModelRef;
  thinking?: ThinkingLevel;
  /** The menu tier `model` was resolved from, written by Pier when it resolves
   *  a name, never taken from a caller; the run's cards show it. */
  tier?: ModelTier;
  /** A feature lead: may delegate to workers, opens with the lead contract. */
  role?: "lead";
  /** A lead for a product or architecture design the user finalizes with
   *  `Design final:`; with `role: "lead"` only. Any other lead builds. */
  design?: true;
  /** `reviewed`: the run is the root of a goal (tasks/goals.ts) — reviewed and
   *  fixed without a turn of its supervisor's until the end; the merge is the user's.
   *  `merged`, the earlier word, is taken as it (definitions.ts) and means the same in a stored row. */
  until?: "reviewed";
  /** Review rounds the goal allows (1–9) before it stops on the user; 3 when absent. */
  rounds?: number;
  /** The review's model as the dispatcher named it (a tier or a menu name);
   *  the root run's tier, else its model, when absent. */
  reviewModel?: string;
}

export type AgentTaskAction = {
  type: "agent";
  session: AgentSessionPolicy;
  prompt: string;
  launch?: AgentLaunchPolicy;
};

export type TaskAction =
  | AgentTaskAction
  | { type: "bash"; script: string; cwd: string }
  | { type: "system"; name: string }
  | { type: "task"; taskId: string };

export type SystemActions = Record<string, (signal: AbortSignal) => Promise<string>>;

/** `conversation`: the continuous conversation's head when the run is
 *  prepared, nobody before its first message — a saved definition's default. */
export type TaskCallback =
  | { type: "conversation" }
  | { type: "none" }
  | { type: "origin" }
  | { type: "session"; sessionId: string };

export interface TaskDefinition {
  id: string;
  /** "subagent" marks one-shot delegations created inline via run; hidden from default lists. */
  kind: "task" | "subagent";
  name: string;
  description: string;
  enabled: boolean;
  archived: boolean;
  revision: number;
  trigger: TaskTrigger;
  action: TaskAction;
  callback: TaskCallback;
  timeoutSeconds: number;
  nextRunAt: number | null;
  creator: string;
  createdBySessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDraft {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: TaskTrigger;
  action: TaskAction;
  callback?: TaskCallback;
  timeoutSeconds?: number;
}

export type { TaskRunState };

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type TaskResult =
  | { type: "agent"; text: string; sessionId: string }
  | { type: "system"; text: string }
  | ({ type: "bash" } & CommandResult)
  | { type: "task"; runId: string; result: TaskResult | null }
  | { type: "watch"; matched: false };

interface TaskRunContext {
  definition: TaskDefinition;
  cwd?: string;
  sessionId?: string;
  model?: ModelRef;
  /** What the run actually reasoned at, read off the session rather than off
   *  the request — an unspecified level inherits the caller's, so the request
   *  is usually blank where the answer is not. */
  thinking?: ThinkingLevel;
  renderedPrompt?: string;
  resumePrompt?: string;
}

export interface TaskRun extends CallbackFields {
  id: string;
  taskId: string;
  taskRevision: number;
  /** The run of a `task` action that waits on this one; a cancel walks the chain. */
  parentRunId: string | null;
  groupId: string | null;
  resumedFromRunId: string | null;
  /** The goal this run is a step of (`Goal.id`), its root run included; absent means none. */
  goalId?: string;
  /** `goal`: launched by a goal's loop, not by a session's request. */
  triggerSource: "manual" | "cron" | "watch" | "agent" | "task" | "goal";
  invokedBySessionId: string | null;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  /** `"fork"` exists only in stored runs; the runner refuses it by name. */
  sessionMode: "reuse" | "fresh" | "fork" | null;
  callbackSessionId: string | null;
  background: boolean;
  state: TaskRunState;
  input: unknown;
  context: TaskRunContext;
  probe: CommandResult | null;
  matched: boolean | null;
  result: TaskResult | null;
  error: string | null;
  skipReason: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** One row of `GET /api/tasks`: the definition and its newest run. */
export interface TaskRow extends TaskDefinition {
  lastRun: TaskRun | null;
}

export type GroupJoinMode = "all" | "first";

/** A fan-out join owned by core: one aggregated callback when the join
 * condition is met. Members carry `groupId` and no individual callback. */
export interface TaskGroup extends CallbackFields {
  id: string;
  join: GroupJoinMode;
  invokedBySessionId: string;
  callbackSessionId: string | null;
  memberRunIds: string[];
  winnerRunId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** A control message is a parent's word to a running child; nothing flows the
 *  other way mid-run — a child that needs an answer ends its turn with the
 *  question as its result, and the answer resumes it. */
export type TaskMessageKind = "steer" | "follow_up";
export type TaskMessageState = "pending" | "delivered" | "failed" | "expired";

export interface TaskMessage {
  id: string;
  runId: string;
  kind: TaskMessageKind;
  fromSessionId: string;
  toSessionId: string;
  state: TaskMessageState;
  content: string;
  createdAt: number;
  deliveredAt: number | null;
  error: string | null;
  /** Persisted, not in memory: an attempt counter that resets with the
   *  process is a ceiling that never arrives. */
  attempts: number;
  nextAttemptAt: number | null;
}

/** The delivery record runs and groups share (their callback* columns are the
 *  same shape); outbox.ts owns the transitions between these states.
 *
 *  `delivered` means the input is in the recipient's own transcript, not that
 *  a send resolved: Pi's queues are memory, so an abort or a restart drops an
 *  accepted input, and reporting that as delivered loses it in silence; a
 *  feature lead's milestone is the one other proof, the resumed run that
 *  carries the text, committed with the mark (service.ts).
 *  `abandoned` is the end of the line — a target nothing can reach, reported
 *  instead of retried forever. */
export interface CallbackFields {
  callbackState: "pending" | "delivered" | "failed" | "abandoned" | null;
  callbackAttempts: number;
  callbackError: string | null;
  callbackNextAttemptAt: number | null;
  /** Absent means `followUp`. */
  callbackMode?: CallbackMode;
}

/** How a finished result joins a recipient that is mid-turn. `followUp` waits
 *  for the turn to end, so a session working for twenty minutes reads its
 *  results twenty minutes late — batched, undisturbed. `steer` is that trade
 *  taken the other way, and only the delegating agent knows which it wants,
 *  so it is chosen per delegation rather than as a policy. */
export type CallbackMode = "followUp" | "steer";

export const retryDelay = (attempts: number): number =>
  Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));

/** Attempts before a delivery is given up on and reported. With the backoff
 *  above that is ~4 minutes: long enough to outlast a busy or restarting
 *  recipient, short enough that whoever is waiting still cares. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** What a delivery says when it stops trying. */
export const undeliverable = (attempts: number, error: string | null): string =>
  `undeliverable after ${String(attempts)} attempts${error ? `: ${error}` : ""}`;

export const isTerminal = (state: TaskRunState): boolean =>
  state === "succeeded" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "interrupted" ||
  state === "skipped";

/** The role a fresh run's session is created with and keeps: a lead's, or a
 *  worker's when a session launched it; a cron or watch run's has none. */
export const createdRole = ({ context: { definition: { action } }, invokedBySessionId }: TaskRun): AgentRole | undefined =>
  action.type === "agent" && action.launch?.role === "lead" ? "lead" : invokedBySessionId !== null ? "worker" : undefined;

/** A lead's phase, fixed the same way: `design` when its run carries `launch.design`, any other lead builds. */
export const createdPhase = (run: TaskRun): LeadPhase | undefined => {
  const { action } = run.context.definition;
  if (createdRole(run) !== "lead" || action.type !== "agent") return undefined;
  return action.launch?.design ? "design" : "build";
};

/** `merge` only on a goal stored while the loop still resumed the worker to merge: the loop never enters it now. */
export type GoalStep = "work" | "review" | "merge";

/** How a goal ended: `done` reviewed clean, the merge waiting on the user (merged, after a legacy `merge` step); `decision` a step's result carried `Needs
 *  your decision` as its status line; `cap` the last allowed review still found issues; `failed`
 *  a step failed, was cancelled, interrupted, timed out, answered `Verdict: blocked` or
 *  several status lines, a review gave no verdict, or its worktree could not be pinned. */
export type GoalOutcome = "done" | "decision" | "cap" | "failed";

/** A `--until reviewed` loop (tasks/goals.ts, docs/plans/18-goal-runtime.md):
 *  the root run's work, reviewed by a run Pier launches, fixed by resuming the
 *  worker, reviewed again up to `cap` rounds; it ends before the merge, the user's to confirm. */
export interface Goal {
  id: string;
  rootRunId: string;
  /** Who launched the root run: every step is owned and cancelled as theirs. */
  supervisorSessionId: string;
  cap: number;
  /** Fix rounds started — one findings → fix → re-review trip each; the
   *  first review counts nothing. */
  round: number;
  step: GoalStep;
  currentRunId: string;
  outcome: GoalOutcome | null;
  /** Why it ended, for `failed`; the cancelling session's word, a step's error, `no verdict`, `blocked — <why>`. */
  reason: string | null;
  reviewModel: string | null;
  /** The commit the last review ran on, set when that review is prepared; null
   *  before the first, absent on a goal stored before reviews were pinned. */
  reviewed?: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** On the record of a goal's run that is not its end, so the run says why it called nobody back. */
export const GOAL_STEP = "a goal's step, not its end";

/** A run behind an open item; a lead's carries its own launches, counted by state,
 *  a goal's root the goal's step, round, cap and end, until a run is queued in its session after that end. */
export interface OpenRun extends LedgerRun {
  workers?: Record<TaskRunState, number>;
  goal?: Pick<Goal, "step" | "round" | "cap" | "outcome" | "reason">;
}

/** Where an open item stands (`openStatus`, tasks/open-items.ts), first match:
 *  `running` while a run's goal is live, a run is queued or running, its session
 *  streams or a lead's workers are queued or running; `waiting on you` while a
 *  goal ended `decision`, `cap` or `done` short of a legacy merge, its stage says so
 *  or its session's design awaits Finalize; `pending release` when every run succeeded
 *  and carries no goal but one a legacy merge ended; else `stopped` — a run failed, was cancelled, interrupted,
 *  skipped or left the ledger. Only `waiting on you` asks anything of the user. */
export type OpenStatus = "running" | "waiting on you" | "pending release" | "stopped";

/** `runs`: each named run's session, by its newest run. `waitsIn`: the session
 *  a `waiting on you` item is answered in, derived beside the status; absent
 *  when the answer is given in the main chat. */
export interface OpenItem {
  problem: string;
  stage: string;
  runs: OpenRun[];
  status: OpenStatus;
  waitsIn?: string;
}

/** What the continuous conversation is solving, as main last said it
 *  (docs/design/10-continuous-session.md#open-items). A session is in one
 *  item or one `unlisted` run, never two. */
export interface OpenItems {
  /** Main's items by `updated_at`, oldest first; then each design lead that has
   *  not reported `Design final:`, is not closed and no item holds, named by its
   *  creating run: the user decides when each is final. */
  items: OpenItem[];
  /** Chain runs in flight in no item's session. */
  unlisted: OpenRun[];
}

/** A `--after` follow-up waiting for its target session to idle, as that
 *  session's queue shows it; `runName` is the run it was parked on. */
export interface ParkedMessage {
  messageId: string;
  runName: string;
  text: string;
}
