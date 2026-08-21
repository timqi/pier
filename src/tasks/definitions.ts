import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Cron } from "croner";
import type { AgentFactory, ThinkingLevel } from "../core/types.js";
import { isThinkingLevel } from "../core/types.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { TaskStore } from "./store.js";
import type {
  AgentLaunchPolicy,
  AgentSessionPolicy,
  AgentTaskAction,
  TaskAction,
  TaskCallback,
  TaskDefinition,
  TaskDraft,
  TaskTrigger,
} from "./types.js";

const DEFAULT_TIMEOUT = 900;
const MIN_WATCH_SECONDS = 5;

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} required`);
  return value.trim();
};

function parseTrigger(raw: unknown): TaskTrigger {
  const value = record(raw);
  if (!value) throw new Error("trigger required");
  if (value.type === "manual") return { type: "manual" };
  if (value.type === "cron") {
    const expression = requiredString(value.expression, "cron expression");
    if (expression.split(/\s+/).length !== 5) throw new Error("cron expression must have five fields");
    const timezone = requiredString(value.timezone, "cron timezone");
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    new Cron(expression, { timezone });
    return { type: "cron", expression, timezone };
  }
  if (value.type === "watch") {
    const intervalSeconds = Number(value.intervalSeconds);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_WATCH_SECONDS) {
      throw new Error(`watch interval must be at least ${MIN_WATCH_SECONDS} seconds`);
    }
    return {
      type: "watch",
      script: requiredString(value.script, "watch script"),
      cwd: requiredString(value.cwd, "watch cwd"),
      intervalSeconds,
      mode: value.mode === "once" ? "once" : "repeat",
    };
  }
  throw new Error("unknown trigger type");
}

export function nextRunAt(trigger: TaskTrigger, from: number): number | null {
  if (trigger.type === "manual") return null;
  if (trigger.type === "watch") return from + trigger.intervalSeconds * 1000;
  return new Cron(trigger.expression, { timezone: trigger.timezone }).nextRun(new Date(from))?.getTime() ?? null;
}

function parseLaunch(raw: unknown): AgentLaunchPolicy | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw);
  if (!value) throw new Error("agent launch policy must be an object");
  const launch: AgentLaunchPolicy = {};
  if (value.model !== undefined) {
    const model = record(value.model);
    if (!model) throw new Error("agent model must be an object");
    launch.model = {
      provider: requiredString(model.provider, "model provider"),
      id: requiredString(model.id, "model id"),
    };
  }
  if (value.thinking !== undefined) {
    if (!isThinkingLevel(value.thinking)) {
      throw new Error("invalid agent thinking level");
    }
    launch.thinking = value.thinking as ThinkingLevel;
  }
  if (value.capabilities !== undefined) {
    if (value.capabilities !== "read" && value.capabilities !== "write") {
      throw new Error("agent capabilities must be read or write");
    }
    launch.capabilities = value.capabilities;
  }
  return Object.keys(launch).length ? launch : undefined;
}

export class TaskDefinitions {
  constructor(
    private readonly store: TaskStore,
    private readonly factory: AgentFactory,
    private readonly router: Router,
    private readonly hub: EventHub,
  ) {}

  list(): TaskDefinition[] { return this.store.listTasks(); }

  get(id: string): TaskDefinition {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }
  async create(raw: unknown, creator = "http", kind: TaskDefinition["kind"] = "task"): Promise<TaskDefinition> {
    // The tool schema marks trigger optional, so a trigger-less new definition
    // means manual. Update keeps requiring it: replacing a cron task with a
    // draft that forgot its trigger must not silently unschedule it.
    const value = record(raw);
    const draft = await this.parseDraft(
      value && value.trigger === undefined ? { ...value, trigger: { type: "manual" } } : raw,
    );
    const now = Date.now();
    const task: TaskDefinition = {
      id: randomUUID(),
      kind,
      name: draft.name,
      description: draft.description ?? "",
      enabled: draft.enabled ?? true,
      archived: false,
      revision: 1,
      trigger: draft.trigger,
      action: draft.action,
      callback: draft.callback ?? { type: "none" },
      timeoutSeconds: draft.timeoutSeconds ?? DEFAULT_TIMEOUT,
      nextRunAt: null,
      creator,
      createdBySessionId: creator.startsWith("session:") ? creator.slice("session:".length) : null,
      createdAt: now,
      updatedAt: now,
    };
    this.assertNoCycle(task);
    task.nextRunAt = task.enabled ? nextRunAt(task.trigger, now) : null;
    this.store.saveTask(task);
    this.changed();
    return task;
  }
  async update(id: string, raw: unknown): Promise<TaskDefinition> {
    const old = this.get(id);
    if (old.archived) throw new Error("archived tasks cannot be edited");
    const draft = await this.parseDraft(raw);
    const now = Date.now();
    const task: TaskDefinition = {
      ...old,
      name: draft.name,
      description: draft.description ?? "",
      enabled: draft.enabled ?? old.enabled,
      revision: old.revision + 1,
      trigger: draft.trigger,
      action: draft.action,
      callback: draft.callback ?? old.callback,
      timeoutSeconds: draft.timeoutSeconds ?? DEFAULT_TIMEOUT,
      nextRunAt: null,
      updatedAt: now,
    };
    this.assertNoCycle(task);
    task.nextRunAt = task.enabled ? nextRunAt(task.trigger, now) : null;
    this.store.saveTask(task);
    this.changed();
    return task;
  }
  setEnabled(id: string, enabled: boolean): TaskDefinition {
    const task = this.get(id);
    if (task.archived && enabled) throw new Error("archived tasks cannot be resumed");
    task.enabled = enabled;
    task.nextRunAt = enabled ? nextRunAt(task.trigger, Date.now()) : null;
    task.updatedAt = Date.now();
    this.store.saveTask(task);
    this.changed();
    return task;
  }
  archive(id: string): TaskDefinition {
    const task = this.get(id);
    task.archived = true;
    task.enabled = false;
    task.nextRunAt = null;
    task.updatedAt = Date.now();
    this.store.saveTask(task);
    this.changed();
    return task;
  }
  resetNextRuns(now: number): void {
    for (const task of this.store.listTasks()) {
      task.nextRunAt = task.enabled && !task.archived ? nextRunAt(task.trigger, now) : null;
      this.store.saveTask(task);
    }
  }
  claimDue(now: number): TaskDefinition[] {
    const due: TaskDefinition[] = [];
    for (const task of this.store.listTasks()) {
      if (!task.enabled || task.archived || task.nextRunAt === null || task.nextRunAt > now) continue;
      task.nextRunAt = nextRunAt(task.trigger, now);
      this.store.saveTask(task);
      due.push(task);
    }
    if (due.length) this.changed();
    return due;
  }
  async sessionExists(sessionId: string): Promise<boolean> {
    return this.router.stateOf(sessionId) !== undefined ||
      (await this.factory.list()).some((session) => session.id === sessionId);
  }

  private async parseDraft(raw: unknown): Promise<TaskDraft> {
    const value = record(raw);
    if (!value) throw new Error("task definition required");
    const timeoutSeconds = value.timeoutSeconds === undefined ? DEFAULT_TIMEOUT : Number(value.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
      throw new Error("timeoutSeconds must be between 1 and 86400");
    }
    const trigger = parseTrigger(value.trigger);
    if (trigger.type === "watch") await this.assertDirectory(trigger.cwd);
    const actionRaw = record(value.action);
    // Self-documenting: tool callers (models) recover from this in one retry.
    if (!actionRaw) {
      throw new Error('action required, e.g. {"type":"agent","session":{"mode":"fresh","cwd":"/abs/path"},"prompt":"..."}');
    }
    let action: TaskAction;
    if (actionRaw.type === "bash") {
      const cwd = requiredString(actionRaw.cwd, "bash cwd");
      await this.assertDirectory(cwd);
      action = { type: "bash", script: requiredString(actionRaw.script, "bash script"), cwd };
    } else if (actionRaw.type === "task") {
      const taskId = requiredString(actionRaw.taskId, "target task");
      this.get(taskId);
      action = { type: "task", taskId };
    } else if (actionRaw.type === "agent") {
      action = await this.parseAgentAction(actionRaw, trigger);
    } else throw new Error("unknown action type");
    return {
      name: requiredString(value.name, "name"),
      description: typeof value.description === "string" ? value.description.trim() : "",
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      trigger,
      action,
      callback: await this.parseCallback(value.callback),
      timeoutSeconds,
    };
  }

  private async parseAgentAction(raw: Record<string, unknown>, trigger: TaskTrigger): Promise<AgentTaskAction> {
    const prompt = requiredString(raw.prompt, "agent prompt");
    const launch = parseLaunch(raw.launch);
    const input = record(raw.session);
    let session: AgentSessionPolicy;
    if (input?.mode === "reuse") {
      const sessionId = requiredString(input.sessionId, "agent session");
      if (!(await this.sessionExists(sessionId))) throw new Error(`unknown session: ${sessionId}`);
      session = { mode: "reuse", sessionId };
    } else if (input?.mode === "fresh") {
      const cwd = requiredString(input.cwd, "agent cwd");
      await this.assertDirectory(cwd);
      session = { mode: "fresh", cwd };
    } else if (input?.mode === "fork") {
      if (trigger.type !== "manual") throw new Error("fork Agent tasks must use a manual trigger");
      const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
      if (cwd) await this.assertDirectory(cwd);
      session = { mode: "fork", ...(cwd ? { cwd } : {}) };
    } else if (typeof raw.sessionId === "string" && raw.sessionId.trim()) {
      const sessionId = raw.sessionId.trim();
      if (!(await this.sessionExists(sessionId))) throw new Error(`unknown session: ${sessionId}`);
      session = { mode: "reuse", sessionId };
    } else {
      // Validation never mutates: a dedicated session is created explicitly
      // (POST /api/sessions) and then referenced with mode:"reuse".
      throw new Error('agent session policy required, e.g. {"mode":"fresh","cwd":"/abs/path"} or {"mode":"fork"} or {"mode":"reuse","sessionId":"..."}');
    }
    if (session.mode === "reuse" && launch) throw new Error("launch policy only applies to fresh or fork sessions");
    return { type: "agent", session, prompt, ...(launch ? { launch } : {}) };
  }

  private async parseCallback(raw: unknown): Promise<TaskCallback | undefined> {
    if (raw === undefined) return undefined;
    const value = record(raw);
    if (!value || (value.type !== "none" && value.type !== "origin" && value.type !== "session")) {
      throw new Error("invalid callback");
    }
    if (value.type !== "session") return { type: value.type };
    const sessionId = requiredString(value.sessionId, "callback session");
    if (!(await this.sessionExists(sessionId))) throw new Error(`unknown session: ${sessionId}`);
    return { type: "session", sessionId };
  }

  private assertNoCycle(candidate: TaskDefinition): void {
    const byId = new Map(this.store.listTasks().map((task) => [task.id, task]));
    byId.set(candidate.id, candidate);
    const seen = new Set<string>();
    let task: TaskDefinition | undefined = candidate;
    while (task?.action.type === "task") {
      if (seen.has(task.id)) throw new Error("task dependency cycle");
      seen.add(task.id);
      task = byId.get(task.action.taskId);
    }
  }

  private async assertDirectory(cwd: string): Promise<void> {
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`working directory does not exist: ${cwd}`);
  }

  private changed(): void { this.hub.emitWorkspace({ type: "tasks-changed" }); }
}
