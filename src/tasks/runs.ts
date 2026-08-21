import { randomUUID } from "node:crypto";
import { TaskCallbacks } from "./callbacks.js";
import { TaskStore } from "./store.js";
import type { TaskDefinition, TaskRun } from "./types.js";

const MAX_DEPTH = 2;
const MAX_CHILDREN_PER_ROOT = 16;

export interface RunProvenance {
  invokedBySessionId?: string | null;
  sourceSessionId?: string | null;
  targetSessionId?: string | null;
  callbackSessionId?: string | null;
  background?: boolean;
  sessionMode?: "reuse" | "fresh" | "fork";
  groupId?: string | null;
  resumedFromRunId?: string | null;
  rootRunId?: string;
  depth?: number;
  resumePrompt?: string;
}

export class TaskRunQueue {
  constructor(
    private readonly store: TaskStore,
    private readonly callbacks: TaskCallbacks,
    private readonly getRun: (id: string) => TaskRun,
    private readonly execute: (run: TaskRun) => void,
    private readonly changed: (run: TaskRun) => void,
  ) {}

  enqueue(
    definition: TaskDefinition,
    input: unknown,
    source: TaskRun["triggerSource"],
    parentRunId: string | null,
    provenance: RunProvenance,
  ): TaskRun {
    const id = randomUUID();
    const parent = parentRunId ? this.getRun(parentRunId) : null;
    const depth = provenance.depth ?? (parent ? parent.depth + 1 : 0);
    const rootRunId = provenance.rootRunId ?? parent?.rootRunId ?? id;
    if (depth > MAX_DEPTH) throw new Error(`subagent depth limit is ${MAX_DEPTH}`);
    if (depth > 0 && this.store.listRunsByRoot(rootRunId, MAX_CHILDREN_PER_ROOT + 1).filter((run) => run.depth > 0).length >= MAX_CHILDREN_PER_ROOT) {
      throw new Error(`subagent child limit is ${MAX_CHILDREN_PER_ROOT} per root run`);
    }
    const invokedBySessionId = provenance.invokedBySessionId ?? null;
    const sourceSessionId = provenance.sourceSessionId ?? invokedBySessionId;
    const sessionMode = definition.action.type === "agent"
      ? provenance.sessionMode ?? definition.action.session.mode
      : null;
    if (sessionMode === "fork" && !sourceSessionId) throw new Error("fork requires a source session");
    if (sessionMode === "fork" && (source === "cron" || source === "watch")) {
      throw new Error("scheduled and watch runs cannot fork a caller session");
    }
    const targetSessionId = provenance.targetSessionId ?? (
      definition.action.type === "agent" && sessionMode === "reuse" && definition.action.session.mode === "reuse"
        ? definition.action.session.sessionId
        : null
    );
    const callbackSessionId = provenance.callbackSessionId !== undefined
      ? provenance.callbackSessionId
      : this.callbacks.target(definition.callback, invokedBySessionId);
    // Overlap is derived from the durable run store — no parallel bookkeeping.
    const interactiveAgent = definition.action.type === "agent" && source !== "cron" && source !== "watch";
    const overlapped = !interactiveAgent && this.store.findActiveRun(definition.id) !== undefined;
    const now = Date.now();
    const run: TaskRun = {
      id,
      taskId: definition.id,
      taskRevision: definition.revision,
      parentRunId,
      groupId: provenance.groupId ?? null,
      rootRunId,
      depth,
      resumedFromRunId: provenance.resumedFromRunId ?? null,
      triggerSource: source,
      invokedBySessionId,
      sourceSessionId,
      targetSessionId,
      sessionMode,
      callbackSessionId,
      background: provenance.background ?? false,
      callbackState: overlapped && callbackSessionId ? "pending" : null,
      callbackAttempts: 0,
      callbackError: null,
      callbackNextAttemptAt: null,
      state: overlapped ? "skipped" : "queued",
      input,
      context: {
        definition: structuredClone(definition),
        ...(provenance.resumePrompt ? { resumePrompt: provenance.resumePrompt } : {}),
      },
      probe: null,
      matched: null,
      result: null,
      error: null,
      skipReason: overlapped ? "overlap" : null,
      queuedAt: now,
      startedAt: null,
      finishedAt: overlapped ? now : null,
    };
    this.store.saveRun(run);
    this.changed(run);
    if (run.state === "queued") this.execute(run);
    else if (run.callbackState === "pending") void this.callbacks.deliver(run);
    return run;
  }
}
