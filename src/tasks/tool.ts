import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentCustomTool } from "../core/types.js";
import { logger } from "../log.js";
import { type TaskDefinitions, record, requiredString } from "./definitions.js";
import type { TaskMessenger } from "./messages.js";
import type { TaskService } from "./service.js";
import type { TaskStore } from "./store.js";
import { isTerminal, type CallbackFields, type CallbackMode, type TaskDefinition, type TaskGroup, type TaskResult, type TaskRun } from "./types.js";

const log = logger("tasks");

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
  /** On a run receipt only: how the result reaches the caller, so the receipt
   *  itself says there is nothing to query. */
  next?: string;
}

export interface GroupSummary {
  groupId: string;
  join: TaskGroup["join"];
  state: "running" | "finished";
  callbackState: TaskGroup["callbackState"];
  callbackMode?: TaskGroup["callbackMode"];
  winnerRunId?: string;
  members: RunSummary[];
  next?: string;
}

/** Absent instead of `null`: a model reads both the same way, and on a group
 *  summary the nulls are a third of the payload. The input names every field
 *  so a summary that forgot one cannot pass as "empty". */
const defined = <T extends object>(value: { [K in keyof T]-?: T[K] | null }): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
  ) as T;

const summarize = (run: TaskRun, pendingDecisionId: string | null): RunSummary => defined<RunSummary>({
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
  next: null,
});

/** The receipt says the callback is the whole answer, or a model that just
 *  launched work reaches for a status call. */
const receipt = <T extends { next?: string }>(summary: T, callbackSessionId: string | null, mode: CallbackMode, callerSessionId: string): T => ({
  ...summary,
  next: callbackSessionId === null
    ? "callback none: the result is not delivered to anyone"
    : callbackSessionId !== callerSessionId
      ? `the result is delivered to session ${callbackSessionId}; this session will not receive a callback`
      : mode === "steer"
        ? "the result interrupts your running turn as a steer message; nothing to query"
        : "the result arrives as a callback message once your turn ends; nothing to query",
});

const SUBAGENT_REDIRECT = "subagents cannot redirect callbacks (callback_session_id)";

/** Who a new run's result goes to — the caller, nobody, or a named session that
 *  must exist. Shared by `run` and `resume`: a resumed run is a new run. */
const callbackTarget = async (
  input: Record<string, unknown>,
  definitions: TaskDefinitions,
  callerSessionId: string,
): Promise<string | null> => {
  if (input.callback_session_id === undefined) return input.callback === "none" ? null : callerSessionId;
  if (input.callback === "none") throw new Error("callback none and callback_session_id conflict: pick one delivery target");
  const target = requiredString(input.callback_session_id, "callback_session_id");
  if (!(await definitions.sessionExists(target))) throw new Error(`unknown session: ${target}`);
  return target;
};

/** A group echoes many results at once, so each is capped; a single-run
 * `recover` stays whole — it is the escape hatch every truncation note points at. */
const trimResult = (summary: RunSummary): RunSummary => {
  if (summary.result?.type !== "agent" || summary.result.text.length <= 2000) return summary;
  return {
    ...summary,
    result: {
      ...summary.result,
      text: `${summary.result.text.slice(0, 2000)}\n[truncated — recover run_id ${summary.runId} with a reason for the full text]`,
    },
  };
};

/** Delivered, given up on and reported, or never owed (`callback:"none"`).
 *  Anything else is still on its way, and reading it here would be reading it twice. */
const settled = (callback: CallbackFields): boolean =>
  callback.callbackState === null || callback.callbackState === "delivered" || callback.callbackState === "abandoned";

/** The same words for queued, running, pending and retrying: a refusal that
 *  named the state would be the status query this operation replaced. */
const notRecoverable = (what: string, callback: { callbackSessionId: string | null }): never => {
  throw new Error(callback.callbackSessionId === null
    ? `${what} is not recoverable yet: it was launched with callback none, so nothing will be delivered; recover reads finished results only and cannot wait for work`
    : `${what} is not recoverable yet: wait for automatic delivery to session ${callback.callbackSessionId}; recover cannot wait for work`);
};

const summarizeGroup = (group: TaskGroup, members: TaskRun[], messages: TaskMessenger): GroupSummary => defined<GroupSummary>({
  groupId: group.id,
  join: group.join,
  state: group.finishedAt ? "finished" : "running",
  callbackState: group.callbackState,
  callbackMode: group.callbackMode ?? null,
  winnerRunId: group.winnerRunId,
  members: members.map((run) => trimResult(summarize(run, messages.openDecisionId(run.id)))),
  next: null,
});

const LaunchSchema = Type.Object({
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  thinking: Type.Optional(Type.String()),
});

// Guidance only: runtime truth stays in parseDraft, so schema drift cannot
// loosen boundary validation.
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
      "Manage durable Pier tasks and subagents. Agent tasks run in a fresh session or a reused one. create files a definition the operator sees in the Console — only for schedules or roles you will run again; a one-off is run with a prompt. Run executes a stored task by task_id, a one-shot subagent from a prompt (shorthand: prompt + optional cwd/launch/name/timeoutSeconds — cwd defaults to your own directory, relative paths resolve against it, name comes from the prompt) or from a full inline task draft, or a core-joined fan-out via tasks[] with join all|first. Every operation returns immediately: results, group joins, and decision replies arrive as callback messages once your turn ends — there is no status query; pass callback 'steer' to have a result interrupt your running turn instead, or 'none' for no callback at all. recover (run_id or group_id, plus a reason) re-reads a finished result after its callback has settled — for truncated text or lost context, never to check progress. Use steer/follow_up/resume for child control and contact/reply for supervisor decisions. models lists the deployment's model menu (operator pins with intent notes, else the live catalog).",
    parameters: Type.Object({
      operation: strEnum(
        "list", "create", "update", "run", "recover", "cancel",
        "steer", "follow_up", "resume", "contact", "reply", "models",
      ),
      task_id: Type.Optional(Type.String()),
      run_id: Type.Optional(Type.String()),
      group_id: Type.Optional(Type.String()),
      message_id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String({ description: "contact: progress | decision. recover: why the delivered callback is not enough (required)." })),
      session_mode: Type.Optional(strEnum("fresh")),
      prompt: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      launch: Type.Optional(LaunchSchema),
      name: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ description: "1–86400; defaults to 3600." })),
      task: Type.Optional(DraftSchema),
      // Spelled out, the draft schema costs more tokens per session than the
      // rest of this contract; `parseDraft` validates either shape.
      tasks: Type.Optional(Type.Unsafe<unknown[]>({
        type: "array",
        description: "2+ entries, each a prompt string, {prompt, cwd?, launch?, name?, timeoutSeconds?}, a task draft shaped exactly like `task`, or {task_id}.",
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

/** What a session opens with: the tool, or nothing — `pier task` covers the
 *  same surface without the schema's per-turn cost. `enabled` is read per
 *  open, so the Console switch reaches the next session, never a running one. */
export function agentTaskTools(enabled: () => boolean, execute: AgentCustomTool["execute"]): () => AgentCustomTool[] {
  const spec = taskToolSpec(execute);
  return () => (enabled() ? [spec] : []);
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
    const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
    // A run's own callback is its parent's link back; a child that could point
    // it elsewhere would strand the supervisor waiting for a result.
    if (active && input.callback_session_id !== undefined) throw new Error(SUBAGENT_REDIRECT);
    if (Array.isArray(input.tasks)) {
      // Core-joined fan-out: members run detached, one aggregated callback.
      if (input.task !== undefined || input.task_id !== undefined) throw new Error("use either task/task_id or tasks[]");
      if (input.session_mode !== undefined) throw new Error("session_mode applies to a single run only");
      if (input.callback_session_id !== undefined) throw new Error("callback_session_id applies to a single run only");
      if (input.tasks.length < 2) throw new Error("tasks[] needs at least 2 entries; use task for a single run");
      const resolved: TaskDefinition[] = [];
      for (const rawEntry of input.tasks) {
        const entry = typeof rawEntry === "string" ? { prompt: rawEntry } : record(rawEntry);
        if (!entry) throw new Error("invalid tasks[] entry");
        resolved.push(entry.task_id === undefined
          ? await resolveDraft(definitions, entry, active, callerSessionId)
          : resolveStored(definitions, entry.task_id, active));
      }
      const groupCallbackSessionId = input.callback === "none" ? null : callerSessionId;
      const { group, runs } = host.runGroup(
        resolved,
        input.join === "first" ? "first" : "all",
        callerSessionId,
        active?.id ?? null,
        groupCallbackSessionId,
        callbackMode,
      );
      return receipt(summarizeGroup(group, runs, messages), groupCallbackSessionId, callbackMode, callerSessionId);
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
    const callbackSessionId = await callbackTarget(input, definitions, callerSessionId);
    const run = host.run(task.id, input.input, "agent", active?.id ?? null, {
      invokedBySessionId: callerSessionId,
      sourceSessionId: callerSessionId,
      callbackSessionId,
      callbackMode,
      background: true,
      sessionMode,
    });
    return receipt(summarize(run, null), callbackSessionId, callbackMode, callerSessionId);
  }
  if (input.operation === "recover") {
    // History only, never status: readable once the callback has said its last
    // word. The required reason is the friction, and the operator sees it.
    const reason = requiredString(input.reason, "reason");
    // The open question is the notification; the reply's continuation reports.
    const decisionOpen = (run: TaskRun): never => {
      throw new Error(`run ${run.id} finished awaiting your decision ${messages.openDecisionId(run.id) ?? ""}; reply to it — the continuation's callback brings the result`);
    };
    // A race winner need not wait for losing members to finish cancelling.
    const groupReady = (group: TaskGroup): void => {
      if (!group.finishedAt || !settled(group)) notRecoverable(`group ${group.id}`, group);
    };
    if (typeof input.group_id === "string") {
      const { group, members } = host.getGroup(input.group_id);
      groupReady(group);
      if (!members.every((run) => isTerminal(run.state))) {
        throw new Error(`recover cannot inspect active members; the race has settled — recover its winning result with run_id ${group.winnerRunId ?? "from the callback"} and a reason`);
      }
      const asking = members.find((run) => messages.openDecisionId(run.id));
      if (asking) decisionOpen(asking);
      log.info(`recover group ${group.id} by ${callerSessionId}: ${reason}`);
      return summarizeGroup(group, members, messages);
    }
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    if (run.groupId) {
      const { group } = host.getGroup(run.groupId);
      groupReady(group);
      if (!isTerminal(run.state)) throw new Error("the group has reported its outcome; recover reads finished results only and cannot wait for this member");
    } else if (!isTerminal(run.state) || !settled(run)) {
      notRecoverable(`run ${run.id}`, run);
    }
    if (messages.openDecisionId(run.id)) decisionOpen(run);
    log.info(`recover run ${run.id} by ${callerSessionId}: ${reason}`);
    return summarize(run, null);
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
    // The resumed run is a new run, so it carries its own callback options,
    // under the same rule as `run`: a subagent may not redirect them.
    if (active && input.callback_session_id !== undefined) throw new Error(SUBAGENT_REDIRECT);
    const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
    const callbackSessionId = await callbackTarget(input, definitions, callerSessionId);
    const run = host.resume(prior.id, requiredString(input.message, "message"), {
      invokedBySessionId: callerSessionId,
      callbackSessionId,
      callbackMode,
      background: true,
    });
    return receipt(summarize(run, null), callbackSessionId, callbackMode, callerSessionId);
  }
  if (input.operation === "message") {
    // The one request `pier task run --run` sends: the run's state, not the
    // caller, decides whether the text steers, queues or resumes, so a status
    // query never has to exist.
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(store, callerSessionId, active, run);
    const message = requiredString(input.message, "message");
    if (isTerminal(run.state)) {
      if (active && input.callback_session_id !== undefined) throw new Error(SUBAGENT_REDIRECT);
      const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
      const callbackSessionId = await callbackTarget(input, definitions, callerSessionId);
      const resumed = host.resume(run.id, message, { invokedBySessionId: callerSessionId, callbackSessionId, callbackMode, background: true });
      return { delivery: "resume", run: receipt(summarize(resumed, null), callbackSessionId, callbackMode, callerSessionId) };
    }
    if (input.callback !== undefined || input.callback_session_id !== undefined) {
      throw new Error(`run ${run.id} is ${run.state}: callback options apply to a resumed run only; drop them to steer or follow up`);
    }
    const delivery = input.after === true ? "follow_up" : "steer";
    return { delivery, message: await host.control(run.id, callerSessionId, delivery, message) };
  }
  if (input.operation === "contact") {
    if (!active) throw new Error("contact is only available inside an active Agent run");
    // The schema no longer narrows `reason` (recover shares the field), so the
    // two names contact accepts are checked here.
    const reason = input.reason === undefined ? "progress" : input.reason;
    if (reason !== "progress" && reason !== "decision") throw new Error(`contact reason must be progress or decision, got ${String(reason)}`);
    return messages.contact(active, callerSessionId, reason, requiredString(input.message, "message"));
  }
  if (input.operation === "reply") {
    return messages.reply(requiredString(input.message_id, "message_id"), callerSessionId, requiredString(input.message, "message"));
  }
  throw new Error("unknown task operation");
}

/** A single run's draft: the top-level shorthand (`prompt` …) or `task`, never both. */
function inlineDraft(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const { prompt, cwd, launch, name, timeoutSeconds } = input;
  if (prompt === undefined) return record(input.task) ?? undefined;
  if (input.task !== undefined) throw new Error("use either prompt or task");
  return { prompt, cwd, launch, name, timeoutSeconds };
}

/** A label for the Console, not an identifier. */
function nameFromPrompt(prompt: string): string {
  const line = prompt.split("\n")
    .map((l) => l.replace(/^[\s#>*-]+/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim())
    .find(Boolean) ?? "subagent";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/** A `prompt` shorthand becomes a fresh Agent action in the caller's own
 *  directory; everything the caller did spell out passes through to parseDraft. */
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

/** Persisted like any task (kind "subagent", filtered from default lists) so
 *  runs stay auditable and resumable. */
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
  // Delivery of a one-off run is the top-level fields' business; a nested
  // callback only means anything on a stored definition's schedule.
  if (draft.callback !== undefined || draft.callback_session_id !== undefined) {
    throw new Error("an inline task draft cannot set callback; use the top-level callback / callback_session_id");
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
