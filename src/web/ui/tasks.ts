import type { TaskDefinition, TaskDraft, TaskMessage, TaskRun } from "../../tasks/types.js";
import { h } from "./dom.js";

interface SessionChoice {
  id: string;
  cwd: string;
  title?: string;
}

interface TaskRow extends TaskDefinition {
  lastRun: TaskRun | null;
}

export interface TasksView {
  show(taskId?: string): void;
  hide(): void;
  refresh(taskId?: string): void;
  readonly visible: boolean;
}

const dateTime = (value: number | null): string =>
  value === null ? "-" : new Date(value).toLocaleString();

const duration = (run: TaskRun): string => {
  if (run.startedAt === null) return "-";
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

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

const button = (label: string, primary = false): HTMLButtonElement => {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `${primary ? "btn btn-primary" : "btn"} text-[12.5px]`;
  el.textContent = label;
  return el;
};

const field = (label: string, control: HTMLElement): HTMLElement => {
  const wrapper = h("label", "flex flex-col gap-1 text-[12.5px] text-neutral-600", label);
  wrapper.append(control);
  return wrapper;
};

const input = (value = "", type = "text"): HTMLInputElement => {
  const el = document.createElement("input");
  el.type = type;
  el.value = value;
  el.className = "rounded-md border border-neutral-300 px-2 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none";
  return el;
};

const select = (options: [string, string][], value: string): HTMLSelectElement => {
  const el = document.createElement("select");
  el.className = "rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] focus:border-indigo-400 focus:outline-none";
  el.append(...options.map(([label, key]) => new Option(label, key)));
  el.value = value;
  return el;
};

const textarea = (value = "", rows = 4): HTMLTextAreaElement => {
  const el = document.createElement("textarea");
  el.value = value;
  el.rows = rows;
  el.spellcheck = false;
  el.className = "resize-y rounded-md border border-neutral-300 px-2 py-1.5 font-mono text-[12.5px] focus:border-indigo-400 focus:outline-none";
  return el;
};

export function createTasksView(
  root: HTMLElement,
  getSessions: () => SessionChoice[],
  openSession: (id: string) => void,
  getCurrentSessionId: () => string | null,
  openActivity: (arg?: string) => void,
): TasksView {
  let visible = false;
  let rows: TaskRow[] = [];
  let availableTasks: TaskRow[] = [];
  let selectedId: string | null = null;
  let filter = "active";

  async function load(): Promise<void> {
    const state = filter === "archived" ? "archived" : "active";
    const res = await fetch(`/api/tasks?state=${state}${filter === "subagent" ? "&kind=subagent" : ""}`);
    if (!res.ok) return renderError(`Failed to load tasks: ${res.status}`);
    rows = (await res.json()) as TaskRow[];
    if (filter !== "archived" && filter !== "subagent") availableTasks = rows;
    if (filter !== "active" && filter !== "archived" && filter !== "subagent") {
      rows = rows.filter((task) => task.trigger.type === filter);
    }
    if (selectedId) await renderDetail(selectedId);
    else renderList();
  }

  function renderError(message: string): void {
    root.replaceChildren(h("p", "p-4 text-[13px] text-red-600", message));
  }

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
    const strip = h("div", "tabstrip");
    const sessionsTab = button("Sessions");
    sessionsTab.onclick = () => openActivity("sessions");
    const depsTab = button("Dependencies");
    depsTab.onclick = () => openActivity("dependencies");
    const tasksTab = button("Tasks");
    tasksTab.classList.add("bg-neutral-200");
    tasksTab.onclick = showList;
    strip.append(sessionsTab, depsTab, tasksTab);
    return strip;
  }

  function showList(): void {
    selectedId = null;
    renderList();
  }

  function renderList(): void {
    const create = button("New task", true);
    create.onclick = () => editDialog();
    const filters = consoleTabs();
    // w-full below md forces its own line inside the wrapping .tabstrip — six
    // filters crammed beside the console tabs are unreachable on a phone.
    const filterBox = h(
      "div",
      "ml-auto flex flex-none items-center gap-1 pl-1 max-md:ml-0 max-md:w-full max-md:overflow-x-auto max-md:pl-0",
    );
    const filterOptions: [string, string][] = [["All", "active"], ["Manual", "manual"], ["Scheduled", "cron"], ["Watching", "watch"], ["Subagents", "subagent"], ["Archived", "archived"]];
    for (const [label, key] of filterOptions) {
      const tab = button(label);
      if (filter === key) tab.classList.add("bg-neutral-200");
      tab.onclick = () => {
        filter = key;
        selectedId = null;
        void load();
      };
      filterBox.append(tab);
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
    const scroll = h("div", "min-h-0 flex-1 overflow-auto");
    scroll.append(table);
    root.replaceChildren(header("Tasks", [create]), filters, scroll);
  }

  function taskRow(task: TaskRow): HTMLElement {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer border-b border-neutral-100 hover:bg-neutral-50";
    tr.onclick = () => {
      selectedId = task.id;
      void renderDetail(task.id);
    };
    const state = task.archived ? "Archived" : task.enabled ? "Enabled" : "Paused";
    const nameCell = document.createElement("td");
    nameCell.className = "truncate py-2.5 pl-4 pr-2";
    nameCell.append(
      h("div", "truncate font-medium", task.name),
      h("div", "text-[11px] text-neutral-400", state),
    );
    tr.append(nameCell);
    for (const text of [
      actionSummary(task),
      triggerSummary(task),
      dateTime(task.nextRunAt),
      task.lastRun ? `${task.lastRun.state} · ${duration(task.lastRun)}` : "-",
    ]) {
      const td = document.createElement("td");
      td.className = "truncate px-2 py-2.5";
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement("td");
    actions.className = "px-2 py-1 text-right";
    const run = button("Run");
    run.disabled = task.archived;
    run.onclick = (event) => {
      event.stopPropagation();
      void runTask(task.id);
    };
    actions.append(run);
    tr.append(actions);
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
    const crumb = h("span", "flex min-w-0 items-center gap-1.5");
    const listLink = h("button", "cursor-pointer text-neutral-500 hover:underline", "Tasks");
    (listLink as HTMLButtonElement).type = "button";
    listLink.onclick = showList;
    crumb.append(listLink, h("span", "text-neutral-400", "›"), h("span", "truncate font-medium", task.name));
    const run = button("Run now", true);
    run.disabled = task.archived;
    run.onclick = () => void runTask(task.id);
    const pause = button(task.enabled ? "Pause" : "Resume");
    pause.disabled = task.archived || task.trigger.type === "manual";
    pause.onclick = () => void mutate(`/api/tasks/${task.id}/${task.enabled ? "pause" : "resume"}`);
    const edit = button("Edit");
    edit.disabled = task.archived;
    edit.onclick = () => editDialog(task);
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
      renderRuns(pane, task, runs);
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

  function renderRuns(pane: HTMLElement, task: TaskDefinition, runs: TaskRun[]): void {
    const list = h("div", "divide-y divide-neutral-100");
    for (const run of runs) {
      const row = h("button", "grid w-full cursor-pointer grid-cols-[7.5rem_1fr_7.5rem_6.25rem] gap-3 px-4 py-2.5 text-left text-[12.5px] hover:bg-neutral-50");
      row.append(
        h("span", "font-medium", run.state),
        h("span", "truncate text-neutral-500", dateTime(run.queuedAt)),
        h("span", "text-neutral-500", run.triggerSource),
        h("span", "text-right text-neutral-500", duration(run)),
      );
      row.onclick = () => void openRun(pane, task, run.id, list);
      list.append(row);
    }
    if (!runs.length) list.append(h("p", "p-4 text-[13px] text-neutral-400", "No runs yet."));
    pane.replaceChildren(list);
  }

  async function openRun(pane: HTMLElement, task: TaskDefinition, id: string, list: HTMLElement): Promise<void> {
    const [res, messagesRes] = await Promise.all([
      fetch(`/api/task-runs/${id}`),
      fetch(`/api/task-runs/${id}/messages`),
    ]);
    if (!res.ok) return;
    const run = (await res.json()) as TaskRun;
    const messages = messagesRes.ok ? await messagesRes.json() as TaskMessage[] : [];
    const back = button("Back to runs");
    back.onclick = () => pane.replaceChildren(list);
    const actions = h("div", "flex items-center gap-2 border-b border-neutral-200 px-4 py-2");
    actions.append(back, h("span", "font-mono text-[12px] text-neutral-400", run.id));
    if (run.targetSessionId) {
      const open = button("Open session");
      open.classList.add("ml-auto");
      open.onclick = () => openSession(run.targetSessionId!);
      actions.append(open);
    }
    if (run.state === "queued" || run.state === "running") {
      const steer = button("Steer");
      steer.onclick = () => void promptRun(`/api/task-runs/${run.id}/steer`, "Steer subagent", {
        mode: "steer",
        sourceSessionId: getCurrentSessionId(),
      });
      const cancel = button("Stop");
      cancel.onclick = () => void mutate(`/api/task-runs/${run.id}/cancel`);
      actions.append(steer, cancel);
    } else if (run.targetSessionId) {
      const resume = button("Continue");
      resume.onclick = () => void promptRun(`/api/task-runs/${run.id}/resume`, "Continue subagent", {
        sourceSessionId: getCurrentSessionId(),
      });
      actions.append(resume);
    }
    const body = h("div", "min-h-0 flex-1 overflow-auto");
    const pre = h("pre", "whitespace-pre-wrap break-words p-4 font-mono text-[12px]", JSON.stringify(run, null, 2));
    body.append(pre);
    if (messages.length) {
      const ledger = h("div", "border-t border-neutral-200");
      ledger.append(h("div", "px-4 py-2 text-[11px] font-semibold uppercase text-neutral-400", "Messages"));
      for (const message of messages) {
        const row = h("div", "grid grid-cols-[6.25rem_6.25rem_1fr] gap-3 border-t border-neutral-100 px-4 py-2 text-[12px]");
        row.append(h("span", "font-medium", message.kind), h("span", "text-neutral-500", message.state), h("span", "whitespace-pre-wrap", message.content));
        ledger.append(row);
      }
      body.append(ledger);
    }
    pane.replaceChildren(actions, body);
  }

  async function promptRun(url: string, title: string, fields: Record<string, unknown>): Promise<void> {
    const message = window.prompt(title);
    if (!message?.trim()) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, message }),
    });
    if (!res.ok) renderError(((await res.json()) as { error?: string }).error ?? "Run control failed");
    else await load();
  }

  async function runTask(id: string): Promise<void> {
    const res = await fetch(`/api/tasks/${id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: getCurrentSessionId() }),
    });
    if (!res.ok) return renderError(((await res.json()) as { error?: string }).error ?? "Failed to run task");
    selectedId = id;
    await renderDetail(id);
  }

  async function mutate(url: string): Promise<void> {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) return renderError(((await res.json()) as { error?: string }).error ?? "Task update failed");
    await load();
  }

  function editDialog(task?: TaskDefinition): void {
    const dialog = document.createElement("dialog");
    dialog.className = "m-auto w-[38.75rem] max-w-[94vw] rounded-lg border border-neutral-200 p-0 shadow-xl backdrop:bg-black/20";
    const form = document.createElement("form");
    form.className = "flex max-h-[88vh] flex-col";
    const formError = h("span", "mr-auto text-[12px] text-red-600");
    const title = h("header", "flex h-11 flex-none items-center border-b border-neutral-200 px-4 font-medium", task ? "Edit task" : "New task");
    const fields = h("div", "grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-4");
    const name = input(task?.name ?? "");
    name.required = true;
    const description = input(task?.description ?? "");
    const timeout = input(String(task?.timeoutSeconds ?? 900), "number");
    timeout.min = "1";
    timeout.max = "86400";
    const triggerType = select([["Manual", "manual"], ["Scheduled", "cron"], ["Watch", "watch"]], task?.trigger.type ?? "manual");
    const actionType = select([["Bash", "bash"], ["Agent", "agent"], ["Task", "task"]], task?.action.type ?? "bash");
    const callbackType = select([["No callback", "none"], ["Invoking session", "origin"], ["Specific session", "session"]], task?.callback.type ?? "none");
    const callbackChoices = getSessions().map((session) => [`${session.title ?? "Untitled"} · ${session.cwd}`, session.id] as [string, string]);
    const savedCallbackId = task?.callback.type === "session" ? task.callback.sessionId : null;
    if (savedCallbackId && !callbackChoices.some(([, id]) => id === savedCallbackId)) {
      callbackChoices.push([`Current session · ${savedCallbackId}`, savedCallbackId]);
    }
    const callbackSession = select(callbackChoices, savedCallbackId ?? "");
    const callbackSessionField = field("Callback session", callbackSession);
    callbackSessionField.classList.toggle("hidden", callbackType.value !== "session");
    callbackType.onchange = () => callbackSessionField.classList.toggle("hidden", callbackType.value !== "session");
    fields.append(
      field("Name", name),
      field("Description", description),
      field("Trigger", triggerType),
      field("Action", actionType),
      field("Callback", callbackType),
      callbackSessionField,
      field("Timeout (seconds)", timeout),
    );
    const dynamic = h("div", "col-span-2 grid grid-cols-2 gap-3 border-t border-neutral-200 pt-3");
    fields.append(dynamic);

    const renderDynamic = (): void => {
      dynamic.replaceChildren();
      let cronExpression: HTMLInputElement | undefined;
      let cronTimezone: HTMLInputElement | undefined;
      let watchScript: HTMLTextAreaElement | undefined;
      let watchInterval: HTMLInputElement | undefined;
      let watchMode: HTMLSelectElement | undefined;
      let watchCwd: HTMLInputElement | undefined;
      if (triggerType.value === "cron") {
        cronExpression = input(task?.trigger.type === "cron" ? task.trigger.expression : "0 9 * * *");
        cronTimezone = input(task?.trigger.type === "cron" ? task.trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone);
        dynamic.append(field("Cron", cronExpression), field("Timezone", cronTimezone));
      } else if (triggerType.value === "watch") {
        watchScript = textarea(task?.trigger.type === "watch" ? task.trigger.script : "", 4);
        watchCwd = input(task?.trigger.type === "watch" ? task.trigger.cwd : getSessions()[0]?.cwd ?? "");
        watchInterval = input(String(task?.trigger.type === "watch" ? task.trigger.intervalSeconds : 60), "number");
        watchMode = select([["Continue after matches", "repeat"], ["Stop after first match", "once"]], task?.trigger.type === "watch" ? task.trigger.mode : "repeat");
        const probe = field("Probe script (0=match, 1=no match)", watchScript);
        probe.classList.add("col-span-2");
        dynamic.append(probe, field("Probe directory", watchCwd), field("Interval (seconds)", watchInterval), field("Mode", watchMode));
      }

      let bashScript: HTMLTextAreaElement | undefined;
      let bashCwd: HTMLInputElement | undefined;
      let agentMode: HTMLSelectElement | undefined;
      let agentSession: HTMLSelectElement | undefined;
      let agentCwd: HTMLInputElement | undefined;
      let agentPrompt: HTMLTextAreaElement | undefined;
      let agentCapabilities: HTMLSelectElement | undefined;
      let agentThinking: HTMLSelectElement | undefined;
      let agentModelProvider: HTMLInputElement | undefined;
      let agentModelId: HTMLInputElement | undefined;
      let targetTask: HTMLSelectElement | undefined;
      if (actionType.value === "bash") {
        bashCwd = input(task?.action.type === "bash" ? task.action.cwd : getSessions()[0]?.cwd ?? "");
        bashScript = textarea(task?.action.type === "bash" ? task.action.script : "", 6);
        const script = field("Bash script", bashScript);
        script.classList.add("col-span-2");
        dynamic.append(field("Working directory", bashCwd), h("span", ""), script);
      } else if (actionType.value === "agent") {
        const sessions = getSessions();
        const saved = task?.action.type === "agent" ? task.action : null;
        const choices = sessions.map((s) => [`${s.title ?? "Untitled"} · ${s.cwd}`, s.id] as [string, string]);
        const savedSessionId = saved?.session.mode === "reuse" ? saved.session.sessionId : "";
        if (savedSessionId && !sessions.some((s) => s.id === savedSessionId)) {
          choices.push([`Current session · ${savedSessionId}`, savedSessionId]);
        }
        agentMode = select([["Reuse session", "reuse"], ["Fresh child per run", "fresh"], ["Fork caller context", "fork"]], saved?.session.mode ?? "fresh");
        agentSession = select(choices, savedSessionId || choices[0]?.[1] || "");
        const savedCwd = saved?.session.mode === "fresh" || saved?.session.mode === "fork" ? saved.session.cwd ?? "" : "";
        agentCwd = input(savedCwd || sessions[0]?.cwd || "");
        agentPrompt = textarea(saved?.prompt ?? "", 6);
        agentCapabilities = select([["Normal project tools", "write"], ["Read only", "read"]], saved?.launch?.capabilities ?? "write");
        agentThinking = select([["Project default", ""], ["Off", "off"], ["Low", "low"], ["Medium", "medium"], ["High", "high"], ["Extra high", "xhigh"]], saved?.launch?.thinking ?? "");
        agentModelProvider = input(saved?.launch?.model?.provider ?? "");
        agentModelId = input(saved?.launch?.model?.id ?? "");
        const sessionField = field("Session", agentSession);
        const cwdField = field("Child directory", agentCwd);
        const launchFields = [field("Capabilities", agentCapabilities), field("Thinking", agentThinking), field("Model provider (optional)", agentModelProvider), field("Model id (optional)", agentModelId)];
        const syncMode = (): void => {
          const reuse = agentMode?.value === "reuse";
          sessionField.classList.toggle("hidden", !reuse);
          cwdField.classList.toggle("hidden", reuse);
          for (const launchField of launchFields) launchField.classList.toggle("hidden", reuse);
        };
        agentMode.onchange = syncMode;
        syncMode();
        const prompt = field("Prompt", agentPrompt);
        prompt.classList.add("col-span-2");
        dynamic.append(field("Session policy", agentMode), sessionField, cwdField, ...launchFields, prompt);
      } else {
        targetTask = select(availableTasks.filter((row) => row.id !== task?.id && !row.archived).map((row) => [row.name, row.id]), task?.action.type === "task" ? task.action.taskId : "");
        dynamic.append(field("Target task", targetTask));
      }

      form.onsubmit = (event) => {
        event.preventDefault();
        const trigger = triggerType.value === "manual"
          ? { type: "manual" as const }
          : triggerType.value === "cron"
            ? { type: "cron" as const, expression: cronExpression!.value, timezone: cronTimezone!.value }
            : { type: "watch" as const, script: watchScript!.value, cwd: watchCwd!.value, intervalSeconds: Number(watchInterval!.value), mode: watchMode!.value as "once" | "repeat" };
        const agentLaunch = actionType.value === "agent" && agentMode!.value !== "reuse"
          ? {
              capabilities: agentCapabilities!.value as "read" | "write",
              ...(agentThinking!.value ? { thinking: agentThinking!.value as "off" | "low" | "medium" | "high" | "xhigh" } : {}),
              ...(agentModelProvider!.value.trim() && agentModelId!.value.trim()
                ? { model: { provider: agentModelProvider!.value.trim(), id: agentModelId!.value.trim() } }
                : {}),
            }
          : undefined;
        const action = actionType.value === "bash"
          ? { type: "bash" as const, cwd: bashCwd!.value, script: bashScript!.value }
          : actionType.value === "agent"
            ? {
                type: "agent" as const,
                prompt: agentPrompt!.value,
                session: agentMode!.value === "reuse"
                  ? { mode: "reuse" as const, sessionId: agentSession!.value }
                  : agentMode!.value === "fork"
                    ? { mode: "fork" as const, ...(agentCwd!.value.trim() ? { cwd: agentCwd!.value.trim() } : {}) }
                    : { mode: "fresh" as const, cwd: agentCwd!.value },
                ...(agentLaunch ? { launch: agentLaunch } : {}),
              }
            : { type: "task" as const, taskId: targetTask!.value };
        const callback = callbackType.value === "origin"
          ? { type: "origin" as const }
          : callbackType.value === "session"
            ? { type: "session" as const, sessionId: callbackSession.value }
            : { type: "none" as const };
        const draft: TaskDraft = { name: name.value, description: description.value, trigger, action, callback, timeoutSeconds: Number(timeout.value) };
        formError.textContent = "";
        void saveTask(task?.id, draft, dialog, formError);
      };
    };
    triggerType.onchange = renderDynamic;
    actionType.onchange = renderDynamic;
    renderDynamic();
    const cancel = button("Cancel");
    cancel.onclick = () => dialog.close();
    const save = button("Save", true);
    save.type = "submit";
    const footer = h("footer", "flex flex-none justify-end gap-2 border-t border-neutral-200 px-4 py-3");
    footer.append(formError, cancel, save);
    form.append(title, fields, footer);
    dialog.append(form);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  }

  async function saveTask(
    id: string | undefined,
    draft: TaskDraft,
    dialog: HTMLDialogElement,
    error: HTMLElement,
  ): Promise<void> {
    const res = await fetch(id ? `/api/tasks/${id}` : "/api/tasks", {
      method: id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!res.ok) {
      error.textContent = ((await res.json()) as { error?: string }).error ?? "Task save failed";
      return;
    }
    const payload = (await res.json()) as TaskDefinition | { task: TaskDefinition };
    const saved = "task" in payload ? payload.task : payload;
    dialog.close();
    selectedId = saved.id;
    await load();
  }

  return {
    get visible() { return visible; },
    show(taskId) {
      visible = true;
      if (taskId) selectedId = taskId;
      root.classList.remove("hidden");
      root.classList.add("flex");
      void load();
    },
    hide() { visible = false; root.classList.add("hidden"); root.classList.remove("flex"); },
    refresh(taskId) { if (!visible) return; if (!selectedId || !taskId || selectedId === taskId) void load(); },
  };
}
