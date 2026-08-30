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
  // Opening a session in Pi costs a round trip long enough to look ignored —
  // the dialog closes and the *previous* session stays on screen. So the pane
  // becomes the new session's before the POST is sent: skeleton, the title an
  // untitled session will keep anyway, and no current id — a prompt typed
  // during the wait must not be sent to the session being left.
  showChat();
  closeDrawer();
  currentId = null;
  source?.close();
  resetChat();
  resetHeaderState();
  setHeaderPending(cwd);
  chatLoading(true);
  const res = await sendJson("/api/sessions", { cwd });
  if (!res.ok) {
    chatLoading(false);
    setHeaderPending(null);
    appendTurn("error", `session create failed: ${res.status}`);
    return;
  }
  const { id } = (await res.json()) as { id: string };
  // The row is known here and the POST already broadcast `sessions-changed`,
  // so it is rendered now and the workspace stream's own refresh reconciles it
  // — selecting must not wait for a full listing (principle 7). Repo and branch
  // come from a session in the same directory, so the row lands in its project
  // rather than jumping there a moment later.
  const { repo, branch } = sessions.find((s) => s.cwd === cwd) ?? {};
  sessions.unshift({
    id, cwd, createdAt: Date.now(), state: "idle", listed: true, unread: false, channel: "web",
    activeRuns: 0, repo, branch,
  });
  await select(id); // renders the rail and the header with the row above
  focusInput();
}

/** `complete` = every session Pi knows, so it replaces the list. A Projects
 *  read speaks only for the pinned ones and merges instead: dropping the rest
 *  would delete the current session out from under its own chat the moment it
 *  is unpinned — header, ⋯ menu and its Pin row with it. */
function commitSessions(rows: SessionInfo[], complete: boolean): void {
  // A title read off an IM prompt still carries its speaker header: every
  // surface downstream reads `title`, so it is made readable once, here.
  const next = rows.map((s) => ({ ...s, title: readableTitle(s.title) }));
  if (complete) {
    sessions = next;
  } else {
    const fresh = new Map(next.map((s) => [s.id, s]));
    sessions = sessions.map((s) => fresh.get(s.id) ?? (s.listed ? { ...s, listed: false } : s));
    const known = new Set(sessions.map((s) => s.id));
    sessions.push(...next.filter((s) => !known.has(s.id)));
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
  maybeAckRead();
}

// Thrown, not swallowed: these run as `void refresh…()` from event handlers,
// and report.ts is listening for exactly that rejection — a rail that quietly
// stopped updating is the shape of bug 5b is about.
const refreshProjects = coalesce(async () => {
  commitSessions(await mustGetJson<SessionInfo[]>("/api/projects", "Could not load projects"), false);
});

/** Full Pi transcript scan, only for surfaces that explicitly need history. */
const refreshSessions = coalesce(async () => {
  commitSessions(await mustGetJson<SessionInfo[]>("/api/sessions", "Could not load sessions"), true);
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
      appendSystemInput(e.text, e.origin, e.ts);
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
      // meta carries the context size and the completion time — keep both live.
      if (e.meta) noteTurnMeta(e.meta);
      break;
    case "queue-state":
      renderQueue(e.steering, e.followUp);
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
  // The pane opens before anything is fetched. A session named from Activity or
  // from the hash is usually not in the list yet, and the full listing that
  // decides that costs ~150ms in which the click looked ignored.
  showChat();
  closeDrawer(); // on mobile the drawer is how you got here
  setSessionHash(id);
  const listed = sessions.some((s) => s.id === id);
  if (id === currentId && listed) return;
  saveDraft(); // the outgoing session keeps its unsent text
  currentId = id;
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  restoreDraft(id);
  renderSessions();
  renderHeader();
  maybeAckRead(); // selecting an unread session is looking at it
  if (listed) return await loadSession(id);
  // Unlisted: show the transcript placeholder first, then pay the listing that
  // says whether this id exists at all — "not found" is worth the wait, a
  // blank pane during it is not. The old stream closes with the pane it was
  // painting, or a delta from the session just left lands in the empty one.
  source?.close();
  resetChat();
  chatLoading(true);
  await refreshSessions();
  if (seq !== selectionSeq || currentId !== id) return;
  await loadSession(id, !sessions.some((s) => s.id === id));
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
  const got = await getJson<SessionSnapshot>(`/api/sessions/${id}/history`, "failed to load session");
  if (currentId !== id) return; // stale: the user switched again mid-fetch
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
  // meta is assistant-only (core/types.ts), so the last one that carries it is
  // the last reply — no role test, and none of Array#findLast (web target).
  const lastReply = snap.turns.reduce<number | null>((at, t) => t.meta?.completedAt ?? at, null);
  setHeaderState(snap.model, snap.context, snap.thinkingLevel, lastReply);
  connect(id, snap.lastSeq);
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
  openFiles: showFiles,
  openTerminal: showTerminal,
  openConsole: showConsole,
  onPinsChanged: renderHeader,
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

// Coming back to a hidden tab — or to an unfocused window — is the other way
// turns get seen.
document.addEventListener("visibilitychange", maybeAckRead);
window.addEventListener("focus", maybeAckRead);

connectWorkspace();
void refreshProjects().then(applyRoute);
