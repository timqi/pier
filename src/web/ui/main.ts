// Workbench frontend orchestrator: session state, selection, and the SSE event
// streams. Surface modules are wired through explicit deps, never imports back.

import "./style.css";
import { initIcons } from "./icons.js";
// One formatter from core, at runtime: how a token count is spelled is the
// same question on every surface (session-header.ts asks it too).
import { compact as tokens } from "../../core/reply.js";
// Same reason: a header this deployment wrote is read back, not re-parsed here.
import { readableTitle, splitSpeaker } from "../../core/identity.js";
import { coalesce, failure, getJson, mustGetJson, postJson, sendJson } from "./api.js";
import { guardFetch, streamDied } from "./auth.js";
import {
  appendDelta,
  appendDivider,
  appendPager,
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
  turnsPane,
} from "./chat.js";
import {
  clearOptimistic,
  dropParked,
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
import { initPalette } from "./palette.js";
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
  setConversationHash,
  setSessionHash,
  showChat,
  showConsole,
  showFiles,
  syncBar,
  toggleFiles,
} from "./views.js";
// Type-only import of the seam contract — erased at build, keeps the wire
// shapes single-sourced in core/types.ts instead of hand-copied here.
import type {
  BackgroundRun,
  ChainMember,
  ChainReason,
  ChatTurn,
  ContextUsage,
  ModelRef,
  OpenItems,
  ParkedMessage,
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
  queue: { steering: string[]; followUp: string[]; parked: ParkedMessage[] };
  queueRecovery: QueueRecovery[];
  queueUncertain: boolean;
  backgroundRuns: BackgroundRun[];
}

declare const __PIER_VERSION__: string; // injected by vite.config.ts

// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
// The selected session when it is not a row — a task run's own, opened from
// its run card's session chip. Fetched by id so the header can name it and its info panel
// can be opened like any other session's.
let detached: SessionInfo | null = null;
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

// --- the continuous conversation (docs/design/10-continuous-session.md) -------------

/** Its sessions, newest first; null while the switch is off. */
let chain: ChainMember[] | null = null;
/** Earlier sessions paged in above the head, oldest first; `error` when one could not be read. */
let earlier: { member: ChainMember; turns: ChatTurn[]; runs: BackgroundRun[]; error?: string }[] = [];
/** On screen before its first session exists: the first message starts one. */
let unstarted = false;
let paging = false;
let pagedAt = 0;
/** What it is solving, for the rail's Open block; null while the switch is off. */
let openItems: OpenItems | null = null;

const headId = (): string | null => chain?.[0]?.sessionId ?? null;
const inConversation = (id: string): boolean => chain?.some((m) => m.sessionId === id) ?? false;
const continuousOpen = (): boolean => chain !== null && (unstarted || (currentId !== null && currentId === headId()));

const DIVIDER: Record<ChainReason, string> = {
  first: "new session",
  idle: "new session — idle 1h",
  lost: "new session — the previous one was lost",
  full: "new session — the previous one was full",
  new: "new session — /new",
};

/** A 404 is the switch being off; anything else is a failure, not "off". */
async function loadChain(): Promise<ChainMember[] | null> {
  const res = await fetch("/api/continuous");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await failure(res, "Could not load the continuous conversation"));
  const { chain } = (await res.json()) as { chain?: unknown };
  return Array.isArray(chain) ? chain as ChainMember[] : null;
}

/** Same contract as the chain's read: a 404 is the switch being off. */
async function loadOpenItems(): Promise<OpenItems | null> {
  const res = await fetch("/api/continuous/open");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await failure(res, "Could not load the open items"));
  return (await res.json()) as OpenItems;
}

// Thrown like refreshSessions', for the same reason.
const refreshOpenItems = coalesce(async () => {
  openItems = await loadOpenItems();
  renderSessions();
});

function openContinuous(): void {
  const head = headId();
  if (head) return void select(head);
  if (unstarted) {
    showChat();
    closeDrawer();
    return setConversationHash();
  }
  ++selectionSeq;
  ++loadSeq;
  saveDraft();
  showChat();
  closeDrawer();
  source?.close();
  source = null;
  currentId = null;
  detached = null;
  currentState = "idle";
  unstarted = true;
  earlier = [];
  resetPane();
  appendTurn("system", "The continuous conversation — your first message starts it.");
  setConversationHash();
  renderSessions();
  renderHeader();
  updateComposer();
  focusInput();
}

/** The session just left stays in view above the new head. */
async function followHead(head: string): Promise<void> {
  earlier = [];
  unstarted = false;
  await select(head);
  if ((chain?.length ?? 0) > 1) await page();
}

/** One earlier session in above the rest; the head is re-read with it, and the
 *  reader stays where they were. */
async function page(): Promise<void> {
  const head = headId();
  const member = chain?.[earlier.length + 1];
  if (paging || !head || !member || currentId !== head) return;
  paging = true;
  try {
    const got = await getJson<{ turns: ChatTurn[]; backgroundRuns: BackgroundRun[] }>(
      `/api/sessions/${member.sessionId}/history`, "Could not load the earlier session");
    if (currentId !== head) return;
    earlier.unshift(got.ok
      ? { member, turns: got.value.turns, runs: got.value.backgroundRuns }
      : { member, turns: [], runs: [], error: got.error });
    const fromBottom = turnsPane.scrollHeight - turnsPane.scrollTop;
    // A keyboard page keeps the keyboard on the pager, which the reload replaced.
    const focused = document.activeElement?.id === "chain-pager";
    await loadSession(head, true);
    turnsPane.scrollTop = turnsPane.scrollHeight - fromBottom;
    if (focused) document.getElementById("chain-pager")?.focus({ preventScroll: true });
    pagedAt = Date.now();
  } finally {
    paging = false;
  }
}

/** Earlier sessions above the head, read-only, each closed by the divider naming the rotation after it. */
function renderEarlier(): void {
  if (!chain) return;
  if (earlier.length < chain.length - 1) appendPager(() => void page());
  for (const [i, e] of earlier.entries()) {
    if (e.error) appendTurn("error", e.error);
    renderSnapshot(e.turns, "idle", e.runs, true);
    const next = earlier[i + 1]?.member ?? chain[0]!;
    appendDivider(DIVIDER[next.reason], next.startedAt);
  }
}

/** Scrolling to the top pages; not right after a page, whose restore may itself land there. */
turnsPane.addEventListener("scroll", () => {
  if (turnsPane.scrollTop < 40 && continuousOpen() && !loading && Date.now() - pagedAt > 500) void page();
}, { passive: true });

// --- sessions --------------------------------------------------------------------

async function createSession(cwd: string): Promise<void> {
  const seq = ++selectionSeq;
  ++loadSeq;
  loading = false;
  // The pane becomes the new session's before the POST: a round trip with the
  // previous session still on screen looks ignored, and a prompt typed during
  // the wait must not go to the session being left.
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
  // The header reads the selected session's row too — its running-runs chip is
  // this list's `activeRuns`, so a re-list is also a repaint.
  renderHeader();
  maybeAckRead();
}

// Thrown, not swallowed: this runs as `void refreshSessions()` from event
// handlers, and report.ts is listening for exactly that rejection — a rail
// that quietly stopped updating is the shape of bug principle 5 is about.
const refreshSessions = coalesce(async () => {
  const [rows, next, open] = await Promise.all([
    mustGetJson<SessionInfo[]>("/api/sessions", "Could not load sessions"),
    loadChain(),
    loadOpenItems(),
  ]);
  const following = continuousOpen();
  const was = headId();
  chain = next;
  openItems = open;
  if (!chain) unstarted = false;
  commitSessions(rows);
  // A rotation — this tab's send or another's — or the first send's new head moves the open conversation there.
  const head = headId();
  if (following && head && head !== was) await followHead(head);
});

/** Focus, not just visibility: an installed workbench behind another app is
 *  still `document.hidden === false` on macOS, which would ack every turn and
 *  suppress the push (web/push.ts). */
function maybeAckRead(): void {
  if (document.hidden || !document.hasFocus() || !isChatVisible()) return;
  const s = sessions.find((x) => x.id === currentId);
  if (!s?.unread) return;
  s.unread = false;
  renderSessions();
  void fetch(`/api/sessions/${s.id}/read`, { method: "POST" });
}

/** Gone from the rail at once, back if the write fails. A closed current
 *  session keeps its pane and is named from `detached`, like a task run's. */
async function closeSession(s: SessionInfo): Promise<void> {
  if (s.id === currentId) detached = s;
  sessions = sessions.filter((x) => x.id !== s.id);
  renderSessions();
  const got = await postJson(`/api/sessions/${s.id}/close`, { closed: true }, "Could not close the session");
  if (got.ok) return;
  if (!sessions.some((x) => x.id === s.id)) sessions = [...sessions, s].sort((a, b) => b.createdAt - a.createdAt);
  renderSessions();
  appendTurn("error", got.error);
}

/** The selected session's persisted summary, when it exists. */
function currentSession(): SessionInfo | undefined {
  return sessions.find((s) => s.id === currentId)
    ?? (detached && detached.id === currentId ? detached : undefined);
}

/** Summary of a selected session the listing does not carry. */
async function loadDetached(id: string): Promise<void> {
  const got = await getJson<SessionInfo>(`/api/sessions/${id}`, "failed to load session");
  // A 404 here is a session that is genuinely gone; the snapshot load says so
  // in the transcript, and the header keeps naming it by its id.
  if (currentId !== id || !got.ok) return;
  detached = { ...got.value, title: readableTitle(got.value.title) };
  renderHeader();
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
      if (e.origin.kind === "task-message") dropParked(e.origin.messageId);
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

function connectWorkspace(): void {
  const src = new EventSource("/api/events");
  // Any (re)connect may follow a gap: re-list instead of replaying.
  src.onopen = () => void refreshSessions();
  src.onerror = () => streamDied(src, "Workspace");
  src.onmessage = (m) => {
    const e = JSON.parse(m.data) as WorkspaceEvent;
    if (e.type === "sessions-changed") {
      void refreshSessions();
      return;
    }
    if (e.type === "tasks-changed" || e.type === "task-run-changed" || e.type === "task-message-changed" || e.type === "task-group-changed") {
      // A run starting or settling changes its launcher's activeRuns dot.
      if (e.type === "task-run-changed") void refreshSessions();
      return;
    }
    if (e.type === "open-items-changed") {
      void refreshOpenItems();
      return;
    }
    // The selected session's own stream already drives composer state.
    if (e.sessionId === currentId) return;
    const s = sessions.find((x) => x.id === e.sessionId);
    // A run's session can be saved after the run-changed refetch listed sessions.
    if (!s) {
      void refreshSessions();
      return;
    }
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
  // Any session of the continuous conversation opens the conversation, at its head.
  if (inConversation(id)) id = headId()!;
  if (id !== currentId || unstarted) {
    earlier = [];
    unstarted = false;
  }
  // A session named from a run card is usually not in the list; the
  // snapshot's 404 says whether the id exists and why.
  showChat();
  closeDrawer(); // on mobile the drawer is how you got here
  setSessionHash(id);
  if (id === currentId && (source || loading)) return;
  ++selectionSeq; // a create in flight is abandoned; its answer must not land here
  ++loadSeq;
  starting = false;
  saveDraft(); // the outgoing session keeps its unsent text
  currentId = id;
  detached = null;
  if (!sessions.some((s) => s.id === id)) void loadDetached(id);
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  restoreDraft(id);
  renderSessions();
  renderHeader();
  maybeAckRead(); // selecting an unread session is looking at it
  await loadSession(id);
}

function resetPane(): void {
  resetChat();
  renderQueue([], [], []);
  renderRecovery([]);
  resetHeaderState();
  turnOpen = false;
  clearOptimistic();
  lastSeq = 0;
}

/** (Re)load the current session's snapshot and reconnect its event stream. */
async function loadSession(id: string, keep = false): Promise<void> {
  if (currentId !== id) return;
  const generation = ++loadSeq;
  source?.close();
  source = null;
  loading = true;
  // Painted before the fetch: a long transcript takes a moment to arrive and
  // render, and until then the pane would look like an empty session. A page
  // (`keep`) leaves the pane as it is until the snapshot is in hand.
  if (!keep) {
    resetPane();
    chatLoading(true);
  }
  const got = await getJson<SessionSnapshot>(`/api/sessions/${id}/history`, "failed to load session");
  if (currentId !== id || generation !== loadSeq) return;
  loading = false;
  if (keep) resetPane();
  if (!got.ok) {
    chatLoading(false);
    appendTurn("error", got.error);
    return;
  }
  const snap = got.value;
  if (continuousOpen()) renderEarlier();
  renderSnapshot(snap.turns, snap.state, snap.backgroundRuns);
  lastSeq = snap.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp, snap.queue.parked);
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
initIcons();
guardFetch();
initTheme();

/** Shared by chat + composer deps: reload only if `id` is still selected. */
const reloadIfCurrent = async (id: string): Promise<void> => {
  if (currentId === id) await loadSession(id);
};

initChat({
  sessionId: () => currentId,
  sessionCwd: () => currentSession()?.cwd ?? null,
  sessionChannel: () => currentSession()?.channel ?? null,
  sessionState: () => currentState,
  select: (id) => void select(id),
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
  continuous: continuousOpen,
  // The re-list sees the rotation and moves the pane to the new head.
  headMoved: () => void refreshSessions(),
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
  currentId: () => currentId,
  select: (id) => void select(id),
  sessionMenu,
  createSession,
  onTitleChanged: renderHeader,
  chain: () => chain,
  continuousOpen,
  openContinuous,
  chatVisible: isChatVisible,
  open: () => openItems,
});
initPalette({
  sessions: () => sessions,
  loadSessions: refreshSessions,
  currentId: () => currentId,
  select,
  createSession,
  openConsole: showConsole,
});
initHeader({
  currentId: () => currentId,
  currentSession,
  createSession: (cwd) => void createSession(cwd),
  syncBar,
  openFiles: showFiles,
  toggleFiles,
  closeSession: (s) => void closeSession(s),
  inConversation,
  continuousOpen,
});
initViews({
  sessions: () => sessions,
  currentId: () => currentId,
  currentSession,
  select: (id) => void select(id),
  continuousOn: () => chain !== null,
  inConversation,
  openContinuous,
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
