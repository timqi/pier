// Console → Tasks view: the task list with its filters, and one task's detail
// page (definition tab + actions). The recent-runs pane lives in task-runs.ts,
// a run itself in the Runs view, and the create/edit dialog in task-editor.ts;
// this file owns navigation and state.

import type { TaskDefinition, TaskRun } from "../../tasks/types.js";
import { coalesce, failure, getJson, refused, sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { badge, button, CONTROL, empty, segmented, select, toolbar } from "./form.js";
import { openTaskEditor, type SessionChoice } from "./task-editor.js";
import { actionSummary, dateTime, definitionView, renderRuns, runBadge, runDuration, taskBadge, triggerSummary } from "./task-runs.js";

interface TaskRow extends TaskDefinition {
  lastRun: TaskRun | null;
}

export type TasksView = ConsoleView & { create(): void; refresh(taskId?: string): void };

export function createTasksView(
  root: HTMLElement,
  getSessions: () => SessionChoice[],
  loadSessions: () => Promise<void>,
  openSession: (id: string) => void,
  getCurrentSessionId: () => string | null,
  openRuns: (filters: Record<string, string>, id?: string) => void,
  openTask: (id?: string) => void,
): TasksView {
  let rows: TaskRow[] = [];
  let availableTasks: TaskRow[] = [];
  let selectedId: string | null = null;
  let filter = "active";
  let trigger = "all";
  let search = "";
  let detailTab: "runs" | "definition" = "runs";
  const runsScroll = { top: 0 };
  let detailRequest = 0;
  let listScroll = 0;
  /** Filter plus payload of the last list drawn — the Activity view's guard
   *  (activity.ts), for the same reason: most workspace events change nothing
   *  here, and replacing the table anyway loses its scroll position and the
   *  click that was mid-press. Filter included because two filters can answer
   *  with the same rows, and the pressed tab is drawn by this list. */
  let drawn = "";

  const loadList = coalesce(async () => {
    if (selectedId || !view.visible) return;
    const request = detailRequest;
    const wanted = `${filter}:${trigger}`;
    const got = await getJson<TaskRow[]>(
      `/api/tasks?state=${filter}&kind=task`,
      "Failed to load tasks",
    );
    if (!view.visible || request !== detailRequest || wanted !== `${filter}:${trigger}`) return;
    if (!got.ok) {
      drawn = "";
      return renderError(got.error);
    }
    const body = JSON.stringify(got.value);
    if (wanted + body === drawn) return;
    drawn = wanted + body;
    rows = got.value;
    if (trigger !== "all") rows = rows.filter((task) => task.trigger.type === trigger);
    renderList();
  });

  const loadDetail = coalesce(async () => {
    if (selectedId && view.visible) await renderDetail(selectedId);
  });

  function load(): Promise<void> {
    return selectedId ? loadDetail() : loadList();
  }

  function renderError(message: string): void {
    root.querySelector("[role=alert]")?.remove();
    const error = h("p", "flex-none p-4 text-[13px] text-red-600", message);
    error.setAttribute("role", "alert");
    root.append(error);
  }

  /** Keep the last good list on a failed refetch: a stale picker beats none. */
  async function activeTasks(): Promise<TaskRow[]> {
    const id = selectedId;
    const got = await getJson<TaskRow[]>("/api/tasks?state=active", "Failed to load tasks");
    if (!got.ok && view.visible && selectedId === id) renderError(got.error);
    return got.ok ? got.value : availableTasks;
  }

  const editorDeps = {
    sessions: getSessions,
    tasks: () => availableTasks,
    onSaved: (id: string) => {
      selectTask(id);
      detailTab = "definition";
      openTask(id);
    },
  };

  /** What names the page on the left (the detail's breadcrumb, the list's
   *  filters), its actions on the right. */
  const bar = (lead: HTMLElement[], actions: HTMLElement[]): HTMLElement =>
    toolbar(...lead, h("div", "ml-auto flex flex-wrap items-center gap-2 max-md:w-full", ...actions));

  function selectTask(id: string): void {
    selectedId = id;
    detailRequest++;
    detailTab = "runs";
    runsScroll.top = 0;
  }

  function showList(): void {
    selectedId = null;
    detailRequest++;
    renderList();
  }

  function createTask(): void {
    if (!view.visible || selectedId !== null) return;
    void Promise.all([loadSessions(), activeTasks()]).then(([, tasks]) => {
      if (!view.visible || selectedId !== null) return;
      availableTasks = tasks;
      openTaskEditor(editorDeps);
    });
  }

  function renderList(): void {
    const filters: HTMLElement[] = [];
    const addFilter = (label: string, options: [string, string][], value: string, change: (value: string) => void): void => {
      const input = select(options, value);
      input.setAttribute("aria-label", label);
      input.dataset.active = String(value !== options[0]?.[1]);
      input.onchange = () => {
        input.dataset.active = String(input.value !== options[0]?.[1]);
        change(input.value);
        listScroll = 0;
        void load();
      };
      filters.push(h("label", "filter-field", h("span", "", label), input));
    };
    const searchInput = h("input", CONTROL) as HTMLInputElement;
    searchInput.type = "search";
    searchInput.placeholder = "Search tasks";
    searchInput.setAttribute("aria-label", "Search tasks");
    searchInput.value = search;
    searchInput.dataset.active = String(Boolean(search));
    searchInput.oninput = () => {
      search = searchInput.value;
      searchInput.dataset.active = String(Boolean(search));
      drawRows();
    };
    filters.push(h("label", "filter-field filter-search", h("span", "", "Search"), searchInput));
    addFilter("Status", [["Current", "active"], ["Archived", "archived"]], filter, (v) => { filter = v; });
    addFilter("Trigger", [["All triggers", "all"], ["Manual", "manual"], ["Scheduled", "cron"], ["Watching", "watch"]], trigger, (v) => { trigger = v; });
    const table = document.createElement("table");
    table.className = "w-full table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="sticky top-0 bg-neutral-50 text-[10.5px] uppercase tracking-wide text-neutral-400 shadow-[inset_0_-1px_0_var(--color-neutral-200)]"><tr>
      <th class="w-[42%] px-4 py-2 font-semibold md:w-[24%]">Name</th><th class="hidden w-[10%] px-2 py-2 font-semibold md:table-cell">Action</th>
      <th class="hidden w-[23%] px-2 py-2 font-semibold md:table-cell">Trigger</th><th class="hidden w-[17%] px-2 py-2 font-semibold md:table-cell">Next</th>
      <th class="px-2 py-2 font-semibold md:w-[14%]">Last result</th><th class="w-[6rem] px-2 py-2 font-semibold"></th></tr></thead>`;
    const body = document.createElement("tbody");
    // Search narrows client-side by name and description; the list is small.
    const drawRows = (): void => {
      const matching = rows.filter((task) => `${task.name} ${task.description ?? ""}`.toLowerCase().includes(search.toLowerCase()));
      body.replaceChildren(...matching.map(taskRow));
      none.classList.toggle("hidden", matching.length > 0);
    };
    table.append(body);
    const none = h("div", "p-4", empty("No matching tasks."));
    const pane = h("div", "min-h-0 flex-1 overflow-auto", table, none);
    drawRows();
    pane.onscroll = () => { listScroll = pane.scrollTop; };
    root.replaceChildren(h("div", "automation-filters task-filters", ...filters), pane);
    pane.scrollTop = listScroll;
  }

  function taskRow(task: TaskRow): HTMLElement {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer border-b border-neutral-100 transition-colors hover:bg-neutral-50";
    tr.onclick = () => openTask(task.id);
    const name = button(task.name);
    name.className = "min-w-0 cursor-pointer truncate text-left font-medium text-neutral-800";
    name.title = task.name;
    tr.append(h("td", "py-2.5 pl-4 pr-2",
      // Wraps so a phone shows the whole name with the badge under it.
      h("div", "flex flex-wrap items-center gap-x-2 gap-y-1", name, taskBadge(task), ...creatorBadge(task)),
      h("div", "truncate text-[11px] text-neutral-400", task.description || ""),
      h("div", "truncate text-[11px] text-neutral-400 md:hidden", triggerSummary(task))));
    for (const text of [actionSummary(task), triggerSummary(task), dateTime(task.nextRunAt)]) {
      const cell = h("td", "hidden truncate px-2 py-2.5 text-neutral-600 md:table-cell", text);
      cell.title = text;
      tr.append(cell);
    }
    tr.append(h("td", "px-2 py-2.5",
      task.lastRun ? h("div", "flex", runBadge(task.lastRun)) : h("div", "text-neutral-400", "–"),
      h("div", "mt-0.5 font-mono text-[11px] text-neutral-400", task.lastRun ? runDuration(task.lastRun) : "")));
    const run = button("Run now");
    run.disabled = task.archived;
    run.onclick = (event) => {
      event.stopPropagation();
      void runTask(task.id);
    };
    tr.append(h("td", "px-2 py-1 text-right", run));
    return tr;
  }

  /** Who filed it. Agents may `create` durable tasks, and a list where their
   *  definitions look like yours is one you cannot tidy: the badge is what
   *  tells a one-shot an agent should have `run` from a schedule you wrote. */
  function creatorBadge(task: TaskDefinition): HTMLElement[] {
    if (!task.createdBySessionId) return [];
    const el = badge("agent", "bg-violet-50 text-violet-700 ring-violet-200");
    el.title = `Created by session ${task.createdBySessionId}`;
    return [el];
  }

  async function renderDetail(id: string): Promise<void> {
    const request = ++detailRequest;
    const previousPane = root.querySelector<HTMLElement>("[data-task-detail]");
    const [gotTask, gotRuns] = await Promise.all([
      getJson<TaskDefinition>(`/api/tasks/${id}`, "Failed to load task"),
      getJson<TaskRun[]>(`/api/tasks/${id}/runs`, "Failed to load the task's runs"),
    ]);
    if (!view.visible || request !== detailRequest || selectedId !== id) return;
    if (!gotTask.ok) return renderError(gotTask.error);
    if (!gotRuns.ok) return renderError(gotRuns.error);
    const task = gotTask.value;
    const runs = gotRuns.value;
    // "Tasks › <name>" breadcrumb: names the task being viewed and doubles
    // as the way back to the list (replaces the old Back button).
    const listLink = button("Tasks");
    listLink.className = "cursor-pointer text-neutral-500 hover:text-neutral-800 hover:underline";
    listLink.onclick = () => openTask();
    const crumb = h("span", "flex min-w-0 items-center gap-2", listLink, h("span", "text-neutral-400", "›"), h("span", "truncate font-medium", task.name), taskBadge(task));
    const run = button("Run now", true);
    run.disabled = task.archived;
    run.onclick = () => void runTask(task.id);
    const pause = button(task.enabled ? "Pause schedule" : "Resume schedule");
    pause.disabled = task.archived || task.action.type === "system" || task.trigger.type === "manual";
    pause.onclick = () => void mutate(`/api/tasks/${task.id}/${task.enabled ? "pause" : "resume"}`);
    const edit = button("Edit");
    edit.disabled = task.archived || task.action.type === "system";
    edit.onclick = () => {
      if (!view.visible || selectedId !== task.id) return;
      void Promise.all([loadSessions(), activeTasks()]).then(([, tasks]) => {
        if (!view.visible || selectedId !== task.id) return;
        availableTasks = tasks;
        openTaskEditor(editorDeps, task);
      });
    };
    const archive = button("Archive");
    archive.disabled = task.archived || task.action.type === "system";
    archive.onclick = () => void mutate(`/api/tasks/${task.id}/archive`);

    const tabs = toolbar();
    const pane = h("div", "min-h-0 flex-1 overflow-auto");
    pane.dataset.taskDetail = id;
    const allRuns = button("All runs");
    allRuns.onclick = () => openRuns({ taskId: task.id });
    const drawPane = (): void => {
      tabs.replaceChildren(
        segmented<typeof detailTab>([[`Recent runs (${runs.length})`, "runs"], ["Definition", "definition"]], detailTab, (next) => { detailTab = next; drawPane(); }),
        h("span", "ml-auto", allRuns),
      );
      if (detailTab === "runs") renderRuns(pane, runs, (id) => openRuns({}, id), runsScroll);
      else { pane.onscroll = null; pane.replaceChildren(definitionView(task, openSession)); }
    };
    const previousScroll = previousPane?.scrollTop ?? 0;
    root.replaceChildren(bar([crumb], [run, ...(task.trigger.type === "manual" ? [] : [pause]), edit, archive]), tabs, pane);
    drawPane();
    pane.scrollTop = previousScroll;
  }

  async function runTask(id: string): Promise<void> {
    try {
      const res = await sendJson(`/api/tasks/${id}/run`, { sourceSessionId: getCurrentSessionId() });
      if (!res.ok) return renderError(await failure(res, "Failed to run task"));
      const result = await res.json() as { runId: string };
      openRuns({}, result.runId);
    } catch (err) { renderError(`Failed to run task: ${String(err)}`); }
  }

  async function mutate(url: string): Promise<void> {
    const error = await refused(url, "POST", "Task update failed");
    if (error) return renderError(error);
    await load();
  }

  const view = consoleView(root, (taskId) => {
    if (taskId && taskId !== selectedId) selectTask(taskId);
    if (!taskId) showList();
    if (!root.childElementCount) renderList();
    void load();
  });
  return Object.assign(view, {
    create: createTask,
    refresh(taskId?: string) {
      if (!view.visible) return;
      if (!selectedId || !taskId || selectedId === taskId) void load();
    },
  });
}
