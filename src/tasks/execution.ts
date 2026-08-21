import { AgentTaskRunner } from "./agent.js";
import { TaskCallbacks } from "./callbacks.js";
import { runBash } from "./command.js";
import { TaskDefinitions } from "./definitions.js";
import { TaskStore } from "./store.js";
import type { TaskResult, TaskRun } from "./types.js";

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
    this.controllers.get(id)?.abort();
  }

  private async execute(run: TaskRun): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, run.context.definition.timeoutSeconds * 1000);
    timeout.unref();
    try {
      const { definition } = run.context;
      if (definition.trigger.type === "watch" && !run.resumedFromRunId) {
        this.markRunning(run);
        run.probe = await runBash(definition.trigger.script, definition.trigger.cwd, run.input, controller.signal);
        run.matched = run.probe.exitCode === 0;
        this.store.saveRun(run);
        if (run.probe.exitCode === 1) run.result = { type: "watch", matched: false };
        else if (run.probe.exitCode !== 0) throw new Error(`watch probe exited ${String(run.probe.exitCode)}`);
      }
      if (run.matched !== false) run.result = await this.executeAction(run, controller.signal);
      run.state = "succeeded";
      if (definition.trigger.type === "watch" && !run.resumedFromRunId && definition.trigger.mode === "once" && run.matched) {
        this.definitions.setEnabled(definition.id, false);
      }
    } catch (error) {
      // A killed child reports `exited null`, not `cancelled`: report why we
      // aborted instead of how the corpse looked.
      const aborted = controller.signal.aborted;
      run.state = aborted ? (timedOut ? "failed" : "cancelled") : "failed";
      run.error = timedOut ? "task timed out" : aborted ? "cancelled" : String(error);
    } finally {
      clearTimeout(timeout);
      run.finishedAt = Date.now();
      // A run that ends awaiting a supervisor decision suppresses its
      // completion callback: the pending question is the notification.
      if (run.callbackSessionId && !this.host.openDecisionId(run.id)) run.callbackState = "pending";
      this.store.saveRun(run);
      this.controllers.delete(run.id);
      this.host.changed(run);
      this.host.settled(run);
      if (run.callbackState === "pending") void this.callbacks.deliver(run);
    }
  }

  private async executeAction(run: TaskRun, signal: AbortSignal): Promise<TaskResult> {
    const action = run.context.definition.action;
    if (action.type === "bash") {
      this.markRunning(run);
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
    if (action.type === "task") {
      this.markRunning(run);
      const child = this.host.runChild(action.taskId, run);
      let rejectWait = (reason?: unknown): void => { void reason; };
      const aborted = new Promise<never>((_, reject) => { rejectWait = reject; });
      const onAbort = (): void => {
        this.host.cancel(child.id);
        rejectWait(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const done = await Promise.race([this.host.waitForRun(child.id), aborted]);
        if (done.state !== "succeeded") throw new Error(`child run ${done.state}`);
        return { type: "task", runId: done.id, result: done.result };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    return this.agent.execute(run, action, signal, () => this.markRunning(run));
  }

  private markRunning(run: TaskRun): void {
    if (run.state === "running") return;
    run.state = "running";
    run.startedAt = Date.now();
    this.store.saveRun(run);
    this.host.changed(run);
  }
}
