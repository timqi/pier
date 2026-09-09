// What a task *is* before it ever runs: the id it is minted with, the draft
// validated into a definition, and when its trigger is next due. Every way a
// definition can be created — HTTP, the task tool, Pier's own owned task —
// arrives here, so a field is checked in one place or nowhere.

import { randomBytes } from "node:crypto";
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
  SystemActions,
  TaskAction,
  TaskCallback,
  TaskDefinition,
  TaskDraft,
  TaskTrigger,
} from "./types.js";

const DEFAULT_TIMEOUT = 900;
const MIN_WATCH_SECONDS = 5;

/** Crockford's base32, lowercased: i, l, o and u are gone, and one case
 *  throughout, so a model re-types an id it read verbatim. */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Exported only so a test can walk all 256 byte values for alphabet bias. */
export const idSymbol = (byte: number): string => ID_ALPHABET.charAt(byte & 31);

/** Every task record's id. These ride through model context constantly, and a
 *  UUID spends ~12 tokens where this spends ~6. Sixteen characters (80 bits;
 *  `& 31` is unbiased): a watch task mints ~6M runs a year, and a collision is
 *  not an error — `saveRun`'s ON CONFLICT DO UPDATE would quietly overwrite. */
export const newId = (): string => Array.from(randomBytes(16), idSymbol).join("");

/** A definition Pier's own code created is reconciled by that code and edited
 *  by nobody: `creator` is `"http"` (Console) or `session:<id>` (task tool);
 *  anything else is an instance-layer owner, which names itself in `by`.
 *  Otherwise a public surface could repoint the tools task while its switch
 *  went on claiming Pier keeps the tools current. */
const ownerOf = (task: TaskDefinition): string | null =>
  task.creator === "http" || task.creator.startsWith("session:") ? null : task.creator;

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

/** Always computed from `from` (boot recomputes from *now*): cron runs missed
 *  while Pier was down are skipped, never caught up — no double fire. */
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
  return Object.keys(launch).length ? launch : undefined;
}

export class TaskDefinitions {
  constructor(
    private readonly store: TaskStore,
    private readonly factory: AgentFactory,
    private readonly router: Router,
    private readonly hub: EventHub,
    private readonly systemActions: SystemActions = {},
  ) {}

  list(): TaskDefinition[] { return this.store.listTasks(); }

  get(id: string): TaskDefinition {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  }
  async create(raw: unknown, creator = "http", kind: TaskDefinition["kind"] = "task"): Promise<TaskDefinition> {
    // A trigger-less new definition means manual. Update keeps requiring it:
    // a draft that forgot its trigger must not silently unschedule a cron task.
    const value = record(raw);
    const draft = await this.parseDraft(
      value && value.trigger === undefined ? { ...value, trigger: { type: "manual" } } : raw,
      creator,
    );
    const now = Date.now();
    const task: TaskDefinition = {
      id: newId(),
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
  async update(id: string, raw: unknown, by?: string): Promise<TaskDefinition> {
    const old = this.get(id);
    this.assertOwner(old, by, "edited");
    if (old.archived) throw new Error("archived tasks cannot be edited");
    const draft = await this.parseDraft(raw, ownerOf(old) ? by : undefined);
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
  setEnabled(id: string, enabled: boolean, by?: string): TaskDefinition {
    const task = this.get(id);
    this.assertOwner(task, by, enabled ? "resumed" : "paused");
    if (task.archived && enabled) throw new Error("archived tasks cannot be resumed");
    task.enabled = enabled;
    task.nextRunAt = enabled ? nextRunAt(task.trigger, Date.now()) : null;
    task.updatedAt = Date.now();
    this.store.saveTask(task);
    this.changed();
    return task;
  }
  archive(id: string, by?: string): TaskDefinition {
    const task = this.get(id);
    this.assertOwner(task, by, "archived");
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
    // The store narrows by index; the JSON is still the record, so its fields decide.
    for (const task of this.store.listDueTasks(now)) {
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
      (await this.factory.find(sessionId)) !== undefined;
  }
  /** A caller's own directory — what a relative or omitted cwd resolves against. */
  async sessionCwd(sessionId: string): Promise<string | undefined> {
    return (await this.factory.find(sessionId))?.cwd;
  }

  /** The guard `ownerOf` exists for, on the three ways a definition changes. */
  private assertOwner(task: TaskDefinition, by: string | undefined, what: string): void {
    const owner = ownerOf(task);
    if (owner && by !== owner) {
      throw new Error(`"${task.name}" is Pier's own ${owner} task: it is reconciled by Pier, not ${what}`);
    }
  }

  /** Checked again at execution: persisted definitions can outlive registration. */
  systemAction(name: string, owner?: string): SystemActions[string] {
    if (!owner || owner === "http" || owner.startsWith("session:") || owner !== name) {
      throw new Error(`system action "${name}" requires its trusted owner`);
    }
    if (!Object.hasOwn(this.systemActions, name) || typeof this.systemActions[name] !== "function") {
      throw new Error(`unregistered system action: ${name}`);
    }
    return this.systemActions[name]!;
  }

  private async parseDraft(raw: unknown, owner?: string): Promise<TaskDraft> {
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
    } else if (actionRaw.type === "system") {
      const name = requiredString(actionRaw.name, "system action name");
      this.systemAction(name, owner);
      action = { type: "system", name };
    } else if (actionRaw.type === "agent") {
      action = await this.parseAgentAction(actionRaw);
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

  private async parseAgentAction(raw: Record<string, unknown>): Promise<AgentTaskAction> {
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
    } else {
      // Validation never mutates: a session is created explicitly and then reused.
      throw new Error('agent session policy required, e.g. {"mode":"fresh","cwd":"/abs/path"} or {"mode":"reuse","sessionId":"..."}');
    }
    if (session.mode === "reuse" && launch) throw new Error("launch policy only applies to fresh sessions");
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
