// Console → Tasks view: the task list with its filters, and one task's detail
// page (definition tab + actions). The runs pane lives in task-runs.ts and the
// create/edit dialog in task-editor.ts; this file owns navigation and state.

import type { TaskDefinition, TaskRun } from "../../tasks/types.js";
import { coalesce, failure, getJson, refused, sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { button, select, tabButton } from "./form.js";
import { openTaskEditor, type SessionChoice } from "./task-editor.js";
import { dateTime, renderRuns, runDuration, type RunViewState } from "./task-runs.js";

interface TaskRow extends TaskDefinition {
  lastRun: TaskRun | null;
}

export type TasksView = ConsoleView & { refresh(taskId?: string): void };

const triggerSummary = (task: TaskDefinition): string => {
  if (task.trigger.type === "manual") return "Manual";
  if (task.trigger.type === "cron") return `${task.trigger.expression} (${task.trigger.timezone})`;
  return `Every ${task.trigger.intervalSeconds}s · ${task.trigger.mode}`;
};

const actionSummary = (task: TaskDefinition): string => {
  if (task.action.type === "agent") return `Agent · ${task.action.session.mode}`;
  if (task.action.type === "bash") return "Bash";
  return "Task";
};

export function createTasksView(
  root: HTMLElement,
  getSessions: () => SessionChoice[],
  loadSessions: () => Promise<void>,
  openSession: (id: string) => void,
  getCurrentSessionId: () => string | null,
  openActivity: (arg?: string) => void,
): TasksView {
  let rows: TaskRow[] = [];
  let availableTasks: TaskRow[] = [];
  let selectedId: string | null = null;
  let filter = "active";
  let trigger = "all";
  let kind = "task";
  let detailTab: "runs" | "definition" = "runs";
  const runView: RunViewState = { selectedId: null, rawOpen: false, scrollTop: 0, listScroll: 0 };
  let detailRequest = 0;
  let listScroll = 0;
  /** Filter plus payload of the last list drawn — the Activity view's guard
   *  (activity.ts), for the same reason: most workspace events change nothing
   *  here, and replacing the table anyway loses its scroll position and the
   *  click that was mid-press. Filter included because two filters can answer
   *  with the same rows, and the pressed tab is drawn by this list. */
  let drawn = "";

  const load = coalesce(async () => {
    const wanted = `${filter}:${kind}:${trigger}`;
    const got = await getJson<TaskRow[]>(
      `/api/tasks?state=${filter}${kind === "subagent" ? "&kind=subagent" : ""}`,
      "Failed to load tasks",
    );
    if (!got.ok) {
      drawn = "";
      return renderError(got.error);
    }
    if (wanted !== `${filter}:${kind}:${trigger}`) return;
    // The detail page has endpoints of its own — a run's state changes without
    // this list changing — so only the list may be skipped.
    const body = JSON.stringify(got.value);
    if (wanted + body === drawn && !selectedId) return;
    drawn = wanted + body;
    rows = got.value;
    // The editor offers active tasks as chain targets whatever the list is
    // filtered to, so a filter that cannot stand in for that list fetches it.
    // Reusing the wrong list left the target picker empty or stale.
    if (filter === "archived" || kind === "subagent") availableTasks = await activeTasks();
    else availableTasks = rows;
    if (wanted !== `${filter}:${kind}:${trigger}`) return;
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
      void load();
    },
  };

  const runsDeps = {
    openSession,
    currentSessionId: getCurrentSessionId,
    mutate,
    onError: renderError,
    reload: load,
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

  // Console tab strip (Sessions | Dependencies | Tasks) mirrors the Activity
  // view's; the first two navigate there, Tasks returns to this view's list.
  // Rendered on the list and the detail page alike, so the console tabs never
  // disappear while inside a task.
  function consoleTabs(): HTMLElement {
    return h(
      "div",
      "tabstrip",
      tabButton("Sessions", false, () => openActivity("sessions")),
      tabButton("Relationships", false, () => openActivity("dependencies")),
      tabButton("Tasks", true, showList),
    );
  }

  function selectTask(id: string): void {
    selectedId = id;
    detailTab = "runs";
    runView.selectedId = null;
    runView.rawOpen = false;
    runView.scrollTop = 0;
    runView.listScroll = 0;
  }

  function showList(): void {
    selectedId = null;
    detailRequest++;
    renderList();
  }

  function renderList(): void {
    const create = button("New task", true);
    create.onclick = () => void loadSessions().then(() => openTaskEditor(editorDeps));
    const filters = consoleTabs();
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
    addFilter("Type", [["Tasks", "task"], ["Subagents", "subagent"]], kind, (v) => { kind = v; });
    addFilter("Trigger", [["All triggers", "all"], ["Manual", "manual"], ["Scheduled", "cron"], ["Watching", "watch"]], trigger, (v) => { trigger = v; });
    const table = document.createElement("table");
    table.className = "w-full table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="sticky top-0 bg-neutral-50 text-[10.5px] uppercase text-neutral-400"><tr>
      <th class="w-[42%] px-4 py-2 font-semibold md:w-[24%]">Name</th><th class="hidden w-[10%] px-2 py-2 font-semibold md:table-cell">Action</th>
      <th class="hidden w-[23%] px-2 py-2 font-semibold md:table-cell">Trigger</th><th class="hidden w-[17%] px-2 py-2 font-semibold md:table-cell">Next</th>
      <th class="px-2 py-2 font-semibold md:w-[14%]">Last result</th><th class="w-[6rem] px-2 py-2 font-semibold"></th></tr></thead>`;
    const body = document.createElement("tbody");
    for (const task of rows) body.append(taskRow(task));
    table.append(body);
    const pane = h("div", "min-h-0 flex-1 overflow-auto", table);
    if (!rows.length) pane.append(h("p", "p-4 text-[13px] text-neutral-500", "No matching tasks."));
    pane.onscroll = () => { listScroll = pane.scrollTop; };
    root.replaceChildren(header("Activity", [create]), filters, filterBox, pane);
    pane.scrollTop = listScroll;
  }

  function taskRow(task: TaskRow): HTMLElement {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer border-b border-neutral-100 hover:bg-neutral-50";
    tr.onclick = () => {
      selectTask(task.id);
      void renderDetail(task.id);
    };
    const state = task.archived ? "Archived" : task.enabled ? "Enabled" : "Paused";
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
      h("div", "break-words", task.lastRun?.state ?? "-"),
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
    listLink.onclick = showList;
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
        tabButton(`Runs (${runs.length})`, detailTab === "runs", () => { detailTab = "runs"; drawPane(); }),
        tabButton("Definition", detailTab === "definition", () => { detailTab = "definition"; drawPane(); }),
      );
      if (detailTab === "runs") renderRuns(pane, runs, runsDeps, runView);
      else renderDefinition(pane, task);
    };
    const previousScroll = previousPane?.scrollTop ?? 0;
    root.replaceChildren(header(crumb, [run, pause, edit, archive]), consoleTabs(), tabs, pane);
    drawPane();
    pane.scrollTop = previousScroll;
  }

  function renderDefinition(pane: HTMLElement, task: TaskDefinition): void {
    pane.dataset.runView = "definition";
    pane.onscroll = null;
    const content = h("div", "grid max-w-4xl grid-cols-[6rem_minmax(0,1fr)] gap-x-5 gap-y-3 p-4 text-[13px] md:grid-cols-[9.375rem_minmax(0,1fr)]");
    const values: [string, string][] = [
      ["Status", task.archived ? "Archived" : task.enabled ? "Enabled" : "Paused"],
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
      if (task.action.session.mode === "fresh") values.push(["Directory", task.action.session.cwd]);
      if (task.action.launch?.model) values.push(["Model", `${task.action.launch.model.provider}/${task.action.launch.model.id}`]);
      if (task.action.launch?.thinking) values.push(["Thinking", task.action.launch.thinking]);
      values.push(["Prompt", task.action.prompt]);
    }
    if (task.action.type === "bash") values.push(["Directory", task.action.cwd], ["Script", task.action.script]);
    if (task.action.type === "task") values.push(["Target task", task.action.taskId]);
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
    pane.replaceChildren(content);
  }

  async function runTask(id: string): Promise<void> {
    const res = await sendJson(`/api/tasks/${id}/run`, { sourceSessionId: getCurrentSessionId() });
    if (!res.ok) return renderError(await failure(res, "Failed to run task"));
    selectTask(id);
    await renderDetail(id);
  }

  async function mutate(url: string): Promise<void> {
    const error = await refused(url, "POST", "Task update failed");
    if (error) return renderError(error);
    await load();
  }

  const view = consoleView(root, (taskId) => {
    if (taskId && taskId !== selectedId) selectTask(taskId);
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
