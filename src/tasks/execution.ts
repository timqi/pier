// One queued run carried to a result: dispatched by action kind, abortable,
// settled exactly once. The lifecycle command.ts and agent.ts share.

import { logger } from "../log.js";
import type { AgentTaskRunner } from "./agent.js";
import type { TaskCallbacks } from "./callbacks.js";
import { runBash } from "./command.js";
import type { TaskDefinitions } from "./definitions.js";
import type { TaskStore } from "./store.js";
import type { TaskResult, TaskRun } from "./types.js";

const log = logger("tasks");

interface ExecutionHost {
  runChild(taskId: string, parent: TaskRun): TaskRun;
  waitForRun(id: string): Promise<TaskRun>;
  cancel(id: string): void;
  settled(run: TaskRun): void;
  changed(run: TaskRun): void;
  openDecisionId(runId: string): string | null;
}

export class TaskExecution {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: TaskStore,
    private readonly definitions: TaskDefinitions,
    private readonly callbacks: TaskCallbacks,
    private readonly agent: AgentTaskRunner,
    private readonly host: ExecutionHost,
  ) {}

  start(run: TaskRun): void {
    void this.execute(run);
  }

  stop(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  cancel(id: string): void {
    log.info(`run ${id} cancel requested`);
    this.controllers.get(id)?.abort();
  }

  private async execute(run: TaskRun): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let timedOut = false;
    let cause: unknown;
    let timeout: NodeJS.Timeout | undefined;
    // The budget is the run's own: waiting for an agent slot or a busy session
    // (agent.ts) is bounded by cancellation and restart, never by the timeout.
    const start = (): void => {
      timeout ??= setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort();
      }, run.context.definition.timeoutSeconds * 1000).unref();
      if (run.state === "running") return;
      run.state = "running";
      run.startedAt = Date.now();
      this.store.saveRun(run);
      this.host.changed(run);
    };
    try {
      const { definition } = run.context;
      if (definition.trigger.type === "watch" && !run.resumedFromRunId) {
        start();
        run.probe = await runBash(definition.trigger.script, definition.trigger.cwd, run.input, controller.signal);
        run.matched = run.probe.exitCode === 0;
        this.store.saveRun(run);
        if (run.probe.exitCode === 1) run.result = { type: "watch", matched: false };
        else if (run.probe.exitCode !== 0) throw new Error(`watch probe exited ${String(run.probe.exitCode)}`);
      }
      if (run.matched !== false) run.result = await this.executeAction(run, controller.signal, start);
      controller.signal.throwIfAborted();
      run.state = "succeeded";
      if (definition.trigger.type === "watch" && !run.resumedFromRunId && definition.trigger.mode === "once" && run.matched) {
        // As the definition's own creator, or the owner guard (definitions.ts)
        // would fail the run that just succeeded.
        this.definitions.setEnabled(definition.id, false, definition.creator);
      }
    } catch (error) {
      // A killed child reports `exited null`; report why we aborted instead.
      const aborted = controller.signal.aborted;
      run.state = aborted ? (timedOut ? "failed" : "cancelled") : "failed";
      run.error = timedOut ? "task timed out" : aborted ? "cancelled" : String(error);
      cause = timedOut ? run.error : error;
    } finally {
      clearTimeout(timeout);
      run.finishedAt = Date.now();
      const seconds = ((run.finishedAt - (run.startedAt ?? run.queuedAt)) / 1000).toFixed(1);
      const settled = `run ${run.id} (${run.context.definition.name}) ${run.state} in ${seconds}s`;
      // Nobody opens the Console to find out a scheduled run failed. A watch
      // probe that did not match fires every interval and would be most of the journal.
      if (run.state === "failed") log.error(settled, cause);
      else if (run.matched === false) log.debug(`${settled} (watch did not match)`);
      else log.info(settled);
      // A run that ends awaiting a supervisor decision suppresses its
      // completion callback: the pending question is the notification.
      if (run.callbackSessionId && !this.host.openDecisionId(run.id)) run.callbackState = "pending";
      this.controllers.delete(run.id);
      try {
        this.store.saveRun(run);
      } catch (err) {
        // Waiters settle from the in-memory run; the callback reads the stale
        // row and waits for the next boot's interrupt sweep.
        log.error(`run ${run.id} final save failed — callback/join deferred to next boot`, err);
      }
      if (run.matched === false) this.store.pruneUnmatchedProbes(run.taskId);
      this.host.changed(run);
      this.host.settled(run);
      if (run.callbackState === "pending") void this.callbacks.deliver(run);
    }
  }

  private async executeAction(run: TaskRun, signal: AbortSignal, start: () => void): Promise<TaskResult> {
    signal.throwIfAborted();
    const action = run.context.definition.action;
    if (action.type === "bash") {
      start();
      run.context.cwd = action.cwd;
      this.store.saveRun(run);
      const result = await runBash(action.script, action.cwd, run.input, signal);
      const output: TaskResult = { type: "bash", ...result };
      if (result.exitCode !== 0) {
        run.result = output;
        throw new Error(`bash exited ${String(result.exitCode)}`);
      }
      return output;
    }
    if (action.type === "system") {
      start();
      const handler = this.definitions.systemAction(action.name, run.context.definition.creator);
      signal.throwIfAborted();
      const text = await handler(signal);
      signal.throwIfAborted();
      return { type: "system", text };
    }
    if (action.type === "task") {
      start();
      const child = this.host.runChild(action.taskId, run);
      let rejectWait = (reason?: unknown): void => { void reason; };
      const aborted = new Promise<never>((_, reject) => { rejectWait = reject; });
      const onAbort = (): void => {
        this.host.cancel(child.id);
        rejectWait(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        const done = await Promise.race([this.host.waitForRun(child.id), aborted]);
        if (done.state !== "succeeded") throw new Error(`child run ${done.state}`);
        return { type: "task", runId: done.id, result: done.result };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    return this.agent.execute(run, action, signal, start);
  }
}
