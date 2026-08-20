// Workbench frontend: session list + chat with per-turn Activity groups
// (avibe's AgentActivityGroup concept, event-driven vanilla port).
// Interaction paths render optimistically and reconcile from the SSE stream.

import "./style.css";
import DOMPurify from "dompurify";
import { marked } from "marked";

type SessionState = "idle" | "streaming";

interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface ModelRef {
  provider: string;
  id: string;
}

type SessionEvent = { seq: number; ts: number; sessionId: string } & (
  | { type: "turn-start" }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-end"; toolCallId: string; isError: boolean; output: string }
  | { type: "turn-end"; text: string }
  | { type: "state"; state: SessionState }
  | { type: "queued"; mode: "steer" | "followUp"; text: string }
  | { type: "queue-state"; steering: string[]; followUp: string[] }
  | { type: "error"; message: string }
);

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

function h(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

// --- static elements ---------------------------------------------------------

const sessionList = $("#session-list");
const turnsPane = $("#turns");
const input = $<HTMLTextAreaElement>("#input");
const modeHint = $("#mode-hint");
const chatTitle = $("#chat-title");
const chatCwd = $("#chat-cwd");
const chatState = $("#chat-state");
const abortBtn = $("#abort");
const newDialog = $<HTMLDialogElement>("#new-dialog");
const modelSelect = $<HTMLSelectElement>("#model-select");
const knownProjects = $("#known-projects");
const queuePanel = $("#queue-panel");
const queueRows = $("#queue-rows");
const sendNowBtn = $("#send-now");
const stopBtn = $("#stop");

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let streamingEl: HTMLElement | null = null;

// --- scrolling -------------------------------------------------------------------
// Stick to the bottom only when the user is already there (avibe behavior);
// force on own sends so the conversation follows the user's action.

const nearBottom = (): boolean =>
  turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;

function scrollBottom(force = false): void {
  if (force || nearBottom()) turnsPane.scrollTop = turnsPane.scrollHeight;
}

// --- session list (grouped by project = cwd) -------------------------------------

function sessionRow(s: SessionInfo): HTMLElement {
  const active = s.id === currentId;
  const li = h(
    "li",
    `flex cursor-pointer items-center gap-1.5 px-3 py-1.5 hover:bg-neutral-100 ${
      active ? "bg-indigo-50 hover:bg-indigo-50" : ""
    }`,
  );
  li.append(
    h(
      "span",
      `h-2 w-2 flex-none rounded-full ${
        s.state === "streaming" ? "bg-green-500 animate-pulse" : "bg-neutral-300"
      }`,
    ),
    h("span", "truncate", s.title ?? "untitled"),
    h("span", "ml-auto flex-none text-[11px] text-neutral-400", relTime(s.createdAt)),
  );
  li.onclick = () => void select(s.id);
  return li;
}

function renderSessions(): void {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const list = groups.get(s.cwd);
    if (list) list.push(s);
    else groups.set(s.cwd, [s]);
  }
  const nodes: HTMLElement[] = [];
  for (const [cwd, list] of groups) {
    const headerEl = h(
      "li",
      "truncate border-b border-neutral-200/70 px-3 pb-1 pt-2.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500",
      basename(cwd),
    );
    headerEl.title = cwd;
    nodes.push(headerEl, ...list.map(sessionRow));
  }
  sessionList.replaceChildren(...nodes);
  knownProjects.replaceChildren(
    ...[...groups.keys()].map((cwd) => {
      const opt = document.createElement("option");
      opt.value = cwd;
      return opt;
    }),
  );
}

async function refreshSessions(): Promise<void> {
  sessions = (await (await fetch("/api/sessions")).json()) as SessionInfo[];
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
}

// --- chat header -----------------------------------------------------------------

function renderHeader(): void {
  const s = sessions.find((x) => x.id === currentId);
  chatTitle.textContent = s?.title ?? (currentId ? currentId.slice(0, 8) : "no session");
  chatCwd.textContent = s?.cwd ?? "";
  modelSelect.classList.toggle("hidden", !currentId);
  chatState.textContent = currentState;
  chatState.className = `flex-none rounded-full px-2 py-0.5 text-[12px] ${
    currentState === "streaming"
      ? "bg-green-100 text-green-700"
      : "bg-neutral-100 text-neutral-500"
  }`;
  abortBtn.classList.toggle("hidden", currentState !== "streaming");
}

function setState(state: SessionState): void {
  currentState = state;
  const s = sessions.find((x) => x.id === currentId);
  if (s) s.state = state;
  renderSessions();
  renderHeader();
  updateModeHint();
  if (state === "idle") void refreshSessions();
}

function updateModeHint(): void {
  const streaming = currentState === "streaming";
  modeHint.textContent = streaming
    ? "streaming — Send queues · Send now steers"
    : "idle — send starts a turn";
  sendNowBtn.classList.toggle("hidden", !streaming);
  stopBtn.classList.toggle("hidden", !streaming);
}

// --- pending queue panel (avibe ChatQueueRow concept) -----------------------

function renderQueue(steering: string[], followUp: string[]): void {
  const rows = [
    ...steering.map((text) => ({ mode: "steer", text })),
    ...followUp.map((text) => ({ mode: "queued", text })),
  ];
  queuePanel.classList.toggle("hidden", rows.length === 0);
  queuePanel.classList.toggle("flex", rows.length > 0);
  queueRows.replaceChildren(
    ...rows.map((r) => {
      const li = h("li", "flex items-center gap-2 rounded-md border border-amber-200 bg-white px-2 py-1 text-[13px]");
      li.append(
        h(
          "span",
          `flex-none rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${
            r.mode === "steer" ? "bg-indigo-100 text-indigo-700" : "bg-amber-100 text-amber-700"
          }`,
          r.mode,
        ),
        h("span", "truncate text-neutral-700", r.text),
      );
      return li;
    }),
  );
}

// --- chat bubbles ------------------------------------------------------------------

const turnStyles: Record<string, string> = {
  user: "bg-indigo-50 text-indigo-950",
  assistant: "bg-neutral-100",
  queued: "bg-amber-50 italic text-amber-900",
  error: "bg-red-50 text-red-700",
};

function appendTurn(kind: keyof typeof turnStyles, text: string, markdown = false): HTMLElement {
  const wrap = h("div", kind === "user" ? "flex justify-end" : "flex");
  const node = h(
    "div",
    `max-w-[50rem] whitespace-pre-wrap break-words rounded-lg px-3 py-2 ${turnStyles[kind]}`,
    text,
  );
  if (markdown) renderMarkdown(node, text);
  wrap.append(node);
  turnsPane.append(wrap);
  scrollBottom();
  return node;
}

/** Swap a plain-text bubble to sanitized rendered markdown. */
function renderMarkdown(node: HTMLElement, raw: string): void {
  node.innerHTML = DOMPurify.sanitize(marked.parse(raw, { async: false }));
  node.classList.remove("whitespace-pre-wrap");
  node.classList.add("md");
}

/** Finalize the in-flight streamed text block (markdown-render it). */
function finalizeStreaming(): void {
  if (!streamingEl) return;
  renderMarkdown(streamingEl, streamingEl.dataset.raw ?? streamingEl.textContent ?? "");
  streamingEl = null;
}

// --- activity group ------------------------------------------------------------------
// One collapsible bubble per turn collects thinking + tool activity
// (avibe's AgentActivityGroup: status, steps, duration, expandable rows).

type ActivityStatus = "running" | "done" | "failed" | "interrupted";

interface Activity {
  el: HTMLDetailsElement;
  headline: HTMLElement;
  rowsEl: HTMLElement;
  toolRows: Map<string, HTMLElement>;
  thinkingRow: HTMLElement | null;
  steps: number;
  startTs: number;
  sawError: boolean;
}

let activity: Activity | null = null; // the live (running) group
let turnOpen = false;

const STATUS_STYLE: Record<ActivityStatus, string> = {
  running: "border-green-200 bg-green-50 text-green-800",
  done: "border-neutral-200 bg-neutral-50 text-neutral-500",
  failed: "border-red-200 bg-red-50 text-red-700",
  interrupted: "border-amber-200 bg-amber-50 text-amber-800",
};

function ensureActivity(ts: number): Activity {
  if (activity) return activity;
  const el = document.createElement("details");
  el.className = `max-w-[50rem] rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE.running}`;
  const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
  const headline = h("span", "truncate", "working…");
  summary.append(h("span", "flex-none", "⚙"), headline);
  const rowsEl = h("div", "mt-1.5 flex flex-col gap-1 border-t border-black/5 pt-1.5 font-mono text-[12.5px]");
  el.append(summary, rowsEl);
  turnsPane.append(el);
  scrollBottom();
  activity = { el, headline, rowsEl, toolRows: new Map(), thinkingRow: null, steps: 0, startTs: ts, sawError: false };
  return activity;
}

function activityHeadline(a: Activity, status: ActivityStatus, latest?: string): void {
  const secs = Math.max(1, Math.round((Date.now() - a.startTs) / 1000));
  const base = `${a.steps} step${a.steps === 1 ? "" : "s"} · ${secs}s`;
  a.headline.textContent =
    status === "running" && latest ? `${base} · ${latest}` : `${base} · ${status}`;
  a.el.className = `max-w-[50rem] rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE[status]}`;
}

function finishActivity(status: ActivityStatus): void {
  if (!activity) return;
  // Any still-running tool rows were cut short.
  for (const row of activity.toolRows.values()) {
    const s = row.querySelector<HTMLElement>(".tool-status");
    if (s && s.textContent === "running…") s.textContent = "interrupted";
  }
  activityHeadline(activity, activity.sawError && status === "done" ? "failed" : status);
  activity = null;
}

function activityToolStart(ts: number, id: string, name: string, args: unknown): void {
  const a = ensureActivity(ts);
  a.steps += 1;
  a.thinkingRow = null;
  const row = h("div", "flex items-baseline gap-1.5");
  const argsText = JSON.stringify(args);
  row.append(
    h("span", "flex-none font-semibold", name),
    h("span", "truncate text-black/50", argsText.length > 120 ? argsText.slice(0, 120) + "…" : argsText),
    h("span", "tool-status ml-auto flex-none text-black/40", "running…"),
  );
  a.toolRows.set(id, row);
  a.rowsEl.append(row);
  activityHeadline(a, "running", name);
  scrollBottom();
}

function activityToolEnd(id: string, isError: boolean, output: string): void {
  const a = activity;
  if (!a) return;
  const row = a.toolRows.get(id);
  a.toolRows.delete(id);
  if (row) {
    const s = row.querySelector<HTMLElement>(".tool-status");
    if (s) {
      s.textContent = isError ? "failed" : "ok";
      s.className = `tool-status ml-auto flex-none ${isError ? "text-red-600" : "text-green-700"}`;
    }
    // Keep rows compact; hover shows the (truncated) tool output.
    if (output) row.title = output.length > 2000 ? output.slice(0, 2000) + "…" : output;
    if (isError) a.sawError = true;
  }
  activityHeadline(a, "running");
}

function activityThinking(ts: number, text: string): void {
  const a = ensureActivity(ts);
  if (!a.thinkingRow) {
    a.thinkingRow = h("div", "whitespace-pre-wrap break-words text-black/45 italic", "");
    a.rowsEl.append(a.thinkingRow);
    activityHeadline(a, "running", "thinking…");
  }
  a.thinkingRow.textContent = ((a.thinkingRow.textContent ?? "") + text).slice(-500);
}

// --- event handling ----------------------------------------------------------------

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  switch (e.type) {
    case "turn-start":
      turnOpen = true;
      break;
    case "text-delta":
      if (!streamingEl) streamingEl = appendTurn("assistant", "");
      streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + e.text;
      streamingEl.textContent = streamingEl.dataset.raw;
      scrollBottom();
      break;
    case "thinking-delta":
      activityThinking(e.ts, e.text);
      break;
    case "tool-start":
      finalizeStreaming(); // a tool call ends the in-flight text block
      activityToolStart(e.ts, e.toolCallId, e.toolName, e.args);
      break;
    case "tool-end":
      activityToolEnd(e.toolCallId, e.isError, e.output);
      break;
    case "turn-end":
      turnOpen = false;
      finishActivity("done");
      if (!streamingEl && e.text) appendTurn("assistant", e.text, true);
      finalizeStreaming();
      break;
    case "queued":
      // The queue panel (fed by queue-state snapshots) is the pending view;
      // nothing to render in the transcript until delivery.
      break;
    case "queue-state":
      renderQueue(e.steering, e.followUp);
      break;
    case "error":
      if (activity) activity.sawError = true;
      appendTurn("error", e.message);
      break;
    case "state":
      if (e.state === "idle" && turnOpen) {
        // idle without a turn-end: the run was aborted
        turnOpen = false;
        finishActivity("interrupted");
        finalizeStreaming();
      }
      if (e.state === "idle") renderQueue([], []); // delivered or dropped
      setState(e.state);
      break;
  }
}

function connect(id: string, after: number): void {
  source?.close();
  source = new EventSource(`/api/sessions/${id}/events?after=${after}`);
  source.onmessage = (m) => handleEvent(JSON.parse(m.data) as SessionEvent);
}

// --- selection & sending --------------------------------------------------------------

async function select(id: string): Promise<void> {
  if (id === currentId) return;
  currentId = id;
  source?.close();
  turnsPane.replaceChildren();
  renderQueue([], []);
  streamingEl = null;
  activity = null;
  turnOpen = false;
  lastSeq = 0;
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  renderSessions();
  renderHeader();
  const res = await fetch(`/api/sessions/${id}/history`);
  if (!res.ok) {
    appendTurn("error", `failed to load session: ${res.status}`);
    return;
  }
  const { turns, lastSeq: seq, model } = (await res.json()) as {
    turns: ChatTurn[];
    lastSeq: number;
    model: ModelRef | null;
  };
  for (const t of turns) appendTurn(t.role, t.text, t.role === "assistant");
  scrollBottom(true);
  lastSeq = seq;
  connect(id, seq);
  void loadModels(id, model);
}

// --- model picker -----------------------------------------------------------------------

const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

async function loadModels(id: string, current: ModelRef | null): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/models`);
  if (!res.ok || id !== currentId) return;
  const models = (await res.json()) as ModelRef[];
  modelSelect.replaceChildren(
    ...models.map((m) => {
      const opt = document.createElement("option");
      opt.value = modelKey(m);
      opt.textContent = m.id;
      return opt;
    }),
  );
  if (current) modelSelect.value = modelKey(current);
}

modelSelect.onchange = async () => {
  if (!currentId) return;
  const m = modelSelect.value.split("/");
  const res = await fetch(`/api/sessions/${currentId}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: m[0], id: m.slice(1).join("/") }),
  });
  if (!res.ok) appendTurn("error", `model change failed: ${res.status}`);
};

async function send(mode: "auto" | "steer"): Promise<void> {
  const text = input.value.trim();
  if (!text || !currentId) return;
  input.value = "";
  updateModeHint();
  // Optimistic: an idle send (or a steer) reads as a user turn; a queued send
  // shows up in the queue panel via the queue-state snapshot instead.
  if (currentState === "idle" || mode === "steer") {
    appendTurn("user", text);
    scrollBottom(true);
  }
  await fetch(`/api/sessions/${currentId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode }),
  });
}

async function recallQueue(): Promise<void> {
  if (!currentId) return;
  const res = await fetch(`/api/sessions/${currentId}/queue/recall`, { method: "POST" });
  if (!res.ok) return;
  const { messages } = (await res.json()) as { messages: string[] };
  // Append (not replace) so an existing draft isn't clobbered — avibe recall rule.
  if (messages.length) {
    input.value = [input.value.trim(), ...messages].filter(Boolean).join("\n");
    input.focus();
  }
  renderQueue([], []);
}

// --- wiring ----------------------------------------------------------------------------

$("#new-session").onclick = () => {
  $<HTMLInputElement>("#new-cwd").value = "";
  newDialog.showModal();
};
$("#new-cancel").onclick = () => newDialog.close();
$<HTMLFormElement>("#new-form").onsubmit = async () => {
  const cwd = $<HTMLInputElement>("#new-cwd").value.trim();
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cwd ? { cwd } : {}),
  });
  const { id } = (await res.json()) as { id: string };
  await refreshSessions();
  await select(id);
  input.focus();
};
const abort = () =>
  currentId && fetch(`/api/sessions/${currentId}/abort`, { method: "POST" });
abortBtn.onclick = abort;
stopBtn.onclick = abort;
sendNowBtn.onclick = () => void send("steer");
$("#queue-recall").onclick = () => void recallQueue();
$<HTMLFormElement>("#composer").onsubmit = (ev) => {
  ev.preventDefault();
  void send("auto");
};
input.oninput = updateModeHint;
input.onkeydown = (ev) => {
  // IME guard: Enter that confirms a composition candidate must not send
  // (isComposing covers modern browsers; 229 covers stragglers).
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void send("auto");
  }
};

void refreshSessions().then(() => {
  const first = sessions[0];
  if (first) void select(first.id);
  else renderHeader();
});
updateModeHint();
