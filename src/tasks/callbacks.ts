// What a finished run says to the session that delegated it. Delivery itself
// belongs to outbox.ts; this file owns the run vocabulary and the batching.

import type { SystemInputSource } from "../core/types.js";
import type { Router } from "../core/router.js";
import { Outbox } from "./outbox.js";
import type { TaskStore } from "./store.js";
import type { TaskCallback, TaskRun } from "./types.js";

/** The run id and the session that did the work: a relayer's next move is a
 *  deep link to it, and without this that costs a second tool call. */
export const runRef = (run: TaskRun): string =>
  `Run: ${run.id}${run.targetSessionId ? ` / Session: ${run.targetSessionId}` : ""}`;

/** What the card in the recipient's transcript says the input came from. */
export const runSource = (run: TaskRun): SystemInputSource => ({
  taskName: run.context.definition.name,
  ...(run.context.model ? { model: run.context.model } : {}),
  ...(run.context.thinking ? { thinking: run.context.thinking } : {}),
});

export function runResultText(run: TaskRun): string {
  let result = run.error ?? "No result";
  if (run.result?.type === "agent" || run.result?.type === "system") result = run.result.text;
  if (run.result?.type === "bash") result = run.result.stdout || run.result.stderr || `exit ${String(run.result.exitCode)}`;
  if (run.result?.type === "task") result = JSON.stringify(run.result.result);
  if (run.result?.type === "watch") result = "Watch condition did not match";
  if (result.length > 8000) result = `${result.slice(0, 8000)}\n[truncated — task tool recover run_id ${run.id} with a reason returns the full text]`;
  return result;
}

export class TaskCallbacks {
  private readonly outbox: Outbox<TaskRun>;

  constructor(
    private readonly store: TaskStore,
    router: Router,
    changed: (run: TaskRun) => void,
    unreachable: (sessionId: string, what: string, why: string) => void,
  ) {
    this.outbox = new Outbox<TaskRun>(router, {
      id: (run) => run.id,
      reload: (id) => this.store.getRun(id),
      save: (run) => { this.store.saveRun(run); },
      changed,
      input: (runs) => ({
        text: this.text(runs),
        origin: {
          kind: "task-callback",
          taskId: runs[0]!.taskId,
          runId: runs[0]!.id,
          sourceSessionId: runs[0]!.targetSessionId,
          runIds: runs.map((run) => run.id),
          // Only for one run: a batch's caption would attribute every result
          // to the first run's name and model.
          ...(runs.length === 1 ? { source: runSource(runs[0]!), state: runs[0]!.state } : {}),
        },
      }),
      describe: (run) => `the result of "${run.context.definition.name}"`,
    }, unreachable);
  }

  target(callback: TaskCallback, origin: string | null): string | null {
    if (callback.type === "session") return callback.sessionId;
    if (callback.type === "origin") return origin;
    return null;
  }

  recover(now = Date.now()): void {
    for (const run of this.store.listPendingCallbacks(now)) void this.deliver(run);
  }

  /** Delivers the candidate together with every other deliverable callback
   * aimed at the same session. */
  async deliver(candidate: TaskRun): Promise<void> {
    const first = this.store.getRun(candidate.id);
    if (!first?.callbackSessionId || (first.callbackState !== "pending" && first.callbackState !== "failed")) return;
    const sessionId = first.callbackSessionId;
    // Once one callback is deliverable, everything pending for the session rides along.
    const batch = this.store.listPendingCallbacks(Number.MAX_SAFE_INTEGER)
      .filter((run) => run.callbackSessionId === sessionId);
    if (!batch.some((run) => run.id === first.id)) return;
    await this.outbox.deliver(sessionId, batch);
  }

  private text(runs: TaskRun[]): string {
    const sections = runs.map((run) => [
      `Task "${run.context.definition.name}" finished with state: ${run.state}`,
      runRef(run),
      "",
      runResultText(run),
    ].join("\n"));
    if (sections.length === 1) return sections[0]!;
    return [`${String(sections.length)} task callbacks`, "", sections.join("\n\n---\n\n")].join("\n");
  }
}
