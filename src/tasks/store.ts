import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";
import type { TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const clamp = (limit: number, cap: number): number => Math.min(Math.max(limit, 1), cap);

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.db = db;
  }

  // Every table is one JSON column plus query columns; these two are the only
  // readers, and the one seam where a future schema change normalizes old rows
  // (pre-v1 databases are refused outright in db.ts).
  #one<T>(sql: string, ...params: (string | number)[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }

  #many<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...params) as unknown as JsonRow[])
      .map((row) => JSON.parse(row.json) as T);
  }

  listTasks(): TaskDefinition[] {
    return this.#many("SELECT json FROM tasks ORDER BY updated_at DESC");
  }

  getTask(id: string): TaskDefinition | undefined {
    return this.#one("SELECT json FROM tasks WHERE id = ?", id);
  }

  saveTask(task: TaskDefinition): void {
    this.db.prepare(`
      INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json
    `).run(task.id, task.updatedAt, JSON.stringify(task));
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
    this.db.prepare(`
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

  listRecentRuns(limit = 100): TaskRun[] {
    return this.#many(
      "SELECT json FROM task_runs ORDER BY queued_at DESC LIMIT ?",
      clamp(limit, 500),
    );
  }

  listRunsByRoot(rootRunId: string, limit = 100): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.rootRunId') = ?
      ORDER BY queued_at LIMIT ?
    `, rootRunId, clamp(limit, 500));
  }

  countActiveRuns(): number {
    const row = this.db.prepare(
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

  listRunsForSession(sessionId: string, limit = 50): TaskRun[] {
    return this.#many(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.invokedBySessionId') = ?
      ORDER BY queued_at DESC LIMIT ?
    `, sessionId, clamp(limit, 200));
  }

  saveGroup(group: TaskGroup): void {
    this.db.prepare(`
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
    this.db.prepare(`
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

  /** Messages whose injection never landed: the delivery sweep retries these. */
  listUndeliveredMessages(): TaskMessage[] {
    return this.#many(
      "SELECT json FROM task_messages WHERE state IN ('pending', 'failed') ORDER BY created_at",
    );
  }

  /** Decisions are excluded: they have no timeout and stay answerable across
   * restarts — a reply to a terminal run resumes it. */
  expirePendingMessages(): TaskMessage[] {
    return this.#many<TaskMessage>(`
      SELECT json FROM task_messages
      WHERE state = 'pending' AND json_extract(json, '$.kind') != 'decision'
    `).map((message) => {
      message.state = "expired";
      // "Confirmed", not "completed": the input may well have been read — the
      // proof of it lives in the recipient's transcript, which this layer
      // cannot see, and the run it steered is interrupted by the same restart.
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
