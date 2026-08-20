import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { TaskDefinitions, record, requiredString } from "./definitions.js";
import { TaskMessenger } from "./messages.js";
import type { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskDefinition, TaskResult, TaskRun } from "./types.js";

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
  background: boolean;
  sessionMode: TaskRun["sessionMode"];
  targetSessionId: string | null;
  callbackSessionId: string | null;
  callbackState: TaskRun["callbackState"];
  depth: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: TaskResult | null;
  error: string | null;
  skipReason: string | null;
}

const summarize = (run: TaskRun): RunSummary => ({
  runId: run.id,
  taskId: run.taskId,
  taskName: run.context.definition.name,
  state: run.state,
  background: run.background,
  sessionMode: run.sessionMode,
  targetSessionId: run.targetSessionId,
  callbackSessionId: run.callbackSessionId,
  callbackState: run.callbackState,
  depth: run.depth,
  queuedAt: run.queuedAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  result: run.result,
  error: run.error,
  skipReason: run.skipReason,
});

// Model-facing draft shape. Guidance only: runtime truth stays in parseDraft,
// so schema drift can never loosen boundary validation.
const DraftSchema = Type.Object({
  name: Type.String(),
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
        Type.Object({ mode: Type.Literal("fresh"), cwd: Type.String() }),
        Type.Object({ mode: Type.Literal("fork"), cwd: Type.Optional(Type.String()) }),
        Type.Object({ mode: Type.Literal("reuse"), sessionId: Type.String() }),
      ]),
      prompt: Type.String(),
      launch: Type.Optional(Type.Object({
        model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
        thinking: Type.Optional(Type.String()),
        capabilities: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
      })),
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
      "Manage durable Pier tasks and subagents. Agent tasks support reused, fresh, or forked sessions. Run executes a stored task by task_id, or pass task (no task_id) to atomically create and run a one-shot subagent. Run detached work with callbacks or wait for results; use wait/steer/follow_up/resume for child control and contact/reply for detached supervisor decisions.",
    parameters: Type.Object({
      operation: strEnum(
        "list", "create", "update", "run", "get", "cancel",
        "wait", "steer", "follow_up", "resume", "contact", "reply",
      ),
      task_id: Type.Optional(Type.String()),
      run_id: Type.Optional(Type.String()),
      run_ids: Type.Optional(Type.Array(Type.String())),
      message_id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      reason: Type.Optional(strEnum("progress", "decision")),
      wait_mode: Type.Optional(strEnum("all", "first")),
      session_mode: Type.Optional(strEnum("fresh", "fork")),
      task: Type.Optional(DraftSchema),
      input: Type.Optional(Type.Unknown()),
      wait: Type.Optional(Type.Boolean()),
      callback: Type.Optional(strEnum("origin", "none")),
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
  signal?: AbortSignal,
): Promise<unknown> {
  const input = record(raw);
  if (!input) throw new Error("task tool parameters required");
  const active = store.findActiveRunForTarget(callerSessionId);
  if (input.operation === "list") return definitions.list().filter((task) => task.kind !== "subagent");
  if (input.operation === "create") {
    if (active) throw new Error("subagents cannot create task definitions");
    return definitions.create(input.task, `session:${callerSessionId}`);
  }
  if (input.operation === "update") {
    if (active) throw new Error("subagents cannot update task definitions");
    return definitions.update(requiredString(input.task_id, "task_id"), input.task);
  }
  if (input.operation === "run") {
    if (active && active.context.definition.action.type === "agent" && active.context.definition.action.launch?.capabilities === "read") {
      throw new Error("read-only subagents cannot delegate nested work");
    }
    const draft = input.task_id === undefined ? record(input.task) : undefined;
    let task: TaskDefinition;
    if (draft) {
      // Inline one-shot subagent: persisted like any task (kind "subagent",
      // filtered from default lists) so runs stay auditable and resumable.
      if (draft.trigger !== undefined && record(draft.trigger)?.type !== "manual") {
        throw new Error("inline subagent tasks must use a manual trigger");
      }
      if (active) {
        const action = record(draft.action);
        if (action?.type !== "agent") throw new Error("subagents may only inline Agent tasks");
        if (record(action.session)?.mode === "reuse") throw new Error("subagent inline tasks cannot reuse an existing session");
      }
      task = await definitions.create({ ...draft, trigger: { type: "manual" } }, `session:${callerSessionId}`, "subagent");
    } else {
      task = definitions.get(requiredString(input.task_id, "task_id"));
    }
    if (active && task.action.type !== "agent") throw new Error("subagents may only invoke Agent tasks");
    const wait = input.wait === true;
    const sessionMode = input.session_mode === "fresh" || input.session_mode === "fork" ? input.session_mode : undefined;
    if (wait && task.action.type === "agent" && !sessionMode && task.action.session.mode === "reuse" && task.action.session.sessionId === callerSessionId) {
      throw new Error("cannot wait for an Agent task targeting the caller's own session");
    }
    let callbackSessionId: string | null = wait || input.callback === "none" ? null : callerSessionId;
    if (!active && !wait && typeof input.callback_session_id === "string") {
      callbackSessionId = requiredString(input.callback_session_id, "callback_session_id");
      if (!(await definitions.sessionExists(callbackSessionId))) throw new Error(`unknown session: ${callbackSessionId}`);
    }
    const run = host.run(task.id, input.input, "agent", active?.id ?? null, {
      invokedBySessionId: callerSessionId,
      sourceSessionId: callerSessionId,
      callbackSessionId,
      background: !wait,
      sessionMode,
    });
    return wait ? summarize(await host.waitForRun(run.id, signal)) : summarize(run);
  }
  if (input.operation === "get") return summarize(host.getRun(requiredString(input.run_id, "run_id")));
  if (input.operation === "wait") {
    const ids = Array.isArray(input.run_ids)
      ? input.run_ids.map((id) => requiredString(id, "run_id"))
      : [requiredString(input.run_id, "run_id")];
    for (const id of ids) assertOwns(store, callerSessionId, active, host.getRun(id));
    return (await host.waitForRuns(ids, input.wait_mode === "first" ? "first" : "all", signal)).map(summarize);
  }
  if (input.operation === "cancel") {
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    return summarize(host.cancel(run.id));
  }
  if (input.operation === "steer" || input.operation === "follow_up") {
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    return host.control(run.id, callerSessionId, input.operation, requiredString(input.message, "message"));
  }
  if (input.operation === "resume") {
    const prior = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, prior);
    const wait = input.wait === true;
    const run = host.resume(prior.id, requiredString(input.message, "message"), {
      invokedBySessionId: callerSessionId,
      callbackSessionId: wait ? null : callerSessionId,
      background: !wait,
    });
    return wait ? summarize(await host.waitForRun(run.id, signal)) : summarize(run);
  }
  if (input.operation === "contact") {
    if (!active) throw new Error("contact is only available inside an active Agent run");
    const reason = input.reason === "decision" ? "decision" : "progress";
    return messages.contact(active, callerSessionId, reason, requiredString(input.message, "message"), input.wait === true, signal);
  }
  if (input.operation === "reply") {
    return messages.reply(requiredString(input.message_id, "message_id"), callerSessionId, requiredString(input.message, "message"));
  }
  throw new Error("unknown task operation");
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
