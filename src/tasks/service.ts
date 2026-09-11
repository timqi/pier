// The facade the rest of Pier talks to about tasks, and the clock behind it:
// the tick, the boot recovery that writes off interrupted runs, and the pause a
// drain needs. Decisions belong to the files beside it.

import type { AgentFactory, BackgroundRun } from "../core/types.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { AgentTaskRunner } from "./agent.js";
import { TaskCallbacks } from "./callbacks.js";
import { TaskDefinitions, requiredString } from "./definitions.js";
import { TaskExecution } from "./execution.js";
import { TaskGroups } from "./groups.js";
import { TaskMessenger } from "./messages.js";
import { TaskRunQueue, type RunProvenance } from "./runs.js";
import type { TaskStore } from "./store.js";
import { handleTask } from "./operations.js";
import type { CallbackMode, GroupJoinMode, RunPage, RunQuery, RunView, SystemActions, TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

const log = logger("tasks");

/** Not `renderedPrompt`: that carries the preamble and input wrapper, which the
 *  delegating session did not send. */
const runPrompt = (run: TaskRun): string | null => {
  if (run.context.resumePrompt) return run.context.resumePrompt;
  const action = run.context.definition.action;
  return action.type === "agent" ? action.prompt : action.type === "bash" ? action.script : null;
};

type TriggerSource = TaskRun["triggerSource"];
type Waiter = (run: TaskRun) => void;

export class TaskService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly messages: TaskMessenger;
  private readonly definitions: TaskDefinitions;
  private readonly callbacks: TaskCallbacks;
  private readonly groups: TaskGroups;
  private readonly runs: TaskRunQueue;
  private readonly execution: TaskExecution;

  constructor(
    readonly store: TaskStore,
    private readonly factory: AgentFactory,
    private readonly router: Router,
    private readonly hub: EventHub,
    /** Structural: tasks/ must not import settings.ts. Absent in bare test rigs. */
    private readonly instance?: {
      modelMenu(): { provider: string; id: string; thinking?: string; note?: string }[];
      systemActions?: SystemActions;
    },
  ) {
    const unreachable = (sessionId: string, what: string, why: string): void =>
      this.unreachable(sessionId, what, why);
    this.messages = new TaskMessenger(store, router, hub, unreachable);
    this.definitions = new TaskDefinitions(store, factory, router, hub, instance?.systemActions);
    this.callbacks = new TaskCallbacks(store, router, (run) => this.changed(run), unreachable);
    this.groups = new TaskGroups(store, router, {
      getRun: (id) => this.getRun(id),
      cancel: (id) => { this.cancel(id); },
      prepareMember: (taskId, groupId, callerSessionId) => this.prepareRun(taskId, null, "agent", null, {
        invokedBySessionId: callerSessionId,
        sourceSessionId: callerSessionId,
        callbackSessionId: null,
        background: true,
        groupId,
      }),
      startMember: (run) => this.runs.start(run),
    }, (group) => this.hub.emitWorkspace({ type: "task-group-changed", groupId: group.id }), unreachable);
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
      (run) => this.execution.start(run),
      (run) => this.changed(run),
    );
  }

  start(tickMs = 1000): void {
    if (this.timer) return;
    // A service started again after pause()/stop() takes work again; without
    // this, the refusal would outlive the drain that justified it.
    this.paused = false;
    const now = Date.now();
    // A run that was running when the process died: it is being written off
    // here, and the previous boot's log is where its work stopped.
    for (const run of this.store.interruptRunning(now)) {
      log.warn(`run ${run.id} (${run.context.definition.name}) interrupted by a restart`);
      this.changed(run);
    }
    this.messages.expirePending();
    this.definitions.resetNextRuns(now);
    this.callbacks.recover(now);
    this.groups.recover(now);
    this.runTimer(tickMs);
  }

  private runTimer(tickMs: number): void {
    this.timer = setInterval(() => {
      // The scheduler's own loop: a throw here would stop nothing (the next
      // tick still fires) and say nothing, so due tasks would just stop.
      void this.tick().catch((err: unknown) => log.error("scheduler tick failed", err));
    }, tickMs);
    this.timer.unref();
  }

  /** For a handover that never started. Not `start()`: its boot recovery would
   *  write off runs this process is still running. */
  unpause(tickMs = 1000): void {
    if (this.timer) return;
    this.paused = false;
    this.runTimer(tickMs);
  }

  stop(): void {
    this.pause();
    this.execution.stop();
  }

  /** New root runs are refused, running ones left for the drain to wait on;
   *  children of a finishing run stay allowed, or the drain fails its own work. */
  pause(): void {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private paused = false;

  private refusePaused(parentRunId: string | null = null): void {
    if (this.paused && parentRunId === null) {
      throw new Error("Pier is restarting — new task runs are not accepted; retry after the restart");
    }
  }

  /** Runs a drain still has to wait for (queued ones start when a slot frees). */
  activeRunCount(): number {
    return this.store.countActiveRuns();
  }

  /** A caller refused as an overlap needs this to know what to wait for;
   *  scanning run history finds nothing once skipped rows outnumber the window. */
  activeRun(taskId: string): TaskRun | undefined {
    return this.store.findActiveRun(taskId);
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

  /** `by` is how owning code says so; the routes and `pier task` have none (definitions.ts). */
  update(id: string, raw: unknown, by?: string): Promise<TaskDefinition> {
    return this.definitions.update(id, raw, by);
  }

  setEnabled(id: string, enabled: boolean, by?: string): TaskDefinition {
    return this.definitions.setEnabled(id, enabled, by);
  }

  archive(id: string, by?: string): TaskDefinition {
    return this.definitions.archive(id, by);
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

  getRunView(id: string): RunView {
    const run = this.getRun(id);
    return { ...run,
      groupCallbackState: run.groupId ? this.store.getGroup(run.groupId)?.callbackState ?? null : null };
  }

  listMessages(runId: string): TaskMessage[] {
    this.getRun(runId);
    return this.messages.list(runId);
  }

  queryRuns(query: RunQuery = {}): RunPage {
    return this.store.queryRuns(query);
  }

  activityRuns(since?: number): TaskRun[] {
    return this.store.activityRuns(since);
  }

  recentMessages(since: number): TaskMessage[] {
    return this.messages.recent(since);
  }

  /** Every run, not the last hour's: the card is a message in the transcript. */
  backgroundRuns(sessionId: string): BackgroundRun[] {
    return this.store.listRunsForSession(sessionId, 200)
      .filter((run) => run.background)
      .reverse()
      .map((run) => this.backgroundRun(run));
  }

  activeBackgroundRunCounts(): Map<string, number> {
    return this.store.countActiveBackgroundRunsBySession();
  }

  /** The sessions runs made for themselves, for a list of the operator's own. */
  taskSessions(): Set<string> {
    return this.store.taskOwnedSessionIds();
  }

  run(
    taskId: string,
    input: unknown = null,
    source: TriggerSource = "manual",
    parentRunId: string | null = null,
    provenance: RunProvenance = {},
  ): TaskRun {
    const run = this.prepareRun(taskId, input, source, parentRunId, provenance);
    this.runs.start(run);
    return run;
  }

  private prepareRun(
    taskId: string,
    input: unknown,
    source: TriggerSource,
    parentRunId: string | null,
    provenance: RunProvenance,
  ): TaskRun {
    this.refusePaused(parentRunId);
    const task = this.get(taskId);
    // `enabled:false` pauses scheduling only; manual and agent triggers still
    // run a paused task on demand. Archiving is the terminal state.
    if (task.archived) throw new Error("archived tasks cannot run");
    return this.runs.prepare(task, input, source, parentRunId, provenance);
  }

  async waitForRun(id: string): Promise<TaskRun> {
    const current = this.getRun(id);
    if (isTerminal(current.state)) return current;
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
    });
  }

  /** Cascades down a `task` action's chain: a child must not outlive the run
   *  that waits on it. */
  cancel(id: string): TaskRun {
    const run = this.getRun(id);
    for (const target of [run, ...this.descendants(run)]) {
      if (!isTerminal(target.state)) this.execution.cancel(target.id);
    }
    return this.getRun(id);
  }

  cancelGroup(id: string): TaskGroup {
    return this.groups.cancelAll(id);
  }

  getGroup(id: string): { group: TaskGroup; members: TaskRun[] } {
    return this.groups.members(id);
  }

  runGroup(
    definitions: TaskDefinition[],
    join: GroupJoinMode,
    callerSessionId: string,
    callbackSessionId: string | null,
    callbackMode: CallbackMode,
  ): { group: TaskGroup; runs: TaskRun[] } {
    this.refusePaused();
    return this.groups.runAll(definitions, join, callerSessionId, callbackSessionId, callbackMode);
  }

  private descendants(run: TaskRun): TaskRun[] {
    const collected: TaskRun[] = [];
    const queue = [run.id];
    while (queue.length > 0) {
      for (const child of this.store.listChildRuns(queue.shift()!)) {
        collected.push(child);
        queue.push(child.id);
      }
    }
    return collected;
  }

  async control(id: string, fromSessionId: string, mode: "steer" | "follow_up", message: string): Promise<TaskMessage> {
    const run = this.getRun(id);
    if (run.context.definition.action.type !== "agent") throw new Error("only Agent runs can be steered");
    if (isTerminal(run.state)) throw new Error("terminal run cannot be steered; resume it instead");
    return this.messages.control(run, fromSessionId, mode, message);
  }

  resume(
    id: string,
    message: string,
    provenance: Pick<RunProvenance, "invokedBySessionId" | "callbackSessionId" | "callbackMode" | "background"> = {},
  ): TaskRun {
    this.refusePaused();
    const prior = this.getRun(id);
    if (!isTerminal(prior.state)) throw new Error("run must be terminal before resume");
    if (prior.context.definition.action.type !== "agent" || !prior.targetSessionId) {
      throw new Error("only persisted Agent runs can be resumed");
    }
    const prompt = requiredString(message, "message");
    const run = this.runs.prepare(prior.context.definition, null, "agent", null, {
      ...provenance,
      sourceSessionId: provenance.invokedBySessionId ?? prior.invokedBySessionId,
      targetSessionId: prior.targetSessionId,
      sessionMode: "reuse",
      resumedFromRunId: prior.id,
      resumePrompt: prompt,
    });
    this.runs.start(run);
    return run;
  }

  /** What `pier task` asks, under the calling session's identity. */
  handle(raw: unknown, callerSessionId: string): Promise<unknown> {
    return handleTask(this, this.definitions, this.store, raw, callerSessionId);
  }

  /** An agent picks from names that exist right now, never from memory. */
  async models(): Promise<{
    source: "menu" | "catalog";
    models: { provider: string; id: string; thinking?: string; note?: string }[];
  }> {
    const menu = this.instance?.modelMenu() ?? [];
    if (menu.length) return { source: "menu", models: menu };
    return { source: "catalog", models: await this.factory.availableModels() };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      this.sweep("schedule", () => {
        // Per task: one enqueue that throws must not spend the other due tasks'
        // occurrence, and its own stays due for the next tick.
        for (const task of this.definitions.due(now)) {
          this.sweep(`schedule ${task.name}`, () => {
            const run = this.store.transact(() => {
              this.definitions.advance(task, now);
              return this.prepareRun(task.id, null, task.trigger.type === "watch" ? "watch" : "cron", null, {});
            });
            this.hub.emitWorkspace({ type: "tasks-changed" });
            this.runs.start(run);
          });
        }
      });
      this.sweep("run callbacks", () => this.callbacks.recover(now));
      this.sweep("group callbacks", () => this.groups.recover(now));
      this.sweep("messages", () => this.messages.retryUndelivered(now));
    } finally {
      this.ticking = false;
    }
  }

  /** Retrying forever costs the same silence as dropping, so it stops and says
   *  so on the log, the record and the recipient's event stream (§5). */
  private unreachable(sessionId: string, what: string, why: string): void {
    log.error(`gave up delivering ${what} to session ${sessionId}: ${why}`);
    this.router.reportTo(sessionId, `${what} could not be delivered — ${why}`);
  }

  /** Isolated: one sweep throwing on every pass must not starve the others. */
  private sweep(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      log.error(`${what} sweep failed`, err);
    }
  }

  private settled(run: TaskRun): void {
    const waiters = this.waiters.get(run.id);
    if (waiters) for (const resolve of waiters) resolve(run);
    this.waiters.delete(run.id);
    this.groups.onSettled(run);
  }

  private backgroundRun(run: TaskRun): BackgroundRun {
    return {
      runId: run.id,
      taskId: run.taskId,
      taskName: run.context.definition.name,
      state: run.state,
      targetSessionId: run.targetSessionId,
      sessionMode: run.sessionMode,
      prompt: runPrompt(run),
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
