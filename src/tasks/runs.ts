// A definition plus an input becomes a queued run. The depth and per-root
// limits are decided here because every caller enqueues through this one door.

import { logger } from "../log.js";
import type { TaskCallbacks } from "./callbacks.js";
import { newId } from "./definitions.js";
import type { TaskStore } from "./store.js";
import type { CallbackMode, TaskDefinition, TaskRun } from "./types.js";

const log = logger("tasks");

const MAX_DEPTH = 2;
const MAX_CHILDREN_PER_ROOT = 16;

export interface RunProvenance {
  invokedBySessionId?: string | null;
  sourceSessionId?: string | null;
  targetSessionId?: string | null;
  callbackSessionId?: string | null;
  callbackMode?: CallbackMode;
  background?: boolean;
  sessionMode?: "reuse" | "fresh";
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

  /** Validate and persist only; callers may stage several runs in a transaction. */
  prepare(
    definition: TaskDefinition,
    input: unknown,
    source: TaskRun["triggerSource"],
    parentRunId: string | null,
    provenance: RunProvenance,
  ): TaskRun {
    const id = newId();
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
      ...(provenance.callbackMode === "steer" ? { callbackMode: "steer" as const } : {}),
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
    return run;
  }

  /** Publish and execute only after all records this run relies on committed. */
  start(run: TaskRun): void {
    this.changed(run);
    const { id, depth, triggerSource: source } = run;
    const overlapped = run.skipReason === "overlap";
    const definition = run.context.definition;
    // Why a run exists is answerable only here: the row keeps the ids, not the
    // reason. A watch probe queues every interval, so it logs at debug.
    const queued = `run ${id} ${run.state}: ${definition.name} via ${source}` +
      `${overlapped ? " (overlapped)" : ""}${depth > 0 ? ` depth ${String(depth)}` : ""}`;
    if (source === "watch" && !overlapped) log.debug(queued);
    else log.info(queued);
    if (run.state === "queued") this.execute(run);
    else if (run.callbackState === "pending") void this.callbacks.deliver(run);
  }
}
