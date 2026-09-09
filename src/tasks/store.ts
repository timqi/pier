// Every query this area makes against pier.db, and nothing else; the schema is
// db.ts's migration list.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { pierDb, statements, transact } from "../db.js";
import type { RunPage, RunQuery, RunView, TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const clamp = (limit: number, cap: number): number => Math.min(Math.max(limit, 1), cap);

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

  listRuns(taskId: string, limit = 50, offset = 0): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs WHERE task_id = ?
      ORDER BY queued_at DESC LIMIT ? OFFSET ?
    `, taskId, limit, offset);
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

  /** The id breaks timestamp ties so a page boundary never repeats or skips a
   *  row. Built per call, not cached: the filter set makes it. */
  queryRuns(query: RunQuery = {}): RunPage {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (sql: string, value: string | number | undefined): void => {
      if (value !== undefined) { where.push(sql); params.push(value); }
    };
    add("r.state = ?", query.state);
    add("r.task_id = ?", query.taskId);
    add("json_extract(r.json, '$.triggerSource') = ?", query.source);
    add("r.queued_at >= ?", query.since);
    add("r.queued_at <= ?", query.until);
    // Keep this predicate identical to migration 17's partial index.
    if (!query.showUnmatched) where.push("NOT (r.state = 'succeeded' AND json_extract(r.json, '$.matched') IS 0)");
    if (query.cursor) {
      where.push("(r.queued_at, r.id) < (?, ?)");
      params.push(query.cursor.queuedAt, query.cursor.id);
    }
    const limit = clamp(query.limit ?? 50, 200);
    const rows = this.db.prepare(`
      SELECT r.json, g.callback_state AS group_callback_state,
        (SELECT m.id FROM task_messages m WHERE m.run_id = r.id
          AND m.state IN ('pending', 'delivered') AND json_extract(m.json, '$.kind') = 'decision'
          ORDER BY m.created_at, m.id LIMIT 1) AS decision_id
      FROM task_runs r LEFT JOIN task_groups g ON g.id = json_extract(r.json, '$.groupId')
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.queued_at DESC, r.id DESC LIMIT ?
    `).all(...params, limit + 1) as unknown as { json: string; decision_id: string | null; group_callback_state: RunView["groupCallbackState"] }[];
    const runs: RunView[] = rows.slice(0, limit).map((row) => ({
      ...JSON.parse(row.json) as TaskRun, pendingDecisionId: row.decision_id, groupCallbackState: row.group_callback_state,
    }));
    const last = runs.at(-1);
    return {
      runs,
      nextCursor: rows.length > limit && last ? { queuedAt: last.queuedAt, id: last.id } : null,
    };
  }

  /** Activity never limits live work; only its optional history is bounded. */
  activityRuns(since?: number): TaskRun[] {
    const active = this.#many<TaskRun>(
      "SELECT json FROM task_runs WHERE state IN ('queued', 'running') ORDER BY queued_at DESC, id DESC",
    );
    if (since === undefined) return active;
    const recent = this.#many<TaskRun>(`
      SELECT json FROM task_runs
      WHERE state NOT IN ('queued', 'running') AND queued_at >= ?
        AND NOT (state = 'succeeded' AND json_extract(json, '$.matched') IS 0)
      ORDER BY queued_at DESC, id DESC LIMIT 200
    `, since);
    return [...active, ...recent].sort((a, b) => b.queuedAt - a.queuedAt || b.id.localeCompare(a.id));
  }

  listRunsByRoot(rootRunId: string, limit = 100): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.rootRunId') = ?
      ORDER BY queued_at LIMIT ?
    `, rootRunId, clamp(limit, 500));
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
   *  these are the agent's conversations with itself, which the rail does not list. */
  taskOwnedSessionIds(): Set<string> {
    const rows = this.sql(`
      SELECT DISTINCT json_extract(json, '$.context.sessionId') AS id
      FROM task_runs
      WHERE json_extract(json, '$.sessionMode') = 'fresh' AND id IS NOT NULL
    `).all() as unknown as { id: string }[];
    return new Set(rows.map((row) => row.id));
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

  listRecentMessages(since: number): TaskMessage[] {
    return this.#many(
      "SELECT json FROM task_messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200",
      since,
    );
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

  /** Decisions are excluded: they have no timeout and stay answerable across
   * restarts — a reply to a terminal run resumes it. */
  expirePendingMessages(): TaskMessage[] {
    return this.#many<TaskMessage>(`
      SELECT json FROM task_messages
      WHERE state = 'pending' AND json_extract(json, '$.kind') != 'decision'
    `).map((message) => {
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
