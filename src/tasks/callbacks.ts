import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { TaskStore } from "./store.js";
import { outbox, type TaskCallback, type TaskRun } from "./types.js";

const log = logger("tasks");

export function runResultText(run: TaskRun): string {
  let result = run.error ?? "No result";
  if (run.result?.type === "agent") result = run.result.text;
  if (run.result?.type === "bash") result = run.result.stdout || run.result.stderr || `exit ${String(run.result.exitCode)}`;
  if (run.result?.type === "task") result = JSON.stringify(run.result.result);
  if (run.result?.type === "watch") result = "Watch condition did not match";
  if (result.length > 8000) result = `${result.slice(0, 8000)}\n[truncated — task tool get run_id ${run.id} returns the full text]`;
  return result;
}

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

  /** Delivers the candidate and, in the same system input, every other
   * deliverable callback aimed at the same session: one model turn drains the
   * backlog instead of one turn per run. */
  async deliver(candidate: TaskRun): Promise<void> {
    if (this.delivering.has(candidate.id)) return;
    const first = this.store.getRun(candidate.id);
    if (!first?.callbackSessionId || (first.callbackState !== "pending" && first.callbackState !== "failed")) return;
    const sessionId = first.callbackSessionId;
    // Ignore retry due-times when sweeping the batch: once one callback is
    // deliverable, everything pending for the session rides along.
    const batch = this.store.listPendingCallbacks(Number.MAX_SAFE_INTEGER).filter(
      (run) => run.callbackSessionId === sessionId && !this.delivering.has(run.id),
    );
    if (!batch.some((run) => run.id === first.id)) return;
    for (const run of batch) this.delivering.add(run.id);
    try {
      const session = await this.router.ensure({ channelId: "task", conversationId: sessionId });
      // Crash-window idempotency: any run id already present in a persisted
      // callback input (single or batched) must not be sent again.
      const seen = new Set<string>();
      for (const turn of await session.history()) {
        if (turn.role !== "system" || turn.origin?.kind !== "task-callback") continue;
        for (const id of turn.origin.runIds ?? [turn.origin.runId]) seen.add(id);
      }
      const fresh = batch.filter((run) => !seen.has(run.id));
      // Waiting for a busy target is not a delivery attempt: counting it would
      // inflate `callbackAttempts` once per second and skip the real failure
      // backoff straight to its ceiling.
      if (fresh.length > 0 && session.state === "streaming") {
        for (const run of batch) {
          outbox.defer(run);
          this.store.saveRun(run);
        }
        return;
      }
      for (const run of batch) {
        outbox.attempt(run);
        this.store.saveRun(run);
      }
      // `systemInput` resolves when the turn it triggers settles, not when Pi
      // accepts the input — so mark delivered first and let a rejection below
      // flip it to failed. Otherwise a recipient turn that runs for minutes
      // leaves the run "pending" and a restart in that window re-delivers.
      const sent = fresh.length > 0
        ? session.systemInput(
          this.text(fresh),
          {
            kind: "task-callback",
            taskId: fresh[0]!.taskId,
            runId: fresh[0]!.id,
            sourceSessionId: fresh[0]!.targetSessionId,
            runIds: fresh.map((run) => run.id),
          },
          "followUp",
        )
        : Promise.resolve();
      for (const run of batch) {
        outbox.delivered(run);
        this.store.saveRun(run);
        this.changed(run);
      }
      if (fresh.length > 0) {
        log.debug(`callback for ${fresh.map((run) => run.id).join(", ")} → session ${sessionId}`);
      }
      await sent;
    } catch (error) {
      // The delegating agent is waiting for an answer that is now late: the
      // retry is silent, so this line is the only sign it is being retried.
      log.warn(`callback to session ${sessionId} failed, will retry`, error);
      for (const stale of batch) {
        const run = this.store.getRun(stale.id);
        if (!run) continue;
        outbox.failed(run, error);
        this.store.saveRun(run);
        this.changed(run);
      }
    } finally {
      for (const run of batch) this.delivering.delete(run.id);
    }
  }

  private text(runs: TaskRun[]): string {
    const sections = runs.map((run) => [
      `Task "${run.context.definition.name}" finished with state: ${run.state}`,
      `Run: ${run.id}`,
      "",
      runResultText(run),
    ].join("\n"));
    if (sections.length === 1) return sections[0]!;
    return [`${String(sections.length)} task callbacks`, "", sections.join("\n\n---\n\n")].join("\n");
  }
}
