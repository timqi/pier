// Console → Tasks view: the task list with its filters, and one task's detail
// page (definition tab + actions). The runs pane lives in task-runs.ts and the
// create/edit dialog in task-editor.ts; this file owns navigation and state.

import type { TaskDefinition, TaskRun } from "../../tasks/types.js";
import { sendJson } from "./api.js";
import { consoleView, h, type ConsoleView } from "./dom.js";
import { button, tabButton } from "./form.js";
import { openTaskEditor, type SessionChoice } from "./task-editor.js";
import { dateTime, renderRuns, runDuration } from "./task-runs.js";

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
  openSession: (id: string) => void,
  getCurrentSessionId: () => string | null,
  openActivity: (arg?: string) => void,
): TasksView {
  let rows: TaskRow[] = [];
  let availableTasks: TaskRow[] = [];
  let selectedId: string | null = null;
  let filter = "active";

  async function load(): Promise<void> {
    const state = filter === "archived" ? "archived" : "active";
    const res = await fetch(`/api/tasks?state=${state}${filter === "subagent" ? "&kind=subagent" : ""}`);
    if (!res.ok) return renderError(`Failed to load tasks: ${res.status}`);
    rows = (await res.json()) as TaskRow[];
    // The editor offers active tasks as chain targets whatever the list is
    // filtered to, so a filter that cannot stand in for that list fetches it.
    // Reusing the wrong list left the target picker empty or stale.
    if (filter === "archived" || filter === "subagent") availableTasks = await activeTasks();
    else availableTasks = rows;
    if (filter !== "active" && filter !== "archived" && filter !== "subagent") {
      rows = rows.filter((task) => task.trigger.type === filter);
    }
    if (selectedId) await renderDetail(selectedId);
    else renderList();
  }

  function renderError(message: string): void {
    root.replaceChildren(h("p", "p-4 text-[13px] text-red-600", message));
  }

  /** Keep the last good list on a failed refetch: a stale picker beats none. */
  async function activeTasks(): Promise<TaskRow[]> {
    const res = await fetch("/api/tasks?state=active");
    return res.ok ? (await res.json()) as TaskRow[] : availableTasks;
  }

  const editorDeps = {
    sessions: getSessions,
    tasks: () => availableTasks,
    onSaved: (id: string) => {
      selectedId = id;
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
    const el = h("header", "flex h-10 flex-none items-center gap-2 border-b border-neutral-200 px-4");
    // A plain string title repeats the mobile top bar; a breadcrumb element
    // (the task detail page) does not, so only the former hides below md.
    el.append(
      typeof title === "string" ? h("span", "truncate font-medium max-md:hidden", title) : title,
    );
    if (actions.length) {
      const box = h("div", "ml-auto flex items-center gap-2");
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
      tabButton("Dependencies", false, () => openActivity("dependencies")),
      tabButton("Tasks", true, showList),
    );
  }

  function showList(): void {
    selectedId = null;
    renderList();
  }

  function renderList(): void {
    const create = button("New task", true);
    create.onclick = () => openTaskEditor(editorDeps);
    const filters = consoleTabs();
    // w-full below md forces its own line inside the wrapping .tabstrip — six
    // filters crammed beside the console tabs are unreachable on a phone.
    const filterBox = h(
      "div",
      "ml-auto flex flex-none items-center gap-1 pl-1 max-md:ml-0 max-md:w-full max-md:overflow-x-auto max-md:pl-0",
    );
    const filterOptions: [string, string][] = [["All", "active"], ["Manual", "manual"], ["Scheduled", "cron"], ["Watching", "watch"], ["Subagents", "subagent"], ["Archived", "archived"]];
    for (const [label, key] of filterOptions) {
      filterBox.append(tabButton(label, filter === key, () => {
        filter = key;
        selectedId = null;
        void load();
      }));
    }
    filters.append(filterBox);
    const table = document.createElement("table");
    // Six table-fixed columns collide at phone width; keep the desktop minimum
    // and let the pane scroll sideways.
    table.className = "w-full min-w-[52rem] table-fixed text-left text-[12.5px]";
    table.innerHTML = `<thead class="sticky top-0 bg-neutral-50 text-[10.5px] uppercase text-neutral-400"><tr>
      <th class="w-[24%] px-4 py-2 font-semibold">Name</th><th class="w-[10%] px-2 py-2 font-semibold">Action</th>
      <th class="w-[23%] px-2 py-2 font-semibold">Trigger</th><th class="w-[17%] px-2 py-2 font-semibold">Next</th>
      <th class="w-[14%] px-2 py-2 font-semibold">Last result</th><th class="px-2 py-2 font-semibold"></th></tr></thead>`;
    const body = document.createElement("tbody");
    for (const task of rows) body.append(taskRow(task));
    table.append(body);
    root.replaceChildren(header("Tasks", [create]), filters, h("div", "min-h-0 flex-1 overflow-auto", table));
  }

  function taskRow(task: TaskRow): HTMLElement {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer border-b border-neutral-100 hover:bg-neutral-50";
    tr.onclick = () => {
      selectedId = task.id;
      void renderDetail(task.id);
    };
    const state = task.archived ? "Archived" : task.enabled ? "Enabled" : "Paused";
    tr.append(h("td", "truncate py-2.5 pl-4 pr-2",
      h("div", "truncate font-medium", task.name),
      h("div", "text-[11px] text-neutral-400", state)));
    for (const text of [
      actionSummary(task),
      triggerSummary(task),
      dateTime(task.nextRunAt),
      task.lastRun ? `${task.lastRun.state} · ${runDuration(task.lastRun)}` : "-",
    ]) {
      tr.append(h("td", "truncate px-2 py-2.5", text));
    }
    const run = button("Run");
    run.disabled = task.archived;
    run.onclick = (event) => {
      event.stopPropagation();
      void runTask(task.id);
    };
    tr.append(h("td", "px-2 py-1 text-right", run));
    return tr;
  }

  async function renderDetail(id: string): Promise<void> {
    const [taskRes, runsRes] = await Promise.all([
      fetch(`/api/tasks/${id}`),
      fetch(`/api/tasks/${id}/runs`),
    ]);
    if (!taskRes.ok || !runsRes.ok) return renderError("Failed to load task");
    const task = (await taskRes.json()) as TaskDefinition;
    const runs = (await runsRes.json()) as TaskRun[];
    // "Tasks › <name>" breadcrumb: names the task being viewed and doubles
    // as the way back to the list (replaces the old Back button).
    const listLink = button("Tasks");
    listLink.className = "cursor-pointer text-neutral-500 hover:underline";
    listLink.onclick = showList;
    const crumb = h("span", "flex min-w-0 items-center gap-1.5", listLink, h("span", "text-neutral-400", "›"), h("span", "truncate font-medium", task.name));
    const run = button("Run now", true);
    run.disabled = task.archived;
    run.onclick = () => void runTask(task.id);
    const pause = button(task.enabled ? "Pause" : "Resume");
    pause.disabled = task.archived || task.trigger.type === "manual";
    pause.onclick = () => void mutate(`/api/tasks/${task.id}/${task.enabled ? "pause" : "resume"}`);
    const edit = button("Edit");
    edit.disabled = task.archived;
    edit.onclick = () => openTaskEditor(editorDeps, task);
    const archive = button("Archive");
    archive.disabled = task.archived;
    archive.onclick = () => void mutate(`/api/tasks/${task.id}/archive`);

    const tabs = h("div", "flex flex-none gap-1 border-b border-neutral-200 px-4 py-2");
    const definitionTab = button("Definition");
    const runsTab = button(`Runs (${runs.length})`);
    const pane = h("div", "min-h-0 flex-1 overflow-auto");
    const showDefinition = (): void => {
      definitionTab.classList.add("bg-neutral-200");
      runsTab.classList.remove("bg-neutral-200");
      renderDefinition(pane, task);
    };
    definitionTab.onclick = showDefinition;
    runsTab.onclick = () => {
      runsTab.classList.add("bg-neutral-200");
      definitionTab.classList.remove("bg-neutral-200");
      renderRuns(pane, runs, runsDeps);
    };
    tabs.append(definitionTab, runsTab);
    root.replaceChildren(header(crumb, [run, pause, edit, archive]), consoleTabs(), tabs, pane);
    if (runs.length) runsTab.click();
    else showDefinition();
  }

  function renderDefinition(pane: HTMLElement, task: TaskDefinition): void {
    const content = h("div", "grid max-w-4xl grid-cols-[9.375rem_minmax(0,1fr)] gap-x-5 gap-y-3 p-4 text-[13px]");
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
      if (task.action.session.mode === "fork") values.push(["Directory", task.action.session.cwd ?? "Caller project"]);
      if (task.action.launch?.model) values.push(["Model", `${task.action.launch.model.provider}/${task.action.launch.model.id}`]);
      if (task.action.launch?.thinking) values.push(["Thinking", task.action.launch.thinking]);
      if (task.action.launch?.capabilities) values.push(["Capabilities", task.action.launch.capabilities]);
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
    if (!res.ok) return renderError(((await res.json()) as { error?: string }).error ?? "Failed to run task");
    selectedId = id;
    await renderDetail(id);
  }

  async function mutate(url: string): Promise<void> {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) return renderError(((await res.json()) as { error?: string }).error ?? "Task update failed");
    await load();
  }

  const view = consoleView(root, (taskId) => {
    if (taskId) selectedId = taskId;
    void load();
  });
  return Object.assign(view, {
    refresh(taskId?: string) {
      if (!view.visible) return;
      if (!selectedId || !taskId || selectedId === taskId) void load();
    },
  });
}
