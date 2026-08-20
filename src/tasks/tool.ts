import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { TaskDefinitions, record, requiredString } from "./definitions.js";
import { TaskMessenger } from "./messages.js";
import type { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskRun } from "./types.js";

/** The model-facing `task` tool contract, injected into the agent seam as data. */
export function taskToolSpec(execute: AgentCustomTool["execute"]): AgentCustomTool {
  return {
    name: "task",
    label: "Pier Task",
    description:
      "Manage durable Pier tasks and subagents. Agent tasks support reused, fresh, or forked sessions. Run detached work with callbacks or wait for results; use wait/steer/follow_up/resume for child control and contact/reply for detached supervisor decisions.",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("list"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("run"),
        Type.Literal("get"),
        Type.Literal("cancel"),
        Type.Literal("wait"),
        Type.Literal("steer"),
        Type.Literal("follow_up"),
        Type.Literal("resume"),
        Type.Literal("contact"),
        Type.Literal("reply"),
      ]),
      task_id: Type.Optional(Type.String()),
      run_id: Type.Optional(Type.String()),
      run_ids: Type.Optional(Type.Array(Type.String())),
      message_id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      reason: Type.Optional(Type.Union([Type.Literal("progress"), Type.Literal("decision")])),
      wait_mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("first")])),
      session_mode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
      task: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      input: Type.Optional(Type.Unknown()),
      wait: Type.Optional(Type.Boolean()),
      callback: Type.Optional(Type.Union([Type.Literal("origin"), Type.Literal("none")])),
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
  if (input.operation === "list") return definitions.list();
  if (input.operation === "create") {
    if (active) throw new Error("subagents cannot create task definitions");
    return definitions.create(input.task, `session:${callerSessionId}`);
  }
  if (input.operation === "update") {
    if (active) throw new Error("subagents cannot update task definitions");
    return definitions.update(requiredString(input.task_id, "task_id"), input.task);
  }
  if (input.operation === "run") {
    const task = definitions.get(requiredString(input.task_id, "task_id"));
    if (active) {
      if (task.action.type !== "agent") throw new Error("subagents may only invoke Agent tasks");
      if (active.context.definition.action.type === "agent" && active.context.definition.action.launch?.capabilities === "read") {
        throw new Error("read-only subagents cannot delegate nested work");
      }
    }
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
    return wait ? host.waitForRun(run.id) : run;
  }
  if (input.operation === "get") return host.getRun(requiredString(input.run_id, "run_id"));
  if (input.operation === "wait") {
    const ids = Array.isArray(input.run_ids)
      ? input.run_ids.map((id) => requiredString(id, "run_id"))
      : [requiredString(input.run_id, "run_id")];
    for (const id of ids) assertOwns(store, callerSessionId, active, host.getRun(id));
    return host.waitForRuns(ids, input.wait_mode === "first" ? "first" : "all");
  }
  if (input.operation === "cancel") {
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    return host.cancel(run.id);
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
    return wait ? host.waitForRun(run.id) : run;
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
