// Workbench frontend: session list + chat (with inline tool activity) + raw
// event timeline. Vanilla TS + Tailwind; layout lives in index.html.
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

// --- static elements -------------------------------------------------------

const sessionList = $("#session-list");
const turnsPane = $("#turns");
const timeline = $("#timeline");
const input = $<HTMLTextAreaElement>("#input");
const modeHint = $("#mode-hint");
const chatTitle = $("#chat-title");
const chatCwd = $("#chat-cwd");
const chatState = $("#chat-state");
const abortBtn = $("#abort");
const newDialog = $<HTMLDialogElement>("#new-dialog");
const modelSelect = $<HTMLSelectElement>("#model-select");
const knownProjects = $("#known-projects");

// --- state ------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let streamingEl: HTMLElement | null = null;
const toolRows = new Map<string, HTMLElement>(); // toolCallId → chat row

// --- session list (grouped by project = cwd) --------------------------------

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
  // Projects are derived, not registered: one group per distinct cwd,
  // ordered by the group's most recent session.
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

// --- chat header ------------------------------------------------------------

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
  // Titles are derived server-side from the first message; refresh cheaply
  // when a turn settles instead of polling.
  if (state === "idle") void refreshSessions();
}

function updateModeHint(): void {
  if (currentState === "idle") {
    modeHint.textContent = "idle — send starts a turn";
  } else {
    modeHint.textContent = input.value.startsWith("!")
      ? "streaming — will steer"
      : "streaming — will queue as follow-up";
  }
}

// --- chat pane ----------------------------------------------------------------

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
  turnsPane.scrollTop = turnsPane.scrollHeight;
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

/** Compact inline tool activity row, avibe-chat style: "⚙ bash · running". */
function appendToolRow(id: string, name: string): void {
  const row = h(
    "div",
    "flex items-center gap-1.5 pl-1 font-mono text-[12.5px] text-neutral-500",
  );
  row.append(h("span", "", "⚙"), h("span", "font-semibold", name), h("span", "tool-status", "running…"));
  toolRows.set(id, row);
  turnsPane.append(row);
  turnsPane.scrollTop = turnsPane.scrollHeight;
}

function finishToolRow(id: string, isError: boolean): void {
  const row = toolRows.get(id);
  if (!row) return;
  toolRows.delete(id);
  const status = row.querySelector<HTMLElement>(".tool-status");
  if (!status) return;
  status.textContent = isError ? "failed" : "done";
  status.className = `tool-status ${isError ? "text-red-600" : "text-green-600"}`;
}

// --- timeline ---------------------------------------------------------------

function detailsRow(summaryText: string, body: string, isError = false): HTMLElement {
  const details = h("details", "min-w-0 flex-1");
  details.append(
    h("summary", `cursor-pointer select-none ${isError ? "text-red-600" : "text-neutral-600"}`, summaryText),
    h("pre", "mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-neutral-100 p-1.5 text-[12px]", body),
  );
  return details;
}

function timelineRow(e: SessionEvent): void {
  const li = h("li", "flex gap-2 border-b border-neutral-200/60 px-1.5 py-1 break-words");
  li.append(
    h("span", "flex-none text-neutral-400", new Date(e.ts).toLocaleTimeString()),
    h("span", "flex-none font-semibold text-neutral-700", e.type),
  );
  if (e.type === "tool-start") {
    li.append(detailsRow(e.toolName, JSON.stringify(e.args, null, 2)));
  } else if (e.type === "tool-end") {
    li.append(detailsRow(e.isError ? "error" : "ok", e.output, e.isError));
  } else if (e.type === "text-delta" || e.type === "thinking-delta") {
    li.append(h("span", "truncate text-neutral-500", e.text));
  } else if (e.type === "queued") {
    li.append(h("span", "text-amber-700", `${e.mode}: ${e.text}`));
  } else if (e.type === "state") {
    li.append(h("span", "text-neutral-500", e.state));
  } else if (e.type === "error") {
    li.append(h("span", "text-red-600", e.message));
  } else if (e.type === "turn-end") {
    li.append(h("span", "text-neutral-500", `${e.text.length} chars`));
  }
  timeline.append(li);
  timeline.scrollTop = timeline.scrollHeight;
}

// --- event handling -----------------------------------------------------------

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  timelineRow(e);
  switch (e.type) {
    case "text-delta":
      if (!streamingEl) streamingEl = appendTurn("assistant", "");
      streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + e.text;
      streamingEl.textContent = streamingEl.dataset.raw;
      turnsPane.scrollTop = turnsPane.scrollHeight;
      break;
    case "tool-start":
      // A tool call ends any in-flight text block; the next delta starts a new one.
      finalizeStreaming();
      appendToolRow(e.toolCallId, e.toolName);
      break;
    case "tool-end":
      finishToolRow(e.toolCallId, e.isError);
      break;
    case "turn-end":
      // Streamed deltas already rendered the text across tool-call blocks;
      // only materialize the full text when nothing streamed (e.g. replay gap).
      if (!streamingEl && e.text) appendTurn("assistant", e.text, true);
      finalizeStreaming();
      break;
    case "queued":
      appendTurn("queued", `[${e.mode}] ${e.text}`);
      break;
    case "error":
      appendTurn("error", e.message);
      break;
    case "state":
      setState(e.state);
      break;
  }
}

function connect(id: string, after: number): void {
  source?.close();
  source = new EventSource(`/api/sessions/${id}/events?after=${after}`);
  source.onmessage = (m) => handleEvent(JSON.parse(m.data) as SessionEvent);
}

// --- selection & sending -------------------------------------------------------

async function select(id: string): Promise<void> {
  if (id === currentId) return;
  currentId = id;
  source?.close();
  turnsPane.replaceChildren();
  timeline.replaceChildren();
  toolRows.clear();
  streamingEl = null;
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
  lastSeq = seq;
  connect(id, seq);
  void loadModels(id, model);
}

// --- model picker -------------------------------------------------------------

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

async function send(mode: "auto" | "steer" | "followUp"): Promise<void> {
  const text = input.value.trim();
  if (!text || !currentId) return;
  input.value = "";
  updateModeHint();
  appendTurn("user", text); // optimistic; queue/error states arrive via SSE
  await fetch(`/api/sessions/${currentId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode }),
  });
}

// --- wiring --------------------------------------------------------------------

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
abortBtn.onclick = () =>
  currentId && fetch(`/api/sessions/${currentId}/abort`, { method: "POST" });
$("#send-steer").onclick = () => void send("steer");
$("#send-queue").onclick = () => void send("followUp");
$<HTMLFormElement>("#composer").onsubmit = (ev) => {
  ev.preventDefault();
  void send("auto");
};
input.oninput = updateModeHint;
input.onkeydown = (ev) => {
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
