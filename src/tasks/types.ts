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

export interface TaskRun {
  id: string;
  taskId: string;
  taskRevision: number;
  parentRunId: string | null;
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
  callbackState: "pending" | "delivered" | "failed" | null;
  callbackAttempts: number;
  callbackError: string | null;
  callbackNextAttemptAt: number | null;
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

export type TaskMessageKind = "steer" | "follow_up" | "progress" | "decision" | "reply";
export type TaskMessageState = "pending" | "delivered" | "answered" | "failed" | "expired";

export interface TaskMessage {
  id: string;
  runId: string;
  kind: TaskMessageKind;
  fromSessionId: string;
  toSessionId: string;
  replyTo: string | null;
  retryOf: string | null;
  state: TaskMessageState;
  content: string;
  createdAt: number;
  deliveredAt: number | null;
  answeredAt: number | null;
  error: string | null;
}

export const isTerminal = (state: TaskRunState): boolean =>
  state === "succeeded" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "interrupted" ||
  state === "skipped";
