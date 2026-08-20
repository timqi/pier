// Workbench frontend: session list + chat + raw event timeline.
// Vite + Tailwind, no framework. Layout lives in index.html.

import "./style.css";

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

const sessionList = $("#session-list");
const turnsPane = $("#turns");
const timeline = $("#timeline");
const input = $<HTMLTextAreaElement>("#input");
const modeHint = $("#mode-hint");

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let streamingEl: HTMLElement | null = null;

const TURN_CLS = "max-w-[52rem] whitespace-pre-wrap break-words rounded-lg px-3.5 py-2.5";
const turnStyles: Record<string, string> = {
  user: "bg-indigo-50 text-indigo-950",
  assistant: "bg-neutral-100",
  queued: "bg-amber-50 italic text-amber-900",
  error: "bg-red-50 text-red-700",
};

function renderSessions(): void {
  sessionList.replaceChildren(
    ...sessions.map((s) => {
      const active = s.id === currentId;
      const li = h(
        "li",
        `flex cursor-pointer items-center gap-2 border-b border-neutral-200/70 px-4 py-2.5 hover:bg-neutral-100 ${
          active ? "bg-indigo-50 hover:bg-indigo-50" : ""
        }`,
      );
      const dot = h(
        "span",
        `h-2 w-2 flex-none rounded-full ${
          s.state === "streaming" ? "bg-green-500 animate-pulse" : "bg-neutral-300"
        }`,
      );
      const title = h("span", "truncate", s.title ?? s.id.slice(0, 8));
      li.append(dot, title);
      li.onclick = () => void select(s.id);
      return li;
    }),
  );
}

function setState(state: SessionState): void {
  currentState = state;
  const s = sessions.find((x) => x.id === currentId);
  if (s) s.state = state;
  renderSessions();
  updateModeHint();
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

function appendTurn(kind: keyof typeof turnStyles, text: string): HTMLElement {
  const wrap = h("div", kind === "user" ? "flex justify-end" : "flex");
  const node = h("div", `${TURN_CLS} ${turnStyles[kind]}`, text);
  wrap.append(node);
  turnsPane.append(wrap);
  turnsPane.scrollTop = turnsPane.scrollHeight;
  return node;
}

function detailsRow(summaryText: string, body: string, isError = false): HTMLElement {
  const details = h("details", "min-w-0 flex-1");
  const summary = h(
    "summary",
    `cursor-pointer select-none ${isError ? "text-red-600" : "text-neutral-600"}`,
    summaryText,
  );
  const pre = h(
    "pre",
    "mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-neutral-100 p-1.5",
    body,
  );
  details.append(summary, pre);
  return details;
}

function timelineRow(e: SessionEvent): void {
  const li = h("li", "flex gap-2 border-b border-neutral-200/60 px-2 py-1.5 break-words");
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

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  timelineRow(e);
  switch (e.type) {
    case "text-delta":
      if (!streamingEl) streamingEl = appendTurn("assistant", "");
      streamingEl.textContent += e.text;
      turnsPane.scrollTop = turnsPane.scrollHeight;
      break;
    case "turn-end":
      if (streamingEl) {
        streamingEl.textContent = e.text;
        streamingEl = null;
      } else if (e.text) {
        appendTurn("assistant", e.text);
      }
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

async function select(id: string): Promise<void> {
  if (id === currentId) return;
  currentId = id;
  source?.close();
  turnsPane.replaceChildren();
  timeline.replaceChildren();
  streamingEl = null;
  lastSeq = 0;
  renderSessions();
  const res = await fetch(`/api/sessions/${id}/history`);
  if (!res.ok) {
    appendTurn("error", `failed to load session: ${res.status}`);
    return;
  }
  const { turns, lastSeq: seq } = (await res.json()) as { turns: ChatTurn[]; lastSeq: number };
  for (const t of turns) appendTurn(t.role, t.text);
  lastSeq = seq;
  connect(id, seq);
}

async function refreshSessions(): Promise<void> {
  sessions = (await (await fetch("/api/sessions")).json()) as SessionInfo[];
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
}

async function send(mode: "auto" | "steer" | "followUp"): Promise<void> {
  const text = input.value.trim();
  if (!text || !currentId) return;
  input.value = "";
  updateModeHint();
  appendTurn("user", text);
  await fetch(`/api/sessions/${currentId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode }),
  });
}

$("#new-session").onclick = async () => {
  const res = await fetch("/api/sessions", { method: "POST", body: "{}" });
  const { id } = (await res.json()) as { id: string };
  await refreshSessions();
  await select(id);
};
$("#abort").onclick = () =>
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
});
updateModeHint();
