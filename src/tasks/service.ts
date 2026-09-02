// The one object the rest of Pier talks to about tasks, and the clock behind
// it: the tick that finds what is due, the boot recovery that writes off runs
// a restart interrupted, and the pause a drain needs. Every decision it looks
// like it makes belongs to a file beside it (definitions, runs, execution,
// groups, messages, callbacks) — what is genuinely here is scheduling and the
// facade, so the HTTP routes and the task tool cannot drift apart.

import type { AgentFactory, BackgroundRun } from "../core/types.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { AgentTaskRunner } from "./agent.js";
import { TaskCallbacks } from "./callbacks.js";
import { TaskDefinitions, requiredString } from "./definitions.js";
import { TaskExecution } from "./execution.js";
import { TaskGroups } from "./groups.js";
import { TaskMessenger } from "./messages.js";
import { TaskRunQueue, type RunProvenance } from "./runs.js";
import { TaskStore } from "./store.js";
import { handleTaskTool } from "./tool.js";
import type { GroupJoinMode, TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

const log = logger("tasks");

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
    /** Structural on purpose: tasks/ must not import settings.ts — main.ts
     *  hands in a closure over the store instead. Absent in bare test rigs. */
    private readonly instance?: {
      modelMenu(): { provider: string; id: string; thinking?: string; note?: string }[];
    },
  ) {
    const unreachable = (sessionId: string, what: string, why: string): void =>
      this.unreachable(sessionId, what, why);
    this.messages = new TaskMessenger(store, router, hub, (runId, prompt, fromSessionId) =>
      this.resume(runId, prompt, { invokedBySessionId: fromSessionId, callbackSessionId: fromSessionId, background: true }),
      unreachable);
    this.definitions = new TaskDefinitions(store, factory, router, hub);
    this.callbacks = new TaskCallbacks(store, router, (run) => this.changed(run), unreachable);
    this.groups = new TaskGroups(store, router, {
      getRun: (id) => this.getRun(id),
      cancel: (id) => { this.cancel(id); },
      openDecisionId: (runId) => this.messages.openDecisionId(runId),
      startMember: (taskId, groupId, callerSessionId, parentRunId) => this.run(taskId, null, "agent", parentRunId, {
        invokedBySessionId: callerSessionId,
        sourceSessionId: callerSessionId,
        callbackSessionId: null,
        background: true,
        groupId,
      }),
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
      openDecisionId: (runId) => this.messages.openDecisionId(runId),
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

  /** Undo a `pause()` that was not followed by an exit — the auto-updater
   *  drains before handing over, and a handover that never started must not
   *  leave the scheduler switched off. Deliberately not `start()`: the boot
   *  recovery in there would write off runs this process is still running. */
  unpause(tickMs = 1000): void {
    if (this.timer) return;
    this.paused = false;
    this.runTimer(tickMs);
  }

  stop(): void {
    this.pause();
    this.execution.stop();
  }

  /** Stop taking new work but leave running runs alone — a graceful restart
   *  (src/drain.ts) waits for them, where stop() would abort them. The
   *  scheduler timer goes, and new root runs are refused; children of a run
   *  that is still finishing stay allowed, because refusing them would fail
   *  the very work the drain is waiting for. */
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

  /** The run this task has in flight, if any. The store already answers this
   *  for the overlap guard (runs.ts); a caller that has just been refused as
   *  an overlap needs the same answer to know what to wait for, and scanning
   *  run history for it finds nothing once the skipped rows outnumber the
   *  window. */
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

  /** `by` is how the code that owns a definition says so; the HTTP routes and
   *  the task tool have none, which is what closes both (definitions.ts). */
  update(id: string, raw: unknown, by?: string): Promise<TaskDefinition> {
    return this.definitions.update(id, raw, by);
  }

  setEnabled(id: string, enabled: boolean, by?: string): TaskDefinition {
    return this.definitions.setEnabled(id, enabled, by);
  }

  archive(id: string, by?: string): TaskDefinition {
    return this.definitions.archive(id, by);
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

  openDecisionId(runId: string): string | null {
    return this.messages.openDecisionId(runId);
  }

  recentRuns(limit = 100): TaskRun[] {
    return this.store.listRecentRuns(limit);
  }

  recentMessages(since: number): TaskMessage[] {
    return this.messages.recent(since);
  }

  backgroundRuns(sessionId: string): BackgroundRun[] {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.store.listRunsForSession(sessionId, 50)
      .filter((run) => run.background && (!isTerminal(run.state) || run.queuedAt >= cutoff))
      .slice(0, 20)
      .reverse()
      .map((run) => this.backgroundRun(run));
  }

  /** The same runs `backgroundRuns` reports as in flight, counted per session
   *  in one query — a list needs the number, not the runs. */
  activeBackgroundRunCounts(): Map<string, number> {
    return this.store.countActiveBackgroundRunsBySession();
  }

  run(
    taskId: string,
    input: unknown = null,
    source: TriggerSource = "manual",
    parentRunId: string | null = null,
    provenance: RunProvenance = {},
  ): TaskRun {
    this.refusePaused(parentRunId);
    const task = this.get(taskId);
    // `enabled:false` pauses scheduling only; manual and agent triggers still
    // run a paused task on demand. Archiving is the terminal state.
    if (task.archived) throw new Error("archived tasks cannot run");
    return this.runs.enqueue(task, input, source, parentRunId, provenance);
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

  /** Cascades: orphans must not outlive the delegation that wanted them. */
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
    parentRunId: string | null,
    callbackSessionId: string | null,
  ): { group: TaskGroup; runs: TaskRun[] } {
    this.refusePaused(parentRunId);
    return this.groups.runAll(definitions, join, callerSessionId, parentRunId, callbackSessionId);
  }

  private descendants(run: TaskRun): TaskRun[] {
    const byParent = new Map<string, TaskRun[]>();
    for (const member of this.store.listRunsByRoot(run.rootRunId, 500)) {
      if (!member.parentRunId) continue;
      const siblings = byParent.get(member.parentRunId) ?? [];
      siblings.push(member);
      byParent.set(member.parentRunId, siblings);
    }
    const collected: TaskRun[] = [];
    const queue = [run.id];
    while (queue.length > 0) {
      for (const child of byParent.get(queue.shift()!) ?? []) {
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

  reply(messageId: string, fromSessionId: string, message: string): Promise<TaskMessage> {
    return this.messages.reply(messageId, fromSessionId, message);
  }

  resume(
    id: string,
    message: string,
    provenance: Pick<RunProvenance, "invokedBySessionId" | "callbackSessionId" | "background"> = {},
  ): TaskRun {
    this.refusePaused();
    const prior = this.getRun(id);
    if (!isTerminal(prior.state)) throw new Error("run must be terminal before resume");
    if (prior.context.definition.action.type !== "agent" || !prior.targetSessionId) {
      throw new Error("only persisted Agent runs can be resumed");
    }
    const prompt = requiredString(message, "message");
    this.messages.expireDecisions(prior.id, "superseded by a manual resume");
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

  tool(raw: unknown, callerSessionId: string): Promise<unknown> {
    return handleTaskTool(this, this.definitions, this.store, this.messages, raw, callerSessionId);
  }

  /** The deployment's model advice: the operator's pinned menu when one is
   * set, the curated live catalog otherwise — an agent picks from names that
   * exist right now, never from memory. */
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
        for (const task of this.definitions.claimDue(now)) {
          this.run(task.id, null, task.trigger.type === "watch" ? "watch" : "cron");
        }
      });
      this.sweep("run callbacks", () => this.callbacks.recover(now));
      this.sweep("group callbacks", () => this.groups.recover(now));
      this.sweep("messages", () => this.messages.retryUndelivered(now));
    } finally {
      this.ticking = false;
    }
  }

  /** A delivery nobody can complete. Retrying it forever costs the same
   * silence as dropping it, so it stops here and says so on three surfaces:
   * the operator's log, the record the tool and Console read, and the event
   * stream of the session that was supposed to receive it (§5b). */
  private unreachable(sessionId: string, what: string, why: string): void {
    log.error(`gave up delivering ${what} to session ${sessionId}: ${why}`);
    this.router.reportTo(sessionId, `${what} could not be delivered — ${why}`);
  }

  /** Four independent sweeps, isolated: one throwing (a group whose member row
   * is gone throws on every pass) must not starve the retries behind it. */
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
