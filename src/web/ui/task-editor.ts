// Console → Tasks: the create/edit dialog. One form whose trigger and action
// sections re-render as their type selects change; submit assembles a
// TaskDraft and POSTs/PATCHes it. tasks.ts owns the list this returns to.

import type { TaskDefinition, TaskDraft } from "../../tasks/types.js";
import { sendJson } from "./api.js";
import { h } from "./dom.js";
import { button, field, input, select, textarea } from "./form.js";

export interface SessionChoice {
  id: string;
  cwd: string;
  title?: string;
}

export interface TaskEditorDeps {
  sessions: () => SessionChoice[];
  /** Candidate targets for a task-action (the current active list). */
  tasks: () => TaskDefinition[];
  onSaved: (id: string) => void;
}

/** Known sessions as select options, keeping a saved id Pi no longer lists. */
function sessionChoices(sessions: SessionChoice[], savedId: string | null): [string, string][] {
  const choices = sessions.map((s) => [`${s.title ?? "Untitled"} · ${s.cwd}`, s.id] as [string, string]);
  if (savedId && !choices.some(([, id]) => id === savedId)) {
    choices.push([`Current session · ${savedId}`, savedId]);
  }
  return choices;
}

export function openTaskEditor(deps: TaskEditorDeps, task?: TaskDefinition): void {
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
  const savedCallbackId = task?.callback.type === "session" ? task.callback.sessionId : null;
  const callbackSession = select(sessionChoices(deps.sessions(), savedCallbackId), savedCallbackId ?? "");
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
      watchCwd = input(task?.trigger.type === "watch" ? task.trigger.cwd : deps.sessions()[0]?.cwd ?? "");
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
      bashCwd = input(task?.action.type === "bash" ? task.action.cwd : deps.sessions()[0]?.cwd ?? "");
      bashScript = textarea(task?.action.type === "bash" ? task.action.script : "", 6);
      const script = field("Bash script", bashScript);
      script.classList.add("col-span-2");
      dynamic.append(field("Working directory", bashCwd), h("span", ""), script);
    } else if (actionType.value === "agent") {
      const sessions = deps.sessions();
      const saved = task?.action.type === "agent" ? task.action : null;
      const savedSessionId = saved?.session.mode === "reuse" ? saved.session.sessionId : "";
      const choices = sessionChoices(sessions, savedSessionId || null);
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
      targetTask = select(deps.tasks().filter((row) => row.id !== task?.id && !row.archived).map((row) => [row.name, row.id]), task?.action.type === "task" ? task.action.taskId : "");
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
      void saveTask(task?.id, draft, dialog, formError, deps.onSaved);
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
  onSaved: (id: string) => void,
): Promise<void> {
  const res = await sendJson(id ? `/api/tasks/${id}` : "/api/tasks", draft, id ? "PATCH" : "POST");
  if (!res.ok) {
    error.textContent = ((await res.json()) as { error?: string }).error ?? "Task save failed";
    return;
  }
  const payload = (await res.json()) as TaskDefinition | { task: TaskDefinition };
  const saved = "task" in payload ? payload.task : payload;
  dialog.close();
  onSaved(saved.id);
}
