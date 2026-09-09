// A tools switch becomes exactly one run of the one task Pier owns. Beside
// tools.ts because tools.ts may not import tasks/; the task's run history is
// the tools status surface (§5).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "./log.js";
import { PIER_HOME } from "./paths.js";
import type { TaskService } from "./tasks/service.js";
import { isTerminal } from "./tasks/types.js";
import { coalescedSync, type SyncAttempt } from "./tools.js";
import type { ToolsSyncNote } from "./web/types.js";

/** The owner guard in tasks/definitions.ts: only this creator may write it back. */
const TOOLS_TASK_CREATOR = "tools";

// "pier", not "tools": what an operator greps the journal for.
const log = logger("pier");

/** POSIX single quotes: this string is run by bash months from now. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** From a source checkout there is no `cli.js` and node cannot strip types
 *  through `.js` imports, so it is the same command under tsx. Neither
 *  available is a refusal with a reason, never a task whose script cannot run. */
const toolsSyncScript = (): { script: string } | { problem: string } => {
  const built = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(built)) return { script: `${shellQuote(process.execPath)} ${shellQuote(built)} tools sync` };
  const source = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (!existsSync(source)) return { problem: `no CLI to run: neither ${built} nor ${source} exists` };
  try {
    return {
      script: `${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve("tsx"))}` +
        ` ${shellQuote(source)} tools sync`,
    };
  } catch {
    return { problem: `running from source (${source}) and tsx is not installed — run npm install, or npm run build` };
  }
};

export function toolsTask(tasks: TaskService) {
  let toolsTaskId: string | null = null;

  /** Created once and never retired: a task that comes and goes is a state
   *  class of its own, and a run with nothing on already says so. Repairs a
   *  definition an older Pier could still edit. */
  const ensureToolsTask = async (): Promise<{ id: string } | { problem: string }> => {
    const command = toolsSyncScript();
    if ("problem" in command) return { problem: command.problem };
    const draft = {
      name: "tools: daily update",
      description: "Installs the CLI tools switched on in Settings → Agent and keeps them current.",
      enabled: true,
      trigger: {
        type: "cron" as const,
        expression: "17 4 * * *",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
      // PIER_HOME as cwd: the command belongs to the instance, not to a project.
      action: { type: "bash" as const, script: command.script, cwd: PIER_HOME },
      callback: { type: "none" as const },
      timeoutSeconds: 1800,
    };
    // Nothing can un-archive a task, so an archived one is replaced, history kept.
    const owned = tasks.list().filter((task) => task.creator === TOOLS_TASK_CREATOR && !task.archived);
    // Two would fight over ubix's state lock every night.
    for (const extra of owned.slice(1)) {
      log.warn(`archiving a second tools update task (${extra.id})`);
      tasks.archive(extra.id, TOOLS_TASK_CREATOR);
    }
    const task = owned[0];
    // Every field, not just the command: a paused or renamed task still claims
    // to keep the tools current while the daily run never happens.
    if (task && Object.entries(draft).some(([key, value]) => JSON.stringify(task[key as keyof typeof task]) !== JSON.stringify(value))) {
      log.warn("the tools update task was edited — restoring the definition Pier owns");
      await tasks.update(task.id, draft, TOOLS_TASK_CREATOR);
    }
    const id = task ? task.id : (await tasks.create(draft, TOOLS_TASK_CREATOR)).id;
    toolsTaskId = id;
    return { id };
  };

  /** The half of `coalescedSync` (tools.ts) that knows what a task is. */
  const requestSync = coalescedSync((): SyncAttempt => {
    if (!toolsTaskId) throw new Error("no tools update task to run");
    const settled = (id: string): Promise<void> => tasks.waitForRun(id).then(() => undefined);
    // A run can finish between being in flight and being asked about; three
    // refusals with nothing running is a bug, reported rather than retried.
    for (let attempt = 0; attempt < 3; attempt++) {
      const mine = tasks.run(toolsTaskId, null, "manual");
      if (!isTerminal(mine.state)) return { ran: "started", settled: settled(mine.id) };
      const active = tasks.activeRun(toolsTaskId);
      if (active) return { ran: "overlapped", settled: settled(active.id) };
    }
    throw new Error("the tools sync was refused as an overlap three times with nothing running");
  }, (err: unknown) => log.error("the tools sync could not be run", err));

  const toolsChanged = async (): Promise<ToolsSyncNote> => {
    try {
      const task = await ensureToolsTask();
      if ("problem" in task) {
        log.error(`tools cannot be managed: ${task.problem}`);
        return { state: "refused", reason: task.problem };
      }
      return { state: requestSync() };
    } catch (err) {
      log.error("the tools update task could not be reconciled", err);
      return { state: "refused", reason: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    /** At boot, before any route exists: two first flips could otherwise both create one. */
    reconcile: ensureToolsTask,
    id: () => toolsTaskId,
    changed: toolsChanged,
  };
}
