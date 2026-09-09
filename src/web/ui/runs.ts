// Console → Runs: every execution across tasks — the filtered, keyset-paged
// list and, one level in, a run. Filtering and paging are the task API's
// (`/api/task-runs`); the run detail and its controls are task-runs.ts's,
// shared with the task page. This file owns the filter set, which *is* the
// route's query string: every change navigates, so Back walks filters too.
import { ChevronRight } from "lucide";
import { icon } from "./icons.js";
import type { RunPage, TaskDefinition } from "../../tasks/types.js";
import { coalesce, getJson, refused } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { button, CONTROL, empty, select } from "./form.js";
import { dateTime, openRun, runAttention, runBadge, runDuration, type RunViewState, type TaskRunsDeps } from "./task-runs.js";

export type RunsView = ConsoleView & { refresh(): void };

export function createRunsView(
  root: HTMLElement,
  openSession: (id: string) => void,
  navigate: (filters: Record<string, string>, id?: string) => void,
  openTask: (id: string) => void,
): RunsView {
  let filters = new URLSearchParams();
  let tasks: TaskDefinition[] = [];
  let drawn = "";
  let pane = h("div", "min-h-0 flex-1 overflow-auto");
  let taskSelect: HTMLSelectElement | undefined;
  const state: RunViewState = { selectedId: null, rawOpen: false, scrollTop: 0, drawn: "" };
  const go = (next: URLSearchParams, id?: string): void => navigate(Object.fromEntries(next), id);
  const onError = (message: string): void => {
    root.querySelector("[role=alert]")?.remove();
    const error = h("p", "p-4 text-[13px] text-red-600", message);
    error.setAttribute("role", "alert"); root.append(error);
  };
  const deps: TaskRunsDeps = {
    openSession, openTask,
    openRun: (id) => go(filters, id),
    mutate: async (url) => {
      const error = await refused(url, "POST", "Run update failed");
      if (error) onError(error);
      else await load();
    },
  };
  const load = coalesce(async () => {
    const id = state.selectedId;
    if (id) return openRun(pane, id, () => go(filters), deps, state);
    const wanted = filters.toString();
    const got = await getJson<RunPage>(`/api/task-runs?${wanted}`, "Could not load runs");
    if (wanted !== filters.toString() || state.selectedId) return;
    if (!got.ok) return onError(got.error);
    root.querySelector("[role=alert]")?.remove();
    const payload = JSON.stringify(got.value);
    if (drawn === wanted + payload) return;
    drawn = wanted + payload;
    drawPage(got.value);
  });

  function change(key: string, value: string): void {
    const next = new URLSearchParams(filters);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("cursor");
    go(next);
  }

  function drawShell(): void {
    drawn = "";
    pane = h("div", "min-h-0 flex-1 overflow-auto");
    taskSelect = undefined;
    if (state.selectedId) { root.replaceChildren(pane); return; }
    root.replaceChildren(drawControls(), pane);
  }

  function taskChoices(): [string, string][] {
    const options: [string, string][] = tasks.map((task) => [task.name + (task.archived ? " (archived)" : ""), task.id]);
    const selected = filters.get("taskId");
    if (selected && !tasks.some((task) => task.id === selected)) options.push([selected, selected]);
    return [["All tasks", ""], ...options];
  }

  // The filter row is the page's toolbar: the Automation strip above names
  // the view, so this row carries only what narrows the list.
  function drawControls(): HTMLElement {
    const box = h("div", "automation-filters run-filters");
    const filter = (label: string, key: string, options: [string, string][]): HTMLSelectElement => {
      const input = select(options, filters.get(key) ?? "");
      input.dataset.active = String(Boolean(filters.get(key)));
      input.setAttribute("aria-label", label);
      input.onchange = () => change(key, input.value);
      box.append(h("label", `filter-field ${key === "taskId" ? "filter-wide" : ""}`, h("span", "", label), input));
      return input;
    };
    filter("State", "state", [["All states", ""], ...["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "skipped"].map((v): [string, string] => [v, v])]);
    filter("Source", "source", [["All sources", ""], ...["manual", "agent", "cron", "watch", "task"].map((v): [string, string] => [v, v])]);
    taskSelect = filter("Task", "taskId", taskChoices());
    const dates = h("details", "filter-dates") as HTMLDetailsElement;
    const dateCount = Number(filters.has("since")) + Number(filters.has("until"));
    dates.open = dateCount > 0;
    dates.append(h("summary", "flex cursor-pointer items-center gap-1.5 py-1 text-[12px] text-neutral-600", icon(ChevronRight, "chev h-3 w-3"), dateCount ? `Date range (${dateCount})` : "Date range"));
    const dateFields = h("div", "filter-date-fields");
    for (const [label, key] of [["From", "since"], ["Through", "until"]] as const) {
      const input = h("input", CONTROL) as HTMLInputElement;
      input.type = "datetime-local"; input.setAttribute("aria-label", label);
      const value = filters.get(key);
      if (value) {
        const date = new Date(Number(value));
        if (Number.isFinite(date.getTime())) input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      }
      input.dataset.active = String(Boolean(input.value));
      input.onchange = () => change(key, input.value ? String(new Date(input.value).getTime()) : "");
      dateFields.append(h("label", "filter-field", h("span", "", label), input));
    }
    dates.append(dateFields);
    const toggle = h("input", "h-4 w-4 flex-none") as HTMLInputElement;
    toggle.type = "checkbox";
    toggle.checked = filters.get("showUnmatched") === "true";
    toggle.onchange = () => change("showUnmatched", toggle.checked ? "true" : "");
    const visibility = h("label", "flex min-h-10 cursor-pointer items-center gap-2 text-[11.5px] text-neutral-500", toggle, "Show unmatched probes");
    const active = [...filters.keys()].filter((key) => key !== "cursor").length;
    const reset = button(active ? `Reset filters (${active})` : "Reset filters");
    reset.classList.add("filter-action");
    reset.disabled = !active;
    reset.onclick = () => navigate({});
    box.append(dates, h("div", "filter-footer", visibility, reset));
    return box;
  }

  function drawPage(page: RunPage): void {
    const list = h("div", "divide-y divide-neutral-100");
    for (const run of page.runs) {
      const row = h("div", "px-4 py-3 text-[12px] transition-colors hover:bg-neutral-50");
      const open = h("button", "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 text-left md:grid-cols-[minmax(0,1fr)_12rem_5rem]");
      open.setAttribute("type", "button"); open.onclick = () => go(filters, run.id);
      // Phone: name and duration share the first line, the date takes the
      // second; desktop lays the three out as columns (hence the md:order-*).
      open.append(
        h("span", "flex min-w-0 items-center gap-2", runBadge(run), h("span", "min-w-0 truncate font-medium text-neutral-800", run.context.definition.name)),
        h("span", "text-right font-mono text-[11.5px] text-neutral-400 md:order-2", runDuration(run)),
        h("span", "col-span-2 text-neutral-500 md:order-1 md:col-span-1", dateTime(run.queuedAt)),
        h("span", "col-span-2 break-all font-mono text-[11px] text-neutral-400 md:order-3 md:col-span-3", `${run.id} · ${run.triggerSource}`));
      row.append(open);
      const attention = runAttention(run);
      if (attention) row.append(h("p", "mt-1.5 inline-block break-words rounded-md bg-amber-50 px-2 py-0.5 text-[11.5px] text-amber-700 ring-1 ring-amber-200", attention));
      const relations = h("div", "mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-neutral-500");
      const chip = "max-w-full break-all rounded-md bg-neutral-100 px-1.5 py-0.5 text-left";
      const link = (label: string, action: () => void): void => {
        const el = h("button", `${chip} cursor-pointer transition-colors hover:bg-neutral-200 hover:text-neutral-800`, label);
        el.setAttribute("type", "button"); el.onclick = action; relations.append(el);
      };
      if (run.parentRunId) link(`Parent ${run.parentRunId}`, () => go(filters, run.parentRunId!));
      if (run.resumedFromRunId) link(`Resumed from ${run.resumedFromRunId}`, () => go(filters, run.resumedFromRunId!));
      if (run.result?.type === "task") { const id = run.result.runId; link(`Child result ${id}`, () => go(filters, id)); }
      if (run.groupId) relations.append(h("span", chip, `Group ${run.groupId}`));
      if (relations.childElementCount) row.append(relations);
      list.append(row);
    }
    if (!page.runs.length) list.append(h("div", "p-4", empty("No matching runs.")));
    const paging = h("div", "flex items-center gap-3 border-t border-neutral-200 p-4");
    if (filters.has("cursor")) {
      const newest = button("Newest"); newest.onclick = () => change("cursor", ""); paging.append(newest);
    }
    if (page.nextCursor) {
      const older = button("Older runs");
      older.onclick = () => { const next = new URLSearchParams(filters); next.set("cursor", JSON.stringify(page.nextCursor)); go(next); };
      paging.append(older);
    }
    const scroll = pane.scrollTop;
    pane.replaceChildren(list, paging); pane.scrollTop = scroll;
  }

  /** The Task picker's options; redrawn in place when they change, so the page
   *  already on screen stays. */
  async function loadTasks(): Promise<void> {
    const got = await getJson<TaskDefinition[]>("/api/tasks?kind=task", "Could not load task filters");
    if (!got.ok) return onError(got.error);
    if (JSON.stringify(tasks) === JSON.stringify(got.value)) return;
    tasks = got.value;
    if (!state.selectedId && taskSelect?.isConnected) {
      taskSelect.replaceChildren(...taskChoices().map(([label, value]) => new Option(label, value)));
      taskSelect.value = filters.get("taskId") ?? "";
    }
  }

  const view = consoleView(root, (id, query) => {
    filters = new URLSearchParams(query);
    if (state.selectedId !== (id || null)) { state.rawOpen = false; state.scrollTop = 0; }
    state.selectedId = id || null;
    drawShell();
    void load();
    if (!id) void loadTasks();
  });
  return Object.assign(view, { refresh() { if (view.visible) void load(); } });
}
