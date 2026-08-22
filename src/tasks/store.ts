import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";
import type { TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const parseTask = (json: string): TaskDefinition => JSON.parse(json) as TaskDefinition;
const parseRun = (json: string): TaskRun => JSON.parse(json) as TaskRun;

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync = pierDb()) {
    this.db = db;
  }

  listTasks(): TaskDefinition[] {
    return (this.db.prepare("SELECT json FROM tasks ORDER BY updated_at DESC").all() as unknown as JsonRow[])
      .map((r) => parseTask(r.json));
  }

  getTask(id: string): TaskDefinition | undefined {
    const row = this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id) as
      | JsonRow
      | undefined;
    return row ? parseTask(row.json) : undefined;
  }

  saveTask(task: TaskDefinition): void {
    this.db.prepare(`
      INSERT INTO tasks(id, updated_at, json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json
    `).run(task.id, task.updatedAt, JSON.stringify(task));
  }

  listRuns(taskId: string, limit = 50, offset = 0): TaskRun[] {
    return (this.db.prepare(`
      SELECT json FROM task_runs WHERE task_id = ?
      ORDER BY queued_at DESC LIMIT ? OFFSET ?
    `).all(taskId, limit, offset) as unknown as JsonRow[])
      .map((r) => parseRun(r.json));
  }

  getRun(id: string): TaskRun | undefined {
    const row = this.db.prepare("SELECT json FROM task_runs WHERE id = ?").get(id) as
      | JsonRow
      | undefined;
    return row ? parseRun(row.json) : undefined;
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
    return (this.db.prepare(`
      SELECT json FROM task_runs ORDER BY queued_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)) as unknown as JsonRow[])
      .map((row) => parseRun(row.json));
  }

  listRunsByRoot(rootRunId: string, limit = 100): TaskRun[] {
    return (this.db.prepare(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.rootRunId') = ?
      ORDER BY queued_at LIMIT ?
    `).all(rootRunId, Math.min(Math.max(limit, 1), 500)) as unknown as JsonRow[])
      .map((row) => parseRun(row.json));
  }

  findActiveRun(taskId: string): TaskRun | undefined {
    const row = this.db.prepare(`
      SELECT json FROM task_runs
      WHERE task_id = ? AND state IN ('queued', 'running') LIMIT 1
    `).get(taskId) as JsonRow | undefined;
    return row ? parseRun(row.json) : undefined;
  }

  findActiveRunForTarget(sessionId: string): TaskRun | undefined {
    const row = this.db.prepare(`
      SELECT json FROM task_runs
      WHERE state IN ('queued', 'running')
        AND json_extract(json, '$.targetSessionId') = ?
      ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, queued_at DESC LIMIT 1
    `).get(sessionId) as JsonRow | undefined;
    return row ? parseRun(row.json) : undefined;
  }

  listRunsForSession(sessionId: string, limit = 50): TaskRun[] {
    return (this.db.prepare(`
      SELECT json FROM task_runs
      WHERE json_extract(json, '$.invokedBySessionId') = ?
      ORDER BY queued_at DESC LIMIT ?
    `).all(sessionId, Math.min(Math.max(limit, 1), 200)) as unknown as JsonRow[])
      .map((row) => parseRun(row.json));
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
    const row = this.db.prepare("SELECT json FROM task_groups WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as TaskGroup : undefined;
  }

  /** Unfinished joins plus deliverable group callbacks, for settle and recovery. */
  listOpenGroups(now = Date.now()): TaskGroup[] {
    return (this.db.prepare(`
      SELECT json FROM task_groups
      WHERE finished_at IS NULL
        OR (callback_state IN ('pending', 'failed')
          AND (json_extract(json, '$.callbackNextAttemptAt') IS NULL
            OR json_extract(json, '$.callbackNextAttemptAt') <= ?))
      ORDER BY created_at
    `).all(now) as unknown as JsonRow[]).map((row) => JSON.parse(row.json) as TaskGroup);
  }

  saveMessage(message: TaskMessage): void {
    this.db.prepare(`
      INSERT INTO task_messages(id, run_id, state, created_at, json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, json=excluded.json
    `).run(message.id, message.runId, message.state, message.createdAt, JSON.stringify(message));
  }

  getMessage(id: string): TaskMessage | undefined {
    const row = this.db.prepare("SELECT json FROM task_messages WHERE id = ?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as TaskMessage : undefined;
  }

  listMessages(runId: string): TaskMessage[] {
    return (this.db.prepare(`
      SELECT json FROM task_messages WHERE run_id = ? ORDER BY created_at
    `).all(runId) as unknown as JsonRow[]).map((row) => JSON.parse(row.json) as TaskMessage);
  }

  listRecentMessages(since: number, limit = 200): TaskMessage[] {
    return (this.db.prepare(`
      SELECT json FROM task_messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?
    `).all(since, Math.min(Math.max(limit, 1), 500)) as unknown as JsonRow[])
      .map((row) => JSON.parse(row.json) as TaskMessage);
  }

  /** Messages whose injection never landed: the delivery sweep retries these. */
  listUndeliveredMessages(): TaskMessage[] {
    return (this.db.prepare(`
      SELECT json FROM task_messages WHERE state IN ('pending', 'failed') ORDER BY created_at
    `).all() as unknown as JsonRow[]).map((row) => JSON.parse(row.json) as TaskMessage);
  }

  /** Decisions are excluded: they have no timeout and stay answerable across
   * restarts — a reply to a terminal run resumes it. */
  expirePendingMessages(): TaskMessage[] {
    const rows = this.db.prepare(`
      SELECT json FROM task_messages
      WHERE state = 'pending' AND json_extract(json, '$.kind') != 'decision'
    `).all() as unknown as JsonRow[];
    return rows.map((row) => {
      const message = JSON.parse(row.json) as TaskMessage;
      message.state = "expired";
      message.error = "Pier restarted before delivery completed";
      this.saveMessage(message);
      return message;
    });
  }

  listPendingCallbacks(now = Date.now()): TaskRun[] {
    return (this.db.prepare(`
      SELECT json FROM task_runs
      WHERE callback_state IN ('pending', 'failed')
        AND (json_extract(json, '$.callbackNextAttemptAt') IS NULL
          OR json_extract(json, '$.callbackNextAttemptAt') <= ?)
      ORDER BY queued_at
    `).all(now) as unknown as JsonRow[]).map((row) => parseRun(row.json));
  }

  interruptRunning(now = Date.now()): TaskRun[] {
    const rows = this.db.prepare(
      "SELECT json FROM task_runs WHERE state IN ('queued', 'running')",
    ).all() as unknown as JsonRow[];
    return rows.map((row) => {
      const run = parseRun(row.json);
      run.state = "interrupted";
      run.error = "Pier restarted while the run was active";
      run.finishedAt = now;
      if (run.callbackSessionId) run.callbackState = "pending";
      this.saveRun(run);
      return run;
    });
  }

}
