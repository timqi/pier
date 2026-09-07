// The single hourly task owned by the configuration subscription. The task
// history records manual and scheduled checks; its enabled bit follows the
// subscription, never a second independently editable switch.

import type { ConfigSync } from "./config-sync.js";
import type { TaskService } from "./tasks/service.js";
import type { ConfigSyncStatus } from "./web/types.js";

const OWNER = "config-sync";

export function configSyncTask(tasks: TaskService, sync: ConfigSync) {
  let taskId: string | null = null;
  let reconciliation: Promise<void> = Promise.resolve();
  const reconcile = (): Promise<void> => {
    const next = reconciliation.then(async () => {
      const owned = tasks.list().filter((task) => task.creator === OWNER && !task.archived);
      for (const extra of owned.slice(1)) tasks.archive(extra.id, OWNER);
      const status = sync.status();
      if (!owned.length && !status.sourceUrl) return;
      const draft = {
        name: "Configuration sync",
        description: "Checks the configuration source from Settings > Agent every hour.",
        enabled: status.enabled,
        trigger: { type: "cron" as const, expression: "23 * * * *", timezone: "UTC" },
        action: { type: "system" as const, name: OWNER },
        callback: { type: "none" as const },
        timeoutSeconds: 30,
      };
      const task = owned[0];
      if (!task) taskId = (await tasks.create(draft, OWNER)).id;
      else {
        taskId = task.id;
        if (Object.entries(draft).some(([key, value]) => JSON.stringify(task[key as keyof typeof task]) !== JSON.stringify(value))) {
          await tasks.update(task.id, draft, OWNER);
        }
      }
    });
    // A failed reconciliation must be retryable, but the caller still receives
    // the original rejection and reports it on its originating surface.
    reconciliation = next.then(() => undefined, () => undefined);
    return next;
  };
  const run = async (): Promise<string> => {
    await reconcile();
    if (!taskId || !sync.status().enabled) throw new Error("Configuration subscription is paused");
    const active = tasks.activeRun(taskId);
    const started = active ?? tasks.run(taskId, null, "manual");
    const done = await tasks.waitForRun(started.id);
    if (done.state !== "succeeded") throw new Error(done.error ?? `Configuration sync ${done.state}`);
    return done.result?.type === "system" ? done.result.text : "Configuration sync finished";
  };
  return {
    reconcile,
    run,
    status: (): ConfigSyncStatus => ({
      ...sync.status(), taskId,
      nextRunAt: taskId ? tasks.get(taskId).nextRunAt : null,
    }),
  };
}
