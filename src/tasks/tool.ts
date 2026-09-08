import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { TaskDefinitions, record, requiredString } from "./definitions.js";
import { TaskMessenger } from "./messages.js";
import type { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { CallbackMode, TaskDefinition, TaskGroup, TaskResult, TaskRun } from "./types.js";

// JSON-Schema enum emits ~1/3 the tokens of typebox's anyOf-of-consts.
const strEnum = <const T extends readonly string[]>(...values: T) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values] });

/** Model-facing run shape: everything the caller can act on, none of the
 * context echo (definition, renderedPrompt, probe) that wastes its tokens. */
export interface RunSummary {
  runId: string;
  taskId: string;
  taskName: string;
  state: TaskRun["state"];
  /** Who fired this run — the definition's trigger is only its schedule policy. */
  triggerSource: TaskRun["triggerSource"];
  groupId?: string;
  sessionMode: TaskRun["sessionMode"];
  targetSessionId?: string;
  callbackSessionId?: string;
  callbackState: TaskRun["callbackState"];
  /** Echoed only when it is not the default: the one confirmation the caller
   *  gets that its result will interrupt rather than wait. */
  callbackMode?: TaskRun["callbackMode"];
  pendingDecisionId?: string;
  depth: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: TaskResult;
  error?: string;
  skipReason?: string;
}

export interface GroupSummary {
  groupId: string;
  join: TaskGroup["join"];
  state: "running" | "finished";
  callbackState: TaskGroup["callbackState"];
  callbackMode?: TaskGroup["callbackMode"];
  winnerRunId?: string;
  members: RunSummary[];
}

/**
 * Drop the fields with nothing in them instead of sending `null`.
 *
 * A run summary has eighteen fields and most are empty for most of a run's
 * life; a model reads "absent" and "null" the same way. On a `get` that lists
 * several runs this is a third of the payload.
 *
 * The input names every field — a summary that forgot one would otherwise pass
 * as "that field was empty" — and the result is the type with the empty ones
 * gone, which is why those are declared optional above.
 */
const defined = <T extends object>(value: { [K in keyof T]-?: T[K] | null }): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
  ) as T;

const summarize = (run: TaskRun, pendingDecisionId: string | null): RunSummary => defined({
  runId: run.id,
  taskId: run.taskId,
  taskName: run.context.definition.name,
  state: run.state,
  triggerSource: run.triggerSource,
  groupId: run.groupId,
  sessionMode: run.sessionMode,
  targetSessionId: run.targetSessionId,
  callbackSessionId: run.callbackSessionId,
  callbackState: run.callbackState,
  callbackMode: run.callbackMode ?? null,
  pendingDecisionId,
  depth: run.depth,
  queuedAt: run.queuedAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  result: run.result,
  error: run.error,
  skipReason: run.skipReason,
});

/** A list echoes many results at once, so each is capped; a single-run `get`
 * stays whole — it is the escape hatch every truncation note points at. */
const trimResult = (summary: RunSummary): RunSummary => {
  if (summary.result?.type !== "agent" || summary.result.text.length <= 2000) return summary;
  return {
    ...summary,
    result: {
      ...summary.result,
      text: `${summary.result.text.slice(0, 2000)}\n[truncated — get run_id ${summary.runId} for the full text]`,
    },
  };
};

const summarizeGroup = (group: TaskGroup, members: TaskRun[], messages: TaskMessenger): GroupSummary => defined({
  groupId: group.id,
  join: group.join,
  state: group.finishedAt ? "finished" : "running",
  callbackState: group.callbackState,
  callbackMode: group.callbackMode ?? null,
  winnerRunId: group.winnerRunId,
  members: members.map((run) => trimResult(summarize(run, messages.openDecisionId(run.id)))),
});

const LaunchSchema = Type.Object({
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  thinking: Type.Optional(Type.String()),
});

// Model-facing draft shape. Guidance only: runtime truth stays in parseDraft,
// so schema drift can never loosen boundary validation.
const DraftSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Defaults to the prompt's first line." })),
  description: Type.Optional(Type.String()),
  trigger: Type.Optional(Type.Union([
    Type.Object({ type: Type.Literal("manual") }),
    Type.Object({ type: Type.Literal("cron"), expression: Type.String(), timezone: Type.String() }),
    Type.Object({
      type: Type.Literal("watch"),
      script: Type.String(),
      cwd: Type.String(),
      intervalSeconds: Type.Number(),
      mode: strEnum("once", "repeat"),
    }),
  ])),
  action: Type.Union([
    Type.Object({
      type: Type.Literal("agent"),
      session: Type.Union([
        Type.Object({ mode: Type.Literal("fresh"), cwd: Type.Optional(Type.String({ description: "Absolute, or relative to your session's directory; omitted = your directory." })) }),
        Type.Object({ mode: Type.Literal("reuse"), sessionId: Type.String() }),
      ]),
      prompt: Type.String(),
      launch: Type.Optional(LaunchSchema),
    }),
    Type.Object({ type: Type.Literal("bash"), script: Type.String(), cwd: Type.String() }),
    Type.Object({ type: Type.Literal("task"), taskId: Type.String() }),
  ]),
  callback: Type.Optional(Type.Union([
    Type.Object({ type: Type.Literal("none") }),
    Type.Object({ type: Type.Literal("origin") }),
    Type.Object({ type: Type.Literal("session"), sessionId: Type.String() }),
  ])),
  timeoutSeconds: Type.Optional(Type.Number()),
});

/** The model-facing `task` tool contract, injected into the agent seam as data. */
export function taskToolSpec(execute: AgentCustomTool["execute"]): AgentCustomTool {
  return {
    name: "task",
    label: "Pier Task",
    description:
      "Manage durable Pier tasks and subagents. Agent tasks run in a fresh session or a reused one. create files a definition the operator sees in the Console — only for schedules or roles you will run again; a one-off is run with a prompt. Run executes a stored task by task_id, a one-shot subagent from a prompt (shorthand: prompt + optional cwd/launch/name — cwd defaults to your own directory, relative paths resolve against it, name comes from the prompt) or from a full inline task draft, or a core-joined fan-out via tasks[] with join all|first. Get accepts run_id, group_id, or task_id for that task's recent runs. Every operation returns immediately: results, group joins, and decision replies arrive as callback messages once your turn ends — don't poll get for them; pass callback 'steer' to have a result interrupt your running turn instead, or 'none' for no callback at all. Use steer/follow_up/resume for child control and contact/reply for supervisor decisions. models lists the deployment's model menu (operator pins with intent notes, else the live catalog).",
    parameters: Type.Object({
      operation: strEnum(
        "list", "create", "update", "run", "get", "cancel",
        "steer", "follow_up", "resume", "contact", "reply", "models",
      ),
      task_id: Type.Optional(Type.String()),
      run_id: Type.Optional(Type.String()),
      group_id: Type.Optional(Type.String()),
      message_id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      reason: Type.Optional(strEnum("progress", "decision")),
      session_mode: Type.Optional(strEnum("fresh")),
      // The one-shot shorthand: a prompt is the whole delegation, and the
      // fresh session in the caller's own directory is what it means.
      prompt: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      launch: Type.Optional(LaunchSchema),
      name: Type.Optional(Type.String()),
      task: Type.Optional(DraftSchema),
      // The same draft again, spelled out, cost more tokens in every session
      // than the whole rest of this contract. One copy is the guidance; this
      // one points at it, and `parseDraft` is what actually validates either.
      tasks: Type.Optional(Type.Unsafe<unknown[]>({
        type: "array",
        description: "2+ entries, each a prompt string, {prompt, cwd?, launch?, name?}, a task draft shaped exactly like `task`, or {task_id}.",
        items: { type: "object" },
      })),
      join: Type.Optional(strEnum("all", "first")),
      input: Type.Optional(Type.Unknown()),
      callback: Type.Optional(strEnum("origin", "none", "steer")),
      callback_session_id: Type.Optional(Type.String()),
    }),
    execute,
  };
}

export async function handleTaskTool(
  host: TaskService,
  definitions: TaskDefinitions,
  store: TaskStore,
  messages: TaskMessenger,
  raw: unknown,
  callerSessionId: string,
): Promise<unknown> {
  const input = record(raw);
  if (!input) throw new Error("task tool parameters required");
  const active = store.findActiveRunForTarget(callerSessionId);
  if (input.operation === "list") return definitions.list().filter((task) => task.kind !== "subagent");
  if (input.operation === "models") return host.models();
  if (input.operation === "create") {
    if (active) throw new Error("subagents cannot create task definitions");
    return definitions.create(await expandDraft(definitions, input.task, callerSessionId), `session:${callerSessionId}`);
  }
  if (input.operation === "update") {
    if (active) throw new Error("subagents cannot update task definitions");
    return definitions.update(requiredString(input.task_id, "task_id"), await expandDraft(definitions, input.task, callerSessionId));
  }
  if (input.operation === "run") {
    // One reading of `callback` for both shapes below: a run and a fan-out
    // choose the same way, and two readings are two things to keep in step.
    const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
    if (Array.isArray(input.tasks)) {
      // Core-joined fan-out: members run detached, one aggregated callback.
      if (input.task !== undefined || input.task_id !== undefined) throw new Error("use either task/task_id or tasks[]");
      if (input.session_mode !== undefined) throw new Error("session_mode applies to a single run only");
      if (input.tasks.length < 2) throw new Error("tasks[] needs at least 2 entries; use task for a single run");
      const resolved: TaskDefinition[] = [];
      for (const rawEntry of input.tasks) {
        const entry = typeof rawEntry === "string" ? { prompt: rawEntry } : record(rawEntry);
        if (!entry) throw new Error("invalid tasks[] entry");
        resolved.push(entry.task_id === undefined
          ? await resolveDraft(definitions, entry, active, callerSessionId)
          : resolveStored(definitions, entry.task_id, active));
      }
      const { group, runs } = host.runGroup(
        resolved,
        input.join === "first" ? "first" : "all",
        callerSessionId,
        active?.id ?? null,
        input.callback === "none" ? null : callerSessionId,
        callbackMode,
      );
      return summarizeGroup(group, runs, messages);
    }
    const draft = input.task_id === undefined ? inlineDraft(input) : undefined;
    const task = draft
      ? await resolveDraft(definitions, draft, active, callerSessionId)
      : resolveStored(definitions, input.task_id, active);
    // Same as the HTTP route: a named mode the schema no longer offers is
    // answered, not quietly swapped for the definition's own policy.
    if (input.session_mode !== undefined && input.session_mode !== "fresh") {
      throw new Error(`unsupported session_mode: ${String(input.session_mode)}`);
    }
    const sessionMode = input.session_mode;
    let callbackSessionId: string | null = input.callback === "none" ? null : callerSessionId;
    if (!active && callbackSessionId && typeof input.callback_session_id === "string") {
      callbackSessionId = requiredString(input.callback_session_id, "callback_session_id");
      if (!(await definitions.sessionExists(callbackSessionId))) throw new Error(`unknown session: ${callbackSessionId}`);
    }
    const run = host.run(task.id, input.input, "agent", active?.id ?? null, {
      invokedBySessionId: callerSessionId,
      sourceSessionId: callerSessionId,
      callbackSessionId,
      callbackMode,
      background: true,
      sessionMode,
    });
    return summarize(run, null);
  }
  if (input.operation === "get") {
    if (typeof input.group_id === "string") {
      const { group, members } = host.getGroup(input.group_id);
      return summarizeGroup(group, members, messages);
    }
    // Run history by task: without it, checking what a task did (or whether a
    // cascade landed) means leaving the tool for the database.
    if (input.run_id === undefined && typeof input.task_id === "string") {
      return host.listRuns(input.task_id, 10).map((run) => trimResult(summarize(run, messages.openDecisionId(run.id))));
    }
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    return summarize(run, messages.openDecisionId(run.id));
  }
  if (input.operation === "cancel") {
    if (typeof input.group_id === "string") {
      const { group, members } = host.getGroup(input.group_id);
      for (const member of members) assertOwns(store, callerSessionId, active, member);
      const cancelled = host.cancelGroup(group.id);
      return summarizeGroup(cancelled, cancelled.memberRunIds.map((id) => host.getRun(id)), messages);
    }
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    const cancelled = host.cancel(run.id);
    return summarize(cancelled, messages.openDecisionId(cancelled.id));
  }
  if (input.operation === "steer" || input.operation === "follow_up") {
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    return host.control(run.id, callerSessionId, input.operation, requiredString(input.message, "message"));
  }
  if (input.operation === "resume") {
    const prior = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, prior);
    const run = host.resume(prior.id, requiredString(input.message, "message"), {
      invokedBySessionId: callerSessionId,
      callbackSessionId: input.callback === "none" ? null : callerSessionId,
      background: true,
    });
    return summarize(run, null);
  }
  if (input.operation === "contact") {
    if (!active) throw new Error("contact is only available inside an active Agent run");
    const reason = input.reason === "decision" ? "decision" : "progress";
    return messages.contact(active, callerSessionId, reason, requiredString(input.message, "message"));
  }
  if (input.operation === "reply") {
    return messages.reply(requiredString(input.message_id, "message_id"), callerSessionId, requiredString(input.message, "message"));
  }
  throw new Error("unknown task operation");
}

/** A single run's draft: the top-level shorthand (`prompt` …) or `task`, never both. */
function inlineDraft(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const { prompt, cwd, launch, name } = input;
  if (prompt === undefined) return record(input.task) ?? undefined;
  if (input.task !== undefined) throw new Error("use either prompt or task");
  return { prompt, cwd, launch, name };
}

/** The prompt's first line, unmarked and cut short: a label for the Console,
 *  not an identifier — the run's id is what anything addresses. */
function nameFromPrompt(prompt: string): string {
  const line = prompt.split("\n")
    .map((l) => l.replace(/^[\s#>*-]+/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim())
    .find(Boolean) ?? "subagent";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/**
 * The shape a draft is validated in, from the shapes a caller may write it in.
 * A `prompt` shorthand becomes a fresh Agent action; a fresh session's cwd
 * resolves against the caller's own directory (and is that directory when
 * omitted); a missing name is the prompt's first line. Everything the caller
 * did spell out passes through untouched — parseDraft still judges it.
 */
async function expandDraft(definitions: TaskDefinitions, raw: unknown, callerSessionId: string): Promise<unknown> {
  let draft = record(raw);
  if (!draft) return raw;
  if (typeof draft.prompt === "string") {
    if (draft.action !== undefined) throw new Error("use either prompt (shorthand) or action");
    const { prompt, cwd, launch, name, ...rest } = draft;
    draft = { ...rest, name, action: { type: "agent", session: { mode: "fresh", cwd }, prompt, launch } };
  }
  const action = record(draft.action);
  const session = record(action?.session);
  if (action?.type === "agent" && session?.mode === "fresh" && (session.cwd === undefined || (typeof session.cwd === "string" && !isAbsolute(session.cwd)))) {
    const base = await definitions.sessionCwd(callerSessionId);
    if (!base) throw new Error(`cwd ${session.cwd === undefined ? "omitted" : `"${session.cwd}" is relative`} and the calling session has no working directory; give an absolute path`);
    draft = { ...draft, action: { ...action, session: { ...session, cwd: resolve(base, session.cwd ?? ".") } } };
  }
  if (draft.name === undefined && typeof action?.prompt === "string") draft = { ...draft, name: nameFromPrompt(action.prompt) };
  return draft;
}

/** Inline one-shot subagent: persisted like any task (kind "subagent",
 * filtered from default lists) so runs stay auditable and resumable. */
async function resolveDraft(
  definitions: TaskDefinitions,
  raw: unknown,
  active: TaskRun | undefined,
  callerSessionId: string,
): Promise<TaskDefinition> {
  const draft = record(await expandDraft(definitions, raw, callerSessionId));
  if (!draft) throw new Error("task definition required");
  if (draft.trigger !== undefined && record(draft.trigger)?.type !== "manual") {
    throw new Error("inline subagent tasks must use a manual trigger");
  }
  if (active) {
    const action = record(draft.action);
    if (action?.type !== "agent") throw new Error("subagents may only inline Agent tasks");
    if (record(action.session)?.mode === "reuse") throw new Error("subagent inline tasks cannot reuse an existing session");
  }
  return definitions.create({ ...draft, trigger: { type: "manual" } }, `session:${callerSessionId}`, "subagent");
}

function resolveStored(definitions: TaskDefinitions, taskId: unknown, active: TaskRun | undefined): TaskDefinition {
  const task = definitions.get(requiredString(taskId, "task_id"));
  if (active && task.action.type !== "agent") throw new Error("subagents may only invoke Agent tasks");
  return task;
}

function assertOwns(store: TaskStore, callerSessionId: string, active: TaskRun | undefined, target: TaskRun): void {
  if (active) {
    let cursor: TaskRun | undefined = target;
    while (cursor?.parentRunId) {
      if (cursor.parentRunId === active.id) return;
      cursor = store.getRun(cursor.parentRunId);
    }
    throw new Error("subagent may only control descendant runs");
  }
  let root = target;
  while (root.parentRunId) {
    const parent = store.getRun(root.parentRunId);
    if (!parent) throw new Error(`unknown parent run: ${root.parentRunId}`);
    root = parent;
  }
  if (root.invokedBySessionId !== callerSessionId) throw new Error("session does not own this run");
}
