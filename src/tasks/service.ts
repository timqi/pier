// The facade the rest of Pier talks to about tasks, and the clock behind it:
// the tick and the boot pass over the runs the last process left in flight.
// Decisions belong to the files beside it.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { MODEL_TIERS, type AgentFactory, type BackgroundRun, type LedgerRun, type ModelTier, type TaskRunState } from "../core/types.js";
import type { MainChain } from "../core/chain.js";
import type { EventHub } from "../core/hub.js";
import type { Router } from "../core/router.js";
import { logger } from "../log.js";
import { AgentTaskRunner, type Restart } from "./agent.js";
import { DESIGN_FINAL, ledgerRun, LEAD_TURN, MILESTONE, runModel, settleCallback, TaskCallbacks } from "./callbacks.js";
import type { Milestone } from "./outbox.js";
import { TaskDefinitions, requiredString } from "./definitions.js";
import { TaskExecution } from "./execution.js";
import { TaskGoals, type Worktree } from "./goals.js";
import { TaskGroups } from "./groups.js";
import { assertNotReplaced, planHandoff, type Handoff } from "./handoff.js";
import { TaskMessenger } from "./messages.js";
import { openItems, recordOpenItems } from "./open-items.js";
import { TaskRunQueue, type RunProvenance } from "./runs.js";
import { INTERRUPTED, type StatsRow, type TaskStore } from "./store.js";
import { handleTask } from "./operations.js";
import type { CallbackMode, Goal, GroupJoinMode, OpenItems, ParkedMessage, SystemActions, TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";
import { isTerminal } from "./types.js";

const log = logger("tasks");

/** Not `renderedPrompt`: that carries the preamble and input wrapper, which the
 *  delegating session did not send. */
const runPrompt = (run: TaskRun): string | null => {
  if (run.handoff) return run.handoff.prompt;
  if (run.context.resumePrompt) return run.context.resumePrompt;
  const action = run.context.definition.action;
  return action.type === "agent" ? action.prompt : action.type === "bash" ? action.script : null;
};

type TriggerSource = TaskRun["triggerSource"];
type ResumeProvenance = Pick<RunProvenance, "invokedBySessionId" | "callbackSessionId" | "callbackMode" | "background">;

/** The continuous conversation as tasks see it: its members launch and receive as one. */
export type TaskChain = Pick<MainChain, "chainOf" | "members">;
type Waiter = (run: TaskRun) => void;

const TIER_ORDER: StatsRow["tier"][] = [...MODEL_TIERS, "named"];

/** Never a shell; a failure throws the tool's own first line, `git <args>: …` or `wt: …`. */
const exec = (tool: "git" | "wt", cwd: string, args: string[]): Promise<string> => new Promise((done, reject) => {
  execFile(tool, args, { cwd }, (err, stdout, stderr) => {
    const why = (stderr.trim() || err?.message || "").split("\n")[0]!;
    if (err) reject(Object.assign(new Error(tool === "git" ? `git ${args.join(" ")}: ${why}` : `wt: ${why}`), { status: err.code }));
    else done(stdout.trim());
  });
});
const git = (cwd: string, ...args: string[]): Promise<string> => exec("git", cwd, args);

/** What a goal's review is pinned to (goals.ts `GoalHost.worktree`). */
async function worktree(cwd: string): Promise<Worktree> {
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`worktree ${cwd} is gone`);
  const head = await git(cwd, "rev-parse", "HEAD");
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  // A repository with no origin HEAD is the ordinary local case, not a failure: its target is main.
  const origin = await git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => null);
  const base = origin?.replace(/^origin\//, "") ?? "main";
  const baseSha = await git(cwd, "merge-base", "HEAD", base);
  const clean = (await git(cwd, "status", "--porcelain")) === "";
  return { head, branch, base, baseSha, clean };
}

/** A worktree's commits since its target, as a continuation's handoff shows them (handoff.ts). */
async function branchLog(cwd: string): Promise<string> {
  const tree = await worktree(cwd);
  const range = `${tree.baseSha.slice(0, 7)}..HEAD`;
  const clip = (out: string): string => {
    const lines = out.split("\n");
    return lines.length > 60 ? [...lines.slice(0, 60), `… ${String(lines.length - 60)} more lines`].join("\n") : out || "(none)";
  };
  return [
    `${cwd} on ${tree.branch}, target ${tree.base}${tree.clean ? "" : ", uncommitted changes present"}`,
    `$ git log --oneline ${range}`, clip(await git(cwd, "log", "--oneline", range)),
    `$ git diff --stat ${range}`, clip(await git(cwd, "diff", "--stat", range)),
  ].join("\n");
}

/** A fresh run's own worktree, `branch` off the one `cwd` has checked out: `.path` of `wt`'s JSON line. */
async function addWorktree(cwd: string, branch: string): Promise<string> {
  const from = await git(cwd, "branch", "--show-current");
  const out = await exec("wt", cwd, ["switch", "-c", branch, "-b", from, "--no-cd", "-y", "--format", "json"]);
  const path = (JSON.parse(out.split("\n")[0] || "null") as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || !path) throw new Error(`wt: no worktree path in ${JSON.stringify(out.slice(0, 200))}`);
  return path;
}

export class TaskService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** The last process's runs, read before this one can add any: a run
   *  launched while the boot waits for its secrets is not one to resume. */
  private leftover: TaskRun[];
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly messages: TaskMessenger;
  private readonly definitions: TaskDefinitions;
  private readonly callbacks: TaskCallbacks;
  private readonly groups: TaskGroups;
  private readonly runs: TaskRunQueue;
  private readonly execution: TaskExecution;
  private readonly goals: TaskGoals;
  /** Seams a test replaces: git and wt are never run by one. */
  worktree = worktree;
  addWorktree = addWorktree;
  branchLog = branchLog;

  constructor(
    readonly store: TaskStore,
    private readonly factory: AgentFactory,
    private readonly router: Router,
    private readonly hub: EventHub,
    /** Structural: tasks/ must not import settings.ts. */
    private readonly instance: {
      modelMenu(): { provider: string; id: string; thinking?: string; tier?: ModelTier }[];
      systemActions?: SystemActions;
      continuous: TaskChain;
      /** A design lead's run settled: the user's turn (`waiting`), its `Design
       *  final:` (`final`), or a run of it that did not succeed (`failed`). */
      designLead?: (run: TaskRun, state: "waiting" | "final" | "failed") => void;
      /** A child run ended abnormally where no callback note in the head's chat
       *  says so (`owesNotice`); the chat is told through the restart ledger. */
      abnormalEnd?: (run: TaskRun) => void;
    },
  ) {
    this.leftover = store.inFlightRuns();
    const headOf = (id: string): string => this.headOf(id);
    const conversation = (): string | null => this.head();
    const unreachable = (sessionId: string, what: string, why: string): void =>
      this.unreachable(sessionId, what, why);
    this.messages = new TaskMessenger(store, router, hub, unreachable, (runId) => {
      const run = store.getRun(runId);
      if (run) this.status(run);
    });
    this.definitions = new TaskDefinitions(store, factory, router, hub, instance.systemActions);
    this.callbacks = new TaskCallbacks(store, router, (run) => this.changed(run), unreachable, headOf, this.milestone, conversation);
    this.groups = new TaskGroups(store, router, {
      getRun: (id) => this.getRun(id),
      cancel: (id, by) => { this.cancel(id, by); },
      prepareMember: (taskId, groupId, callerSessionId) => this.prepareRun(taskId, null, "agent", null, {
        invokedBySessionId: callerSessionId,
        sourceSessionId: callerSessionId,
        callbackSessionId: null,
        background: true,
        groupId,
      }),
      startMember: (run) => this.runs.start(run),
    }, (group) => this.hub.emitWorkspace({ type: "task-group-changed", groupId: group.id }), unreachable, headOf, this.milestone);
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
      settled: (run, unasked) => this.settled(run, unasked),
      changed: (run) => this.changed(run),
      stopping: () => router.isStopping(),
    });
    this.runs = new TaskRunQueue(
      store,
      this.callbacks,
      (run) => this.execution.start(run),
      (run) => this.changed(run),
    );
    this.goals = new TaskGoals(store, this.definitions, {
      prepare: (definition, source, provenance) => this.runs.prepare(definition, null, source, null, provenance),
      start: (run) => this.runs.start(run),
      cancelRun: (id) => { this.execution.cancel(id); },
      models: () => this.models().then((listed) => listed.models),
      deliver: (run) => this.callbacks.deliver(run),
      worktree: (cwd) => this.worktree(cwd),
    });
    router.onTurnEnd((sessionId, text) => {
      // Only the head's turns write the list.
      if (instance.continuous.members()[0]?.sessionId === sessionId) {
        try {
          if (recordOpenItems(store, text, Date.now())) hub.emitWorkspace({ type: "open-items-changed" });
        } catch (err) {
          log.warn(`open items: the markers in ${sessionId}'s reply could not be written`, err);
        }
      }
      if (!DESIGN_FINAL.test(text)) return;
      // On Pi's dispatch stack, which must not unwind.
      try {
        this.designFinal(sessionId, text);
      } catch (err) {
        log.error(`lead ${sessionId}: a Design final: outside any run could not be recorded; main was not told`, err);
      }
    });
  }

  /** A design lead finalized in its own session, a turn outside any run (the
   *  user confirmed there): recorded as a finished run of the lead whose result
   *  is that reply, so it reports to the lead's supervisor, and the session list and
   *  `/status` see it, exactly as a run's `Design final:` does. */
  private designFinal(sessionId: string, text: string): void {
    // A run's own turn reports through the run.
    if (this.store.leadPhaseOf(sessionId) !== "design" || this.store.findActiveRunForTarget(sessionId)?.state === "running") return;
    const last = this.store.latestRunForTarget(sessionId);
    if (!last) return;
    const run = this.store.transact(() => {
      const run = this.runs.prepare(last.context.definition, null, "agent", null, {
        invokedBySessionId: last.invokedBySessionId,
        sourceSessionId: last.invokedBySessionId,
        targetSessionId: sessionId,
        sessionMode: "reuse",
        resumedFromRunId: last.id,
        callbackSessionId: last.callbackSessionId,
        callbackMode: last.callbackMode,
        background: last.background,
      });
      const now = Date.now();
      run.state = "succeeded";
      run.startedAt = run.finishedAt = now;
      run.result = { type: "agent", text, sessionId };
      run.context.sessionId = sessionId;
      settleCallback(run, this.store);
      this.store.saveRun(run);
      return run;
    });
    if (run.callbackSessionId === null) log.warn(`lead ${sessionId}: Design final: recorded as run ${run.id}; the lead reports to no one`);
    else log.info(`lead ${sessionId}: Design final: outside any run, recorded as run ${run.id} for ${run.callbackSessionId}`);
    this.runs.start(run);
    this.designLead(run);
  }

  /** What a settled run of a design lead means to whoever shows the lead to
   *  the user (channels/runtime.ts); a reporter that throws must not unwind the settle. */
  private designLead(run: TaskRun): void {
    const lead = run.targetSessionId;
    if (!this.instance.designLead || lead === null || this.store.leadPhaseOf(lead) !== "design") return;
    const state = run.callbackError === LEAD_TURN ? "waiting"
      : run.state !== "succeeded" ? "failed"
      : run.result?.type === "agent" && DESIGN_FINAL.test(run.result.text) ? "final"
      : undefined;
    if (!state) return;
    try {
      this.instance.designLead(run, state);
    } catch (err) {
      log.error(`lead ${lead}: its ${state} state could not be reported`, err);
    }
  }

  /** The clock: after the boot pass, or at once when the unlock is refused
   *  (main.ts). Pending control messages are not touched: the tick's sweep
   *  retries the ones whose run still runs and expires the rest. */
  start(tickMs = 1000): void {
    if (this.timer) return;
    const now = Date.now();
    this.definitions.resetNextRuns(now);
    this.callbacks.recover(now);
    this.goals.recover();
    this.groups.recover(now);
    this.runTimer(tickMs);
  }

  /** The runs the last process left in flight, once, after secrets and
   *  adapters are up so a resumed model has its credentials
   *  (docs/design/13-stop-and-resume.md §Task runs). `at`/`downMs` are the
   *  restart the resumed turn is told about; `queuedFor` is what the stop
   *  saved for a run's session, which the run's resume owns. */
  resumeAfterRestart({ at, downMs, queuedFor }: Omit<Restart, "queued"> & { queuedFor(sessionId: string): string[] }): void {
    const leftover = this.leftover;
    this.leftover = [];
    for (const run of leftover) {
      // A child's parent is a `task` action, which never resumes: a child must
      // not outlive the run that waits on it.
      if (run.parentRunId === null && run.state === "queued") {
        this.execution.start(run);
        continue;
      }
      const { action, trigger } = run.context.definition;
      const probing = trigger.type === "watch" && run.resumedFromRunId === null && run.matched !== true;
      if (run.parentRunId === null && action.type === "agent" && !probing) {
        log.info(`run ${run.id} (${run.context.definition.name}) resumes after a restart`);
        this.execution.start(run, { at, downMs, queued: run.targetSessionId ? queuedFor(run.targetSessionId) : [] });
        continue;
      }
      // The previous boot's log is where its work stopped.
      log.warn(`run ${run.id} (${run.context.definition.name}) interrupted by a restart`);
      run.state = "interrupted";
      run.error = INTERRUPTED;
      run.finishedAt = at;
      if (run.callbackSessionId) run.callbackState = "pending";
      this.store.saveRun(run);
      this.changed(run);
      this.abnormalEnd(run, false);
    }
    this.callbacks.recover(at);
    this.groups.recover(at);
    this.goals.recover();
  }

  private runTimer(tickMs: number): void {
    this.timer = setInterval(() => {
      // The scheduler's own loop: a throw here would stop nothing (the next
      // tick still fires) and say nothing, so due tasks would just stop.
      void this.tick().catch((err: unknown) => log.error("scheduler tick failed", err));
    }, tickMs);
    this.timer.unref();
  }

  /** The clock only: no run is touched, so what is in flight stays in flight
   *  for the next boot's pass. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs in flight, queued ones included: the auto-update's idle check. */
  activeRunCount(): number {
    return this.store.countActiveRuns();
  }

  /** A caller refused as an overlap needs this to know what to wait for;
   *  scanning run history finds nothing once skipped rows outnumber the window. */
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

  /** `by` is how owning code says so; `pier task` has none (definitions.ts). */
  update(id: string, raw: unknown, by?: string): Promise<TaskDefinition> {
    return this.definitions.update(id, raw, by);
  }

  setEnabled(id: string, enabled: boolean, by?: string): TaskDefinition {
    return this.definitions.setEnabled(id, enabled, by);
  }

  archive(id: string, by?: string): TaskDefinition {
    return this.definitions.archive(id, by);
  }

  /** `pier task list`'s last run: the newest `limit` of a definition's runs. */
  listRuns(taskId: string, limit = 1): TaskRun[] {
    return this.store.listRuns(taskId, limit);
  }

  getRun(id: string): TaskRun {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`unknown task run: ${id}`);
    return run;
  }

  /** Every run, not the last hour's: the card is a message in the transcript. */
  backgroundRuns(sessionId: string): BackgroundRun[] {
    return this.store.listRunsForSession(sessionId, 200)
      .filter((run) => run.background)
      .reverse()
      .map((run) => this.backgroundRun(run));
  }

  /** What the session's queue shows beside Pi's own: follow-ups waiting for it to idle. */
  parkedMessages(sessionId: string): ParkedMessage[] {
    return this.store.pendingFollowUpsTo(sessionId).map((message) => ({
      messageId: message.id,
      runName: this.store.getRun(message.runId)?.context.definition.name ?? message.runId,
      text: message.content,
    }));
  }

  /** The run ledger: runs any of `sessionIds` launched (every run, when null), in flight or finished since `since`, at most 200. */
  ledger(sessionIds: string[] | null, since: number, states?: readonly TaskRunState[]): LedgerRun[] {
    return this.store.ledgerRuns(sessionIds, since, states).map(ledgerRun);
  }

  /** Dispatched runs of the last `days` by launch tier, role and the model the
   *  session settled on; a run with no role is the head's own, not dispatch. */
  stats(days: number): { days: number; rows: StatsRow[] } {
    const sorted = this.store.agentRunStats(Date.now() - days * 86_400_000).sort((a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.role.localeCompare(b.role) || b.runs - a.runs);
    return { days, rows: sorted };
  }

  openItems(): OpenItems {
    return openItems(this.store, this.router, this.instance.continuous.members().map((m) => m.sessionId));
  }

  activeBackgroundRunCounts(): Map<string, number> {
    return this.store.countActiveBackgroundRunsBySession();
  }

  /** The sessions runs made for themselves, for a list of the operator's own. */
  taskSessions(): Set<string> {
    return this.store.taskOwnedSessionIds();
  }

  run(
    taskId: string,
    input: unknown = null,
    source: TriggerSource = "manual",
    parentRunId: string | null = null,
    provenance: RunProvenance = {},
  ): TaskRun {
    const run = this.prepareRun(taskId, input, source, parentRunId, provenance);
    this.runs.start(run);
    return run;
  }

  private prepareRun(
    taskId: string,
    input: unknown,
    source: TriggerSource,
    parentRunId: string | null,
    provenance: RunProvenance,
  ): TaskRun {
    const task = this.get(taskId);
    // `enabled:false` pauses scheduling only; manual and agent triggers still
    // run a paused task on demand. Archiving is the terminal state.
    if (task.archived) throw new Error("archived tasks cannot run");
    const { action, trigger } = task;
    // A row stored with `until` and no `rounds` is the goal it was (goals.open caps it at 3).
    const launch: { rounds?: number; until?: unknown } | undefined = action.type === "agent" ? action.launch : undefined;
    if (action.type !== "agent" || (launch?.rounds === undefined && launch?.until === undefined)) return this.runs.prepare(task, input, source, parentRunId, provenance);
    // operations.ts refuses these first; a goal is one launched run's loop.
    if (action.session.mode !== "fresh" || trigger.type !== "manual" || provenance.groupId || parentRunId !== null) {
      throw new Error("a goal (--rounds, --worktree) is one fresh --prompt run's, not a reused session's, a schedule's, a batch member's or a chained task's");
    }
    return this.store.transact(() => {
      const run = this.runs.prepare(task, input, source, parentRunId, provenance);
      this.goals.open(run);
      return run;
    });
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

  /** Cascades down a `task` action's chain: a child must not outlive the run
   *  that waits on it. `by` is the asking session: the head asks for the user,
   *  any other session did not, so that run's end is noticed; the cascade is not. */
  cancel(id: string, by?: string): TaskRun {
    const run = this.getRun(id);
    const goal = run.goalId ? this.store.getGoal(run.goalId) : undefined;
    if (goal?.finishedAt === null) {
      this.goals.cancel(goal, by ?? "Pier");
      return this.getRun(id);
    }
    const unasked = by !== undefined && this.headOf(by) !== this.head();
    for (const target of [run, ...this.descendants(run)]) {
      if (!isTerminal(target.state)) this.execution.cancel(target.id, unasked && target === run);
    }
    return this.getRun(id);
  }

  cancelGroup(id: string, by?: string): TaskGroup {
    return this.groups.cancelAll(id, by);
  }

  getGroup(id: string): { group: TaskGroup; members: TaskRun[] } {
    return this.groups.members(id);
  }

  runGroup(
    definitions: TaskDefinition[],
    join: GroupJoinMode,
    callerSessionId: string,
    callbackSessionId: string | null,
    callbackMode: CallbackMode,
  ): { group: TaskGroup; runs: TaskRun[] } {
    return this.groups.runAll(definitions, join, callerSessionId, callbackSessionId, callbackMode);
  }

  private descendants(run: TaskRun): TaskRun[] {
    const collected: TaskRun[] = [];
    const queue = [run.id];
    while (queue.length > 0) {
      for (const child of this.store.listChildRuns(queue.shift()!)) {
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

  /** The new session a `--run` continues `id` in (handoff.ts), or undefined to resume it in place. */
  handoff(id: string, message: string, forced: boolean): Promise<Handoff | undefined> {
    return planHandoff(this.store, (cwd) => this.branchLog(cwd), this.getRun(id), message, forced);
  }

  /** `goal`: `--rounds` beside `--run` — the resumed run roots a new goal of `cap` reviews, on
   *  `reviewModel`, else the ended goal's. `handoff`: continued in a new session instead. */
  resume(
    id: string,
    message: string,
    provenance: ResumeProvenance = {},
    goal?: { cap: number; reviewModel?: string },
    handoff?: Handoff,
  ): TaskRun {
    const prior = this.getRun(id);
    // Re-checked with the run's insert: a concurrent `--run` may have replaced the session while the handoff was planned.
    const run = this.store.transact(() => {
      assertNotReplaced(this.store, prior.targetSessionId);
      const ended = goal ? this.goalAgain(prior) : undefined;
      const run = this.prepareResume(prior, message, provenance, handoff);
      if (goal) this.goals.open(run, { cap: goal.cap, reviewModel: goal.reviewModel ?? ended!.reviewModel });
      return run;
    });
    this.runs.start(run);
    return run;
  }

  /** The user's answer to an ended goal goes back through the loop, never around it. */
  private goalAgain(prior: TaskRun): Goal {
    const goal = prior.goalId ? this.store.getGoal(prior.goalId) : undefined;
    if (goal?.rootRunId !== prior.id) throw new Error(`--rounds beside --run resumes a goal's root run; run ${prior.id} is not one${goal ? `; its root is run ${goal.rootRunId}` : ""}`);
    if (goal.finishedAt === null) throw new Error(`run ${prior.id}'s goal has not ended; cancel it or wait for its end`);
    const latest = prior.targetSessionId ? this.store.goalOf(prior.targetSessionId) : undefined;
    if (latest && latest.id !== goal.id) {
      throw new Error(`run ${prior.id}'s session is in a later goal, rooted at run ${latest.rootRunId}; --run that one`);
    }
    return goal;
  }

  private prepareResume(
    prior: TaskRun,
    message: string,
    provenance: ResumeProvenance,
    handoff?: Handoff,
  ): TaskRun {
    if (!isTerminal(prior.state)) throw new Error("run must be terminal before resume");
    if (prior.handoff && !prior.targetSessionId) {
      throw new Error(`run ${prior.id} ended before its new session opened; --run ${prior.resumedFromRunId ?? "the run it continued"} to continue that work`);
    }
    if (prior.context.definition.action.type !== "agent" || !prior.targetSessionId) {
      throw new Error("only persisted Agent runs can be resumed");
    }
    const prompt = requiredString(message, "message");
    const common = { ...provenance, sourceSessionId: provenance.invokedBySessionId ?? prior.invokedBySessionId, resumedFromRunId: prior.id };
    if (handoff) {
      return this.runs.prepare(handoff.definition, null, "agent", null, { ...common, sessionMode: "fresh", resumePrompt: handoff.text, handoff: handoff.record });
    }
    return this.runs.prepare(prior.context.definition, null, "agent", null, {
      ...common,
      targetSessionId: prior.targetSessionId,
      sessionMode: "reuse",
      resumePrompt: prompt,
    });
  }

  /** A lead reports once per wave (docs/design/10-continuous-session.md
   *  §Feature lead): the result that leaves nothing owed to it in flight
   *  resumes its last run, whose own callback reaches its supervisor. */
  private readonly milestone: Milestone = (sessionId, text, settle) => {
    if (this.store.roleOf(sessionId) !== "lead" || this.store.countOwedTo(sessionId) > 0) return "plain";
    const last = this.store.latestRunForTarget(sessionId);
    if (!last || last.callbackSessionId === null) return "plain";
    // A running turn reports upstream when it ends.
    if (!isTerminal(last.state)) return "wait";
    try {
      // One transaction: a crash between the resume and the marks would resume twice.
      const run = this.store.transact(() => {
        const run = this.prepareResume(last, `${MILESTONE}\n\n${text()}`, {
          invokedBySessionId: last.invokedBySessionId,
          callbackSessionId: last.callbackSessionId,
          callbackMode: last.callbackMode,
          background: last.background,
        });
        settle();
        return run;
      });
      this.runs.start(run);
      return "resumed";
    } catch (err) {
      log.error(`lead ${sessionId}: the wave's last result could not resume run ${last.id}; delivering it as a plain callback`, err);
      return "plain";
    }
  };

  /** What `pier task` asks, under the calling session's identity. */
  handle(raw: unknown, callerSessionId: string): Promise<unknown> {
    return handleTask(this, this.definitions, this.store, raw, callerSessionId, this.instance.continuous);
  }

  /** An agent picks from names that exist right now, never from memory. */
  async models(): Promise<{
    source: "menu" | "catalog";
    models: { provider: string; id: string; thinking?: string; tier?: ModelTier }[];
  }> {
    const menu = this.instance.modelMenu();
    if (menu.length) return { source: "menu", models: menu };
    return { source: "catalog", models: await this.factory.availableModels() };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      this.sweep("schedule", () => {
        // Per task: one enqueue that throws must not spend the other due tasks'
        // occurrence, and its own stays due for the next tick.
        for (const task of this.definitions.due(now)) {
          this.sweep(`schedule ${task.name}`, () => {
            const run = this.store.transact(() => {
              this.definitions.advance(task, now);
              return this.prepareRun(task.id, null, task.trigger.type === "watch" ? "watch" : "cron", null, {});
            });
            this.hub.emitWorkspace({ type: "tasks-changed" });
            this.runs.start(run);
          });
        }
      });
      this.sweep("run callbacks", () => this.callbacks.recover(now));
      this.sweep("group callbacks", () => this.groups.recover(now));
      this.sweep("messages", () => this.messages.retryUndelivered(now));
    } finally {
      this.ticking = false;
    }
  }

  /** Retrying forever costs the same silence as dropping, so it stops and says
   *  so on the log, the record and the recipient's event stream (§5). */
  private unreachable(sessionId: string, what: string, why: string): void {
    log.error(`gave up delivering ${what} to session ${sessionId}: ${why}`);
    this.router.reportTo(sessionId, `${what} could not be delivered — ${why}`);
  }

  /** Isolated: one sweep throwing on every pass must not starve the others. */
  private sweep(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      log.error(`${what} sweep failed`, err);
    }
  }

  private settled(run: TaskRun, unasked: boolean): void {
    const waiters = this.waiters.get(run.id);
    if (waiters) for (const resolve of waiters) resolve(run);
    this.waiters.delete(run.id);
    this.groups.onSettled(run);
    // advance() ends the goal on its own throws; this catch is for the end itself failing.
    void this.goals.advance(run).catch((err: unknown) => log.error(`run ${run.id}: its goal could not advance or end`, err));
    this.designLead(run);
    this.abnormalEnd(run, unasked);
  }

  private head(): string | null {
    return this.instance.continuous.members()[0]?.sessionId ?? null;
  }

  private headOf(id: string): string {
    return this.instance.continuous.chainOf(id)?.[0] ?? id;
  }

  /** A reporter that throws must not unwind the settle. */
  private abnormalEnd(run: TaskRun, unasked: boolean): void {
    const group = run.groupId === null ? undefined : this.store.getGroup(run.groupId);
    const resultTo = group ? group.callbackSessionId : run.callbackSessionId;
    const head = this.head();
    const toHead = resultTo !== null && head !== null && this.headOf(resultTo) === head;
    if (!this.instance.abnormalEnd || !owesNotice(run, unasked, toHead)) return;
    try {
      this.instance.abnormalEnd(run);
    } catch (err) {
      log.error(`run ${run.id}: its ${run.state} end could not be noticed`, err);
    }
  }

  private backgroundRun(run: TaskRun): BackgroundRun {
    return {
      runId: run.id,
      taskId: run.taskId,
      taskName: run.context.definition.name,
      state: run.state,
      targetSessionId: run.targetSessionId,
      sessionMode: run.sessionMode,
      prompt: runPrompt(run),
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      // A finished run's pending messages only wait for the sweep to expire them.
      queuedMessages: isTerminal(run.state) ? 0 : this.store.countPendingFollowUps(run.id),
      ...(run.goalId ? { goalId: run.goalId } : {}),
      ...(byPier(run) ? { byPier: true } : {}),
      ...runModel(run),
    };
  }

  private changed(run: TaskRun): void {
    this.hub.emitWorkspace({ type: "task-run-changed", taskId: run.taskId, runId: run.id });
    this.status(run);
  }

  private status(run: TaskRun): void {
    if (run.background && run.invokedBySessionId) {
      this.hub.emit(run.invokedBySessionId, { type: "task-status", run: this.backgroundRun(run) });
    }
  }
}

/** A lead's milestone resume carries its marker; a design final outside any run
 *  is the one resume with no prompt (`designFinal`). */
const byPier = (run: TaskRun): boolean =>
  run.triggerSource === "goal" || run.context.resumePrompt?.startsWith(MILESTONE) === true ||
  (run.resumedFromRunId !== null && !run.context.resumePrompt);

/** A child run's abnormal end the home chat would not otherwise see. An
 *  interruption always: its callback lands while no chat is connected. A failure
 *  or a cancel only when its result goes to a lead or nobody — the head's
 *  callback note says it — and a cancel only when no one asked for the user. */
export function owesNotice(run: TaskRun, unasked: boolean, resultToHead: boolean): boolean {
  if (run.invokedBySessionId === null) return false;
  if (run.state === "interrupted") return true;
  if (resultToHead) return false;
  return run.state === "failed" || (run.state === "cancelled" && unasked);
}
