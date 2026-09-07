// One run on screen, wherever it was reached from: the detail page with its
// controls (steer/stop/continue, reply to a decision), result, probe, the
// definition it ran and its message ledger, plus the compact run list a task
// page shows. The definition view is shared with the task page, which shows
// the same record at its current revision. runs.ts and tasks.ts own the
// surrounding navigation.

import type { CommandResult, RunView, TaskDefinition, TaskGroup, TaskMessage, TaskRun } from "../../tasks/types.js";
import { getJson, promptRun, type Sent } from "./api.js";
import { fmtDuration, h } from "./dom.js";
import { badge, button, empty, toolbar } from "./form.js";

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

/** One tint per outcome, so a list of runs reads by colour before by word.
 *  Neutral is "nothing to act on": queued, skipped, a probe that did not match. */
const RUN_TINT: Record<TaskRun["state"], string> = {
  queued: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  succeeded: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
  cancelled: "bg-amber-50 text-amber-700 ring-amber-200",
  interrupted: "bg-amber-50 text-amber-700 ring-amber-200",
  skipped: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

/** The run's state as a badge — the same chip in every list and on the run page. */
export function runBadge(run: TaskRun): HTMLElement {
  const label = runLabel(run);
  return badge(
    label,
    label === "No match" ? RUN_TINT.skipped : RUN_TINT[run.state],
    run.state === "running" ? "animate-pulse bg-sky-500" : undefined,
  );
}

/** A task's standing as a badge: scheduled and live, scheduled but paused,
 *  fired by hand only, or retired. */
export function taskBadge(task: TaskDefinition): HTMLElement {
  if (task.archived) return badge("Archived", "bg-neutral-50 text-neutral-400 ring-neutral-200");
  if (task.trigger.type === "manual") return badge("Manual", "bg-neutral-100 text-neutral-600 ring-neutral-200");
  return task.enabled
    ? badge("Enabled", "bg-emerald-50 text-emerald-700 ring-emerald-200")
    : badge("Paused", "bg-amber-50 text-amber-700 ring-amber-200");
}

/** Section label and code block on the run page — the Console's label type
 *  and the chat's code tint, so the page reads like the rest of the product. */
const SECTION = "px-4 pt-4 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400";
const CODE = "m-4 mt-2 whitespace-pre-wrap break-words rounded-lg border border-black/[0.06] bg-black/[0.025] px-3 py-2 font-mono text-[12px] leading-snug dark:border-neutral-200 dark:bg-neutral-100";

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
  const content = h("div", "grid max-w-4xl grid-cols-[6rem_minmax(0,1fr)] gap-x-5 gap-y-3.5 p-4 text-[13px] md:grid-cols-[9.375rem_minmax(0,1fr)]");
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
      h("span", "pt-px text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", label),
      h("pre", "whitespace-pre-wrap break-words font-mono text-[12.5px] leading-snug", value),
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
    const row = h("button", "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-[12.5px] transition-colors hover:bg-neutral-50 md:grid-cols-[7.5rem_minmax(0,1fr)_7.5rem_6.25rem]");
    row.setAttribute("type", "button");
    row.append(
      h("span", "flex", runBadge(run)),
      h("span", "truncate text-neutral-500", dateTime(run.queuedAt)),
      h("span", "text-neutral-500", run.triggerSource),
      h("span", "text-right font-mono text-[11.5px] text-neutral-400", runDuration(run)),
    );
    row.onclick = () => openRun(run.id);
    list.append(row);
  }
  if (!runs.length) list.append(h("div", "p-4", empty("No runs yet.")));
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
  back.className = "cursor-pointer text-neutral-500 hover:text-neutral-800 hover:underline";
  back.onclick = () => { state.selectedId = null; state.scrollTop = 0; backToList(); };
  const actions = toolbar(back, h("span", "text-neutral-400", "›"), h("span", "min-w-0 truncate font-mono text-[12px] text-neutral-500", id));
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
    // A fan-out group's callback card names the group where a run's names its
    // run, so this route is reached with a group id too — and the cards already
    // in a transcript cannot be rewritten, which makes the fallback the only
    // repair for them. The run error is what surfaces if it is no group either.
    const group = await getJson<{ group: TaskGroup; members: TaskRun[] }>(`/api/task-groups/${id}`, got.error);
    if (!pane.isConnected || pane.dataset.runRequest !== request || state.selectedId !== id) return;
    state.drawn = "";
    if (!group.ok) {
      pane.replaceChildren(actions, h("p", "p-4 text-[13px] text-red-600", got.error));
      return;
    }
    const { group: joined, members } = group.value;
    const list = h("div", "min-w-0");
    pane.replaceChildren(actions, h("div", "border-b border-neutral-100 bg-neutral-50/60 px-4 py-3 text-[12.5px] text-neutral-600",
      [`Task group \u00b7 join ${joined.join}`, `${String(members.length)} runs`,
        joined.callbackState ? `callback ${joined.callbackState}` : ""].filter(Boolean).join(" \u00b7 ")), list);
    renderRuns(list, members, deps.openRun, { top: 0 });
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
      steer.onclick = () => void control(promptRun(steer, "Steer run", `/api/task-runs/${run.id}/steer`, {
        mode: "steer", sourceSessionId: deps.currentSessionId(),
      }, "Run control failed"), deps);
      actions.append(steer);
    }
    const cancel = button("Stop run");
    // Stop is one click from a running agent's end, next to controls that only
    // add to it — the ask is what tells the two apart.
    cancel.onclick = () => {
      if (window.confirm(`Stop this run of "${run.context.definition.name}"?`)) void deps.mutate(`/api/task-runs/${run.id}/cancel`);
    };
    actions.append(cancel);
  } else if (run.context.definition.action.type === "agent" && run.targetSessionId) {
    const resume = button("Continue");
    resume.onclick = () => void control(promptRun(resume, "Continue run", `/api/task-runs/${run.id}/resume`, {
      sourceSessionId: deps.currentSessionId(),
    }, "Run control failed"), deps, true);
    actions.append(resume);
  }
  const decision = messages.find((message) => message.id === run.pendingDecisionId);
  if (decision && decision.toSessionId === deps.currentSessionId()) {
    const reply = button("Reply to decision");
    reply.onclick = () => void control(promptRun(reply, "Reply to decision", `/api/task-messages/${decision.id}/reply`, {
      sourceSessionId: deps.currentSessionId(),
    }, "Reply failed"), deps);
    actions.append(reply);
  }
  const body = h("div", "min-w-0");
  const attention = runAttention(run);
  body.append(h("div", "flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-100 bg-neutral-50/60 px-4 py-3 text-[12.5px]",
    h("span", "flex items-center gap-2", runBadge(run), h("span", "font-medium", run.context.definition.name)),
    ...(attention ? [h("span", "rounded-md bg-amber-50 px-2 py-0.5 text-[12px] text-amber-700 ring-1 ring-amber-200", attention)] : []),
    h("span", "text-neutral-500", dateTime(run.queuedAt)),
    h("span", "text-neutral-500", run.triggerSource),
    h("span", "font-mono text-[11.5px] text-neutral-400", runDuration(run)),
  ));
  // Where this run sits: the task it belongs to, and the runs it came from or
  // produced, each one click away. A group has no page; it is named.
  const links = h("div", "flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3 text-[12px]");
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
  if (run.groupId) links.append(h("span", "break-all font-mono text-[11.5px] text-neutral-500", `Group: ${run.groupId}`));
  body.append(links);
  for (const error of [run.error, run.skipReason, run.callbackError]) {
    if (error) body.append(h("p", "m-4 whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700", error));
  }
  if (run.result) {
    const result = run.result;
    const text = result.type === "agent" || result.type === "system" ? result.text : result.type === "bash" ? commandText(result)
      : result.type === "task" ? `Child run: ${result.runId}` : "Watch did not match.";
    body.append(h("h3", SECTION, "Result"), h("pre", CODE, text || "No output."));
  }
  if (run.probe) body.append(
    h("h3", SECTION, `Watch probe: ${run.matched === null ? "not evaluated" : run.matched ? "matched" : "not matched"}`),
    h("pre", CODE, commandText(run.probe)),
  );
  // The definition as it was when this run was queued, not as it is now.
  const config = h("details", "border-t border-neutral-200");
  config.append(h("summary", "flex cursor-pointer items-center gap-1.5 px-4 py-3 text-[12px] text-neutral-500 hover:text-neutral-800", h("span", "chev", "▶"), `Configuration snapshot (revision ${run.taskRevision})`),
    definitionView(run.context.definition, deps.openSession));
  body.append(config);
  if (!gotMessages.ok) body.append(h("p", "m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700", gotMessages.error));
  if (messages.length) {
    const rows = h("div", "mt-2 divide-y divide-neutral-100 border-t border-neutral-100");
    for (const message of messages) {
      const row = h("div", "grid grid-cols-[auto_1fr] gap-3 px-4 py-2 text-[12px] md:grid-cols-[6.25rem_6.25rem_minmax(0,1fr)]");
      row.append(h("span", "font-medium", message.kind), h("span", "text-neutral-500", message.state), h("span", "col-span-2 whitespace-pre-wrap break-words md:col-span-1", message.content));
      if (message.error) row.append(h("span", "col-span-2 break-words text-red-600 md:col-span-3", message.error));
      rows.append(row);
    }
    body.append(h("div", "border-t border-neutral-200", h("div", SECTION, "Messages"), rows));
  }
  const raw = h("details", "border-t border-neutral-200") as HTMLDetailsElement;
  raw.open = state.rawOpen;
  raw.ontoggle = () => { if (raw.isConnected) state.rawOpen = raw.open; };
  raw.append(h("summary", "flex cursor-pointer items-center gap-1.5 px-4 py-3 text-[12px] text-neutral-500 hover:text-neutral-800", h("span", "chev", "▶"), "Raw record"),
    h("pre", CODE, JSON.stringify(run, null, 2)));
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
