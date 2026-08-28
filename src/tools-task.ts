// One reason: a tools switch has to become exactly one run of the one task
// Pier owns — which takes knowing what that task runs, keeping it the task
// Pier wrote, and turning a burst of switches into one run of it.
//
// It lives beside tools.ts rather than inside it because tools.ts may not
// import tasks/, and outside main.ts because main.ts is wiring: this is the
// only rule in the instance layer that is neither construction nor a callback.
// The task's run history *is* the tools status surface — the install, the daily
// update and every failure are runs with output, so there is no second place to
// look (§5b).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "./log.js";
import { PIER_HOME } from "./paths.js";
import type { TaskService } from "./tasks/service.js";
import { isTerminal } from "./tasks/types.js";
import { coalescedSync, type SyncAttempt } from "./tools.js";
import type { ToolsSyncNote } from "./web/types.js";

/** Marks the daily update task as Pier's own — this file finds the one it owns
 *  rather than one a person wrote, and names itself with it when it writes the
 *  definition back (the owner guard in tasks/definitions.ts). */
const TOOLS_TASK_CREATOR = "tools";

// The area these lines have always logged under: the move must not rename
// anything an operator greps the journal for.
const log = logger("pier");

/** POSIX single quotes: `$`, a backtick and a backslash mean things inside
 *  double quotes, and this string is run by bash months from now. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * How this Pier runs `pier tools sync`. Installed, that is the built CLI beside
 * main.js. From a source checkout there is no `cli.js` and node cannot strip
 * types through imports that still say `.js`, so it is the same command under
 * tsx — which is what a source checkout has. Neither available is a refusal
 * with a reason, never a task whose script cannot run.
 */
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
  /** Which task is Pier's, and the id every managed run goes through. */
  let toolsTaskId: string | null = null;

  /**
   * The one task Pier owns, brought in line with what it should be.
   *
   * Created once and never retired: a task that comes and goes is a state class
   * of its own (two boots racing to create it, a retirement racing a switch),
   * and the run it would have been retired for already says "no tools switched
   * on". Repaired rather than trusted, because the task routes can edit it and a
   * switch must not silently run somebody's edited script.
   */
  const ensureToolsTask = async (): Promise<{ id: string } | { problem: string }> => {
    const command = toolsSyncScript();
    if ("problem" in command) return { problem: command.problem };
    const draft = {
      name: "tools: daily update",
      description: "Installs the CLI tools switched on in Settings → Agent and keeps them current.",
      trigger: {
        type: "cron" as const,
        expression: "17 4 * * *",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
      // PIER_HOME as cwd: the command belongs to the instance, not to a project.
      action: { type: "bash" as const, script: command.script, cwd: PIER_HOME },
      timeoutSeconds: 1800,
    };
    const draftShape = [draft.name, draft.description, true, draft.trigger, draft.action, { type: "none" }, draft.timeoutSeconds];
    // Archived is not "owned but edited": nothing can un-archive a task, so the
    // replacement is a new one and the old one keeps its history.
    const owned = tasks.list().filter((task) => task.creator === TOOLS_TASK_CREATOR && !task.archived);
    // One per creator. Two would fight over ubix's state lock every night, each
    // reporting the other's run as an overlap.
    for (const extra of owned.slice(1)) {
      log.warn(`archiving a second tools update task (${extra.id})`);
      tasks.archive(extra.id, TOOLS_TASK_CREATOR);
    }
    const task = owned[0];
    // Every field Pier owns, not just the command: a paused task, a renamed one
    // or one pointed at a callback still claims to be keeping the tools current
    // while the daily run never happens.
    const current = task &&
      JSON.stringify([task.name, task.description, task.enabled, task.trigger, task.action, task.callback, task.timeoutSeconds]);
    if (task && current !== JSON.stringify(draftShape)) {
      log.warn("the tools update task was edited — restoring the definition Pier owns");
      // Named as the owner: this is the one path allowed to write it back
      // (tasks/definitions.ts).
      await tasks.update(task.id, { ...draft, enabled: true, callback: { type: "none" } }, TOOLS_TASK_CREATOR);
    }
    const id = task ? task.id : (await tasks.create(draft, TOOLS_TASK_CREATOR)).id;
    toolsTaskId = id;
    return { id };
  };

  /** The half of `coalescedSync` (tools.ts, which has the rule and why) that
   *  knows what a task is: start a run, and hand back what to wait for — our own
   *  run, or the one already in flight that made ours a `skipped` row. */
  const requestSync = coalescedSync((): SyncAttempt => {
    if (!toolsTaskId) throw new Error("no tools update task to run");
    const settled = (id: string): Promise<void> => tasks.waitForRun(id).then(() => undefined);
    // Bounded, because the only way round this loop is a run that finished
    // between being in flight and being asked about: real, rare, and not
    // something to spin on. Three refusals in a row with nothing running is a
    // bug, and it is reported as one rather than retried forever.
    for (let attempt = 0; attempt < 3; attempt++) {
      const mine = tasks.run(toolsTaskId, null, "manual");
      if (!isTerminal(mine.state)) return { ran: "started", settled: settled(mine.id) };
      const active = tasks.activeRun(toolsTaskId);
      if (active) return { ran: "overlapped", settled: settled(active.id) };
    }
    throw new Error("the tools sync was refused as an overlap three times with nothing running");
  }, (err: unknown) => log.error("the tools sync could not be run", err));

  /** A switch was flipped: make sure the task is the one Pier means, then ask
   *  for a sync. Answers with what that switch should say about it. */
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
    /** Reconcile now. At boot, before any route exists: two first flips could
     *  otherwise both find no task and create one each. */
    reconcile: ensureToolsTask,
    /** The task whose runs are the status surface, null until there is one. */
    id: () => toolsTaskId,
    changed: toolsChanged,
  };
}
