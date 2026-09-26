// Every query this area makes against pier.db, and nothing else; the schema is
// db.ts's migration list.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { pierDb, statements, transact } from "../db.js";
import type { AgentRole, LeadPhase } from "../core/types.js";
import { createdRole, type TaskDefinition, type TaskGroup, type TaskMessage, type TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const clamp = (limit: number, cap: number): number => Math.min(Math.max(limit, 1), cap);

/** Kept unmatched probes per watch: one page of history, which is all any
 *  surface lists of a probe that found nothing. */
const KEPT_PROBES = 50;

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

  /** Runs launched by any of `sessionIds`: in flight, or finished at or after `since`. */
  ledgerRuns(sessionIds: string[], since: number): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.invokedBySessionId') IN (SELECT value FROM json_each(?))
        AND (state IN ('queued', 'running') OR json_extract(json, '$.finishedAt') >= ?)
        AND NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0)
      ORDER BY queued_at DESC, id DESC LIMIT 200
    `, JSON.stringify(sessionIds), since);
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
    if (!run || createdRole(run) !== "lead" || run.context.definition.action.type !== "agent") return undefined;
    return run.context.definition.action.launch?.design ? "design" : "build";
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
    return this.#one(`
      SELECT json FROM task_runs WHERE json_extract(json, '$.targetSessionId') = ? ORDER BY queued_at DESC, id DESC LIMIT 1
    `, sessionId);
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

  expirePendingMessages(): TaskMessage[] {
    return this.#many<TaskMessage>("SELECT json FROM task_messages WHERE state = 'pending'").map((message) => {
      message.state = "expired";
      // "Confirmed", not "completed": the proof lives in a transcript this
      // layer cannot see.
      message.error = "Pier restarted before delivery could be confirmed";
      this.saveMessage(message);
      return message;
    });
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

  interruptRunning(now = Date.now()): TaskRun[] {
    return this.#many<TaskRun>(
      "SELECT json FROM task_runs WHERE state IN ('queued', 'running')",
    ).map((run) => {
      run.state = "interrupted";
      run.error = "Pier restarted while the run was active";
      run.finishedAt = now;
      if (run.callbackSessionId) run.callbackState = "pending";
      this.saveRun(run);
      return run;
    });
  }
}
