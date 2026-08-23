import type { ModelRef, ThinkingLevel } from "../core/types.js";

export type TaskTrigger =
  | { type: "manual" }
  | { type: "cron"; expression: string; timezone: string }
  | { type: "watch"; script: string; cwd: string; intervalSeconds: number; mode: "once" | "repeat" };

export type AgentSessionPolicy =
  | { mode: "reuse"; sessionId: string }
  | { mode: "fresh"; cwd: string }
  | { mode: "fork"; cwd?: string };

export interface AgentLaunchPolicy {
  model?: ModelRef;
  thinking?: ThinkingLevel;
  capabilities?: "read" | "write";
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
  | { type: "task"; taskId: string };

export type TaskCallback =
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

export type TaskRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type TaskResult =
  | { type: "agent"; text: string; sessionId: string }
  | ({ type: "bash" } & CommandResult)
  | { type: "task"; runId: string; result: TaskResult | null }
  | { type: "watch"; matched: false };

export interface TaskRunContext {
  definition: TaskDefinition;
  cwd?: string;
  sessionId?: string;
  model?: ModelRef;
  renderedPrompt?: string;
  resumePrompt?: string;
}

export interface TaskRun extends CallbackFields {
  id: string;
  taskId: string;
  taskRevision: number;
  parentRunId: string | null;
  groupId: string | null;
  rootRunId: string;
  depth: number;
  resumedFromRunId: string | null;
  triggerSource: "manual" | "cron" | "watch" | "agent" | "task";
  invokedBySessionId: string | null;
  sourceSessionId: string | null;
  targetSessionId: string | null;
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

export type TaskMessageKind = "steer" | "follow_up" | "progress" | "decision" | "reply";
export type TaskMessageState = "pending" | "delivered" | "answered" | "failed" | "expired";

export interface TaskMessage {
  id: string;
  runId: string;
  kind: TaskMessageKind;
  fromSessionId: string;
  toSessionId: string;
  replyTo: string | null;
  state: TaskMessageState;
  content: string;
  createdAt: number;
  deliveredAt: number | null;
  answeredAt: number | null;
  error: string | null;
  /** Persisted, not in memory: a decision outlives restarts, and an attempt
   *  counter that resets with the process is a ceiling that never arrives. */
  attempts: number;
  nextAttemptAt: number | null;
}

/** The delivery record runs and groups share (their callback* columns are the
 *  same shape); outbox.ts owns the transitions between these states.
 *
 *  `delivered` means the input is in the recipient's own transcript, not that
 *  a send resolved: Pi's queues are memory, so an abort or a restart drops an
 *  accepted input, and reporting that as delivered loses it in silence.
 *  `abandoned` is the end of the line — a target nothing can reach, reported
 *  instead of retried forever. */
export interface CallbackFields {
  callbackState: "pending" | "delivered" | "failed" | "abandoned" | null;
  callbackAttempts: number;
  callbackError: string | null;
  callbackNextAttemptAt: number | null;
}

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
