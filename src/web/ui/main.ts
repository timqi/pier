// Workbench frontend orchestrator: session state, selection, and the SSE
// event streams. Rendering lives in the surface modules — sidebar.ts
// (projects + dialogs), chat.ts (turns pane), composer.ts (input, queue
// panel, attachments), session-header.ts (title + ⋯ menu), views.ts (Console
// views + routing) — wired here through explicit deps, never imports back.
// Interaction paths render optimistically and reconcile from the SSE stream.

import "./style.css";
// One formatter from core, at runtime: how a token count is spelled is the
// same question on every surface (session-header.ts asks it too).
import { compact as tokens } from "../../core/reply.js";
// Same reason: a header this deployment wrote is read back, not re-parsed here.
import { readableTitle, splitSpeaker } from "../../core/identity.js";
import { coalesce, getJson, mustGetJson, sendJson } from "./api.js";
import { guardFetch, streamDied } from "./auth.js";
import {
  appendDelta,
  appendSystemInput,
  appendTurn,
  chatLoading,
  completeTurn,
  finalizeStreaming,
  initChat,
  interruptTurn,
  renderSnapshot,
  resetChat,
  scrollBottom,
} from "./chat.js";
import {
  clearOptimistic,
  focusInput,
  initComposer,
  markOptimisticUser,
  reconcileOptimisticUser,
  renderQueue,
  renderRecovery,
  restoreDraft,
  saveDraft,
  send,
  updateComposer,
} from "./composer.js";
import { initPush } from "./notifications.js";
import { initReport } from "./report.js";
import {
  initHeader,
  noteTurnMeta,
  renderHeader,
  resetHeaderState,
  sessionInfo,
  sessionMenu,
  setHeaderPending,
  setHeaderState,
} from "./session-header.js";
import { closeDrawer, initShell } from "./shell.js";
import { initTheme } from "./theme.js";
import { initVersion } from "./version.js";
import { initSidebar, renderSessions, type SessionInfo } from "./sidebar.js";
import {
  activityThinking,
  activityToolEnd,
  activityToolStart,
  noteTurnError,
  renderBackgroundRun,
} from "./turn-activity.js";
import {
  applyRoute,
  initViews,
  isChatVisible,
  refreshActivity,
  refreshTasks,
  refreshRuns,
  setSessionHash,
  showChat,
  showConsole,
  showFiles,
  showRun,
  syncBar,
  toggleFiles,
} from "./views.js";
// Type-only import of the seam contract — erased at build, keeps the wire
// shapes single-sourced in core/types.ts instead of hand-copied here.
import type {
  BackgroundRun,
  ChatTurn,
  ContextUsage,
  ModelRef,
  QueueRecovery,
  SessionEvent,
  SessionState,
  ThinkingLevel,
  WorkspaceEvent,
} from "../../core/types.js";

/** GET /api/sessions/:id/history — the snapshot every delta is applied onto. */
interface SessionSnapshot {
  turns: ChatTurn[];
  lastSeq: number;
  epoch: string;
  model: ModelRef | null;
  state: SessionState;
  context: ContextUsage | null;
  thinkingLevel: ThinkingLevel;
  queue: { steering: string[]; followUp: string[] };
  queueRecovery: QueueRecovery[];
  queueUncertain: boolean;
  backgroundRuns: BackgroundRun[];
}

declare const __PIER_VERSION__: string; // injected by vite.config.ts

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let selectionSeq = 0;
let loadSeq = 0;
let loading = false;
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let turnOpen = false;
// A session posted to Pi whose id hasn't come back: the pane is already its
// own (createSession), so the header and the composer say it isn't ready yet.
let starting = false;

// --- sessions --------------------------------------------------------------------

async function createSession(cwd: string): Promise<void> {
  const seq = ++selectionSeq;
  ++loadSeq;
  loading = false;
  // Opening a session in Pi costs a round trip long enough to look ignored —
  // the dialog closes and the *previous* session stays on screen. So the pane
  // becomes the new session's before the POST is sent: skeleton, the title an
  // untitled session will keep anyway, and no current id — a prompt typed
  // during the wait must not be sent to the session being left.
  showChat();
  closeDrawer();
  currentId = null;
  source?.close();
  source = null;
  resetChat();
  renderRecovery([]);
  resetHeaderState();
  setHeaderPending(cwd);
  chatLoading(true);
  starting = true;
  updateComposer();
  const res = await sendJson("/api/sessions", { cwd });
  if (seq !== selectionSeq) return;
  starting = false;
  if (!res.ok) {
    chatLoading(false);
    setHeaderPending(null);
    updateComposer();
    appendTurn("error", `session create failed: ${res.status}`);
    return;
  }
  const { id } = (await res.json()) as { id: string };
  if (seq !== selectionSeq) return;
  // The row is known here and the POST already broadcast `sessions-changed`,
  // so it is rendered now and the workspace stream's own refresh reconciles it
  // — selecting must not wait for a full listing (principle 7).
  sessions.unshift({
    id, cwd, createdAt: Date.now(), state: "idle", unread: false, channel: "web",
    activeRuns: 0,
  });
  await select(id); // renders the rail and the header with the row above
  if (currentId === id) focusInput();
}

/** Every session Pi knows, so it replaces the list. */
function commitSessions(rows: SessionInfo[]): void {
  // A title read off an IM prompt still carries its speaker header: every
  // surface downstream reads `title`, so it is made readable once, here.
  sessions = rows.map((s) => ({ ...s, title: readableTitle(s.title) }));
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
  maybeAckRead();
}

// Thrown, not swallowed: this runs as `void refreshSessions()` from event
// handlers, and report.ts is listening for exactly that rejection — a rail
// that quietly stopped updating is the shape of bug 5b is about.
const refreshSessions = coalesce(async () => {
  commitSessions(await mustGetJson<SessionInfo[]>("/api/sessions", "Could not load sessions"));
});

/** Seen = read: the selected session's chat is on screen in a *focused*
 *  window. The ack clears the server-side unread mark, and the resulting
 *  broadcast moves every other client's dot back too. Optimistic locally — the
 *  dot must not stay amber while the user is literally looking at the turn.
 *
 *  Focus, not just visibility: an installed workbench left open behind another
 *  app is still `document.hidden === false` on macOS, so visibility alone
 *  claimed every finished turn had been read and the push that should have
 *  followed (web/push.ts) was suppressed by a window nobody was looking at. */
function maybeAckRead(): void {
  if (document.hidden || !document.hasFocus() || !isChatVisible()) return;
  const s = sessions.find((x) => x.id === currentId);
  if (!s?.unread) return;
  s.unread = false;
  renderSessions();
  void fetch(`/api/sessions/${s.id}/read`, { method: "POST" });
}

/** The selected session's persisted summary, when it exists. */
function currentSession(): SessionInfo | undefined {
  return sessions.find((s) => s.id === currentId);
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
      // The event carries core/identity.ts's speaker header; the ledger holds
      // what was typed, and a session name is not a timestamp. Only the turn
      // itself keeps the header — chat.ts renders it as the row's caption.
      const typed = splitSpeaker(e.text).text;
      maybeSetTitle(e.sessionId, typed); // first prompt names the session
      // Already on screen from our own optimistic render? Just reconcile.
      if (reconcileOptimisticUser(typed)) break;
      finalizeStreaming(); // a delivered queue message ends the text block
      appendTurn("user", e.text, false, e.ts);
      scrollBottom();
      break;
    }
    case "text-start":
      finalizeStreaming();
      break;
    case "text-delta":
      appendDelta(e.text);
      break;
    case "thinking-delta":
      finalizeStreaming(); // new reasoning makes the preceding text an update
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
      // meta carries the context size and the completion time — keep both live.
      if (e.meta) noteTurnMeta(e.meta);
      break;
    case "queue-state":
      renderQueue(e.steering, e.followUp);
      break;
    case "queue-recovery":
      renderRecovery(e.batches, e.uncertain);
      break;
    case "context-compacted":
      // The transcript keeps no trace of a compaction, so this line is the
      // only place the button's effect — or an automatic one — is ever seen.
      finalizeStreaming();
      appendTurn("system", `Context compacted — ${tokens(e.before)} → ${tokens(e.after)}`, false, e.ts);
      scrollBottom();
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
  src.onerror = () => streamDied(src, "Workspace");
  src.onmessage = (m) => {
    const e = JSON.parse(m.data) as WorkspaceEvent;
    if (e.type === "sessions-changed") {
      void refreshSessions();
      return;
    }
    if (e.type === "tasks-changed" || e.type === "task-run-changed" || e.type === "task-message-changed" || e.type === "task-group-changed") {
      refreshTasks(e.type === "task-run-changed" ? e.taskId : undefined);
      refreshRuns();
      refreshActivity();
      // A run starting or settling changes its launcher's activeRuns dot.
      if (e.type === "task-run-changed") void refreshSessions();
      return;
    }
    refreshActivity();
    // The selected session's own stream already drives composer state.
    if (e.sessionId === currentId) return;
    const s = sessions.find((x) => x.id === e.sessionId);
    if (!s) return;
    s.state = e.state;
    renderSessions();
  };
}

function connect(id: string, cursor: string, generation: number): void {
  source?.close();
  const stream = new EventSource(`/api/sessions/${id}/events?after=${cursor}`);
  const current = (): boolean => source === stream && currentId === id && generation === loadSeq;
  stream.onmessage = (m) => {
    if (current()) handleEvent(JSON.parse(m.data) as SessionEvent);
  };
  stream.addEventListener("reset", () => {
    if (current()) void loadSession(id);
  });
  stream.onerror = () => {
    if (current()) streamDied(stream, "Session");
  };
  source = stream;
}

// --- selection --------------------------------------------------------------------

async function select(id: string): Promise<void> {
  // The pane opens before anything is fetched. A session named from Activity or
  // Runs is usually not in the list at all — a task run's own session is not
  // a row — and the snapshot is what says whether the id exists: its 404
  // carries the reason (ui/api.ts), so nothing is decided here first.
  showChat();
  closeDrawer(); // on mobile the drawer is how you got here
  setSessionHash(id);
  if (id === currentId && (source || loading)) return;
  ++selectionSeq; // a create in flight is abandoned; its answer must not land here
  ++loadSeq;
  starting = false;
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
  if (currentId !== id) return;
  const generation = ++loadSeq;
  source?.close();
  source = null;
  loading = true;
  resetChat();
  renderQueue([], []);
  renderRecovery([]);
  resetHeaderState();
  turnOpen = false;
  clearOptimistic();
  lastSeq = 0;
  // Painted before the fetch: a long transcript takes a moment to arrive and
  // render, and until then the pane would look like an empty session.
  chatLoading(true);
  const got = await getJson<SessionSnapshot>(`/api/sessions/${id}/history`, "failed to load session");
  if (currentId !== id || generation !== loadSeq) return;
  loading = false;
  if (!got.ok) {
    chatLoading(false);
    appendTurn("error", got.error);
    return;
  }
  const snap = got.value;
  renderSnapshot(snap.turns, snap.state, snap.backgroundRuns);
  lastSeq = snap.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp);
  renderRecovery(snap.queueRecovery, snap.queueUncertain);
  // meta is assistant-only (core/types.ts), so the last one that carries it is
  // the last reply — no role test, and none of Array#findLast (web target).
  const lastReply = snap.turns.reduce<number | null>((at, t) => t.meta?.completedAt ?? at, null);
  setHeaderState(snap.model, snap.context, snap.thinkingLevel, lastReply);
  connect(id, `${snap.epoch}:${snap.lastSeq}`, generation);
}

// --- wiring ----------------------------------------------------------------------------

// First, before any surface can issue a request: from here on a 401 is the
// login page and not a per-caller error message, and anything that throws on
// the way reaches the server's log instead of only the browser console.
initReport();
guardFetch();
initTheme();

/** Shared by chat + composer deps: reload only if `id` is still selected. */
const reloadIfCurrent = async (id: string): Promise<void> => {
  if (currentId === id) await loadSession(id);
};

initChat({
  sessionId: () => currentId,
  sessionState: () => currentState,
  select: (id) => void select(id),
  showRun,
  send: (mode, label) => void send(mode, label),
  ownTurn: (text) => {
    markOptimisticUser(text);
    setState("streaming"); // an edit resend starts a turn; the buttons say so now
  },
  reload: reloadIfCurrent,
});
initComposer({
  sessionId: () => currentId,
  starting: () => starting,
  sessionState: () => currentState,
  chatVisible: isChatVisible,
  setState,
  reload: reloadIfCurrent,
});
initShell({
  sessionMenu: (anchor) => {
    const s = currentSession();
    if (s) sessionMenu(anchor, s);
  },
  sessionInfo: (anchor) => {
    const s = currentSession();
    if (s) sessionInfo(anchor, s);
  },
});
initSidebar({
  sessions: () => sessions,
  loadSessions: refreshSessions,
  currentId: () => currentId,
  select: (id) => void select(id),
  sessionMenu,
  createSession,
  openConsole: showConsole,
  onTitleChanged: renderHeader,
});
initHeader({
  currentId: () => currentId,
  currentSession,
  createSession: (cwd) => void createSession(cwd),
  syncBar,
  openFiles: showFiles,
  toggleFiles,
});
initViews({
  sessions: () => sessions,
  loadSessions: refreshSessions,
  currentId: () => currentId,
  currentSession,
  select: (id) => void select(id),
  maybeAckRead,
});

initVersion(__PIER_VERSION__);
// Also what makes Pier installable and what answers a navigation with the
// network gone; the notification permission is asked for in Settings, never here.
void initPush();

// The last of the three saying "the workbench does not zoom" (index.html,
// style.css): on a pinch, Safari's own gesture events overrule both.
document.addEventListener("gesturestart", (ev) => ev.preventDefault());

// Coming back to a hidden tab — or to an unfocused window — is the other way
// turns get seen.
document.addEventListener("visibilitychange", maybeAckRead);
window.addEventListener("focus", maybeAckRead);

connectWorkspace();
void refreshSessions().then(applyRoute);
