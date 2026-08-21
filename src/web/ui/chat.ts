// The turns pane: chat rows, markdown, per-turn Activity groups, streaming
// text, system-input and background-run rows, and inline user-message edit.
// main.ts owns session state and the event stream; this module only renders
// into #turns through the functions it exports.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { splitReply } from "../../core/reply.js";
import { renderAttachments, rewriteFileLinks } from "./attachments.js";
import { highlightCode } from "./highlight.js";
import { $, detailsRow, h } from "./dom.js";
import { renderSuggestions, resetSuggestions } from "./suggestions.js";
import type {
  ActivityStep,
  BackgroundRun,
  SessionState,
  SystemInputOrigin,
  TurnMeta,
} from "../../core/types.js";

/** Everything chat rendering needs from the orchestrator (main.ts). */
export interface ChatDeps {
  sessionId: () => string | null;
  sessionState: () => SessionState;
  select: (id: string) => void;
  showTasks: (taskId?: string) => void;
  send: (mode: "auto" | "steer", label?: string) => void;
  /** Reload the session snapshot if `id` is still the selected session. */
  reload: (id: string) => Promise<void>;
}

let deps: ChatDeps;

export function initChat(d: ChatDeps): void {
  deps = d;
}

export const turnsPane = $("#turns");

/** 1200 → "1.2K", 12_000 → "12K" — absolute token counts read badly inline. */
export const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);

// --- scrolling -------------------------------------------------------------------
// Stick to the bottom only when the user is already there (avibe behavior);
// force on own sends so the conversation follows the user's action.

const nearBottom = (): boolean =>
  turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;

export function scrollBottom(force = false): void {
  if (force || nearBottom()) turnsPane.scrollTop = turnsPane.scrollHeight;
}

// --- chat rows (Slack-style full-width) ----------------------------------------------
// No sender labels: user rows carry an accent bar + tint, agent rows stay plain.

const ROW_STYLE: Record<string, { row: string; body: string }> = {
  user: { row: "border-l-indigo-500 bg-indigo-50", body: "text-neutral-900" },
  assistant: { row: "border-l-transparent", body: "text-neutral-900" },
  error: { row: "border-l-red-400 bg-red-50", body: "text-red-700" },
  system: { row: "border-l-cyan-500 bg-cyan-50", body: "text-neutral-800" },
};

// No rules between rows: tint and accent say who is speaking, the gap only says
// whether the speaker changed (4px within a run, 6px across one), and the
// padding is generous — the block breathes, the lines don't.
export function appendTurn(kind: keyof typeof ROW_STYLE, text: string, markdown = false): HTMLElement {
  const s = ROW_STYLE[kind]!;
  // Consecutive rows from the same sender read as one block (Slack grouping).
  const grouped = (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative border-l-2 px-5 ${grouped ? "pt-1 pb-2.5" : "mt-1.5 py-2.5"} ${s.row}`);
  row.dataset.kind = kind;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, text);
  if (markdown) renderMarkdown(node, text);
  row.append(node);
  if (kind === "user") {
    const edit = h(
      "button",
      "absolute right-2 top-1 hidden h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:flex",
    );
    edit.title = "Edit — resends from here; this message and later turns leave the context";
    edit.setAttribute("aria-label", "Edit message");
    edit.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="m10.7 2.3 3 3L6 13H3v-3l7.7-7.7zM9.3 3.7l3 3"/></svg>';
    edit.onclick = () => startEdit(row, node);
    row.append(edit);
  }
  turnsPane.append(row);
  scrollBottom();
  return node;
}

export function appendSystemInput(text: string, origin: SystemInputOrigin): void {
  const kind = origin.kind === "task-callback"
    ? "Task callback"
    : origin.kind === "task-message"
      ? origin.messageKind === "decision" ? "Decision needed" : `Task ${origin.messageKind.replace("_", " ")}`
      : "Agent task input";
  const row = h("div", "mt-1.5 border-l-2 border-l-cyan-500 bg-cyan-50 px-5 py-2.5");
  row.dataset.kind = "system";
  const head = h("div", "mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-cyan-800");
  head.append(h("span", "", kind));
  if (origin.sourceSessionId && origin.sourceSessionId !== "console") {
    const source = h("button", "truncate font-mono normal-case text-cyan-700 hover:underline", origin.sourceSessionId.slice(0, 12));
    source.title = "Open source session";
    source.onclick = () => deps.select(origin.sourceSessionId!);
    head.append(h("span", "text-cyan-400", "from"), source);
  }
  const run = h("button", "ml-auto flex-none font-mono normal-case text-cyan-700 hover:underline", `run ${origin.runId.slice(0, 8)}`);
  run.onclick = () => deps.showTasks(origin.taskId);
  head.append(run);
  if (origin.kind === "task-message" && origin.messageKind === "decision") {
    const reply = h("button", "flex-none text-[11px] font-semibold normal-case text-cyan-800 hover:underline", "Reply");
    reply.onclick = () => void replyToDecision(origin.messageId);
    head.append(reply);
  }
  row.append(head, h("div", "whitespace-pre-wrap break-words text-[14px] text-neutral-800", text));
  turnsPane.append(row);
  scrollBottom();
}

// --- background runs (detached task calls made from this session) ------------------

const RUN_STYLE: Record<BackgroundRun["state"], string> = {
  queued: "border-amber-200 bg-amber-50 text-amber-800",
  running: "border-green-200 bg-green-50 text-green-800",
  succeeded: "border-neutral-200 bg-neutral-50 text-neutral-600",
  failed: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-neutral-200 bg-neutral-50 text-neutral-500",
  interrupted: "border-amber-200 bg-amber-50 text-amber-800",
  skipped: "border-neutral-200 bg-neutral-50 text-neutral-500",
};

const backgroundRows = new Map<string, HTMLElement>();

async function replyToDecision(messageId: string): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  const message = window.prompt("Reply to subagent");
  if (!message?.trim()) return;
  const res = await fetch(`/api/task-messages/${messageId}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, sourceSessionId: id }),
  });
  if (!res.ok) appendTurn("error", ((await res.json()) as { error?: string }).error ?? "reply failed");
}

async function steerBackground(runId: string): Promise<void> {
  const message = window.prompt("Steer subagent");
  if (!message?.trim()) return;
  await fetch(`/api/task-runs/${runId}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, mode: "steer", sourceSessionId: deps.sessionId() }),
  });
}

async function resumeBackground(runId: string): Promise<void> {
  const message = window.prompt("Continue subagent");
  if (!message?.trim()) return;
  await fetch(`/api/task-runs/${runId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, sourceSessionId: deps.sessionId() }),
  });
}

export function renderBackgroundRun(run: BackgroundRun): void {
  let row = backgroundRows.get(run.runId);
  if (!row) {
    row = h("div", "mx-5 my-1.5 border px-3 py-2 text-[13px]");
    row.dataset.kind = "background-run";
    turnsPane.append(row);
    backgroundRows.set(run.runId, row);
  }
  row.className = `mx-5 my-1.5 border px-3 py-2 text-[13px] ${RUN_STYLE[run.state]}`;
  const active = run.state === "queued" || run.state === "running";
  const status = active ? h("span", "spinner") : h("span", "w-3 flex-none text-center", run.state === "succeeded" ? "✓" : run.state === "failed" ? "✕" : "·");
  const title = h("button", "min-w-0 truncate text-left font-medium hover:underline", run.taskName);
  title.onclick = () => deps.showTasks(run.taskId);
  const head = h("div", "flex items-center gap-2");
  head.append(status, h("span", "flex-none text-[11px] font-semibold uppercase", run.state), title);
  const controls = h("div", "ml-auto flex flex-none items-center gap-2");
  if (run.targetSessionId) {
    const target = h("button", "font-mono text-[11px] hover:underline", "Open");
    target.title = `Open ${run.targetSessionId}`;
    target.onclick = () => deps.select(run.targetSessionId!);
    controls.append(target);
  }
  if (active) {
    const steer = h("button", "text-[11px] font-semibold hover:underline", "Steer");
    steer.onclick = () => void steerBackground(run.runId);
    const cancel = h("button", "text-[11px] font-semibold hover:underline", "Stop");
    cancel.onclick = () => void fetch(`/api/task-runs/${run.runId}/cancel`, { method: "POST" });
    controls.append(steer, cancel);
  } else if (run.targetSessionId && run.sessionMode !== null) {
    const resume = h("button", "text-[11px] font-semibold hover:underline", "Continue");
    resume.onclick = () => void resumeBackground(run.runId);
    controls.append(resume);
  }
  head.append(controls);
  const started = run.startedAt ?? run.queuedAt;
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - started) / 1000));
  row.replaceChildren(
    head,
    h("div", "mt-1 text-[11px] opacity-70", `${run.sessionMode ?? "task"} · depth ${run.depth} · ${seconds}s · ${run.runId}`),
  );
  scrollBottom();
}

// --- edit user message ------------------------------------------------------------
// Pencil on a user row → inline textarea; Enter rewinds the transcript to just
// before that message server-side and re-sends the edited text, so the old
// message stops polluting the context. Later turns are dropped with it.

function startEdit(row: HTMLElement, node: HTMLElement): void {
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  if (row.querySelector("textarea")) return;
  const area = document.createElement("textarea");
  area.value = node.textContent ?? ""; // user turns are plain text
  area.className =
    "block w-full resize-none rounded-md border border-indigo-300 bg-white px-2 py-1 focus:outline-none";
  // Grow with content like the composer does; same 192px cap (max-h-48).
  const grow = (): void => {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 192)}px`;
  };
  area.oninput = grow;
  node.classList.add("hidden");
  node.after(area);
  grow();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const cancel = (): void => {
    area.remove();
    node.classList.remove("hidden");
  };
  area.onkeydown = (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Escape") cancel();
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const text = area.value.trim();
      if (!text) return cancel();
      void submitEdit(row, text);
    }
  };
}

async function submitEdit(row: HTMLElement, text: string): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  // The Nth user row on screen is the Nth user turn of history().
  const index = [...turnsPane.querySelectorAll('[data-kind="user"]')].indexOf(row);
  const res = await fetch(`/api/sessions/${id}/turns/${index}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    appendTurn("error", `edit failed: ${res.status}`);
    return;
  }
  await deps.reload(id); // the transcript was rewound — reload it
}

/** Row-hover meta chip on agent turns: completion time · duration · tokens. */
function setMetaHint(node: HTMLElement, meta?: TurnMeta): void {
  if (!meta) return;
  const secs = Math.max(1, Math.round(meta.durationMs / 1000));
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
  // 24-hour, local timezone.
  const time = new Date(meta.completedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const chip = h(
    "span",
    "absolute -top-2.5 right-3 z-10 hidden rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[11.5px] text-neutral-500 shadow-sm group-hover:inline",
    `${time} · ${dur} · ${compact(meta.tokens)} tok`,
  );
  (node.parentElement ?? node).append(chip);
}

// --- copy to clipboard -----------------------------------------------------------

/** navigator.clipboard is secure-context only and the dev target binds 0.0.0.0,
 *  so a LAN-IP visit falls back to the legacy selection trick. */
async function copy(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.className = "fixed opacity-0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("clipboard unavailable");
}

/** Copy affordance whose own label reports the outcome — no toast machinery. */
export function copyBtn(cls: string, text: () => string): HTMLElement {
  const btn = h("button", cls, "Copy");
  btn.title = "Copy to clipboard";
  let timer: ReturnType<typeof setTimeout> | undefined;
  btn.onclick = async (ev) => {
    ev.stopPropagation(); // copying isn't "activate the row this sits in"
    btn.textContent = await copy(text()).then(() => "Copied", () => "Failed");
    clearTimeout(timer);
    timer = setTimeout(() => (btn.textContent = "Copy"), 1200);
  };
  return btn;
}

/** Wrap each fenced block so a copy button can sit in its corner without
 *  scrolling away with the code, and copy the source text, not the tokens. */
function addCodeCopy(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const wrap = h("div", "group/code relative");
    pre.replaceWith(wrap);
    wrap.append(
      pre,
      copyBtn(
        "absolute right-1.5 top-1.5 cursor-pointer rounded border border-black/[0.08] bg-white/85 px-1.5 py-0.5 text-[11px] text-neutral-500 opacity-0 transition-opacity hover:bg-white hover:text-neutral-800 focus:opacity-100 group-hover/code:opacity-100",
        () => code.textContent ?? "",
      ),
    );
  }
}

/** Swap a plain-text bubble to sanitized rendered markdown. */
function renderMarkdown(node: HTMLElement, raw: string): void {
  // Attachment links are rewritten to the session's files route first: the
  // sanitizer drops `file:` URLs (rightly), so they'd vanish otherwise.
  const id = deps.sessionId();
  const md = id ? rewriteFileLinks(raw, id) : raw;
  node.innerHTML = DOMPurify.sanitize(marked.parse(md, { async: false }));
  node.classList.remove("whitespace-pre-wrap");
  node.classList.add("md");
  highlightCode(node);
  addCodeCopy(node);
  renderAttachments(node, showImage);
}

/** An assistant turn: markdown bubble, hover meta, and — only for the turn
 *  that just ended (`offer`) — next-step buttons. A mid-turn text block or a
 *  replayed history turn never offers them: the run has moved on. */
function renderAssistant(
  node: HTMLElement,
  raw: string,
  meta?: TurnMeta,
  offer = false,
): HTMLElement {
  const { text, suggestions } = splitReply(raw);
  renderMarkdown(node, text);
  setMetaHint(node, meta);
  if (offer) {
    renderSuggestions(node.parentElement ?? node, suggestions, (label) => deps.send("auto", label));
  }
  return node;
}

export const appendAssistant = (raw: string, meta?: TurnMeta, offer = false): HTMLElement =>
  renderAssistant(appendTurn("assistant", ""), raw, meta, offer);

// --- streaming text ---------------------------------------------------------------

let streamingEl: HTMLElement | null = null;

/** Append a text-delta to the in-flight (plain text) streamed block. */
export function appendDelta(text: string): void {
  if (!streamingEl) streamingEl = appendTurn("assistant", "");
  streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + text;
  streamingEl.textContent = streamingEl.dataset.raw;
  scrollBottom();
}

/** Finalize the in-flight streamed text block (markdown-render it). */
export function finalizeStreaming(offer = false): void {
  if (!streamingEl) return;
  const node = streamingEl;
  streamingEl = null;
  renderAssistant(node, node.dataset.raw ?? node.textContent ?? "", undefined, offer);
}

/** turn-end presentation. `text` is the authoritative full turn text — a
 *  client that joined mid-turn only holds the deltas it happened to see. */
export function completeTurn(text: string | undefined, meta?: TurnMeta): void {
  finishActivity("done");
  if (streamingEl) {
    if (text) streamingEl.dataset.raw = text;
    setMetaHint(streamingEl, meta);
  } else if (text) {
    appendAssistant(text, meta, true);
  }
  finalizeStreaming(true);
}

/** idle without a turn-end: the run was aborted. */
export function interruptTurn(): void {
  finishActivity("interrupted");
  finalizeStreaming();
}

/** Reset everything before a session snapshot re-render. */
export function resetChat(): void {
  turnsPane.replaceChildren();
  streamingEl = null;
  activity = null;
  backgroundRows.clear();
  resetSuggestions();
}

// --- activity group ------------------------------------------------------------------
// One collapsible bubble per turn collects thinking + tool activity
// (avibe's AgentActivityGroup: status icon + chevron, steps, duration,
// each step itself an expandable details row).

type ActivityStatus = "running" | "done" | "failed" | "interrupted";

interface ToolRow {
  el: HTMLDetailsElement;
  statusEl: HTMLElement;
  outputPre: HTMLElement;
}

interface Activity {
  el: HTMLDetailsElement;
  statusIcon: HTMLElement;
  headline: HTMLElement;
  rowsEl: HTMLElement;
  toolRows: Map<string, ToolRow>;
  thinking: { pre: HTMLElement; summary: HTMLElement } | null;
  steps: number;
  failedSteps: number;
  startTs: number;
  sawError: boolean; // turn-level error event — fails the whole group
}

let activity: Activity | null = null; // the live (running) group

const STATUS_STYLE: Record<ActivityStatus, string> = {
  running: "border-green-200 bg-green-50 text-green-800",
  done: "border-neutral-200 bg-neutral-50 text-neutral-500",
  failed: "border-red-200 bg-red-50 text-red-700",
  interrupted: "border-amber-200 bg-amber-50 text-amber-800",
};

const STATUS_ICON: Record<Exclude<ActivityStatus, "running">, string> = {
  done: "✓",
  failed: "✕",
  interrupted: "⏸",
};

function statusIconEl(status: ActivityStatus): HTMLElement {
  return status === "running"
    ? h("span", "spinner")
    : h("span", "flex-none text-[12px] font-bold", STATUS_ICON[status]);
}

function ensureActivity(ts: number): Activity {
  if (activity) return activity;
  const statusIcon = statusIconEl("running");
  const headline = h("span", "truncate", "working…");
  const { el } = detailsRow(
    `mx-5 my-1.5 rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE.running}`,
    [statusIcon, headline],
  );
  el.dataset.kind = "activity";
  // Caps at ~10 step rows, then scrolls: an expanded group can't swallow the chat.
  const rowsEl = h("div", "mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain border-t border-black/5 pt-1.5");
  el.append(rowsEl);
  turnsPane.append(el);
  scrollBottom();
  activity = { el, statusIcon, headline, rowsEl, toolRows: new Map(), thinking: null, steps: 0, failedSteps: 0, startTs: ts, sawError: false };
  return activity;
}

function activityHeadline(a: Activity, status: ActivityStatus, latest?: string): void {
  const secs = Math.max(1, Math.round((Date.now() - a.startTs) / 1000));
  const base = `${a.steps} step${a.steps === 1 ? "" : "s"} · ${secs}s`;
  a.headline.textContent =
    status === "running" && latest
      ? `${base} · ${latest}`
      : status === "done"
        ? base
        : `${base} · ${status}`;
  a.el.className = `mx-5 my-1.5 rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE[status]}`;
  const icon = statusIconEl(status);
  a.statusIcon.replaceWith(icon);
  a.statusIcon = icon;
}

function finishActivity(status: ActivityStatus): void {
  if (!activity) return;
  // Any still-running tool rows were cut short.
  for (const { statusEl } of activity.toolRows.values()) {
    if (statusEl.textContent === "running…") statusEl.textContent = "interrupted";
  }
  // One failed step doesn't fail the group — its red row says enough. All-red
  // is reserved for every step failing, or a turn-level error (sawError).
  const allFailed = activity.steps > 0 && activity.failedSteps === activity.steps;
  activityHeadline(
    activity,
    (activity.sawError || allFailed) && status === "done" ? "failed" : status,
  );
  activity = null;
}

/** A turn-level error event fails the whole group when it closes. */
export function noteTurnError(): void {
  if (activity) activity.sawError = true;
}

export function activityToolStart(ts: number, id: string, name: string, args: unknown): void {
  const a = ensureActivity(ts);
  a.steps += 1;
  a.thinking = null;
  const argsText = JSON.stringify(args, null, 2) ?? "";
  const short = argsText.replace(/\s+/g, " ");
  const statusEl = h("span", "ml-auto flex-none text-black/40", "running…");
  const { el } = detailsRow("rounded-md px-1 py-0.5 font-mono text-[12.5px] hover:bg-black/[0.03]", [
    h("span", "flex-none font-semibold", name),
    h("span", "truncate text-black/50", short.length > 100 ? short.slice(0, 100) + "…" : short),
    statusEl,
  ]);
  const body = h("div", "mt-1 flex flex-col gap-1 pl-4");
  const argsPre = h("pre", "max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-black/[0.04] p-1.5 text-[12px]", argsText);
  const outputPre = h("pre", "hidden max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-black/[0.04] p-1.5 text-[12px]");
  body.append(argsPre, outputPre);
  el.append(body);
  a.toolRows.set(id, { el, statusEl, outputPre });
  a.rowsEl.append(el);
  a.rowsEl.scrollTop = a.rowsEl.scrollHeight; // capped list: follow the newest step
  activityHeadline(a, "running", name);
  scrollBottom();
}

export function activityToolEnd(id: string, isError: boolean, output: string): void {
  const a = activity;
  if (!a) return;
  const row = a.toolRows.get(id);
  a.toolRows.delete(id);
  if (row) {
    row.statusEl.textContent = isError ? "failed" : "ok";
    row.statusEl.className = `ml-auto flex-none ${isError ? "text-red-600" : "text-green-700"}`;
    row.el.classList.toggle("bg-red-50", isError);
    row.el.classList.toggle("text-red-700", isError);
    if (output) {
      row.outputPre.textContent = output.length > 8000 ? output.slice(0, 8000) + "…" : output;
      row.outputPre.classList.remove("hidden");
    }
    if (isError) a.failedSteps += 1;
  }
  activityHeadline(a, "running");
}

export function activityThinking(ts: number, text: string): void {
  const a = ensureActivity(ts);
  if (!a.thinking) {
    const { el, summary } = detailsRow("rounded-md px-1 py-0.5 text-[12.5px] italic text-black/50 hover:bg-black/[0.03]", [
      h("span", "truncate", "thinking…"),
    ]);
    const pre = h("div", "mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap pl-4 not-italic text-black/60", "");
    el.append(pre);
    a.rowsEl.append(el);
    a.thinking = { pre, summary };
    activityHeadline(a, "running", "thinking…");
  }
  const t = a.thinking;
  t.pre.textContent = ((t.pre.textContent ?? "") + text).slice(-4000);
  const line = (t.pre.textContent ?? "").split("\n").filter(Boolean).pop() ?? "thinking…";
  const label = t.summary.lastElementChild as HTMLElement;
  label.textContent = line.length > 90 ? "…" + line.slice(-90) : line;
}

/**
 * Rebuild a finished turn's Activity group from the snapshot, through the same
 * functions the live stream drives — so a reload shows the real step count and
 * duration instead of restarting at zero.
 */
let replaySeq = 0;

export function replayActivity(steps: ActivityStep[], durationMs = 0, live = false): void {
  const start = Date.now() - durationMs; // headline duration is now - startTs
  for (const s of steps) {
    if (s.kind === "thinking") {
      activityThinking(start, s.text ?? "");
      continue;
    }
    // Real tool call ids when the snapshot has them: a live tool-end for a
    // replayed row then closes that row instead of missing it.
    const id = s.id ?? `replay-${++replaySeq}`;
    activityToolStart(start, id, s.toolName ?? "", s.args);
    // No recorded output = the run was cut short; leave the row running so
    // finishActivity marks the group interrupted.
    if (s.output !== undefined) activityToolEnd(id, s.isError ?? false, s.output);
  }
  // The turn still running keeps its group open, so the live stream counts on
  // into it instead of opening a second bubble beneath the replayed one.
  if (live) return;
  finishActivity(
    steps.some((s) => s.kind === "tool" && s.output === undefined) ? "interrupted" : "done",
  );
}

// --- image lightbox + thumbnails ---------------------------------------------------

const imageDialog = $<HTMLDialogElement>("#image-dialog");
const imageFull = $<HTMLImageElement>("#image-full");
imageDialog.onclick = () => imageDialog.close();

/** Full-size view of any chat image (transcript, pending, or attachment). */
export function showImage(src: string): void {
  imageFull.src = src;
  imageDialog.showModal();
}

/** Thumbnail in a chat row; click shows the image full size. */
export function imageThumb(src: string): HTMLImageElement {
  const thumb = document.createElement("img");
  thumb.src = src;
  thumb.loading = "lazy";
  thumb.className = "mt-1.5 max-h-48 cursor-zoom-in rounded-md border border-black/5";
  thumb.onclick = () => showImage(src);
  return thumb;
}
