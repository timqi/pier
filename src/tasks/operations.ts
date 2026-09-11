// The `/task` socket route: every `pier task` operation — run, message, save,
// list, cancel, recover — validated here once, answered with the summaries a
// model reads. Scheduling and delivery stay in the service; this file decides
// who may ask for what.

import { isAbsolute, resolve } from "node:path";
import type { ModelRef } from "../core/types.js";
import { logger } from "../log.js";
import { type TaskDefinitions, record, requiredString } from "./definitions.js";
import type { TaskService } from "./service.js";
import type { TaskStore } from "./store.js";
import { isTerminal, type CallbackFields, type CallbackMode, type TaskDefinition, type TaskGroup, type TaskResult, type TaskRun } from "./types.js";

const log = logger("tasks");

type MenuEntry = Awaited<ReturnType<TaskService["models"]>>["models"][number];
type Menu = () => Promise<MenuEntry[]>;

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

const summarize = (run: TaskRun): RunSummary => defined<RunSummary>({
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

/** Who a new run's result goes to — the caller, nobody, or a named session that
 *  must exist. Shared by `run` and `message` on a finished run: a resumed run is a new run. */
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
      text: `${summary.result.text.slice(0, 2000)}\n[truncated — pier task recover --run ${summary.runId} --reason … for the full text]`,
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

const summarizeGroup = (group: TaskGroup, members: TaskRun[]): GroupSummary => defined<GroupSummary>({
  groupId: group.id,
  join: group.join,
  state: group.finishedAt ? "finished" : "running",
  callbackState: group.callbackState,
  callbackMode: group.callbackMode ?? null,
  winnerRunId: group.winnerRunId,
  members: members.map((run) => trimResult(summarize(run))),
  next: null,
});

export async function handleTask(
  host: TaskService,
  definitions: TaskDefinitions,
  store: TaskStore,
  raw: unknown,
  callerSessionId: string,
): Promise<unknown> {
  const input = record(raw);
  if (!input) throw new Error("task parameters required");
  // Delegation is one level (docs/design/09-tasks-cli.md §Two levels, no tree):
  // what a supervised run launched would report to a session no run owns. A
  // queued run has not taken the session's turn, so it gates nothing yet.
  const active = store.findActiveRunForTarget(callerSessionId);
  if (active?.state === "running" && store.supervised(active)) throw new Error("a delegated run cannot delegate; ask in your result and let your supervisor run it");
  const menu: Menu = () => host.models().then((listed) => listed.models);
  if (input.operation === "list") return definitions.list().filter((task) => task.kind !== "subagent");
  if (input.operation === "save") {
    const draft = await expandDraft(definitions, menu, input.task, callerSessionId);
    return input.task_id === undefined
      ? definitions.create(draft, `session:${callerSessionId}`)
      : definitions.update(requiredString(input.task_id, "task_id"), draft);
  }
  if (input.operation === "run") {
    // `--model ?`: the menu instead of a run, the one lookup the common case never pays.
    if (record(input.launch)?.model === "?") return host.models();
    const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
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
          ? await resolveDraft(definitions, menu, entry, callerSessionId)
          : definitions.get(requiredString(entry.task_id, "task_id")));
      }
      const groupCallbackSessionId = input.callback === "none" ? null : callerSessionId;
      const { group, runs } = host.runGroup(
        resolved,
        input.join === "first" ? "first" : "all",
        callerSessionId,
        groupCallbackSessionId,
        callbackMode,
      );
      return receipt(summarizeGroup(group, runs), groupCallbackSessionId, callbackMode, callerSessionId);
    }
    const draft = input.task_id === undefined ? inlineDraft(input) : undefined;
    const task = draft
      ? await resolveDraft(definitions, menu, draft, callerSessionId)
      : definitions.get(requiredString(input.task_id, "task_id"));
    // Same as the HTTP route: a named mode the schema no longer offers is
    // answered, not quietly swapped for the definition's own policy.
    if (input.session_mode !== undefined && input.session_mode !== "fresh") {
      throw new Error(`unsupported session_mode: ${String(input.session_mode)}`);
    }
    const sessionMode = input.session_mode;
    const callbackSessionId = await callbackTarget(input, definitions, callerSessionId);
    const run = host.run(task.id, input.input, "agent", null, {
      invokedBySessionId: callerSessionId,
      sourceSessionId: callerSessionId,
      callbackSessionId,
      callbackMode,
      background: true,
      sessionMode,
    });
    return receipt(summarize(run), callbackSessionId, callbackMode, callerSessionId);
  }
  if (input.operation === "recover") {
    // History only, never status: readable once the callback has said its last
    // word. The required reason is the friction, and the operator sees it.
    const reason = requiredString(input.reason, "reason");
    // A race winner need not wait for losing members to finish cancelling.
    const groupReady = (group: TaskGroup): void => {
      if (!group.finishedAt || !settled(group)) notRecoverable(`group ${group.id}`, group);
    };
    if (typeof input.group_id === "string") {
      const { group, members } = host.getGroup(input.group_id);
      groupReady(group);
      if (!members.every((run) => isTerminal(run.state))) {
        throw new Error(`recover cannot inspect active members; the race has settled — recover its winning result with --run ${group.winnerRunId ?? "<id from the callback>"} and a reason`);
      }
      log.info(`recover group ${group.id} by ${callerSessionId}: ${reason}`);
      return summarizeGroup(group, members);
    }
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    if (run.groupId) {
      const { group } = host.getGroup(run.groupId);
      groupReady(group);
      if (!isTerminal(run.state)) throw new Error("the group has reported its outcome; recover reads finished results only and cannot wait for this member");
    } else if (!isTerminal(run.state) || !settled(run)) {
      notRecoverable(`run ${run.id}`, run);
    }
    log.info(`recover run ${run.id} by ${callerSessionId}: ${reason}`);
    return summarize(run);
  }
  if (input.operation === "cancel") {
    if (typeof input.group_id === "string") {
      const { group, members } = host.getGroup(input.group_id);
      for (const member of members) assertOwns(callerSessionId, member);
      const cancelled = host.cancelGroup(group.id);
      return summarizeGroup(cancelled, cancelled.memberRunIds.map((id) => host.getRun(id)));
    }
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(callerSessionId, run);
    const cancelled = host.cancel(run.id);
    return summarize(cancelled);
  }
  if (input.operation === "message") {
    // The one request `pier task run --run` sends: the run's state, not the
    // caller, decides whether the text steers, queues or resumes, so a status
    // query never has to exist.
    const run = host.getRun(requiredString(input.run_id, "run_id"));
    assertOwns(callerSessionId, run);
    const message = requiredString(input.message, "message");
    if (isTerminal(run.state)) {
      // A resumed run is a new run with its own callback.
      const callbackMode: CallbackMode = input.callback === "steer" ? "steer" : "followUp";
      const callbackSessionId = await callbackTarget(input, definitions, callerSessionId);
      const resumed = host.resume(run.id, message, { invokedBySessionId: callerSessionId, callbackSessionId, callbackMode, background: true });
      return { delivery: "resume", run: receipt(summarize(resumed), callbackSessionId, callbackMode, callerSessionId) };
    }
    if (input.callback !== undefined || input.callback_session_id !== undefined) {
      throw new Error(`run ${run.id} is ${run.state}: callback options apply to a resumed run only; drop them to steer or follow up`);
    }
    const delivery = input.after === true ? "follow_up" : "steer";
    return { delivery, message: await host.control(run.id, callerSessionId, delivery, message) };
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

/** `launch.model` by name (docs/design/09-tasks-cli.md §Models): an exact
 *  `provider/id` on the menu is that pin; one case-insensitive substring hit
 *  over provider, id and note is that pin, its thinking the default; a
 *  `provider/id` nobody pinned is taken as written. Anything else is refused
 *  with the lines to pick from, so the agent never guesses an id. */
function resolveModel(name: string, menu: MenuEntry[]): { model: ModelRef; thinking?: string } {
  const needle = name.trim().toLowerCase();
  const full = (pin: MenuEntry): string => `${pin.provider}/${pin.id}`;
  const line = (pin: MenuEntry): string => `${full(pin)}${pin.thinking ? ` · ${pin.thinking}` : ""}${pin.note ? ` — ${pin.note}` : ""}`;
  const exact = menu.find((pin) => full(pin).toLowerCase() === needle);
  const hits = exact ? [exact] : menu.filter((pin) => `${full(pin)} ${pin.note ?? ""}`.toLowerCase().includes(needle));
  if (hits.length === 1) return { model: { provider: hits[0]!.provider, id: hits[0]!.id }, thinking: hits[0]!.thinking };
  const slash = name.indexOf("/");
  if (!hits.length && slash > 0 && slash < name.length - 1) return { model: { provider: name.slice(0, slash), id: name.slice(slash + 1) } };
  throw new Error(`model "${name}" matches ${String(hits.length)} of the menu:\n${(hits.length ? hits : menu).map(line).join("\n")}`);
}

/** A `prompt` shorthand becomes a fresh Agent action in the caller's own
 *  directory; everything the caller did spell out passes through to parseDraft. */
async function expandDraft(definitions: TaskDefinitions, menu: Menu, raw: unknown, callerSessionId: string): Promise<unknown> {
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
  const launch = record(action?.launch);
  if (typeof launch?.model === "string") {
    const { model, thinking } = resolveModel(launch.model, await menu());
    const resolved = { ...launch, model, ...(launch.thinking === undefined && thinking ? { thinking } : {}) };
    draft = { ...draft, action: { ...record(draft.action), launch: resolved } };
  }
  return draft;
}

/** Persisted like any task (kind "subagent", filtered from default lists) so
 *  runs stay auditable and resumable. */
async function resolveDraft(
  definitions: TaskDefinitions,
  menu: Menu,
  raw: unknown,
  callerSessionId: string,
): Promise<TaskDefinition> {
  const draft = record(await expandDraft(definitions, menu, raw, callerSessionId));
  if (!draft) throw new Error("task definition required");
  if (draft.trigger !== undefined && record(draft.trigger)?.type !== "manual") {
    throw new Error("inline subagent tasks must use a manual trigger");
  }
  // Delivery of a one-off run is the top-level fields' business; a nested
  // callback only means anything on a stored definition's schedule.
  if (draft.callback !== undefined || draft.callback_session_id !== undefined) {
    throw new Error("an inline task draft cannot set callback; use the top-level callback / callback_session_id");
  }
  return definitions.create({ ...draft, trigger: { type: "manual" } }, `session:${callerSessionId}`, "subagent");
}

/** The session that launched a run controls it, and so does the run's own
 *  session; a `task` action's child inherits its parent's launcher. */
function assertOwns(callerSessionId: string, target: TaskRun): void {
  if (target.invokedBySessionId !== callerSessionId && target.targetSessionId !== callerSessionId) {
    throw new Error("session does not own this run");
  }
}
