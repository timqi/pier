// One run on screen, wherever it was reached from: the detail page with its
// controls (steer/stop/continue, reply to a decision), result, probe, the
// definition it ran and its message ledger, plus the compact run list a task
// page shows. The definition view is shared with the task page, which shows
// the same record at its current revision. runs.ts and tasks.ts own the
// surrounding navigation.

import type { CommandResult, RunView, TaskDefinition, TaskMessage, TaskRun } from "../../tasks/types.js";
import { getJson, promptRun, type Sent } from "./api.js";
import { fmtDuration, h } from "./dom.js";
import { button } from "./form.js";

export interface TaskRunsDeps {
  openSession: (id: string) => void;
  currentSessionId: () => string | null;
  mutate: (url: string) => Promise<void>;
  onError: (message: string) => void;
  reload: () => Promise<void>;
  openRun: (id: string) => void;
  openTask: (id: string) => void;
}

export const dateTime = (value: number | null): string =>
  value === null ? "-" : new Date(value).toLocaleString();

export const runDuration = (run: TaskRun): string =>
  run.startedAt === null ? "-" : fmtDuration((run.finishedAt ?? Date.now()) - run.startedAt);

export const runLabel = (run: TaskRun): string =>
  run.state === "succeeded" && run.matched === false ? "No match" : run.state;

export const triggerSummary = (task: TaskDefinition): string => {
  if (task.trigger.type === "manual") return "Manual";
  if (task.trigger.type === "cron") return `${task.trigger.expression} (${task.trigger.timezone})`;
  return `Every ${task.trigger.intervalSeconds}s · ${task.trigger.mode}`;
};

export const actionSummary = (task: TaskDefinition): string => {
  if (task.action.type === "agent") return `Agent · ${task.action.session.mode}`;
  if (task.action.type === "bash") return "Bash";
  if (task.action.type === "system") return "System";
  return "Task";
};

/** A definition as readable fields: the task page's Definition tab, and the
 *  revision a run carried in its snapshot. */
export function definitionView(task: TaskDefinition, openSession: (id: string) => void): HTMLElement {
  const content = h("div", "grid max-w-4xl grid-cols-[6rem_minmax(0,1fr)] gap-x-5 gap-y-3 p-4 text-[13px] md:grid-cols-[9.375rem_minmax(0,1fr)]");
  const values: [string, string][] = [
    ["Status", task.archived ? "Archived" : task.trigger.type === "manual" ? "Manual" : task.enabled ? "Enabled" : "Paused"],
    ["Trigger", triggerSummary(task)],
    ["Action", actionSummary(task)],
    ["Timeout", `${task.timeoutSeconds}s`],
    ["Next run", dateTime(task.nextRunAt)],
    ["Revision", String(task.revision)],
    ["Created by", task.createdBySessionId ?? task.creator],
    ["Callback", task.callback.type === "session" ? task.callback.sessionId : task.callback.type],
    ["Description", task.description || "-"],
  ];
  if (task.action.type === "agent") {
    values.push(["Session policy", task.action.session.mode]);
    if (task.action.session.mode === "reuse") values.push(["Session", task.action.session.sessionId]);
    // By shape: a legacy `fork` definition carries a directory the details
    // view would otherwise stop showing.
    if ("cwd" in task.action.session) values.push(["Directory", task.action.session.cwd]);
    if (task.action.launch?.model) values.push(["Model", `${task.action.launch.model.provider}/${task.action.launch.model.id}`]);
    if (task.action.launch?.thinking) values.push(["Thinking", task.action.launch.thinking]);
    values.push(["Prompt", task.action.prompt]);
  }
  if (task.action.type === "bash") values.push(["Directory", task.action.cwd], ["Script", task.action.script]);
  if (task.action.type === "task") values.push(["Target task", task.action.taskId]);
  if (task.action.type === "system") values.push(["System action", task.action.name]);
  if (task.trigger.type === "watch") values.push(["Probe", task.trigger.script]);
  for (const [label, value] of values) {
    content.append(
      h("span", "text-[11px] font-semibold uppercase text-neutral-400", label),
      h("pre", "whitespace-pre-wrap break-words font-mono text-[12.5px]", value),
    );
  }
  if (task.action.type === "agent" && task.action.session.mode === "reuse") {
    const { sessionId } = task.action.session;
    const open = button("Open session");
    open.onclick = () => openSession(sessionId);
    content.append(h("span", "", ""), open);
  }
  return content;
}

/** What still needs a human or a retry: an unanswered decision, a callback
 *  (the run's own or its group's) that has not landed. */
export function runAttention(run: RunView): string {
  return [run.pendingDecisionId ? "Awaiting decision" : "",
    run.callbackState && run.callbackState !== "delivered" ? `Callback not delivered (${run.callbackState})` : "",
    run.groupCallbackState && run.groupCallbackState !== "delivered" ? `Group callback not delivered (${run.groupCallbackState})` : ""].filter(Boolean).join(" · ");
}

/** What survives a redraw of the detail: which run, the raw disclosure, the
 *  scroll position, and the payload last drawn so an event that changed
 *  nothing does not replace a button mid-click. */
export interface RunViewState {
  selectedId: string | null;
  rawOpen: boolean;
  scrollTop: number;
  drawn: string;
}

export function renderRuns(pane: HTMLElement, runs: TaskRun[], openRun: (id: string) => void, scroll: { top: number }): void {
  const list = h("div", "divide-y divide-neutral-100");
  for (const run of runs) {
    const row = h("button", "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 text-left text-[12.5px] hover:bg-neutral-50 md:grid-cols-[7.5rem_minmax(0,1fr)_7.5rem_6.25rem]");
    row.setAttribute("type", "button");
    row.append(
      h("span", "font-medium", runLabel(run)),
      h("span", "truncate text-neutral-500", dateTime(run.queuedAt)),
      h("span", "text-neutral-500", run.triggerSource),
      h("span", "text-right text-neutral-500", runDuration(run)),
    );
    row.onclick = () => openRun(run.id);
    list.append(row);
  }
  if (!runs.length) list.append(h("p", "p-4 text-[13px] text-neutral-400", "No runs yet."));
  pane.replaceChildren(list);
  pane.scrollTop = scroll.top;
  pane.onscroll = () => { scroll.top = pane.scrollTop; };
}

const commandText = (result: CommandResult): string =>
  `Exit code: ${result.exitCode ?? "-"}\nstdout:\n${result.stdout}${result.stdoutTruncated ? "\n[stdout truncated]" : ""}\nstderr:\n${result.stderr}${result.stderrTruncated ? "\n[stderr truncated]" : ""}`;

export async function openRun(pane: HTMLElement, id: string, backToList: () => void, deps: TaskRunsDeps, state: RunViewState): Promise<void> {
  const request = String(Number(pane.dataset.runRequest ?? 0) + 1);
  pane.dataset.runRequest = request;
  pane.onscroll = () => { state.scrollTop = pane.scrollTop; };
  const back = button("Runs");
  back.className = "cursor-pointer text-neutral-500 hover:underline";
  back.onclick = () => { state.selectedId = null; state.scrollTop = 0; backToList(); };
  const actions = h("div", "flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2");
  actions.append(back, h("span", "min-w-0 truncate font-mono text-[12px] text-neutral-400", id));
  // Only a pane that shows another run (or nothing) gets the placeholder: a
  // refresh of the run on screen redraws it in place.
  const fresh = pane.dataset.runId !== id;
  if (fresh) {
    pane.dataset.runId = id;
    pane.replaceChildren(actions, h("p", "p-4 text-[13px] text-neutral-500", "Loading run..."));
  }
  const [got, gotMessages] = await Promise.all([
    getJson<RunView>(`/api/task-runs/${id}`, "Could not load the run"),
    getJson<TaskMessage[]>(`/api/task-runs/${id}/messages`, "Could not load the run's messages"),
  ]);
  if (!pane.isConnected || pane.dataset.runRequest !== request || state.selectedId !== id) return;
  if (!got.ok) {
    state.drawn = "";
    pane.replaceChildren(actions, h("p", "p-4 text-[13px] text-red-600", got.error));
    return;
  }
  const run = got.value;
  const messages = gotMessages.ok ? gotMessages.value : [];
  const payload = JSON.stringify([run, gotMessages]);
  if (!fresh && state.drawn === payload) return;
  state.drawn = payload;
  if (run.targetSessionId) {
    const open = button("Open session");
    open.classList.add("ml-auto");
    open.onclick = () => deps.openSession(run.targetSessionId!);
    actions.append(open);
  }
  if (run.state === "queued" || run.state === "running") {
    if (run.context.definition.action.type === "agent") {
      const steer = button("Steer");
      steer.onclick = () => void control(promptRun("Steer run", `/api/task-runs/${run.id}/steer`, {
        mode: "steer", sourceSessionId: deps.currentSessionId(),
      }, "Run control failed"), deps);
      actions.append(steer);
    }
    const cancel = button("Stop run");
    cancel.onclick = () => void deps.mutate(`/api/task-runs/${run.id}/cancel`);
    actions.append(cancel);
  } else if (run.context.definition.action.type === "agent" && run.targetSessionId) {
    const resume = button("Continue");
    resume.onclick = () => void control(promptRun("Continue run", `/api/task-runs/${run.id}/resume`, {
      sourceSessionId: deps.currentSessionId(),
    }, "Run control failed"), deps, true);
    actions.append(resume);
  }
  const decision = messages.find((message) => message.id === run.pendingDecisionId);
  if (decision && decision.toSessionId === deps.currentSessionId()) {
    const reply = button("Reply to decision");
    reply.onclick = () => void control(promptRun("Reply to decision", `/api/task-messages/${decision.id}/reply`, {
      sourceSessionId: deps.currentSessionId(),
    }, "Reply failed"), deps);
    actions.append(reply);
  }
  const body = h("div", "min-w-0");
  body.append(h("div", "flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-100 px-4 py-3 text-[12.5px]",
    h("span", "font-medium", runLabel(run)),
    h("span", "text-amber-700", runAttention(run)),
    h("span", "text-neutral-500", dateTime(run.queuedAt)),
    h("span", "text-neutral-500", run.triggerSource),
    h("span", "text-neutral-500", runDuration(run)),
  ));
  // Where this run sits: the task it belongs to, and the runs it came from or
  // produced, each one click away. A group has no page; it is named.
  const links = h("div", "flex flex-wrap items-center gap-3 border-b border-neutral-100 px-4 py-3 text-[12px]");
  const link = (label: string, go: () => void): void => {
    const el = button(label); el.classList.add("max-w-full", "break-all", "!whitespace-normal"); el.onclick = go; links.append(el);
  };
  if (run.context.definition.kind === "task") link(`Task: ${run.context.definition.name}`, () => deps.openTask(run.taskId));
  if (run.parentRunId) link(`Parent: ${run.parentRunId}`, () => deps.openRun(run.parentRunId!));
  if (run.resumedFromRunId) link(`Resumed from: ${run.resumedFromRunId}`, () => deps.openRun(run.resumedFromRunId!));
  if (run.result?.type === "task") {
    const childId = run.result.runId;
    link(`Child result: ${childId}`, () => deps.openRun(childId));
  }
  if (run.groupId) links.append(h("span", "break-all text-neutral-500", `Group: ${run.groupId}`));
  body.append(links);
  for (const error of [run.error, run.skipReason, run.callbackError]) {
    if (error) body.append(h("p", "whitespace-pre-wrap break-words p-4 text-[13px] text-red-600", error));
  }
  if (run.result) {
    const result = run.result;
    const text = result.type === "agent" || result.type === "system" ? result.text : result.type === "bash" ? commandText(result)
      : result.type === "task" ? `Child run: ${result.runId}` : "Watch did not match.";
    body.append(h("h3", "px-4 pt-3 text-[12px] font-medium", "Result"), h("pre", "whitespace-pre-wrap break-words p-4 font-mono text-[12px]", text || "No output."));
  }
  if (run.probe) body.append(
    h("h3", "px-4 pt-3 text-[12px] font-medium", `Watch probe: ${run.matched === null ? "not evaluated" : run.matched ? "matched" : "not matched"}`),
    h("pre", "whitespace-pre-wrap break-words p-4 font-mono text-[12px]", commandText(run.probe)),
  );
  // The definition as it was when this run was queued, not as it is now.
  const config = h("details", "border-t border-neutral-200");
  config.append(h("summary", "cursor-pointer px-4 py-3 text-[12px] text-neutral-500", `Configuration snapshot (revision ${run.taskRevision})`),
    definitionView(run.context.definition, deps.openSession));
  body.append(config);
  if (!gotMessages.ok) body.append(h("p", "p-4 text-[13px] text-red-600", gotMessages.error));
  if (messages.length) {
    const ledger = h("div", "border-t border-neutral-200");
    ledger.append(h("div", "px-4 py-2 text-[11px] font-semibold uppercase text-neutral-400", "Messages"));
    for (const message of messages) {
      const row = h("div", "grid grid-cols-[auto_1fr] gap-3 border-t border-neutral-100 px-4 py-2 text-[12px] md:grid-cols-[6.25rem_6.25rem_minmax(0,1fr)]");
      row.append(h("span", "font-medium", message.kind), h("span", "text-neutral-500", message.state), h("span", "col-span-2 whitespace-pre-wrap break-words md:col-span-1", message.content));
      if (message.error) row.append(h("span", "col-span-2 break-words text-red-600 md:col-span-3", message.error));
      ledger.append(row);
    }
    body.append(ledger);
  }
  const raw = h("details", "border-t border-neutral-200") as HTMLDetailsElement;
  raw.open = state.rawOpen;
  raw.ontoggle = () => { if (raw.isConnected) state.rawOpen = raw.open; };
  raw.append(h("summary", "cursor-pointer px-4 py-3 text-[12px] text-neutral-500", "Raw record"),
    h("pre", "whitespace-pre-wrap break-words px-4 pb-4 font-mono text-[12px]", JSON.stringify(run, null, 2)));
  body.append(raw);
  pane.replaceChildren(actions, body);
  pane.scrollTop = state.scrollTop;
  pane.onscroll = () => { state.scrollTop = pane.scrollTop; };
}

/** Show what went wrong, or reload so the run's new state is on screen — or,
 *  for a continuation, open the run it created. */
async function control(outcome: Promise<Sent>, deps: TaskRunsDeps, continued = false): Promise<void> {
  const result = await outcome;
  if (!result.sent) return;
  if (result.error) deps.onError(result.error);
  else if (continued && result.response) {
    try {
      const run = await result.response.json() as TaskRun;
      deps.openRun(run.id);
    } catch (err) { deps.onError(`Could not open continuation: ${String(err)}`); }
  } else await deps.reload();
}
