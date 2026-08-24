// Workbench frontend orchestrator: session state, selection, and the SSE
// event streams. Rendering lives in the surface modules — sidebar.ts
// (projects + dialogs), chat.ts (turns pane), composer.ts (input, queue
// panel, attachments), session-header.ts (title + ⋯ menu), views.ts (Console
// views + routing) — wired here through explicit deps, never imports back.
// Interaction paths render optimistically and reconcile from the SSE stream.

import "./style.css";
import { sendJson } from "./api.js";
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
  restoreDraft,
  saveDraft,
  send,
  updateComposer,
} from "./composer.js";
import { initReport } from "./report.js";
import {
  initHeader,
  noteContextTokens,
  renderHeader,
  resetHeaderState,
  sessionMenu,
  setHeaderState,
} from "./session-header.js";
import { closeDrawer, initShell } from "./shell.js";
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
  setSessionHash,
  showChat,
  showConsole,
  showFiles,
  showTasks,
  showTerminal,
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

declare const __PIER_VERSION__: string; // injected by vite.config.ts

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
let selectionSeq = 0;
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let turnOpen = false;

// --- sessions --------------------------------------------------------------------

async function createSession(cwd: string): Promise<void> {
  const res = await sendJson("/api/sessions", { cwd });
  if (!res.ok) {
    appendTurn("error", `session create failed: ${res.status}`);
    return;
  }
  const { id } = (await res.json()) as { id: string };
  await refreshProjects();
  await select(id);
  focusInput();
}

/** `complete` = every session Pi knows, so it replaces the list. A Projects
 *  read speaks only for the pinned ones and merges instead: dropping the rest
 *  would delete the current session out from under its own chat the moment it
 *  is unpinned — header, ⋯ menu and its Pin row with it. */
function commitSessions(next: SessionInfo[], complete: boolean): void {
  if (complete) {
    sessions = next;
  } else {
    const fresh = new Map(next.map((s) => [s.id, s]));
    sessions = sessions.map((s) => fresh.get(s.id) ?? (s.pinned ? { ...s, pinned: false } : s));
    const known = new Set(sessions.map((s) => s.id));
    sessions.push(...next.filter((s) => !known.has(s.id)));
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
  maybeAckRead();
}

/** One list request in flight at a time; anything asked for during one runs
 *  after it, so a burst of workspace events costs two fetches, not twenty. */
function coalesce(load: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  let dirty = false;
  return () => {
    dirty = true;
    return inflight ??= (async () => {
      while (dirty) {
        dirty = false;
        await load();
      }
    })().finally(() => {
      inflight = undefined;
    });
  };
}

const refreshProjects = coalesce(async () => {
  commitSessions((await (await fetch("/api/projects")).json()) as SessionInfo[], false);
});

/** Full Pi transcript scan, only for surfaces that explicitly need history. */
const refreshSessions = coalesce(async () => {
  commitSessions((await (await fetch("/api/sessions")).json()) as SessionInfo[], true);
});

/** Seen = read: the selected session's chat is on screen in a visible tab.
 *  The ack clears the server-side unread mark, and the resulting broadcast
 *  moves every other client's dot back too. Optimistic locally — the dot
 *  must not stay amber while the user is literally looking at the turn. */
function maybeAckRead(): void {
  if (document.hidden || !isChatVisible()) return;
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
  if (state === "idle") void refreshProjects();
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
      if (e.meta) noteContextTokens(e.meta.tokens);
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
  // Any (re)connect may follow a gap — re-list Projects instead of replaying.
  src.onopen = () => void refreshProjects();
  src.onerror = () => streamDied(src, "Workspace");
  src.onmessage = (m) => {
    const e = JSON.parse(m.data) as WorkspaceEvent;
    if (e.type === "sessions-changed") {
      void refreshProjects();
      return;
    }
    if (e.type === "tasks-changed" || e.type === "task-run-changed" || e.type === "task-message-changed" || e.type === "task-group-changed") {
      refreshTasks(e.type === "task-run-changed" ? e.taskId : undefined);
      refreshActivity();
      // A run starting or settling changes its launcher's activeRuns dot.
      if (e.type === "task-run-changed") void refreshProjects();
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

function connect(id: string, after: number): void {
  source?.close();
  const stream = new EventSource(`/api/sessions/${id}/events?after=${after}`);
  stream.onmessage = (m) => handleEvent(JSON.parse(m.data) as SessionEvent);
  stream.onerror = () => streamDied(stream, "Session");
  source = stream;
}

// --- selection --------------------------------------------------------------------

async function select(id: string): Promise<void> {
  const seq = ++selectionSeq;
  let missing = false;
  if (!sessions.some((s) => s.id === id)) {
    await refreshSessions();
    if (seq !== selectionSeq) return;
    missing = !sessions.some((s) => s.id === id);
  }
  showChat();
  closeDrawer(); // on mobile the drawer is how you got here
  setSessionHash(id);
  if (id === currentId && !missing) return;
  saveDraft(); // the outgoing session keeps its unsent text
  currentId = id;
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  restoreDraft(id);
  renderSessions();
  renderHeader();
  maybeAckRead(); // selecting an unread session is looking at it
  await loadSession(id, missing);
}

/** (Re)load the current session's snapshot and reconnect its event stream. */
async function loadSession(id: string, missing = false): Promise<void> {
  source?.close();
  resetChat();
  renderQueue([], []);
  resetHeaderState();
  turnOpen = false;
  clearOptimistic();
  lastSeq = 0;
  // Painted before the fetch: a long transcript takes a moment to arrive and
  // render, and until then the pane would look like an empty session.
  chatLoading(true);
  if (missing) {
    chatLoading(false);
    appendTurn("error", `session not found: ${id}`);
    return;
  }
  const res = await fetch(`/api/sessions/${id}/history`);
  const snap = res.ok ? ((await res.json()) as SessionSnapshot) : null;
  if (currentId !== id) return; // stale: the user switched again mid-fetch
  if (!snap) {
    chatLoading(false);
    appendTurn("error", `failed to load session: ${res.status}`);
    return;
  }
  renderSnapshot(snap.turns, snap.state, snap.backgroundRuns);
  lastSeq = snap.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp);
  setHeaderState(snap.model, snap.context, snap.thinkingLevel);
  connect(id, snap.lastSeq);
}

// --- wiring ----------------------------------------------------------------------------

// First, before any surface can issue a request: from here on a 401 is the
// login page and not a per-caller error message, and anything that throws on
// the way reaches the server's log instead of only the browser console.
initReport();
guardFetch();

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
  ownTurn: (text) => {
    markOptimisticUser(text);
    setState("streaming"); // an edit resend starts a turn; the buttons say so now
  },
  reload: reloadIfCurrent,
});
initComposer({
  sessionId: () => currentId,
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
});
initSidebar({
  sessions: () => sessions,
  loadSessions: refreshSessions,
  currentId: () => currentId,
  select: (id) => void select(id),
  sessionMenu,
  createSession,
  openFiles: showFiles,
  openTerminal: showTerminal,
  openConsole: showConsole,
  onPinsChanged: renderHeader,
});
initHeader({
  currentId: () => currentId,
  currentSession,
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

// Coming back to a hidden tab is the other way turns get seen.
document.addEventListener("visibilitychange", maybeAckRead);

connectWorkspace();
void refreshProjects().then(applyRoute);
