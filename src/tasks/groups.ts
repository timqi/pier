import { Router } from "../core/router.js";
import { logger } from "../log.js";
import { runResultText } from "./callbacks.js";
import { newId } from "./definitions.js";
import { Outbox } from "./outbox.js";
import { TaskStore } from "./store.js";
import type { GroupJoinMode, TaskDefinition, TaskGroup, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

const log = logger("tasks");

interface GroupHost {
  getRun(id: string): TaskRun;
  cancel(id: string): void;
  openDecisionId(runId: string): string | null;
  startMember(taskId: string, groupId: string, callerSessionId: string, parentRunId: string | null): TaskRun;
}

/** Core-owned fan-out join: members run detached, the group delivers one
 * aggregated callback when the join condition is met (design 04). */
export class TaskGroups {
  private readonly outbox: Outbox<TaskGroup>;

  constructor(
    private readonly store: TaskStore,
    router: Router,
    private readonly host: GroupHost,
    private readonly changed: (group: TaskGroup) => void,
    unreachable: (sessionId: string, what: string, why: string) => void,
  ) {
    this.outbox = new Outbox<TaskGroup>(router, {
      id: (group) => group.id,
      reload: (id) => this.store.getGroup(id),
      save: (group) => { this.store.saveGroup(group); },
      changed,
      // A group names itself in the origin where a run names its run id, so the
      // engine's transcript proof works unchanged.
      input: (groups) => ({
        text: this.text(groups[0]!),
        origin: { kind: "task-callback", taskId: groups[0]!.id, runId: groups[0]!.id, sourceSessionId: null },
      }),
      describe: (group) => `the result of a ${String(group.memberRunIds.length)}-run group`,
    }, unreachable);
  }

  /** Enqueues every member or none: a partially started group is worse than
   * a rejected one. */
  runAll(
    definitions: TaskDefinition[],
    join: GroupJoinMode,
    callerSessionId: string,
    parentRunId: string | null,
    callbackSessionId: string | null,
  ): { group: TaskGroup; runs: TaskRun[] } {
    const group = this.create(join, callerSessionId, callbackSessionId);
    const runs: TaskRun[] = [];
    try {
      for (const definition of definitions) {
        runs.push(this.host.startMember(definition.id, group.id, callerSessionId, parentRunId));
      }
    } catch (error) {
      log.warn(`group ${group.id} rolled back after ${String(runs.length)} members`, error);
      for (const run of runs) this.host.cancel(run.id);
      throw error;
    }
    this.setMembers(group, runs.map((run) => run.id));
    return { group: this.get(group.id), runs };
  }

  members(id: string): { group: TaskGroup; members: TaskRun[] } {
    const group = this.get(id);
    return { group, members: group.memberRunIds.map((runId) => this.host.getRun(runId)) };
  }

  cancelAll(id: string): TaskGroup {
    for (const runId of this.get(id).memberRunIds) this.host.cancel(runId);
    return this.get(id);
  }

  private create(join: GroupJoinMode, invokedBySessionId: string, callbackSessionId: string | null): TaskGroup {
    const group: TaskGroup = {
      id: newId(),
      join,
      invokedBySessionId,
      callbackSessionId,
      memberRunIds: [],
      winnerRunId: null,
      callbackState: null,
      callbackAttempts: 0,
      callbackError: null,
      callbackNextAttemptAt: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.store.saveGroup(group);
    return group;
  }

  private setMembers(group: TaskGroup, runIds: string[]): void {
    group.memberRunIds = runIds;
    this.store.saveGroup(group);
    this.changed(group);
  }

  private get(id: string): TaskGroup {
    const group = this.store.getGroup(id);
    if (!group) throw new Error(`unknown task group: ${id}`);
    return group;
  }

  onSettled(run: TaskRun): void {
    if (!run.groupId) return;
    const group = this.store.getGroup(run.groupId);
    if (group && !group.finishedAt && group.memberRunIds.length > 0) this.evaluate(group);
  }

  recover(now = Date.now()): void {
    for (const group of this.store.listOpenGroups(now)) {
      if (!group.finishedAt) this.evaluate(group);
      else void this.deliver(group);
    }
  }

  private evaluate(group: TaskGroup): void {
    const members = group.memberRunIds.map((id) => this.host.getRun(id));
    if (group.join === "first") {
      const winner = members.find((run) => isTerminal(run.state));
      if (!winner) return;
      group.winnerRunId = winner.id;
      // Losers are cancelled, not erased: their sessions stay resumable.
      for (const run of members) if (!isTerminal(run.state)) this.host.cancel(run.id);
    } else if (!members.every((run) => isTerminal(run.state))) {
      return;
    }
    group.finishedAt = Date.now();
    group.callbackState = group.callbackSessionId ? "pending" : null;
    this.store.saveGroup(group);
    this.changed(group);
    if (group.callbackState === "pending") void this.deliver(group);
  }

  /** The engine owns retry, proof and the ceiling; a group is a batch of one. */
  async deliver(candidate: TaskGroup): Promise<void> {
    const group = this.store.getGroup(candidate.id);
    if (!group?.callbackSessionId || (group.callbackState !== "pending" && group.callbackState !== "failed")) return;
    await this.outbox.deliver(group.callbackSessionId, [group]);
  }

  private text(group: TaskGroup): string {
    const members = group.memberRunIds.map((id) => this.host.getRun(id));
    const sections = members.map((run) => {
      const head = [
        `- "${run.context.definition.name}" \u2014 state: ${run.state}`,
        `  Run: ${run.id}${run.targetSessionId ? ` / Session: ${run.targetSessionId}` : ""}`,
      ];
      const decision = this.host.openDecisionId(run.id);
      if (decision) head.push(`  Needs a decision: reply to message ${decision}`);
      if (group.join === "first" && run.id !== group.winnerRunId) {
        head.push("  Cancelled after the winning run; resume its session to recover partial work.");
        return head.join("\n");
      }
      return [...head, "", runResultText(run)].join("\n");
    });
    return [
      `Task group finished (join: ${group.join}) with ${String(members.length)} runs`,
      `Group: ${group.id}`,
      "",
      sections.join("\n\n---\n\n"),
    ].join("\n");
  }
}
