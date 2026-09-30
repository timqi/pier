// Every query this area makes against pier.db, and nothing else; the schema is
// db.ts's migration list.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { pierDb, statements, transact } from "../db.js";
import type { OpenItemMarker } from "../core/reply.js";
import { TASK_RUN_STATES, type AgentRole, type LeadPhase, type TaskRunState } from "../core/types.js";
import { createdPhase, createdRole, type Goal, type TaskDefinition, type TaskGroup, type TaskMessage, type TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const clamp = (limit: number, cap: number): number => Math.min(Math.max(limit, 1), cap);

/** Kept unmatched probes per watch: one page of history, which is all any
 *  surface lists of a probe that found nothing. */
const KEPT_PROBES = 50;

/** The error of a run that cannot continue after a restart: not a result, not a cancel. */
export const INTERRUPTED = "Pier restarted while the run was active";

export class TaskStore {
  /** Every query below is a fixed string, so each is compiled once. */
  private readonly sql: (sql: string) => StatementSync;

  constructor(private readonly db: DatabaseSync = pierDb()) {
    this.sql = statements(db);
  }

  /** Commit related task records before publishing events or starting work. */
  transact<T>(work: () => T): T {
    return transact(this.db, work);
  }

  // The only readers of the JSON columns, and where a schema change normalizes old rows.
  #one<T>(sql: string, ...params: (string | number)[]): T | undefined {
    const row = this.sql(sql).get(...params) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }

  #many<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.sql(sql).all(...params) as unknown as JsonRow[])
      .map((row) => JSON.parse(row.json) as T);
  }

  listTasks(): TaskDefinition[] {
    return this.#many("SELECT json FROM tasks ORDER BY updated_at DESC");
  }

  getTask(id: string): TaskDefinition | undefined {
    return this.#one("SELECT json FROM tasks WHERE id = ?", id);
  }

  saveTask(task: TaskDefinition): void {
    this.sql(`
      INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json
    `).run(task.id, task.updatedAt, JSON.stringify(task));
  }

  /** Asked of the index, not every document: an idle second reads no row. */
  listDueTasks(now: number): TaskDefinition[] {
    return this.#many(
      "SELECT json FROM tasks WHERE next_run_at IS NOT NULL AND next_run_at <= ?",
      now,
    );
  }

  listRuns(taskId: string, limit = 50): TaskRun[] {
    return this.#many("SELECT json FROM task_runs WHERE task_id = ? ORDER BY queued_at DESC LIMIT ?", taskId, limit);
  }

  getRun(id: string): TaskRun | undefined {
    return this.#one("SELECT json FROM task_runs WHERE id = ?", id);
  }

  saveRun(run: TaskRun): void {
    this.sql(`
      INSERT INTO task_runs(id, task_id, queued_at, state, callback_state, json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state=excluded.state, callback_state=excluded.callback_state, json=excluded.json
    `).run(
      run.id,
      run.taskId,
      run.queuedAt,
      run.state,
      run.callbackState,
      JSON.stringify(run),
    );
  }

  /** A watch at the five-second floor mints 17k rows a day, ~1.6 kB each, that
   *  no list shows; only rows nothing can dangle from are dropped — a child
   *  run is named in its parent's stored result. */
  pruneUnmatchedProbes(taskId: string): void {
    this.sql(`
      DELETE FROM task_runs WHERE id IN (
        SELECT r.id FROM task_runs r
        WHERE r.task_id = ? AND r.state = 'succeeded' AND json_extract(r.json, '$.matched') IS 0
          AND r.callback_state IS NULL AND json_extract(r.json, '$.groupId') IS NULL
          AND json_extract(r.json, '$.parentRunId') IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_messages m WHERE m.run_id = r.id)
          -- A NULL in this list would make NOT IN unknown for every candidate.
          AND r.id NOT IN (
            SELECT json_extract(c.json, '$.resumedFromRunId') FROM task_runs c
            WHERE c.task_id = ? AND json_extract(c.json, '$.resumedFromRunId') IS NOT NULL
          )
        ORDER BY r.queued_at DESC, r.id DESC LIMIT -1 OFFSET ?
      )
    `).run(taskId, taskId, KEPT_PROBES);
  }

  /** Runs launched by any of `sessionIds`: in flight, or finished at or after
   *  `since`; only those in `states` when given. In flight first, so the cap
   *  never drops a run still owed a result; then newest first. */
  ledgerRuns(sessionIds: string[], since: number, states?: readonly TaskRunState[]): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.invokedBySessionId') IN (SELECT value FROM json_each(?))
        AND (state IN ('queued', 'running') OR json_extract(json, '$.finishedAt') >= ?)
        AND state IN (SELECT value FROM json_each(?))
        AND NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0)
      ORDER BY state IN ('queued', 'running') DESC, queued_at DESC, id DESC LIMIT 200
    `, JSON.stringify(sessionIds), since, JSON.stringify(states ?? TASK_RUN_STATES));
  }

  /** Each lead's launches by state over its whole life, in one statement: a
   *  lead's session is one feature's, so no window or cap applies. */
  workerCounts(leadSessionIds: string[]): Map<string, Record<TaskRunState, number>> {
    const counts = new Map(leadSessionIds.map((id) => [id, Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])) as Record<TaskRunState, number>]));
    for (const r of this.sql(`
      SELECT json_extract(json, '$.invokedBySessionId') AS lead, state, COUNT(*) AS n FROM task_runs
      WHERE lead IN (SELECT value FROM json_each(?)) AND NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0)
      GROUP BY lead, state
    `).all(JSON.stringify(leadSessionIds)) as unknown as { lead: string; state: TaskRunState; n: number }[]) counts.get(r.lead)![r.state] = r.n;
    return counts;
  }

  /** Opened agent runs a session or the user fired that settled at or after
   *  `since`, newest first; skipped runs never ran. */
  finishedAgentRuns(since: number): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE state IN ('succeeded', 'failed', 'cancelled', 'interrupted')
        AND json_extract(json, '$.triggerSource') IN ('agent', 'manual', 'goal')
        AND json_extract(json, '$.context.definition.action.type') = 'agent'
        AND json_extract(json, '$.context.model') IS NOT NULL
        AND json_extract(json, '$.finishedAt') >= ?
      ORDER BY json_extract(json, '$.finishedAt') DESC
    `, since);
  }

  /** A `task` action's child runs; a cancel walks them. */
  listChildRuns(parentRunId: string): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.parentRunId') = ?
      ORDER BY queued_at LIMIT 500
    `, parentRunId);
  }

  /** Someone waits on this run's result — its own callback or its group's — so
   *  the run is one turn of its session and may not delegate (design 09). */
  supervised(run: TaskRun): boolean {
    if (run.callbackSessionId !== null) return true;
    return run.groupId !== null && (this.getGroup(run.groupId)?.callbackSessionId ?? null) !== null;
  }

  countActiveRuns(): number {
    const row = this.sql(
      "SELECT COUNT(*) AS n FROM task_runs WHERE state IN ('queued', 'running')",
    ).get() as { n: number };
    return row.n;
  }

  findActiveRun(taskId: string): TaskRun | undefined {
    return this.#one(`
      SELECT json FROM task_runs
      WHERE task_id = ? AND state IN ('queued', 'running') LIMIT 1
    `, taskId);
  }

  findActiveRunForTarget(sessionId: string): TaskRun | undefined {
    return this.#one(`
      SELECT json FROM task_runs
      WHERE state IN ('queued', 'running')
        AND json_extract(json, '$.targetSessionId') = ?
      ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, queued_at DESC LIMIT 1
    `, sessionId);
  }

  /** The state column narrows the scan to live runs; no JSON is parsed. */
  countActiveBackgroundRunsBySession(): Map<string, number> {
    const rows = this.sql(`
      SELECT json_extract(json, '$.invokedBySessionId') AS session_id, COUNT(*) AS n
      FROM task_runs
      WHERE state IN ('queued', 'running')
        AND json_extract(json, '$.background') = 1
        AND json_extract(json, '$.invokedBySessionId') IS NOT NULL
      GROUP BY session_id
    `).all() as unknown as { session_id: string; n: number }[];
    return new Map(rows.map((row) => [row.session_id, row.n]));
  }

  /** `fresh` is the one mode that makes a session rather than borrowing one;
   *  these are the agent's conversations with itself, which the session list does not
   *  list. A feature lead's is the user's too, so it is not one of them. */
  taskOwnedSessionIds(): Set<string> {
    const rows = this.sql(`
      SELECT DISTINCT json_extract(json, '$.context.sessionId') AS id
      FROM task_runs
      WHERE json_extract(json, '$.sessionMode') = 'fresh' AND id IS NOT NULL
        AND json_extract(json, '$.context.definition.action.launch.role') IS NOT 'lead'
    `).all() as unknown as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** The fresh run that made the session; a resume or a `--session`
   *  continuation never does, so the session's role is this run's for its life. */
  creatorOf(sessionId: string): TaskRun | undefined {
    return this.#one(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.targetSessionId') = ? AND json_extract(json, '$.sessionMode') = 'fresh'
      ORDER BY queued_at LIMIT 1
    `, sessionId);
  }

  roleOf(sessionId: string): AgentRole | undefined {
    const run = this.creatorOf(sessionId);
    return run && createdRole(run);
  }

  leadPhaseOf(sessionId: string): LeadPhase | undefined {
    const run = this.creatorOf(sessionId);
    return run && createdPhase(run);
  }

  /** Every lead session with its phase (as `leadPhaseOf`), its creating run,
   *  whether a run targeting it is queued or running, and — a design lead's —
   *  whether no run of it has reported `Design final:` yet, which leaves the
   *  design on the user; in one statement for the session list's listing. */
  leads(): Map<string, { phase: LeadPhase; runId: string; runLive: boolean; designOpen: boolean }> {
    const rows = this.sql(`
      SELECT c.id, c.run_id, c.design, l.id IS NOT NULL AS live, f.id IS NOT NULL AS final FROM (
        SELECT id AS run_id, json_extract(json, '$.targetSessionId') AS id,
          json_extract(json, '$.context.definition.action.launch.role') AS role,
          json_extract(json, '$.context.definition.action.launch.design') AS design,
          ROW_NUMBER() OVER (PARTITION BY json_extract(json, '$.targetSessionId') ORDER BY queued_at) AS n
        FROM task_runs
        WHERE json_extract(json, '$.sessionMode') = 'fresh' AND json_extract(json, '$.targetSessionId') IS NOT NULL
      ) c
      LEFT JOIN (
        SELECT DISTINCT json_extract(json, '$.targetSessionId') AS id FROM task_runs WHERE state IN ('queued', 'running')
      ) l ON l.id = c.id
      LEFT JOIN (
        SELECT DISTINCT json_extract(json, '$.targetSessionId') AS id FROM task_runs
        WHERE json_extract(json, '$.result.type') = 'agent'
          AND instr(char(10) || json_extract(json, '$.result.text'), char(10) || 'Design final:') > 0
      ) f ON f.id = c.id
      WHERE c.n = 1 AND c.role = 'lead'
    `).all() as unknown as { id: string; run_id: string; design: number | null; live: number; final: number }[];
    return new Map(rows.map((r) => {
      const phase: LeadPhase = r.design === 1 ? "design" : "build";
      return [r.id, { phase, runId: r.run_id, runLive: r.live === 1, designOpen: phase === "design" && r.final === 0 }];
    }));
  }

  /** What a milestone resumes, and whose supervisor it reports to. */
  latestRunForTarget(sessionId: string): TaskRun | undefined {
    // Two runs queued in one millisecond are common (a turn and the run it records); ids are random, rowid is insertion order.
    return this.#one(`
      SELECT json FROM task_runs WHERE json_extract(json, '$.targetSessionId') = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1
    `, sessionId);
  }

  /** A session's runs oldest first: a goal's review reads its worker's steering off them. */
  runsForTarget(sessionId: string): TaskRun[] {
    return this.#many("SELECT json FROM task_runs WHERE json_extract(json, '$.targetSessionId') = ? ORDER BY queued_at, rowid", sessionId);
  }

  /** Runs in flight whose result is owed to the session, their own or their
   *  unfinished group's; a finished group's losers still cancelling owe nothing. */
  countOwedTo(sessionId: string): number {
    const row = this.sql(`
      SELECT COUNT(*) AS n FROM task_runs r
      WHERE r.state IN ('queued', 'running') AND (
        json_extract(r.json, '$.callbackSessionId') = ?
        OR EXISTS (SELECT 1 FROM task_groups g WHERE g.id = json_extract(r.json, '$.groupId')
          AND g.finished_at IS NULL AND json_extract(g.json, '$.callbackSessionId') = ?))
    `).get(sessionId, sessionId) as { n: number };
    return row.n;
  }

  /** Whether a result is still coming to the session: a run in flight owed
   *  to it, or a finished run's or group's callback not yet delivered. */
  awaitsResults(sessionId: string): boolean {
    if (this.countOwedTo(sessionId) > 0) return true;
    const row = this.sql(`
      SELECT EXISTS (SELECT 1 FROM task_runs WHERE callback_state IN ('pending', 'failed')
          AND json_extract(json, '$.callbackSessionId') = ?)
        OR EXISTS (SELECT 1 FROM task_groups WHERE callback_state IN ('pending', 'failed')
          AND json_extract(json, '$.callbackSessionId') = ?) AS owed
    `).get(sessionId, sessionId) as { owed: number };
    return row.owed === 1;
  }

  listRunsForSession(sessionId: string, limit = 50): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.invokedBySessionId') = ?
      ORDER BY queued_at DESC LIMIT ?
    `, sessionId, clamp(limit, 200));
  }

  saveGoal(goal: Goal): void {
    this.sql(`
      INSERT INTO goals(id, root_run_id, current_run_id, created_at, finished_at, json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        current_run_id=excluded.current_run_id, finished_at=excluded.finished_at, json=excluded.json
    `).run(goal.id, goal.rootRunId, goal.currentRunId, goal.createdAt, goal.finishedAt, JSON.stringify(goal));
  }

  getGoal(id: string): Goal | undefined {
    return this.#one("SELECT json FROM goals WHERE id = ?", id);
  }

  /** The goal whose root run made or targets the session: an open item's run line reads it. */
  goalOf(sessionId: string): Goal | undefined {
    return this.#one(`
      SELECT g.json FROM goals g JOIN task_runs r ON r.id = g.root_run_id
      WHERE json_extract(r.json, '$.targetSessionId') = ?
      ORDER BY g.created_at DESC LIMIT 1
    `, sessionId);
  }

  /** The newest goal whose root run works in `cwd`, whoever launched it: the tree's review evidence. */
  goalIn(cwd: string): Goal | undefined {
    return this.#one(`SELECT g.json FROM goals g JOIN task_runs r ON r.id = g.root_run_id WHERE coalesce(json_extract(r.json, '$.context.cwd'),
      json_extract(r.json, '$.context.definition.action.session.cwd')) = ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1`, cwd);
  }

  /** Goals not ended, oldest first: the boot pass advances any whose current run settled unadvanced. */
  liveGoals(): Goal[] {
    return this.#many("SELECT json FROM goals WHERE finished_at IS NULL ORDER BY created_at");
  }

  saveGroup(group: TaskGroup): void {
    this.sql(`
      INSERT INTO task_groups(id, created_at, callback_state, finished_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        callback_state=excluded.callback_state, finished_at=excluded.finished_at, json=excluded.json
    `).run(group.id, group.createdAt, group.callbackState, group.finishedAt, JSON.stringify(group));
  }

  getGroup(id: string): TaskGroup | undefined {
    return this.#one("SELECT json FROM task_groups WHERE id = ?", id);
  }

  /** Unfinished joins plus deliverable group callbacks, for settle and recovery. */
  listOpenGroups(now = Date.now()): TaskGroup[] {
    return this.#many(`
      SELECT json FROM task_groups
      WHERE finished_at IS NULL
        OR (callback_state IN ('pending', 'failed')
          AND (json_extract(json, '$.callbackNextAttemptAt') IS NULL
            OR json_extract(json, '$.callbackNextAttemptAt') <= ?))
      ORDER BY created_at
    `, now);
  }

  saveMessage(message: TaskMessage): void {
    this.sql(`
      INSERT INTO task_messages(id, run_id, state, created_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, json=excluded.json
    `).run(message.id, message.runId, message.state, message.createdAt, JSON.stringify(message));
  }

  getMessage(id: string): TaskMessage | undefined {
    return this.#one("SELECT json FROM task_messages WHERE id = ?", id);
  }

  listMessages(runId: string): TaskMessage[] {
    return this.#many("SELECT json FROM task_messages WHERE run_id = ? ORDER BY created_at", runId);
  }

  /** Follow-ups parked for the session until it idles: its queue shows them. */
  pendingFollowUpsTo(sessionId: string): TaskMessage[] {
    return this.#many(`
      SELECT json FROM task_messages
      WHERE state = 'pending' AND json_extract(json, '$.kind') = 'follow_up'
        AND json_extract(json, '$.toSessionId') = ?
      ORDER BY created_at
    `, sessionId);
  }

  countPendingFollowUps(runId: string): number {
    const row = this.sql(`
      SELECT COUNT(*) AS n FROM task_messages
      WHERE run_id = ? AND state = 'pending' AND json_extract(json, '$.kind') = 'follow_up'
    `).get(runId) as { n: number };
    return row.n;
  }

  /** Each beside its run, so the sweep costs one query. A message whose run is
   *  gone comes back with `run: undefined`. */
  listUndeliveredMessages(): { message: TaskMessage; run: TaskRun | undefined }[] {
    const rows = this.sql(`
      SELECT m.json AS json, r.json AS run_json
      FROM task_messages m LEFT JOIN task_runs r ON r.id = m.run_id
      WHERE m.state IN ('pending', 'failed') ORDER BY m.created_at
    `).all() as unknown as { json: string; run_json: string | null }[];
    return rows.map((row) => ({
      message: JSON.parse(row.json) as TaskMessage,
      run: row.run_json === null ? undefined : JSON.parse(row.run_json) as TaskRun,
    }));
  }

  listPendingCallbacks(now = Date.now()): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE callback_state IN ('pending', 'failed')
        AND (json_extract(json, '$.callbackNextAttemptAt') IS NULL
          OR json_extract(json, '$.callbackNextAttemptAt') <= ?)
      ORDER BY queued_at
    `, now);
  }

  /** In queue order, so a resumed boot takes slots in the order they were asked for. */
  inFlightRuns(): TaskRun[] {
    return this.#many<TaskRun>("SELECT json FROM task_runs WHERE state IN ('queued', 'running') ORDER BY queued_at");
  }

  /** The continuous conversation's open items, oldest first; `runIds` as main wrote them. */
  openItems(): { problem: string; stage: string; runIds: string[] }[] {
    return (this.sql("SELECT problem, stage, run_ids FROM open_items ORDER BY updated_at, rowid").all() as { problem: string; stage: string; run_ids: string }[])
      .map((r) => ({ problem: r.problem, stage: r.stage, runIds: JSON.parse(r.run_ids) as string[] }));
  }

  /** Main's markers, in reply order, as one write; answers how many rows changed. */
  markOpenItems(markers: OpenItemMarker[], now: number): number {
    return this.transact(() => markers.reduce((n, m) => n + Number(m.op === "open"
      ? this.sql(`INSERT INTO open_items(problem, stage, run_ids, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(problem) DO UPDATE SET stage = excluded.stage, run_ids = excluded.run_ids, updated_at = excluded.updated_at`)
        .run(m.problem, m.stage, JSON.stringify(m.runIds), now).changes
      : this.sql("DELETE FROM open_items WHERE problem = ?").run(m.problem).changes), 0));
  }
}
