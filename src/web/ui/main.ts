// Workbench frontend: session list + chat with per-turn Activity groups
// (avibe's AgentActivityGroup concept, event-driven vanilla port).
// Interaction paths render optimistically and reconcile from the SSE stream.

import "./style.css";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { $, h } from "./dom.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
// Type-only import of the seam contract — erased at build, keeps the wire
// shapes single-sourced in core/types.ts instead of hand-copied here.
import type {
  ActivityStep,
  ChatTurn,
  ContextUsage,
  ImageAttachment,
  ModelRef,
  SessionEvent,
  SessionState,
  TurnMeta,
  WorkspaceEvent,
} from "../../core/types.js";

/** GET /api/sessions/:id/history — the snapshot every delta is applied onto. */
interface SessionSnapshot {
  turns: ChatTurn[];
  lastSeq: number;
  model: ModelRef | null;
  state: SessionState;
  context: ContextUsage | null;
  queue: { steering: string[]; followUp: string[] };
}

declare const __PIER_VERSION__: string; // injected by vite.config.ts

/** GET /api/sessions row: AgentFactory.list() entry + live state + pin flag. */
interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
  pinned: boolean;
}

function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** 1200 → "1.2K", 12_000 → "12K" — absolute token counts read badly inline. */
const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);

// --- static elements ---------------------------------------------------------

const projectTree = $("#project-tree");
const archiveDialog = $<HTMLDialogElement>("#archive-dialog");
const archiveList = $("#archive-list");
const archiveSearch = $<HTMLInputElement>("#archive-search");
const archiveCount = $("#archive-count");
const turnsPane = $("#turns");
const input = $<HTMLTextAreaElement>("#input");
const chatTitle = $("#chat-title");
const chatMenu = $("#chat-menu");
const stateChip = $("#state-chip");
const sendBtn = $("#send");
const newDialog = $<HTMLDialogElement>("#new-dialog");
const knownProjects = $("#known-projects");
const queuePanel = $("#queue-panel");
const queueRows = $("#queue-rows");
const sendNowBtn = $("#send-now");
const stopBtn = $("#stop");
const imageStrip = $("#image-strip");
const attachInput = $<HTMLInputElement>("#attach-input");

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let streamingEl: HTMLElement | null = null;
let pendingImages: ImageAttachment[] = [];
// Texts already rendered optimistically, awaiting their user-message event so
// the same turn isn't drawn twice.
let optimisticUserTexts: string[] = [];

// --- scrolling -------------------------------------------------------------------
// Stick to the bottom only when the user is already there (avibe behavior);
// force on own sends so the conversation follows the user's action.

const nearBottom = (): boolean =>
  turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;

function scrollBottom(force = false): void {
  if (force || nearBottom()) turnsPane.scrollTop = turnsPane.scrollHeight;
}

// --- projects (pinned sessions, grouped by cwd) ------------------------------------
// Projects lists pinned sessions only — those created in Pier (auto-pinned) or
// pinned from the All-sessions dialog — so Pi history never floods the sidebar.

const COLLAPSED_KEY = "pier.collapsedProjects";
const collapsed = new Set<string>(loadCollapsed());

function loadCollapsed(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function setCollapsed(cwd: string, closed: boolean): void {
  if (closed) collapsed.add(cwd);
  else collapsed.delete(cwd);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function groupByCwd(list: SessionInfo[]): Map<string, SessionInfo[]> {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const existing = groups.get(s.cwd);
    if (existing) existing.push(s);
    else groups.set(s.cwd, [s]);
  }
  return groups;
}

const stateDot = (s: SessionInfo): HTMLElement =>
  h(
    "span",
    `h-2 w-2 flex-none rounded-full ${
      s.state === "streaming" ? "bg-green-500 animate-pulse" : "bg-neutral-300"
    }`,
  );

/** Unpin keeps the session — it just moves back into the All-sessions list. */
async function setPinned(s: SessionInfo, pinned: boolean): Promise<void> {
  s.pinned = pinned;
  renderSessions();
  renderHeader();
  const res = await fetch(`/api/sessions/${s.id}/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) {
    s.pinned = !pinned; // reconcile: the server is the truth
    renderSessions();
    renderHeader();
  }
}

function sessionRow(s: SessionInfo): HTMLElement {
  const active = s.id === currentId;
  const li = h(
    "li",
    `group flex cursor-pointer items-center gap-1.5 py-1.5 pl-6 pr-3 hover:bg-neutral-100 ${
      active ? "bg-indigo-50 hover:bg-indigo-50" : ""
    }`,
  );
  const more = h(
    "button",
    "ml-auto hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block",
    "\u22ef",
  );
  more.title = "Session actions";
  more.onclick = (ev) => {
    ev.stopPropagation();
    sessionMenu(more, s);
  };
  li.append(stateDot(s), h("span", "truncate", s.title ?? "untitled"), more);
  li.onclick = () => void select(s.id);
  return li;
}

/** One collapsible project = one cwd; collapse state lives in localStorage. */
function projectNode(cwd: string, list: SessionInfo[]): HTMLElement {
  const badge = list.some((s) => s.state === "streaming")
    ? h("span", "ml-auto h-2 w-2 flex-none rounded-full bg-green-500 animate-pulse")
    : h("span", "ml-auto flex-none text-[11px] text-neutral-400", String(list.length));
  const { el, summary } = detailsRow("border-b border-neutral-200/70", [
    h("span", "truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500", basename(cwd)),
    badge,
  ]);
  summary.className += " px-3 py-1.5 hover:bg-neutral-100";
  summary.title = cwd;
  el.open = !collapsed.has(cwd);
  el.ontoggle = () => setCollapsed(cwd, !el.open);
  const rows = h("ul", "pb-1");
  rows.append(...list.map(sessionRow));
  el.append(rows);
  return el;
}

function renderSessions(): void {
  const projects = groupByCwd(sessions.filter((s) => s.pinned));
  projectTree.replaceChildren(
    ...(projects.size
      ? [...projects].map(([cwd, list]) => projectNode(cwd, list))
      : [
          h(
            "p",
            "px-3 py-2 text-[12.5px] leading-snug text-neutral-400",
            "No projects yet — create a session, or pin one from All sessions.",
          ),
        ]),
  );
  archiveCount.textContent = String(sessions.length);
  knownProjects.replaceChildren(
    ...[...groupByCwd(sessions).keys()].map((cwd) => {
      const opt = document.createElement("option");
      opt.value = cwd;
      return opt;
    }),
  );
  if (archiveDialog.open) renderArchive();
}

// --- all sessions (everything Pi knows about, pin from here) -----------------------

function archiveRow(s: SessionInfo): HTMLElement {
  const li = h("li", "flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-neutral-100");
  const pin = h(
    "button",
    `flex-none rounded px-1.5 py-0.5 text-[11.5px] ${
      s.pinned
        ? "bg-indigo-50 text-indigo-600"
        : "text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
    }`,
    s.pinned ? "pinned" : "pin",
  );
  pin.title = s.pinned ? "Remove from Projects" : "Pin to Projects";
  pin.onclick = (ev) => {
    ev.stopPropagation();
    void setPinned(s, !s.pinned);
  };
  li.append(
    stateDot(s),
    h("span", "truncate", s.title ?? "untitled"),
    h("span", "ml-auto flex-none text-[11px] text-neutral-400", relTime(s.createdAt)),
    pin,
  );
  li.onclick = () => {
    archiveDialog.close();
    void select(s.id);
  };
  return li;
}

function renderArchive(): void {
  const q = archiveSearch.value.trim().toLowerCase();
  const match = sessions.filter(
    (s) => !q || `${s.title ?? ""} ${s.cwd}`.toLowerCase().includes(q),
  );
  const nodes: HTMLElement[] = [];
  for (const [cwd, list] of groupByCwd(match)) {
    const head = h(
      "li",
      "truncate px-3 pb-0.5 pt-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500",
      basename(cwd),
    );
    head.title = cwd;
    nodes.push(head, ...list.map(archiveRow));
  }
  archiveList.replaceChildren(
    ...(nodes.length
      ? nodes
      : [h("li", "px-3 py-3 text-[13px] text-neutral-400", "No matching sessions.")]),
  );
}

/** Sessions created here that Pi doesn't list yet (persisted on first message). */
const fresh = new Map<string, SessionInfo>();

async function refreshSessions(): Promise<void> {
  const listed = (await (await fetch("/api/sessions")).json()) as SessionInfo[];
  for (const s of listed) fresh.delete(s.id);
  sessions = [...fresh.values(), ...listed];
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
}

// --- chat header -----------------------------------------------------------------

function renderHeader(): void {
  // A fresh session may not be listed yet (Pi persists on first message) —
  // synthesize a stub so the ⋯ menu (info, pin, model) works from turn zero.
  const s =
    sessions.find((x) => x.id === currentId) ??
    (currentId
      ? { id: currentId, cwd: "—", createdAt: Date.now(), state: currentState, pinned: false }
      : undefined);
  chatTitle.textContent = s ? (s.title ?? "Untitled session") : "no session";
  chatMenu.classList.toggle("hidden", !s);
  // Everything per-session (info, pin, model) lives in the ⋯ menu.
  if (s) chatMenu.onclick = () => sessionMenu(chatMenu, s);
}

function setState(state: SessionState): void {
  currentState = state;
  const s = sessions.find((x) => x.id === currentId);
  if (s) s.state = state;
  renderSessions();
  renderHeader();
  updateComposer();
  if (state === "idle") void refreshSessions();
}

/** Composer toolbar: subtle state indicator + contextual buttons. */
function updateComposer(): void {
  const streaming = currentState === "streaming";
  stateChip.replaceChildren(
    h(
      "span",
      `h-1.5 w-1.5 flex-none rounded-full ${streaming ? "bg-green-500 animate-pulse" : "bg-neutral-300"}`,
    ),
    h("span", streaming ? "text-green-700" : "", streaming ? "streaming" : "idle"),
  );
  stateChip.title = streaming
    ? "streaming — Queue defers · Send now steers · Stop aborts"
    : "idle — send starts a turn";
  sendBtn.textContent = streaming ? "Queue" : "Send";
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

// --- chat rows (Slack-style full-width) ----------------------------------------------
// No sender labels: user rows carry an accent bar + tint, agent rows stay plain.

const ROW_STYLE: Record<string, { row: string; body: string }> = {
  user: { row: "border-l-2 border-indigo-500 bg-indigo-50/60", body: "text-neutral-900" },
  assistant: { row: "border-l-2 border-transparent", body: "text-neutral-800" },
  error: { row: "border-l-2 border-red-400 bg-red-50/60", body: "text-red-700" },
};

function appendTurn(kind: keyof typeof ROW_STYLE, text: string, markdown = false): HTMLElement {
  const s = ROW_STYLE[kind]!;
  // Consecutive rows from the same sender read as one block (Slack grouping).
  const grouped = (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative px-5 py-1 ${grouped ? "mt-px" : "mt-2"} ${s.row}`);
  row.dataset.kind = kind;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, text);
  if (markdown) renderMarkdown(node, text);
  row.append(node);
  turnsPane.append(row);
  scrollBottom();
  return node;
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
// (avibe's AgentActivityGroup: status icon + chevron, steps, duration,
// each step itself an expandable details row).

type ActivityStatus = "running" | "done" | "failed" | "interrupted";

interface ToolRow {
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

/** Chevron + summary skeleton shared by the group chip and step rows. */
function detailsRow(cls: string, summaryChildren: HTMLElement[]): { el: HTMLDetailsElement; summary: HTMLElement } {
  const el = document.createElement("details");
  el.className = cls;
  const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
  summary.append(h("span", "chev", "▶"), ...summaryChildren);
  el.append(summary);
  return { el, summary };
}

function ensureActivity(ts: number): Activity {
  if (activity) return activity;
  const statusIcon = statusIconEl("running");
  const headline = h("span", "truncate", "working…");
  const { el } = detailsRow(
    `mx-5 mt-2 rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE.running}`,
    [statusIcon, headline],
  );
  el.dataset.kind = "activity";
  const rowsEl = h("div", "mt-1.5 flex flex-col gap-1 border-t border-black/5 pt-1.5");
  el.append(rowsEl);
  turnsPane.append(el);
  scrollBottom();
  activity = { el, statusIcon, headline, rowsEl, toolRows: new Map(), thinking: null, steps: 0, startTs: ts, sawError: false };
  return activity;
}

function activityHeadline(a: Activity, status: ActivityStatus, latest?: string): void {
  const secs = Math.max(1, Math.round((Date.now() - a.startTs) / 1000));
  const base = `${a.steps} step${a.steps === 1 ? "" : "s"} · ${secs}s`;
  a.headline.textContent =
    status === "running" && latest ? `${base} · ${latest}` : `${base} · ${status}`;
  a.el.className = `mx-5 mt-2 rounded-lg border px-3 py-1.5 text-[13px] ${STATUS_STYLE[status]}`;
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
  activityHeadline(activity, activity.sawError && status === "done" ? "failed" : status);
  activity = null;
}

function activityToolStart(ts: number, id: string, name: string, args: unknown): void {
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
  a.toolRows.set(id, { statusEl, outputPre });
  a.rowsEl.append(el);
  activityHeadline(a, "running", name);
  scrollBottom();
}

function activityToolEnd(id: string, isError: boolean, output: string): void {
  const a = activity;
  if (!a) return;
  const row = a.toolRows.get(id);
  a.toolRows.delete(id);
  if (row) {
    row.statusEl.textContent = isError ? "failed" : "ok";
    row.statusEl.className = `ml-auto flex-none ${isError ? "text-red-600" : "text-green-700"}`;
    if (output) {
      row.outputPre.textContent = output.length > 8000 ? output.slice(0, 8000) + "…" : output;
      row.outputPre.classList.remove("hidden");
    }
    if (isError) a.sawError = true;
  }
  activityHeadline(a, "running");
}

function activityThinking(ts: number, text: string): void {
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

function replayActivity(steps: ActivityStep[], durationMs = 0): void {
  const start = Date.now() - durationMs; // headline duration is now - startTs
  for (const s of steps) {
    if (s.kind === "thinking") {
      activityThinking(start, s.text ?? "");
      continue;
    }
    const id = `replay-${++replaySeq}`;
    activityToolStart(start, id, s.toolName ?? "", s.args);
    // No recorded output = the run was cut short; leave the row running so
    // finishActivity marks the group interrupted.
    if (s.output !== undefined) activityToolEnd(id, s.isError ?? false, s.output);
  }
  finishActivity(
    steps.some((s) => s.kind === "tool" && s.output === undefined) ? "interrupted" : "done",
  );
}

// --- event handling ----------------------------------------------------------------

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  switch (e.type) {
    case "turn-start":
      turnOpen = true;
      break;
    case "user-message": {
      // Already on screen from our own optimistic render? Just reconcile.
      const i = optimisticUserTexts.indexOf(e.text);
      if (i >= 0) {
        optimisticUserTexts.splice(i, 1);
        break;
      }
      finalizeStreaming(); // a delivered queue message ends the text block
      appendTurn("user", e.text);
      scrollBottom();
      break;
    }
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
      // e.text is the authoritative full turn text — a client that joined
      // mid-turn only holds the deltas it happened to see.
      if (streamingEl) {
        if (e.text) streamingEl.dataset.raw = e.text;
        setMetaHint(streamingEl, e.meta);
      } else if (e.text) {
        setMetaHint(appendTurn("assistant", e.text, true), e.meta);
      }
      finalizeStreaming();
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

/**
 * Workspace stream: keeps this client's session list in step with every other
 * client (and with IM traffic). Content still arrives per session.
 */
function connectWorkspace(): void {
  const src = new EventSource("/api/events");
  // Any (re)connect may follow a gap — re-list instead of replaying.
  src.onopen = () => void refreshSessions();
  src.onmessage = (m) => {
    const e = JSON.parse(m.data) as WorkspaceEvent;
    if (e.type === "sessions-changed") {
      void refreshSessions();
      return;
    }
    // The selected session's own stream already drives composer state.
    if (e.sessionId === currentId) return;
    const s = sessions.find((x) => x.id === e.sessionId);
    if (!s) return;
    s.state = e.state;
    renderSessions();
  };
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
  optimisticUserTexts = [];
  lastSeq = 0;
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  renderSessions();
  renderHeader();
  const res = await fetch(`/api/sessions/${id}/history`);
  const snap = res.ok ? ((await res.json()) as SessionSnapshot) : null;
  if (currentId !== id) return; // stale: the user switched again mid-fetch
  if (!snap) {
    appendTurn("error", `failed to load session: ${res.status}`);
    return;
  }
  for (const t of snap.turns) {
    if (t.steps?.length) replayActivity(t.steps, t.meta?.durationMs);
    if (t.text) setMetaHint(appendTurn(t.role, t.text, t.role === "assistant"), t.meta);
  }
  scrollBottom(true);
  lastSeq = snap.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp);
  currentModel = snap.model;
  currentContext = snap.context;
  renderHeader();
  connect(id, snap.lastSeq);
}

// --- session context menu (pin + model) -------------------------------------------------
// Same menu from the chat header and from a project row's ⋯ button.

/** Model + context usage of the *current* session (from its snapshot). */
let currentModel: ModelRef | null = null;
let currentContext: ContextUsage | null = null;

/** Read-only details panel: what this session is and how full its context is. */
function sessionInfo(anchor: HTMLElement, s: SessionInfo): void {
  const rows: [string, string][] = [
    ["Title", s.title ?? "untitled"],
    ["Directory", s.cwd],
    ["Session", s.id],
  ];
  if (s.id === currentId) {
    rows.push(["Model", currentModel?.id ?? "—"]);
    const u = currentContext;
    rows.push([
      "Context",
      u
        ? `${u.tokens === null ? "?" : compact(u.tokens)} / ${compact(u.contextWindow)}` +
          (u.tokens === null ? "" : ` (${Math.round((u.tokens / u.contextWindow) * 100)}%)`)
        : "—",
    ]);
  }
  const panel = h("div", "flex max-w-80 flex-col gap-1.5 px-3 py-2");
  for (const [label, value] of rows) {
    const row = h("div", "flex flex-col");
    row.append(
      h("span", "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", label),
      h("span", "break-all font-mono text-[12px] text-neutral-700", value),
    );
    panel.append(row);
  }
  openPanel(anchor, panel);
}

async function pickModel(anchor: HTMLElement, id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/models`);
  if (!res.ok) return;
  const models = (await res.json()) as ModelRef[];
  openPanel(
    anchor,
    modelPicker({
      models,
      current: id === currentId ? currentModel : null,
      onPick: (m) => {
        closeMenu();
        void setModel(id, m);
      },
    }),
  );
}

async function setModel(id: string, model: ModelRef): Promise<void> {
  if (id === currentId) {
    currentModel = model; // optimistic; the POST response is the truth
    renderHeader();
  }
  const res = await fetch(`/api/sessions/${id}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(model),
  });
  if (!res.ok) {
    appendTurn("error", `model change failed: ${res.status}`);
    return;
  }
  const { model: applied } = (await res.json()) as { model: ModelRef | null };
  if (id === currentId && applied) {
    currentModel = applied;
    renderHeader();
  }
}

function sessionMenu(anchor: HTMLElement, s: SessionInfo): void {
  openMenu(anchor, [
    {
      items: [
        {
          label: "Session info",
          onSelect: () => sessionInfo(anchor, s),
        },
        {
          label: s.pinned ? "Remove from Projects" : "Pin to Projects",
          checked: s.pinned,
          onSelect: () => {
            closeMenu();
            void setPinned(s, !s.pinned);
          },
        },
        {
          label: "Model",
          hint: s.id === currentId ? (currentModel?.id ?? "…") : "",
          onSelect: () => void pickModel(anchor, s.id),
        },
      ],
    },
  ]);
}

// --- image attachments ---------------------------------------------------------

function renderImageStrip(): void {
  imageStrip.classList.toggle("hidden", pendingImages.length === 0);
  imageStrip.classList.toggle("flex", pendingImages.length > 0);
  imageStrip.replaceChildren(
    ...pendingImages.map((img, i) => {
      const wrap = h("div", "relative");
      const thumb = document.createElement("img");
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      thumb.className = "h-16 w-16 rounded-md border border-neutral-200 object-cover";
      const remove = h(
        "button",
        "absolute -right-1.5 -top-1.5 h-4 w-4 cursor-pointer rounded-full bg-neutral-700 text-[10px] leading-none text-white hover:bg-red-600",
        "×",
      );
      remove.onclick = () => {
        pendingImages.splice(i, 1);
        renderImageStrip();
      };
      wrap.append(thumb, remove);
      return wrap;
    }),
  );
}

function addImageFile(file: File): void {
  if (!file.type.startsWith("image/") || pendingImages.length >= 8) return;
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result as string;
    pendingImages.push({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type });
    renderImageStrip();
  };
  reader.readAsDataURL(file);
}

/** Mirrors the agent seam's user-message text so reconcile can match on it. */
const imageMarker = (text: string, images: number): string =>
  images ? `${text}${text ? " " : ""}[${images} image${images > 1 ? "s" : ""}]` : text;

async function send(mode: "auto" | "steer"): Promise<void> {
  const text = input.value.trim();
  const images = pendingImages;
  if ((!text && images.length === 0) || !currentId) return;
  input.value = "";
  pendingImages = [];
  renderImageStrip();
  updateComposer();
  // Optimistic: an idle send (or a steer) reads as a user turn; a queued send
  // shows up in the queue panel via the queue-state snapshot instead.
  if (currentState === "idle" || mode === "steer") {
    optimisticUserTexts.push(imageMarker(text, images.length));
    const bubble = appendTurn("user", text);
    for (const img of images) {
      const thumb = document.createElement("img");
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      thumb.className = "mt-1.5 max-h-48 rounded-md";
      bubble.append(thumb);
    }
    scrollBottom(true);
  }
  await fetch(`/api/sessions/${currentId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mode, images: images.length ? images : undefined }),
  });
}

/** Promote the queue: steer into the running turn, or abort it and re-prompt. */
async function deliverQueue(mode: "steer" | "restart"): Promise<void> {
  if (!currentId) return;
  renderQueue([], []); // optimistic; queue-state snapshots reconcile
  const res = await fetch(`/api/sessions/${currentId}/queue/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) appendTurn("error", `queue ${mode} failed: ${res.status}`);
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
$("#open-archive").onclick = () => {
  archiveSearch.value = "";
  renderArchive();
  archiveDialog.showModal();
  archiveSearch.focus();
};
$("#archive-close").onclick = () => archiveDialog.close();
$("#version").textContent = `v${__PIER_VERSION__}`;
archiveSearch.oninput = () => renderArchive();
$<HTMLFormElement>("#new-form").onsubmit = async () => {
  const cwd = $<HTMLInputElement>("#new-cwd").value.trim();
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) {
    appendTurn("error", `session create failed: ${res.status}`);
    return;
  }
  const { id } = (await res.json()) as { id: string };
  // Insert into Projects immediately (the server pins web-created sessions);
  // waiting for Pi's list would leave the session invisible until turn one ends.
  fresh.set(id, { id, cwd, createdAt: Date.now(), state: "idle", pinned: true });
  await refreshSessions();
  await select(id);
  input.focus();
};
stopBtn.onclick = () =>
  currentId && fetch(`/api/sessions/${currentId}/abort`, { method: "POST" });
sendNowBtn.onclick = () => void send("steer");
$("#queue-steer").onclick = () => void deliverQueue("steer");
$("#queue-restart").onclick = () => void deliverQueue("restart");
$("#queue-recall").onclick = () => void recallQueue();
$<HTMLFormElement>("#composer").onsubmit = (ev) => {
  ev.preventDefault();
  void send("auto");
};
input.onkeydown = (ev) => {
  // IME guard: Enter that confirms a composition candidate must not send
  // (isComposing covers modern browsers; 229 covers stragglers).
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void send("auto");
  }
};
// Paste / drop / picker → pending image strip.
input.onpaste = (ev) => {
  for (const item of ev.clipboardData?.items ?? []) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    if (file) addImageFile(file);
  }
};
turnsPane.ondragover = (ev) => ev.preventDefault();
turnsPane.ondrop = (ev) => {
  ev.preventDefault();
  for (const file of ev.dataTransfer?.files ?? []) addImageFile(file);
};
$("#attach").onclick = () => attachInput.click();
attachInput.onchange = () => {
  for (const file of attachInput.files ?? []) addImageFile(file);
  attachInput.value = "";
};

connectWorkspace();
void refreshSessions().then(() => {
  const first = sessions.find((s) => s.pinned) ?? sessions[0];
  if (first) void select(first.id);
  else renderHeader();
});
updateComposer();
