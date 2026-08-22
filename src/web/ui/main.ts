// Workbench frontend orchestrator: session state, the SSE event streams,
// routing, and the chat header. Rendering lives in the surface modules —
// sidebar.ts (projects + dialogs), chat.ts (turns pane), composer.ts (input,
// queue panel, images) — wired here through explicit deps, never imports back.
// Interaction paths render optimistically and reconcile from the SSE stream.

import "./style.css";
import { createActivityView } from "./activity.js";
import {
  appendAssistant,
  appendDelta,
  appendSystemInput,
  appendTurn,
  activityThinking,
  activityToolEnd,
  activityToolStart,
  completeTurn,
  copyBtn,
  finalizeStreaming,
  imageRow,
  imageThumb,
  initChat,
  interruptTurn,
  noteTurnError,
  renderBackgroundRun,
  replayActivity,
  resetChat,
  scrollBottom,
  turnsPane,
} from "./chat.js";
import {
  clearOptimistic,
  focusInput,
  initComposer,
  reconcileOptimisticUser,
  renderQueue,
  restoreDraft,
  saveDraft,
  send,
  syncQueuePanel,
  updateComposer,
} from "./composer.js";
import { createChannelsView } from "./channels.js";
import { compact } from "../../core/reply.js";
import { createBoardsView } from "./boards.js";
import { createConfigView } from "./config.js";
import { $, h } from "./dom.js";
import { closeMenu, openMenu, openPanel } from "./menu.js";
import { modelPicker } from "./model-picker.js";
import { initNotify, noteState } from "./notify.js";
import { closeDrawer, initShell, setBarTitle } from "./shell.js";
import { groupByCwd, initSidebar, renderSessions, setPinned, type SessionInfo } from "./sidebar.js";
import { createTasksView } from "./tasks.js";
// Type-only import of the seam contract — erased at build, keeps the wire
// shapes single-sourced in core/types.ts instead of hand-copied here.
import type {
  BackgroundRun,
  ChatTurn,
  ContextUsage,
  ModelRef,
  SessionEvent,
  SessionState,
  ThinkingLevel,
  WorkspaceEvent,
} from "../../core/types.js";

/** GET /api/sessions/:id/history — the snapshot every delta is applied onto. */
interface SessionSnapshot {
  turns: ChatTurn[];
  lastSeq: number;
  model: ModelRef | null;
  state: SessionState;
  context: ContextUsage | null;
  thinkingLevel: ThinkingLevel;
  queue: { steering: string[]; followUp: string[] };
  backgroundRuns: BackgroundRun[];
}

interface ThinkingResponse {
  level: ThinkingLevel;
  levels: ThinkingLevel[];
}

declare const __PIER_VERSION__: string; // injected by vite.config.ts

// --- static elements ---------------------------------------------------------

const chatHeader = $("#chat-header");
const composerForm = $<HTMLFormElement>("#composer");
const consoleSection = $<HTMLDetailsElement>("#console-section");
const openActivityBtn = $("#open-activity");
const openConfigBtn = $("#open-config");
const openChannelsBtn = $("#open-channels");
const openBoardsBtn = $("#open-boards");
const chatTitle = $("#chat-title");
const chatMenu = $("#chat-menu");
const sessionMeta = $("#session-meta");

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let currentId: string | null = null;
let currentState: SessionState = "idle";
let chatVisible = true;
let source: EventSource | null = null;
let lastSeq = 0;
let turnOpen = false;

// --- sessions --------------------------------------------------------------------

async function createSession(cwd: string): Promise<void> {
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
  await refreshSessions();
  await select(id);
  focusInput();
}

async function refreshSessions(): Promise<void> {
  sessions = (await (await fetch("/api/sessions")).json()) as SessionInfo[];
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
  maybeAckRead();
}

/** Seen = read: the selected session's chat is on screen in a visible tab.
 *  The ack clears the server-side unread mark, and the resulting broadcast
 *  moves every other client's dot back too. Optimistic locally — the dot
 *  must not stay amber while the user is literally looking at the turn. */
function maybeAckRead(): void {
  if (document.hidden || !chatVisible) return;
  const s = sessions.find((x) => x.id === currentId);
  if (!s?.unread) return;
  s.unread = false;
  renderSessions();
  void fetch(`/api/sessions/${s.id}/read`, { method: "POST" });
}

// --- chat header -----------------------------------------------------------------

/** The listed session, or a stub for one Pi hasn't persisted yet — a fresh
 *  session must have a working ⋯ menu (info, pin, model) from turn zero. */
function currentSession(): SessionInfo | undefined {
  return (
    sessions.find((x) => x.id === currentId) ??
    (currentId
      ? { id: currentId, cwd: "—", createdAt: Date.now(), state: currentState, pinned: false, unread: false, activeRuns: 0 }
      : undefined)
  );
}

function renderHeader(): void {
  const s = currentSession();
  chatTitle.textContent = s ? (s.title ?? "Untitled session") : "no session";
  chatMenu.classList.toggle("hidden", !s);
  // Everything per-session (info, pin, model) lives in the ⋯ menu.
  if (s) chatMenu.onclick = () => sessionMenu(chatMenu, s);
  renderSessionMeta();
  syncBar();
}

/** Percent of the context window used (capped at 100). */
const contextUsed = (tokens: number, u: ContextUsage): number =>
  Math.min(100, Math.round((tokens / u.contextWindow) * 100));

/** Full context reading, shared by the meta chip's hover and the info panel. */
const contextLabel = (u: ContextUsage): string =>
  u.tokens === null
    ? `?/${compact(u.contextWindow)}`
    : `${compact(u.tokens)}/${compact(u.contextWindow)} · ${100 - contextUsed(u.tokens, u)}% left`;

/** Title-row meta: the resident chip shows bare token usage ("12K tok",
 *  quiet → amber ≥ 70% used → red ≥ 90%); hover swaps in the full headroom
 *  reading and unfolds model + reasoning chips. Before the first usage
 *  report the model chip stands in as the resident hover target. An untitled
 *  session has no title to read, so it starts unfolded — the chips are then
 *  the only thing identifying it. */
function renderSessionMeta(): void {
  const chip = (tag: string, cls: string, text: string): HTMLElement =>
    h(tag, `flex-none rounded px-1.5 py-px font-mono ${cls}`, text);
  const u = currentContext;
  const tokens = u?.tokens ?? null;
  const id = currentId;
  const untitled = !sessions.find((x) => x.id === id)?.title;
  const onHover = untitled ? "" : "hidden group-hover:inline";
  const chips: HTMLElement[] = [];
  if (currentModel && id) {
    // Also the shortest path to switching models.
    const model = chip(
      "button",
      `${tokens === null ? "" : onHover} cursor-pointer bg-indigo-50 font-medium text-indigo-700 hover:bg-indigo-100`,
      currentModel.id,
    );
    model.title = "Change model";
    model.onclick = () => void pickModel(model, id);
    chips.push(model);
  }
  if (currentThinking && currentThinking !== "off") {
    chips.push(chip("span", `${onHover} bg-neutral-100 text-neutral-500`, `reasoning ${currentThinking}`));
  }
  if (u && tokens !== null) {
    const used = contextUsed(tokens, u);
    const tone =
      used >= 90
        ? "bg-red-50 text-red-700"
        : used >= 70
          ? "bg-amber-50 text-amber-700"
          : "bg-neutral-100 text-neutral-500";
    const ctx = chip("span", tone, "");
    if (untitled) ctx.textContent = contextLabel(u);
    else
      ctx.append(
        h("span", "group-hover:hidden", `${compact(tokens)} tok`),
        h("span", onHover, contextLabel(u)),
      );
    chips.push(ctx);
  }
  sessionMeta.replaceChildren(...chips);
  sessionMeta.classList.toggle("hidden", chips.length === 0);
  sessionMeta.classList.toggle("flex", chips.length > 0);
}

/** First prompt titles the session optimistically — the server list, which
 *  only updates once Pi persists the session, reconciles it later. */
function maybeSetTitle(id: string, text: string): void {
  const s = sessions.find((x) => x.id === id);
  if (!s || s.title || !text.trim()) return;
  s.title = text.trim().slice(0, 80);
  renderSessions();
  renderHeader();
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

// --- event handling ----------------------------------------------------------------

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  switch (e.type) {
    case "turn-start":
      turnOpen = true;
      break;
    case "system-input":
      finalizeStreaming();
      appendSystemInput(e.text, e.origin);
      break;
    case "task-status":
      renderBackgroundRun(e.run);
      break;
    case "user-message": {
      maybeSetTitle(e.sessionId, e.text); // first prompt names the session
      // Already on screen from our own optimistic render? Just reconcile.
      if (reconcileOptimisticUser(e.text)) break;
      finalizeStreaming(); // a delivered queue message ends the text block
      appendTurn("user", e.text);
      scrollBottom();
      break;
    }
    case "text-delta":
      appendDelta(e.text);
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
      completeTurn(e.text, e.meta);
      // meta.tokens is the context size at completion — keep the meta line live.
      if (e.meta && currentContext) {
        currentContext = { ...currentContext, tokens: e.meta.tokens };
        renderSessionMeta();
      }
      break;
    case "queue-state":
      renderQueue(e.steering, e.followUp);
      break;
    case "error":
      noteTurnError();
      appendTurn("error", e.message);
      break;
    case "state":
      if (e.state === "idle" && turnOpen) {
        // idle without a turn-end: the run was aborted
        turnOpen = false;
        interruptTurn();
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
    if (e.type === "tasks-changed" || e.type === "task-run-changed" || e.type === "task-message-changed" || e.type === "task-group-changed") {
      tasksView.refresh(e.type === "task-run-changed" ? e.taskId : undefined);
      activityView.refresh();
      // A run starting or settling changes its launcher's activeRuns dot.
      if (e.type === "task-run-changed") void refreshSessions();
      return;
    }
    activityView.refresh();
    // Every session, selected or not: a finished turn is worth a notification
    // wherever it ran.
    noteState(e.sessionId, e.state);
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

// --- view switching (chat ↔ Console views) -----------------------------------
// Console views hide chat elements but leave session SSE wiring untouched.

const chatEls = [chatHeader, turnsPane, composerForm];
const configView = createConfigView($("#config-view"), () =>
  [...groupByCwd(sessions).keys()],
);
const tasksView = createTasksView(
  $("#tasks-view"),
  () => sessions.map(({ id, cwd, title }) => ({ id, cwd, title })),
  (id) => void select(id),
  () => currentId,
  (arg) => showConsole("activity", arg),
);
const activityView = createActivityView(
  $("#activity-view"),
  (id) => void select(id),
  (taskId) => showTasks(taskId),
);

const channelsView = createChannelsView($("#channels-view"));

const boardsView = createBoardsView($("#boards-view"), (id) => void select(id));

type ConsoleName = "config" | "channels" | "tasks" | "activity" | "boards";

const consoleViews: {
  name: ConsoleName;
  view: { show(arg?: string): void; hide(): void; visible: boolean };
}[] = [
  { name: "config", view: configView },
  { name: "channels", view: channelsView },
  { name: "tasks", view: tasksView },
  { name: "activity", view: activityView },
  { name: "boards", view: boardsView },
];

const consoleBtns = [openConfigBtn, openChannelsBtn, openActivityBtn, openBoardsBtn];

// The Activity menu item reopens whichever of its views (Activity or Tasks)
// was showing last; the views themselves keep their tab/selection state.
let lastActivityConsole: ConsoleName = "activity";

const CONSOLE_LABELS: Record<ConsoleName, string> = {
  config: "Configuration",
  channels: "Channels",
  tasks: "Tasks",
  activity: "Activity",
  boards: "Boards",
};

/** Mobile top bar mirrors the route: a Console view's name, or the chat title
 *  plus its ⋯ menu (the chat header itself is hidden below md). */
function syncBar(): void {
  const open = consoleViews.find((entry) => entry.view.visible);
  if (open) setBarTitle(CONSOLE_LABELS[open.name], false);
  else setBarTitle(chatTitle.textContent ?? "", currentSession() !== undefined);
}

function showConsole(name: ConsoleName, arg?: string): void {
  if (name === "tasks" || name === "activity") lastActivityConsole = name;
  setHash({ kind: "console", name, arg });
  closeDrawer();
  chatVisible = false;
  for (const el of chatEls) el.classList.add("hidden");
  syncQueuePanel();
  for (const entry of consoleViews) {
    if (entry.name === name) entry.view.show(arg);
    else entry.view.hide();
  }
  // Tasks lives under the Activity menu item (tab strip inside the views).
  openConfigBtn.classList.toggle("bg-indigo-50", name === "config");
  openChannelsBtn.classList.toggle("bg-indigo-50", name === "channels");
  openBoardsBtn.classList.toggle("bg-indigo-50", name === "boards");
  openActivityBtn.classList.toggle("bg-indigo-50", name === "tasks" || name === "activity");
  syncBar();
}

const showTasks = (taskId?: string): void => showConsole("tasks", taskId);

function showChat(): void {
  if (!consoleViews.some(({ view }) => view.visible)) return;
  for (const { view } of consoleViews) view.hide();
  for (const btn of consoleBtns) btn.classList.remove("bg-indigo-50");
  chatVisible = true;
  for (const el of chatEls) el.classList.remove("hidden");
  syncQueuePanel();
  syncBar();
  maybeAckRead(); // the selected session's turns just came (back) on screen
}

// --- routing (the hash is the address bar's copy of "where am I") ---------------------
// Every view is addressable — a session's chat, each Console view, one task
// inside it — so refresh, bookmarks and back/forward land where the user was.
// Hash, not path: the static file server stays a static file server.

type Route = { kind: "session"; id: string } | { kind: "console"; name: ConsoleName; arg?: string };

const hashOf = (r: Route): string =>
  r.kind === "session"
    ? `#/session/${encodeURIComponent(r.id)}`
    : `#/${r.name}${r.arg ? `/${encodeURIComponent(r.arg)}` : ""}`;

function parseHash(): Route | null {
  const [head = "", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const name = consoleViews.find((v) => v.name === head)?.name;
  if (name) return { kind: "console", name, arg: arg ? decodeURIComponent(arg) : undefined };
  if (head === "session" && arg) return { kind: "session", id: decodeURIComponent(arg) };
  return null; // unknown or empty → the fallback in applyRoute()
}

// While a route is applied the UI must not rewrite the hash it is reading; the
// guard spans only the synchronous view switch, never the history fetch.
let applyingRoute = false;

function setHash(r: Route, replace = false): void {
  if (applyingRoute) return;
  const next = hashOf(r);
  if (location.hash === next) return;
  if (replace) history.replaceState(null, "", next);
  else location.hash = next; // pushes an entry, so Back returns to the last view
}

/** Hash → UI. A missing or stale route falls back to the first pinned session. */
function applyRoute(): void {
  const route = parseHash();
  const wanted = route?.kind === "session" ? route.id : null;
  const id =
    wanted && sessions.some((s) => s.id === wanted)
      ? wanted
      : (currentId ?? (sessions.find((s) => s.pinned) ?? sessions[0])?.id ?? null);
  applyingRoute = true;
  try {
    if (id && id !== currentId) void select(id);
    if (route?.kind === "console") showConsole(route.name, route.arg);
    else showChat();
    if (!id) renderHeader();
  } finally {
    applyingRoute = false;
  }
  // Boot with no hash, or a session that no longer exists: name where we landed
  // without adding a history entry.
  if (route?.kind !== "console" && id) setHash({ kind: "session", id }, true);
}

// --- selection --------------------------------------------------------------------

async function select(id: string): Promise<void> {
  showChat();
  closeDrawer(); // on mobile the drawer is how you got here
  setHash({ kind: "session", id });
  if (id === currentId) return;
  saveDraft(); // the outgoing session keeps its unsent text
  currentId = id;
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  restoreDraft(id);
  renderSessions();
  renderHeader();
  maybeAckRead(); // selecting an unread session is looking at it
  await loadSession(id);
}

/** (Re)load the current session's snapshot and reconnect its event stream. */
async function loadSession(id: string): Promise<void> {
  source?.close();
  resetChat();
  renderQueue([], []);
  currentModel = null;
  currentContext = null;
  currentThinking = null;
  renderSessionMeta();
  turnOpen = false;
  clearOptimistic();
  lastSeq = 0;
  const res = await fetch(`/api/sessions/${id}/history`);
  const snap = res.ok ? ((await res.json()) as SessionSnapshot) : null;
  if (currentId !== id) return; // stale: the user switched again mid-fetch
  if (!snap) {
    appendTurn("error", `failed to load session: ${res.status}`);
    return;
  }
  // Detached run cards are placed where their result entered the conversation,
  // not at the end of the transcript: a reload must not sweep every card a
  // session ever launched to the bottom, below turns that came after it.
  const unplacedRuns = new Map(snap.backgroundRuns.map((run) => [run.runId, run]));
  // The final assistant turn keeps its next-step buttons across reloads and
  // on every client — an idle session is still waiting on exactly that choice.
  const lastAssistant = snap.turns.reduce((acc, t, i) => (t.role === "assistant" ? i : acc), -1);
  for (const [i, t] of snap.turns.entries()) {
    // The in-flight turn is the trailing one, recognisable while streaming by a
    // tool call without a result or by activity with no answer yet.
    const live =
      snap.state === "streaming" &&
      i === snap.turns.length - 1 &&
      (!t.text || (t.steps?.some((s) => s.kind === "tool" && s.output === undefined) ?? false));
    if (t.steps?.length) replayActivity(t.steps, t.meta?.durationMs, live);
    if (!t.text && !t.images?.length) continue;
    if (t.role === "system" && t.origin) {
      // A callback names every run it delivers (batched ones carry `runIds`).
      const delivered = t.origin.kind === "task-message" ? [t.origin.runId] : (t.origin.runIds ?? [t.origin.runId]);
      for (const runId of delivered) {
        const run = unplacedRuns.get(runId);
        if (!run) continue;
        renderBackgroundRun(run);
        unplacedRuns.delete(runId);
      }
      appendSystemInput(t.text, t.origin);
      continue;
    }
    // meta is assistant-only (core/types.ts), so plain turns need no hint.
    const bubble =
      t.role === "assistant"
        ? appendAssistant(t.text, t.meta, snap.state === "idle" && i === lastAssistant)
        : appendTurn(t.role, t.text);
    // Refs only in the snapshot: each thumbnail pulls its own bytes.
    for (const img of t.images ?? []) {
      imageRow(bubble).append(imageThumb(`/api/sessions/${id}/images/${img.ordinal}`));
    }
  }
  // Whatever is left never reported back — still queued or running, so the
  // bottom is where it belongs.
  for (const run of unplacedRuns.values()) renderBackgroundRun(run);
  scrollBottom(true);
  lastSeq = snap.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp);
  currentModel = snap.model;
  currentContext = snap.context;
  currentThinking = snap.thinkingLevel;
  renderHeader();
  connect(id, snap.lastSeq);
}

// --- session context menu (pin + model) -------------------------------------------------
// Same menu from the chat header and from a project row's ⋯ button.

/** Model + context usage of the *current* session (from its snapshot). */
let currentModel: ModelRef | null = null;
let currentContext: ContextUsage | null = null;
let currentThinking: ThinkingLevel | null = null;

/** Read-only details panel: what this session is and how full its context is. */
function sessionInfo(anchor: HTMLElement, s: SessionInfo): void {
  const rows: [string, string][] = [
    ["Title", s.title ?? "untitled"],
    ["Directory", s.cwd],
    ["Session", s.id],
  ];
  if (s.id === currentId) {
    rows.push(["Model", currentModel?.id ?? "—"]);
    rows.push(["Context", currentContext ? contextLabel(currentContext) : "—"]);
  }
  const panel = h("div", "flex max-w-80 flex-col gap-1.5 px-3 py-2");
  for (const [label, value] of rows) {
    const row = h("div", "group flex flex-col");
    // Every field is copyable — cheaper than deciding which ones deserve it.
    const head = h("div", "flex items-center gap-1.5");
    head.append(
      h("span", "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", label),
      copyBtn(
        "cursor-pointer text-[10.5px] uppercase tracking-wide text-neutral-400 opacity-0 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
        () => value,
      ),
    );
    row.append(head, h("span", "break-all font-mono text-[12px] text-neutral-700", value));
    panel.append(row);
  }
  openPanel(anchor, panel);
}

async function pickModel(anchor: HTMLElement, id: string): Promise<void> {
  const [modelsRes, thinkingRes] = await Promise.all([
    fetch(`/api/sessions/${id}/models`),
    fetch(`/api/sessions/${id}/thinking`),
  ]);
  if (!modelsRes.ok || !thinkingRes.ok) return;
  const models = (await modelsRes.json()) as ModelRef[];
  const thinking = (await thinkingRes.json()) as ThinkingResponse;
  openPanel(
    anchor,
    modelPicker({
      models,
      current: id === currentId ? currentModel : null,
      thinkingLevel: thinking.level,
      thinkingLevels: thinking.levels,
      onPick: (m, thinking) => {
        closeMenu();
        void applyModel(id, m, thinking);
      },
      onThinkingPick: (level) => void setThinkingLevel(id, level),
    }),
  );
}

/** Model, then reasoning — in that order and only on success, because which
 *  levels exist depends on the model (Pi clamps an unsupported one). */
async function applyModel(id: string, model: ModelRef, thinking?: ThinkingLevel): Promise<void> {
  if (!(await setModel(id, model))) return;
  if (thinking) await setThinkingLevel(id, thinking);
}

async function setModel(id: string, model: ModelRef): Promise<boolean> {
  const previous = currentModel;
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
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    if (id === currentId) {
      currentModel = previous; // the optimistic chip was a lie; take it back
      renderHeader();
    }
    appendTurn("error", `model change failed: ${error ?? res.status}`);
    return false;
  }
  const { model: applied } = (await res.json()) as { model: ModelRef | null };
  if (id === currentId && applied) {
    currentModel = applied;
    renderHeader();
  }
  return true;
}

/** Pi clamps an unsupported level, so the response — not the request — is
 *  what the header reports. */
async function setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/thinking`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level }),
  });
  if (!res.ok) {
    appendTurn("error", `reasoning change failed: ${res.status}`);
    return;
  }
  const { level: applied } = (await res.json()) as { level: ThinkingLevel };
  if (id === currentId) {
    currentThinking = applied;
    renderSessionMeta();
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

// --- wiring ----------------------------------------------------------------------------

/** Shared by chat + composer deps: reload only if `id` is still selected. */
const reloadIfCurrent = async (id: string): Promise<void> => {
  if (currentId === id) await loadSession(id);
};

initChat({
  sessionId: () => currentId,
  sessionState: () => currentState,
  select: (id) => void select(id),
  showTasks,
  send: (mode, label) => void send(mode, label),
  reload: reloadIfCurrent,
});
initComposer({
  sessionId: () => currentId,
  sessionState: () => currentState,
  chatVisible: () => chatVisible,
  setState,
  reload: reloadIfCurrent,
});
initShell({
  sessionMenu: (anchor) => {
    const s = currentSession();
    if (s) sessionMenu(anchor, s);
  },
});
initNotify((id) => sessions.find((s) => s.id === id)?.title ?? "Untitled session");
initSidebar({
  sessions: () => sessions,
  currentId: () => currentId,
  select: (id) => void select(id),
  sessionMenu,
  createSession,
  onPinsChanged: renderHeader,
});

openActivityBtn.onclick = () => showConsole(lastActivityConsole);
openConfigBtn.onclick = () => showConsole("config");
openChannelsBtn.onclick = () => showConsole("channels");
openBoardsBtn.onclick = () => showConsole("boards");
consoleSection.open = localStorage.getItem("pier.consoleCollapsed") !== "1";
consoleSection.ontoggle = () =>
  localStorage.setItem("pier.consoleCollapsed", consoleSection.open ? "0" : "1");
$("#version").textContent = `v${__PIER_VERSION__}`;

// Coming back to a hidden tab is the other way turns get seen.
document.addEventListener("visibilitychange", maybeAckRead);

connectWorkspace();
window.onhashchange = applyRoute; // Back/forward and hand-edited URLs
void refreshSessions().then(applyRoute);
