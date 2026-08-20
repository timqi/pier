// Workbench frontend: session list + chat + raw event timeline.
// Compiled by tsconfig.web.json to /main.js. No framework, no deps.

type SessionState = "idle" | "streaming";

interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
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

const sessionList = $("#session-list");
const turns = $("#turns");
const timeline = $("#timeline");
const input = $<HTMLTextAreaElement>("#input");
const modeHint = $("#mode-hint");

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let streamingEl: HTMLElement | null = null;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderSessions(): void {
  sessionList.replaceChildren(
    ...sessions.map((s) => {
      const li = el("li", s.id === currentId ? "active" : "");
      li.append(
        el("span", `dot ${s.state}`),
        el("span", "title", s.title ?? s.id.slice(0, 8)),
      );
      li.onclick = () => select(s.id);
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

function appendTurn(cls: string, text: string): HTMLElement {
  const node = el("div", `turn ${cls}`, text);
  turns.append(node);
  turns.scrollTop = turns.scrollHeight;
  return node;
}

function timelineRow(e: SessionEvent): void {
  const li = document.createElement("li");
  const time = new Date(e.ts).toLocaleTimeString();
  li.append(el("span", "t", time), el("span", "k", e.type));
  if (e.type === "tool-start") {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = e.toolName;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(e.args, null, 2);
    details.append(summary, pre);
    li.append(details);
  } else if (e.type === "tool-end") {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = e.isError ? "error" : "ok";
    const pre = document.createElement("pre");
    pre.textContent = e.output;
    details.append(summary, pre);
    li.append(details);
  } else if (e.type === "text-delta" || e.type === "thinking-delta") {
    li.append(el("span", "", e.text.length > 60 ? e.text.slice(0, 60) + "…" : e.text));
  } else if (e.type === "queued") {
    li.append(el("span", "", `${e.mode}: ${e.text}`));
  } else if (e.type === "state") {
    li.append(el("span", "", e.state));
  } else if (e.type === "error") {
    li.append(el("span", "", e.message));
  } else if (e.type === "turn-end") {
    li.append(el("span", "", `${e.text.length} chars`));
  }
  timeline.append(li);
  timeline.scrollTop = timeline.scrollHeight;
}

function handleEvent(e: SessionEvent): void {
  if (e.seq <= lastSeq) return; // dedupe on replay
  lastSeq = e.seq;
  timelineRow(e);
  switch (e.type) {
    case "text-delta":
      if (!streamingEl) streamingEl = appendTurn("assistant", "");
      streamingEl.textContent += e.text;
      turns.scrollTop = turns.scrollHeight;
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

function connect(id: string): void {
  source?.close();
  lastSeq = 0;
  source = new EventSource(`/api/sessions/${id}/events`);
  source.onmessage = (m) => handleEvent(JSON.parse(m.data) as SessionEvent);
}

function select(id: string): void {
  currentId = id;
  turns.replaceChildren();
  timeline.replaceChildren();
  streamingEl = null;
  renderSessions();
  connect(id);
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
  select(id);
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
  if (first) select(first.id);
});
updateModeHint();
