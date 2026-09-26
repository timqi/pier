// Settings → Tasks: every saved task with its schedule and last result, the
// pause switch, and each run's log one click away. Defining a task stays
// `pier task`'s job; this page watches and pauses.

import type { CommandResult, TaskDefinition, TaskRow, TaskRun } from "../../tasks/types.js";
import { getJson, refused } from "./api.js";
import { h, relTime, stampTime } from "./dom.js";
import { badge, button, card, empty, setStatus, toggle } from "./form.js";

/** One tint per outcome, so a list of runs reads by colour before by word. */
const RUN_TINT: Record<TaskRun["state"], string> = {
  queued: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  succeeded: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
  cancelled: "bg-amber-50 text-amber-700 ring-amber-200",
  interrupted: "bg-amber-50 text-amber-700 ring-amber-200",
  skipped: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

const runBadge = (run: TaskRun): HTMLElement =>
  run.state === "succeeded" && run.matched === false
    ? badge("no match", RUN_TINT.skipped)
    : badge(run.state, RUN_TINT[run.state], run.state === "running" ? "animate-pulse bg-sky-500" : undefined);

const triggerText = (task: TaskDefinition): string => {
  if (task.trigger.type === "manual") return "manual";
  if (task.trigger.type === "cron") return `${task.trigger.expression} (${task.trigger.timezone})`;
  return `watch every ${task.trigger.intervalSeconds}s`;
};

const commandText = (r: CommandResult): string =>
  `exit ${r.exitCode ?? "-"}\n${r.stdout}${r.stdoutTruncated ? "\n[stdout truncated]" : ""}${r.stderr ? `\nstderr:\n${r.stderr}` : ""}${r.stderrTruncated ? "\n[stderr truncated]" : ""}`;

/** What the run left behind, as text: its failure first, then its result. */
function runLog(run: TaskRun): string {
  const parts = [run.error, run.skipReason, run.callbackError].filter((s): s is string => Boolean(s));
  const r = run.result;
  if (r?.type === "agent" || r?.type === "system") parts.push(r.text);
  else if (r?.type === "bash") parts.push(commandText(r));
  else if (r?.type === "task") parts.push(`child run ${r.runId}`);
  if (run.probe) parts.push(`probe: ${commandText(run.probe)}`);
  return parts.join("\n\n") || "No output.";
}

const duration = (run: TaskRun): string => {
  if (run.startedAt === null) return "";
  const s = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function runRow(run: TaskRun): HTMLElement {
  const row = h("details", "rounded-lg border border-neutral-200") as HTMLDetailsElement;
  const summary = h(
    "summary",
    "flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11.5px] text-neutral-500",
    runBadge(run),
    h("span", "", stampTime(run.queuedAt)),
    h("span", "text-neutral-400", run.triggerSource),
    h("span", "ml-auto font-mono text-neutral-400", duration(run)),
  );
  row.append(summary);
  const body = h("div", "flex flex-col gap-2 border-t border-neutral-200 px-3 py-2");
  // Filled on first open: a list of twenty logs is mostly never read.
  row.ontoggle = () => {
    if (!row.open || body.childElementCount) return;
    if (run.targetSessionId) {
      const link = h("a", "text-[11.5px] text-indigo-600 hover:underline", "Open the run's session");
      (link as HTMLAnchorElement).href = `#/session/${encodeURIComponent(run.targetSessionId)}`;
      body.append(link);
    }
    body.append(h("pre", "max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-neutral-700", runLog(run)));
  };
  row.append(body);
  return row;
}

export function createTasksPane(): { el: HTMLElement; show(): void } {
  const listBox = h("div", "flex flex-col gap-2");
  const status = h("span", "text-[11.5px]", "");
  /** Which task's runs are open, so a reload after a toggle keeps them open. */
  const open = new Set<string>();

  async function setEnabled(task: TaskRow, enabled: boolean): Promise<void> {
    const verb = enabled ? "resume" : "pause";
    const error = await refused(`/api/tasks/${encodeURIComponent(task.id)}/${verb}`, "POST", `Could not ${verb} ${task.name}`);
    if (error) setStatus(status, "failed", error);
    else setStatus(status, "saved", `${task.name} ${enabled ? "resumed" : "paused"}.`);
    // Either way: a refused switch has already flipped and must flip back.
    await load();
  }

  function row(task: TaskRow): HTMLElement {
    const runsBox = h("div", "flex flex-col gap-1.5");
    const runsBtn = button("Runs");
    const drawRuns = async (): Promise<void> => {
      runsBox.replaceChildren(h("span", "text-[11.5px] text-neutral-400", "loading…"));
      const got = await getJson<TaskRun[]>(`/api/tasks/${encodeURIComponent(task.id)}/runs`, "Could not load runs");
      if (!got.ok) return void runsBox.replaceChildren(h("span", "text-[11.5px] text-red-600", got.error));
      runsBox.replaceChildren(...(got.value.length ? got.value.map(runRow) : [empty("No runs yet.")]));
    };
    runsBtn.onclick = () => {
      if (open.delete(task.id)) return void runsBox.replaceChildren();
      open.add(task.id);
      void drawRuns();
    };
    if (open.has(task.id)) void drawRuns();

    const meta = [triggerText(task)];
    if (task.nextRunAt !== null) meta.push(`next ${stampTime(task.nextRunAt)}`);
    const last = task.lastRun;
    const head = h(
      "div",
      "flex min-w-0 flex-col gap-1",
      h("span", "flex min-w-0 flex-wrap items-center gap-2",
        h("span", "truncate text-[12.5px] font-medium text-neutral-700", task.name),
        ...(last ? [runBadge(last), h("span", "text-[11px] text-neutral-400", relTime(last.queuedAt))] : [])),
      h("span", "truncate font-mono text-[11.5px] text-neutral-400", meta.join(" · ")),
    );
    if (task.description) head.title = task.description;
    const controls = h("div", "flex flex-none items-center gap-3");
    // A manual task has no schedule to pause.
    if (task.trigger.type !== "manual") {
      const sw = toggle("", "", task.enabled, (v) => void setEnabled(task, v));
      sw.title = task.enabled ? "Enabled — click to pause" : "Paused — click to resume";
      controls.append(sw);
    }
    controls.append(runsBtn);
    return h(
      "div",
      "flex flex-col gap-2 rounded-lg border border-neutral-200 px-3 py-2",
      h("div", "flex items-center justify-between gap-3", head, controls),
      runsBox,
    );
  }

  async function load(): Promise<void> {
    const got = await getJson<TaskRow[]>("/api/tasks", "Could not load tasks");
    if (!got.ok) return void listBox.replaceChildren(empty(got.error));
    listBox.replaceChildren(...(got.value.length
      ? got.value.map(row)
      : [empty("No tasks yet. Ask an agent to schedule one — `pier task` saves it.")]));
  }

  // The column every Settings topic sits in (vault.ts).
  const el = h("div", "mx-auto flex w-full min-w-0 max-w-3xl flex-col", card(
    "Tasks",
    "Saved tasks and their runs. A paused task keeps its definition and stops firing; defining or editing one is `pier task`'s job.",
    listBox,
    status,
  ));
  return { el, show: () => void load() };
}
