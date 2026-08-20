import { Router } from "../core/router.js";
import { TaskStore } from "./store.js";
import type { TaskCallback, TaskRun } from "./types.js";

export class TaskCallbacks {
  private readonly delivering = new Set<string>();

  constructor(
    private readonly store: TaskStore,
    private readonly router: Router,
    private readonly changed: (run: TaskRun) => void,
  ) {}

  target(callback: TaskCallback, origin: string | null): string | null {
    if (callback.type === "session") return callback.sessionId;
    if (callback.type === "origin") return origin;
    return null;
  }

  recover(now = Date.now()): void {
    for (const run of this.store.listPendingCallbacks(now)) void this.deliver(run);
  }

  async deliver(candidate: TaskRun): Promise<void> {
    if (this.delivering.has(candidate.id)) return;
    this.delivering.add(candidate.id);
    try {
      const run = this.store.getRun(candidate.id);
      if (!run?.callbackSessionId || (run.callbackState !== "pending" && run.callbackState !== "failed")) return;
      run.callbackAttempts += 1;
      run.callbackState = "pending";
      run.callbackError = null;
      this.store.saveRun(run);
      const session = await this.router.ensure({ channelId: "task", conversationId: run.callbackSessionId });
      const alreadyDelivered = (await session.history()).some((turn) =>
        turn.role === "system" && turn.origin?.kind === "task-callback" && turn.origin.runId === run.id);
      if (!alreadyDelivered && session.state === "streaming") {
        run.callbackNextAttemptAt = Date.now() + 1000;
        this.store.saveRun(run);
        return;
      }
      if (!alreadyDelivered) {
        await session.systemInput(
          this.text(run),
          { kind: "task-callback", taskId: run.taskId, runId: run.id, sourceSessionId: run.targetSessionId },
          "followUp",
        );
      }
      run.callbackState = "delivered";
      run.callbackNextAttemptAt = null;
      this.store.saveRun(run);
      this.changed(run);
    } catch (error) {
      const run = this.store.getRun(candidate.id);
      if (!run) return;
      run.callbackState = "failed";
      run.callbackError = String(error);
      run.callbackNextAttemptAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(run.callbackAttempts, 6));
      this.store.saveRun(run);
      this.changed(run);
    } finally {
      this.delivering.delete(candidate.id);
    }
  }

  private text(run: TaskRun): string {
    let result = run.error ?? "No result";
    if (run.result?.type === "agent") result = run.result.text;
    if (run.result?.type === "bash") result = run.result.stdout || run.result.stderr || `exit ${String(run.result.exitCode)}`;
    if (run.result?.type === "task") result = JSON.stringify(run.result.result);
    if (run.result?.type === "watch") result = "Watch condition did not match";
    if (result.length > 8000) result = `${result.slice(0, 8000)}\n[truncated; open run ${run.id}]`;
    return [`Task "${run.context.definition.name}" finished with state: ${run.state}`, `Run: ${run.id}`, "", result].join("\n");
  }
}
