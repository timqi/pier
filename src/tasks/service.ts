import type { AgentFactory, BackgroundRun } from "../core/types.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { AgentTaskRunner } from "./agent.js";
import { TaskCallbacks } from "./callbacks.js";
import { TaskDefinitions, requiredString } from "./definitions.js";
import { TaskExecution } from "./execution.js";
import { TaskMessenger } from "./messages.js";
import { TaskRunQueue, type RunProvenance } from "./runs.js";
import { TaskStore } from "./store.js";
import { handleTaskTool } from "./tool.js";
import type { TaskDefinition, TaskMessage, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

type TriggerSource = TaskRun["triggerSource"];
type Waiter = (run: TaskRun) => void;

export class TaskService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly messages: TaskMessenger;
  private readonly definitions: TaskDefinitions;
  private readonly callbacks: TaskCallbacks;
  private readonly runs: TaskRunQueue;
  private readonly execution: TaskExecution;

  constructor(
    readonly store: TaskStore,
    factory: AgentFactory,
    router: Router,
    private readonly hub: EventHub,
  ) {
    this.messages = new TaskMessenger(store, router, hub);
    this.definitions = new TaskDefinitions(store, factory, router, hub);
    this.callbacks = new TaskCallbacks(store, router, (run) => this.changed(run));
    const agent = new AgentTaskRunner(factory, router, store, this.messages, (run) => this.changed(run));
    this.execution = new TaskExecution(store, this.definitions, this.callbacks, agent, {
      runChild: (taskId, parent) => this.run(taskId, parent.input, "task", parent.id, {
        invokedBySessionId: parent.invokedBySessionId,
        sourceSessionId: parent.sourceSessionId,
        callbackSessionId: null,
        background: false,
      }),
      waitForRun: (id) => this.waitForRun(id),
      cancel: (id) => { this.cancel(id); },
      settled: (run) => this.settled(run),
      changed: (run) => this.changed(run),
    });
    this.runs = new TaskRunQueue(
      store,
      this.callbacks,
      (id) => this.getRun(id),
      (run) => this.execution.start(run),
      (run) => this.changed(run),
    );
  }

  start(tickMs = 1000): void {
    if (this.timer) return;
    const now = Date.now();
    for (const run of this.store.interruptRunning(now)) this.changed(run);
    this.messages.expirePending();
    this.definitions.resetNextRuns(now);
    this.callbacks.recover(now);
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.execution.stop();
  }

  list(): TaskDefinition[] {
    return this.definitions.list();
  }

  get(id: string): TaskDefinition {
    return this.definitions.get(id);
  }

  create(raw: unknown, creator = "http"): Promise<TaskDefinition> {
    return this.definitions.create(raw, creator);
  }

  update(id: string, raw: unknown): Promise<TaskDefinition> {
    return this.definitions.update(id, raw);
  }

  setEnabled(id: string, enabled: boolean): TaskDefinition {
    return this.definitions.setEnabled(id, enabled);
  }

  archive(id: string): TaskDefinition {
    return this.definitions.archive(id);
  }

  sessionExists(sessionId: string): Promise<boolean> {
    return this.definitions.sessionExists(sessionId);
  }

  listRuns(taskId: string, limit = 50, offset = 0): TaskRun[] {
    this.get(taskId);
    return this.store.listRuns(taskId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
  }

  getRun(id: string): TaskRun {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`unknown task run: ${id}`);
    return run;
  }

  listMessages(runId: string): TaskMessage[] {
    this.getRun(runId);
    return this.messages.list(runId);
  }

  recentRuns(limit = 100): TaskRun[] {
    return this.store.listRecentRuns(limit);
  }

  recentMessages(since: number, limit = 200): TaskMessage[] {
    return this.messages.recent(since, limit);
  }

  backgroundRuns(sessionId: string): BackgroundRun[] {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.store.listRunsForSession(sessionId, 50)
      .filter((run) => run.background && (!isTerminal(run.state) || run.queuedAt >= cutoff))
      .slice(0, 20)
      .reverse()
      .map((run) => this.backgroundRun(run));
  }

  run(
    taskId: string,
    input: unknown = null,
    source: TriggerSource = "manual",
    parentRunId: string | null = null,
    provenance: RunProvenance = {},
  ): TaskRun {
    const task = this.get(taskId);
    if (task.archived) throw new Error("archived tasks cannot run");
    return this.runs.enqueue(task, input, source, parentRunId, provenance);
  }

  async waitForRun(id: string, signal?: AbortSignal): Promise<TaskRun> {
    const current = this.getRun(id);
    if (isTerminal(current.state)) return current;
    if (signal?.aborted) throw new Error("wait cancelled");
    return new Promise((resolve, reject) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
      // An aborted caller must not leave its waiter behind forever.
      signal?.addEventListener("abort", () => {
        set.delete(resolve);
        reject(new Error("wait cancelled"));
      }, { once: true });
    });
  }

  async waitForRuns(ids: string[], mode: "all" | "first" = "all", signal?: AbortSignal): Promise<TaskRun[]> {
    if (!ids.length) throw new Error("run_ids required");
    const waits = [...new Set(ids)].map((id) => this.waitForRun(id, signal));
    return mode === "first" ? [await Promise.race(waits)] : Promise.all(waits);
  }

  cancel(id: string): TaskRun {
    const run = this.getRun(id);
    if (isTerminal(run.state)) return run;
    this.execution.cancel(id);
    return this.getRun(id);
  }

  async control(id: string, fromSessionId: string, mode: "steer" | "follow_up", message: string): Promise<TaskMessage> {
    const run = this.getRun(id);
    if (run.context.definition.action.type !== "agent") throw new Error("only Agent runs can be steered");
    if (isTerminal(run.state)) throw new Error("terminal run cannot be steered; resume it instead");
    return this.messages.control(run, fromSessionId, mode, message);
  }

  reply(messageId: string, fromSessionId: string, message: string): Promise<TaskMessage> {
    return this.messages.reply(messageId, fromSessionId, message);
  }

  resume(
    id: string,
    message: string,
    provenance: Pick<RunProvenance, "invokedBySessionId" | "callbackSessionId" | "background"> = {},
  ): TaskRun {
    const prior = this.getRun(id);
    if (!isTerminal(prior.state)) throw new Error("run must be terminal before resume");
    if (prior.context.definition.action.type !== "agent" || !prior.targetSessionId) {
      throw new Error("only persisted Agent runs can be resumed");
    }
    const prompt = requiredString(message, "message");
    return this.runs.enqueue(prior.context.definition, null, "agent", null, {
      ...provenance,
      sourceSessionId: provenance.invokedBySessionId ?? prior.invokedBySessionId,
      targetSessionId: prior.targetSessionId,
      sessionMode: "reuse",
      resumedFromRunId: prior.id,
      rootRunId: prior.rootRunId,
      depth: prior.depth,
      resumePrompt: prompt,
    });
  }

  tool(raw: unknown, callerSessionId: string, signal?: AbortSignal): Promise<unknown> {
    return handleTaskTool(this, this.definitions, this.store, this.messages, raw, callerSessionId, signal);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const task of this.definitions.claimDue(now)) {
        this.run(task.id, null, task.trigger.type === "watch" ? "watch" : "cron");
      }
      this.callbacks.recover(now);
    } finally {
      this.ticking = false;
    }
  }

  private settled(run: TaskRun): void {
    const waiters = this.waiters.get(run.id);
    if (waiters) for (const resolve of waiters) resolve(run);
    this.waiters.delete(run.id);
  }

  private backgroundRun(run: TaskRun): BackgroundRun {
    return {
      runId: run.id,
      taskId: run.taskId,
      taskName: run.context.definition.name,
      state: run.state,
      targetSessionId: run.targetSessionId,
      sessionMode: run.sessionMode,
      depth: run.depth,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  private changed(run: TaskRun): void {
    this.hub.emitWorkspace({ type: "task-run-changed", taskId: run.taskId, runId: run.id });
    if (run.background && run.invokedBySessionId) {
      this.hub.emit(run.invokedBySessionId, { type: "task-status", run: this.backgroundRun(run) });
    }
  }
}
