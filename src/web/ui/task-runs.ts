// Console → Tasks: one task's run history — the runs list, a run's detail
// (control actions, raw record, message ledger) and the prompt-driven
// steer/stop/continue controls. tasks.ts owns the surrounding detail page.

import type { TaskMessage, TaskRun } from "../../tasks/types.js";
import { type Sent, getJson, promptRun } from "./api.js";
import { fmtDuration, h } from "./dom.js";
import { button } from "./form.js";

export interface TaskRunsDeps {
  openSession: (id: string) => void;
  currentSessionId: () => string | null;
  /** POST to a task endpoint, reload on success (tasks.ts's mutate). */
  mutate: (url: string) => Promise<void>;
  onError: (message: string) => void;
  reload: () => Promise<void>;
}

export const dateTime = (value: number | null): string =>
  value === null ? "-" : new Date(value).toLocaleString();

export const runDuration = (run: TaskRun): string =>
  run.startedAt === null ? "-" : fmtDuration((run.finishedAt ?? Date.now()) - run.startedAt);

export function renderRuns(pane: HTMLElement, runs: TaskRun[], deps: TaskRunsDeps): void {
  const list = h("div", "divide-y divide-neutral-100");
  for (const run of runs) {
    const row = h("button", "grid w-full cursor-pointer grid-cols-[7.5rem_1fr_7.5rem_6.25rem] gap-3 px-4 py-2.5 text-left text-[12.5px] hover:bg-neutral-50");
    row.append(
      h("span", "font-medium", run.state),
      h("span", "truncate text-neutral-500", dateTime(run.queuedAt)),
      h("span", "text-neutral-500", run.triggerSource),
      h("span", "text-right text-neutral-500", runDuration(run)),
    );
    row.onclick = () => void openRun(pane, run.id, list, deps);
    list.append(row);
  }
  if (!runs.length) list.append(h("p", "p-4 text-[13px] text-neutral-400", "No runs yet."));
  pane.replaceChildren(list);
}

async function openRun(pane: HTMLElement, id: string, list: HTMLElement, deps: TaskRunsDeps): Promise<void> {
  const [got, gotMessages] = await Promise.all([
    getJson<TaskRun>(`/api/task-runs/${id}`, "Could not load the run"),
    getJson<TaskMessage[]>(`/api/task-runs/${id}/messages`, "Could not load the run's messages"),
  ]);
  if (!got.ok) return;
  const run = got.value;
  const messages = gotMessages.ok ? gotMessages.value : [];
  const back = button("Back to runs");
  back.onclick = () => pane.replaceChildren(list);
  const actions = h("div", "flex items-center gap-2 border-b border-neutral-200 px-4 py-2");
  actions.append(back, h("span", "font-mono text-[12px] text-neutral-400", run.id));
  if (run.targetSessionId) {
    const open = button("Open session");
    open.classList.add("ml-auto");
    open.onclick = () => deps.openSession(run.targetSessionId!);
    actions.append(open);
  }
  if (run.state === "queued" || run.state === "running") {
    const steer = button("Steer");
    steer.onclick = () =>
      void control(
        promptRun("Steer subagent", `/api/task-runs/${run.id}/steer`, {
          mode: "steer",
          sourceSessionId: deps.currentSessionId(),
        }, "Run control failed"),
        deps,
      );
    const cancel = button("Stop");
    cancel.onclick = () => void deps.mutate(`/api/task-runs/${run.id}/cancel`);
    actions.append(steer, cancel);
  } else if (run.targetSessionId) {
    const resume = button("Continue");
    resume.onclick = () =>
      void control(
        promptRun("Continue subagent", `/api/task-runs/${run.id}/resume`, {
          sourceSessionId: deps.currentSessionId(),
        }, "Run control failed"),
        deps,
      );
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

/** Show what went wrong, or reload so the run's new state is on screen. */
async function control(outcome: Promise<Sent>, deps: TaskRunsDeps): Promise<void> {
  const result = await outcome;
  if (!result.sent) return;
  if (result.error) deps.onError(result.error);
  else await deps.reload();
}
