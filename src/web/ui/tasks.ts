// Console → Tasks view: the task list with its filters, and one task's detail
// page (definition tab + actions). The recent-runs pane lives in task-runs.ts,
// a run itself in the Runs view, and the create/edit dialog in task-editor.ts;
// this file owns navigation and state.

import type { TaskDefinition, TaskRun } from "../../tasks/types.js";
import { coalesce, failure, getJson, refused, sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { button, select, tabButton } from "./form.js";
import { openTaskEditor, type SessionChoice } from "./task-editor.js";
import { actionSummary, dateTime, definitionView, renderRuns, runDuration, runLabel, triggerSummary } from "./task-runs.js";

interface TaskRow extends TaskDefinition {
  lastRun: TaskRun | null;
}

export type TasksView = ConsoleView & { refresh(taskId?: string): void };

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

  const load = coalesce(async () => {
    const wanted = `${filter}:${trigger}`;
    const got = await getJson<TaskRow[]>(
      `/api/tasks?state=${filter}&kind=task`,
      "Failed to load tasks",
    );
    if (!got.ok) {
      drawn = "";
      return renderError(got.error);
    }
    if (wanted !== `${filter}:${trigger}`) return;
    // The detail page has endpoints of its own; only skip the unchanged list.
    const body = JSON.stringify(got.value);
    if (wanted + body === drawn && !selectedId) return;
    drawn = wanted + body;
    rows = got.value;
    // The editor offers active tasks as chain targets whatever the list is
    // filtered to, so a filter that cannot stand in for that list fetches it.
    // Reusing the wrong list left the target picker empty or stale.
    if (filter === "archived") availableTasks = await activeTasks();
    else availableTasks = rows;
    if (wanted !== `${filter}:${trigger}`) return;
    if (trigger !== "all") rows = rows.filter((task) => task.trigger.type === trigger);
    if (selectedId) await renderDetail(selectedId);
    else renderList();
  });

  function renderError(message: string): void {
    root.querySelector("[role=alert]")?.remove();
    const error = h("p", "flex-none p-4 text-[13px] text-red-600", message);
    error.setAttribute("role", "alert");
    root.append(error);
  }

  /** Keep the last good list on a failed refetch: a stale picker beats none. */
  async function activeTasks(): Promise<TaskRow[]> {
    const got = await getJson<TaskRow[]>("/api/tasks?state=active", "Failed to load tasks");
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

  function header(title: string | HTMLElement, actions: HTMLElement[]): HTMLElement {
    const el = h("header", "flex min-h-10 flex-none flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2");
    // A plain string title repeats the mobile top bar; a breadcrumb element
    // (the task detail page) does not, so only the former hides below md.
    el.append(
      typeof title === "string" ? h("span", "truncate font-medium max-md:hidden", title) : title,
    );
    if (actions.length) {
      const box = h("div", "ml-auto flex flex-wrap items-center gap-2 max-md:w-full");
      box.append(...actions);
      el.append(box);
    }
    return el;
  }

  function selectTask(id: string): void {
    selectedId = id;
    detailTab = "runs";
    runsScroll.top = 0;
  }

  function showList(): void {
    selectedId = null;
    detailRequest++;
    renderList();
  }

  function renderList(): void {
    const create = button("New task", true);
    create.onclick = () => void loadSessions().then(() => openTaskEditor(editorDeps));
    const filterBox = h("div", "flex flex-none flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2");
    const addFilter = (label: string, options: [string, string][], value: string, change: (value: string) => void): void => {
      const input = select(options, value);
      input.setAttribute("aria-label", label);
      input.classList.add("!w-auto", "pr-8");
      input.onchange = () => {
        change(input.value);
        listScroll = 0;
        void load();
      };
      filterBox.append(h("label", "flex items-center gap-2 text-[12px] text-neutral-500", label, input));
    };
    addFilter("Status", [["Current", "active"], ["Archived", "archived"]], filter, (v) => { filter = v; });
    const searchInput = h("input", "min-w-0 rounded border border-neutral-200 px-2 py-1 text-[13px]") as HTMLInputElement;
    searchInput.type = "search";
    searchInput.placeholder = "Search tasks";
    searchInput.setAttribute("aria-label", "Search tasks");
    searchInput.value = search;
    searchInput.oninput = () => { search = searchInput.value; drawRows(); };
    filterBox.append(searchInput);
    addFilter("Trigger", [["All triggers", "all"], ["Manual", "manual"], ["Scheduled", "cron"], ["Watching", "watch"]], trigger, (v) => { trigger = v; });
    const table = document.createElement("table");
    table.className = "w-full table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="sticky top-0 bg-neutral-50 text-[10.5px] uppercase text-neutral-400"><tr>
      <th class="w-[42%] px-4 py-2 font-semibold md:w-[24%]">Name</th><th class="hidden w-[10%] px-2 py-2 font-semibold md:table-cell">Action</th>
      <th class="hidden w-[23%] px-2 py-2 font-semibold md:table-cell">Trigger</th><th class="hidden w-[17%] px-2 py-2 font-semibold md:table-cell">Next</th>
      <th class="px-2 py-2 font-semibold md:w-[14%]">Last result</th><th class="w-[6rem] px-2 py-2 font-semibold"></th></tr></thead>`;
    const body = document.createElement("tbody");
    // Search narrows client-side by name and description; the list is small.
    const drawRows = (): void => {
      const matching = rows.filter((task) => `${task.name} ${task.description ?? ""}`.toLowerCase().includes(search.toLowerCase()));
      body.replaceChildren(...matching.map(taskRow));
      empty.classList.toggle("hidden", matching.length > 0);
    };
    table.append(body);
    const empty = h("p", "p-4 text-[13px] text-neutral-500", "No matching tasks.");
    const pane = h("div", "min-h-0 flex-1 overflow-auto", table, empty);
    drawRows();
    pane.onscroll = () => { listScroll = pane.scrollTop; };
    root.replaceChildren(header("Tasks", [create]), filterBox, pane);
    pane.scrollTop = listScroll;
  }

  function taskRow(task: TaskRow): HTMLElement {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer border-b border-neutral-100 hover:bg-neutral-50";
    tr.onclick = () => openTask(task.id);
    const state = task.archived ? "Archived" : task.trigger.type === "manual" ? "Manual" : task.enabled ? "Enabled" : "Paused";
    const name = button(task.name);
    name.className = "block w-full cursor-pointer truncate text-left font-medium";
    name.title = task.name;
    tr.append(h("td", "truncate py-2.5 pl-4 pr-2", name,
      h("div", "truncate text-[11px] text-neutral-400", state),
      h("div", "truncate text-[11px] text-neutral-400 md:hidden", triggerSummary(task))));
    for (const text of [actionSummary(task), triggerSummary(task), dateTime(task.nextRunAt)]) {
      const cell = h("td", "hidden truncate px-2 py-2.5 md:table-cell", text);
      cell.title = text;
      tr.append(cell);
    }
    tr.append(h("td", "px-2 py-2.5",
      h("div", "break-words", task.lastRun ? runLabel(task.lastRun) : "-"),
      h("div", "text-[11px] text-neutral-400", task.lastRun ? runDuration(task.lastRun) : "")));
    const run = button("Run now");
    run.disabled = task.archived;
    run.onclick = (event) => {
      event.stopPropagation();
      void runTask(task.id);
    };
    tr.append(h("td", "px-2 py-1 text-right", run));
    return tr;
  }

  async function renderDetail(id: string): Promise<void> {
    const request = ++detailRequest;
    const previousPane = root.querySelector<HTMLElement>("[data-task-detail]");
    const [gotTask, gotRuns] = await Promise.all([
      getJson<TaskDefinition>(`/api/tasks/${id}`, "Failed to load task"),
      getJson<TaskRun[]>(`/api/tasks/${id}/runs`, "Failed to load the task's runs"),
    ]);
    if (request !== detailRequest || selectedId !== id) return;
    if (!gotTask.ok) return renderError(gotTask.error);
    if (!gotRuns.ok) return renderError(gotRuns.error);
    const task = gotTask.value;
    const runs = gotRuns.value;
    // "Tasks › <name>" breadcrumb: names the task being viewed and doubles
    // as the way back to the list (replaces the old Back button).
    const listLink = button("Tasks");
    listLink.className = "cursor-pointer text-neutral-500 hover:underline";
    listLink.onclick = () => openTask();
    const crumb = h("span", "flex min-w-0 items-center gap-1.5", listLink, h("span", "text-neutral-400", "›"), h("span", "truncate font-medium", task.name));
    const run = button("Run now", true);
    run.disabled = task.archived;
    run.onclick = () => void runTask(task.id);
    const pause = button(task.enabled ? "Pause schedule" : "Resume schedule");
    pause.disabled = task.archived || task.trigger.type === "manual";
    pause.onclick = () => void mutate(`/api/tasks/${task.id}/${task.enabled ? "pause" : "resume"}`);
    const edit = button("Edit");
    edit.disabled = task.archived;
    edit.onclick = () => void loadSessions().then(() => openTaskEditor(editorDeps, task));
    const archive = button("Archive");
    archive.disabled = task.archived;
    archive.onclick = () => void mutate(`/api/tasks/${task.id}/archive`);

    const tabs = h("div", "flex flex-none gap-1 border-b border-neutral-200 px-4 py-2");
    const pane = h("div", "min-h-0 flex-1 overflow-auto");
    pane.dataset.taskDetail = id;
    const drawPane = (): void => {
      tabs.replaceChildren(
        tabButton(`Recent runs (${runs.length})`, detailTab === "runs", () => { detailTab = "runs"; drawPane(); }),
        tabButton("Definition", detailTab === "definition", () => { detailTab = "definition"; drawPane(); }),
      );
      if (detailTab === "runs") renderRuns(pane, runs, (id) => openRuns({}, id), runsScroll);
      else { pane.onscroll = null; pane.replaceChildren(definitionView(task, openSession)); }
    };
    const previousScroll = previousPane?.scrollTop ?? 0;
    const allRuns = button("All runs");
    allRuns.onclick = () => openRuns({ taskId: task.id });
    root.replaceChildren(header(crumb, [run, ...(task.trigger.type === "manual" ? [] : [pause]), edit, archive, allRuns]), tabs, pane);
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
    refresh(taskId?: string) {
      if (!view.visible) return;
      if (!selectedId || !taskId || selectedId === taskId) void load();
    },
  });
}
