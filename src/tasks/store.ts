import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskDefinition, TaskMessage, TaskRun } from "./types.js";

interface JsonRow {
  json: string;
}

const parseTask = (json: string): TaskDefinition => JSON.parse(json) as TaskDefinition;
const parseRun = (json: string): TaskRun => JSON.parse(json) as TaskRun;

export function defaultTaskDbPath(): string {
  return join(process.env.PIER_HOME ?? join(homedir(), ".pier"), "pier.db");
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(path = defaultTaskDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        callback_state TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_runs_task_time
        ON task_runs(task_id, queued_at DESC);
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_messages_run_time
        ON task_messages(run_id, created_at);
    `);
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

  expirePendingMessages(now = Date.now()): TaskMessage[] {
    const rows = this.db.prepare("SELECT json FROM task_messages WHERE state = 'pending'").all() as unknown as JsonRow[];
    return rows.map((row) => {
      const message = JSON.parse(row.json) as TaskMessage;
      message.state = "expired";
      message.error = "Pier restarted before delivery completed";
      if (message.kind === "decision") message.answeredAt = now;
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

  close(): void {
    this.db.close();
  }
}
