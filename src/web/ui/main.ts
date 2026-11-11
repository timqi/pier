// Workbench frontend orchestrator: session state, selection, and the SSE event
// streams. Surface modules are wired through explicit deps, never imports back.

import "./style.css";
import { initIcons } from "./icons.js";
// One formatter from core, at runtime: how a token count is spelled is the
// same question on every surface (session-header.ts asks it too).
import { compact as tokens } from "../../core/reply.js";
// Same reason: a header this deployment wrote is read back, not re-parsed here.
import { readableTitle, splitSpeaker } from "../../core/identity.js";
import { openItemDestination } from "../../core/open-items.js";
import { coalesce, failure, getJson, mustGetJson } from "./api.js";
import { bundleVersion, guardFetch, matchVersion, streamDied } from "./auth.js";
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
  keepScroll,
  renderSnapshot,
  revealTopic,
  resetChat,
  scrollBottom,
  turnsPane,
} from "./chat.js";
import {
  cancelVoice,
  clearOptimistic,
  dropParked,
  dropStaged,
  endVoice,
  focusInput,
  initComposer,
  markOptimisticUser,
  reconcileOptimisticUser,
  renderQueue,
  restoreDraft,
  saveDraft,
  send,
  setQuote,
  setSkills,
  updateComposer,
} from "./composer.js";
import { initPush, isIOS } from "./notifications.js";
import { initReport, report } from "./report.js";
import { initChains, renderChains, unarchive } from "./chains.js";
import { onCharterSaved, openCharter } from "./charter.js";
import { button } from "./form.js";
import { notify } from "./shell.js";
import { noteDownloads } from "./dom.js";
import { initHeader, noteTurnMeta, renderHeader, resetHeaderState, setHeaderState } from "./session-header.js";
import { initTheme } from "./theme.js";
import { initVersion } from "./version.js";
import { initDrawer, renderDrawer, type SessionInfo } from "./drawer.js";
import { itemMissing, itemTurnsUrl, renderItem, type ItemTurns } from "./item-view.js";
import { refreshSuggestions } from "./suggestions.js";
import { setOpenTopics } from "./topics.js";
import {
  activityThinking,
  activityToolEnd,
  activityToolStart,
  renderBackgroundRun,
} from "./turn-activity.js";
import {
  applyRoute,
  initViews,
  isChatVisible,
  setConversationHash,
  setItemHash,
  setSessionHash,
  showChat,
  showConsole,
  showFiles,
  toggleFiles,
} from "./views.js";
// Type-only import of the seam contract — erased at build, keeps the wire
// shapes single-sourced in core/types.ts instead of hand-copied here.
import type {
  BackgroundRun,
  ChainMember,
  ChatTurn,
  ContextUsage,
  ModelRef,
  OpenItemTarget,
  SessionEvent,
  SessionState,
  ThinkingLevel,
  WorkspaceEvent,
} from "../../core/types.js";
import type { ItemSummary, OpenItems, ParkedMessage } from "../../tasks/types.js";
import type { ChainList } from "../types.js";

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
  backgroundRuns: BackgroundRun[];
  skills: { name: string; description: string }[];
}

type SnapshotRead = Awaited<ReturnType<typeof getJson<SessionSnapshot>>>;


// --- state ---------------------------------------------------------------------

let sessions: SessionInfo[] = [];
// The selected session when it is not a row — a task run's own, opened from
// its run card's session chip. Fetched by id so the header can name it and its info panel
// can be opened like any other session's.
let detached: SessionInfo | null = null;
let loadSeq = 0;
let loading = false;
let currentId: string | null = null;
let currentState: SessionState = "idle";
let source: EventSource | null = null;
let lastSeq = 0;
let turnOpen = false;
/** Streaming set by this tab's own send, no state event since: the one guess
 *  an error may take back — after a server state event, only another one can. */
let optimistic = false;

// --- the continuous conversation (docs/design/10-continuous-session.md) -------------

/** Every chain, `GET /api/chains`; null before it answers. */
let chainList: ChainList | null = null;
/** The chain the pane shows (docs/plans/30-multi-chain.md §对话面板); null before the first read names one. */
let chainId: string | null = null;
/** `#/conversation` lands on the chain last viewed. */
const LAST_CHAIN = "pier.chain";
/** The current chain's sessions, newest first; empty before its first session exists. */
let chain: ChainMember[] = [];
/** The head's context size past which the next message starts a new session; null before the chain answers. */
let rotateAt: number | null = null;
/** Earlier sessions paged in above the head, oldest first; `error` when one could not be read. */
let earlier: { member: ChainMember; turns: ChatTurn[]; runs: BackgroundRun[]; error?: string }[] = [];
/** On screen before its first session exists: the first message starts one. */
let unstarted = false;
let paging = false;
let pagedAt = 0;
/** What it is solving, for the drawer's run rows; null before it answers. */
let openItems: OpenItems | null = null;
/** The item view's problem (`#/conversation/item/…`), and the one the pane was drawn for. */
let item: string | null = null;
let paneItem: string | null = null;
/** The item view's filter, run after each event (item-view.ts); null off the view. */
let itemFilter: (() => void) | null = null;

const headId = (): string | null => chain[0]?.sessionId ?? null;
const inConversation = (id: string): boolean => chain.some((m) => m.sessionId === id);
const continuousOpen = (): boolean => unstarted || (currentId !== null && currentId === headId());

/** One chain's sessions; none named is the first chain. A link to no chain is its 404, said in the pane. */
async function loadChain(id: string | null, signal?: AbortSignal): Promise<{ chainId: string; chain: ChainMember[]; rotateAt: number }> {
  const res = await fetch(id ? `/api/continuous?chain=${encodeURIComponent(id)}` : "/api/continuous", { signal });
  if (!res.ok) throw new Error(await failure(res, "Could not load the continuous conversation"));
  const { chainId, chain, rotateAt } = (await res.json()) as { chainId?: unknown; chain?: unknown; rotateAt?: unknown };
  if (typeof chainId !== "string" || !Array.isArray(chain) || typeof rotateAt !== "number" || !(rotateAt > 0)) {
    throw new Error("The continuous conversation's chain is malformed");
  }
  return { chainId, chain: chain as ChainMember[], rotateAt };
}

const activeChains = () => chainList?.chains.filter((c) => c.archivedAt === undefined) ?? [];
const firstChain = (): string | undefined => [...activeChains()].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;

/** `#/conversation`'s chain: the last one viewed while it is active, else the first. */
function landing(): string | null {
  const last = localStorage.getItem(LAST_CHAIN);
  return activeChains().find((c) => c.id === last)?.id ?? firstChain() ?? chainId;
}

/** A bookmark from before chains names only an item: the one active chain holding it, else the first. */
async function chainHolding(problem: string): Promise<string | null> {
  const got = await getJson<{ items: ItemSummary[] }>(`/api/continuous/items?q=${encodeURIComponent(problem)}`, `Could not find the chain of "${problem}"`);
  if (!got.ok) {
    report(got.error);
    return landing();
  }
  const live = new Set(activeChains().map((c) => c.id));
  const holding = new Set(got.value.items.filter((i) => (i.problem === problem || i.aliases.includes(problem)) && live.has(i.chain)).map((i) => i.chain));
  return holding.size === 1 ? [...holding][0]! : firstChain() ?? chainId;
}

/** Make `id` the pane's chain and read its sessions; false when a later switch took over or the read failed, said in the pane. */
async function switchChain(id: string): Promise<boolean> {
  chainId = id;
  paintTopics();
  chain = [];
  earlier = [];
  unstarted = false;
  renderChains();
  try {
    const next = await loadChain(id);
    if (chainId !== id) return false;
    ({ chainId, chain, rotateAt } = next);
  } catch (err) {
    if (chainId === id) appendTurn("error", String(err));
    return false;
  }
  localStorage.setItem(LAST_CHAIN, chainId);
  renderChains();
  renderDrawer();
  return true;
}

/** A chain's conversation, or an item's view in it; no chain is `#/conversation`'s (`landing`). */
async function openChain(id: string | null, problem: string | null = null, user = true): Promise<void> {
  if (user) cancelNavigation();
  const intent = navigation;
  const to = id ?? (problem ? await chainHolding(problem) : landing());
  if (intent !== navigation) return;
  if (to && to !== chainId && (!(await switchChain(to)) || intent !== navigation)) return;
  if (problem) openItemView(problem);
  else openContinuous(false);
}

/** A page keeps the old pane up while it reads, and a coalesced refresh holds every later one behind it:
 *  a read that never answers must hold neither, so it fails and is retried. */
const READ_MS = 10_000;

/** Each read numbered as it starts: two coalescers read the items, and an earlier read may answer last. */
let openReads = 0;
let openCommitted = 0;

async function loadOpenItems(signal?: AbortSignal): Promise<{ seq: number; open: OpenItems }> {
  const seq = ++openReads;
  const res = await fetch("/api/continuous/open", { signal });
  if (!res.ok) throw new Error(await failure(res, "Could not load the open items"));
  return { seq, open: (await res.json()) as OpenItems };
}

// Thrown like refreshSessions', for the same reason.
const refreshOpenItems = coalesce(async () => {
  commitOpenItems(await loadOpenItems(AbortSignal.timeout(READ_MS)));
  renderDrawer();
});

/** The panel's rows, the chat's tags and its earlier options read the same items; a read older than the one on hand is dropped,
 *  the chat repainted all the same for the chain a first read just named. */
function commitOpenItems({ seq, open }: { seq: number; open: OpenItems }): void {
  if (seq > openCommitted) [openCommitted, openItems] = [seq, open];
  paintTopics();
  refreshSuggestions();
}

/** The chat's tags read only the chain on screen: the same key may be open in another chain. */
const paintTopics = (): void => setOpenTopics(openItems?.items.filter((i) => i.chain?.id === chainId) ?? []);

let navigation = 0;
let snapshotReady = false;
const cancelNavigation = (): void => { ++navigation; };

/** One click owns topic lookup and fallback; only a successfully loaded, missing topic may fall back.
 *  `chain`: the item's, read first when the pane shows another. */
async function openItem(target: OpenItemTarget, chain?: string): Promise<void> {
  const intent = ++navigation;
  const current = (): boolean => intent === navigation && isChatVisible();
  const { session, topic } = openItemDestination(target);
  if (session && !topic) return select(session, false);
  // From Settings (a sidebar row) the chat is not shown until `select`: the switch answers to the intent alone.
  if (chain && chain !== chainId && (!(await switchChain(chain)) || intent !== navigation)) return;
  const head = headId();
  if (!head) return openContinuous(false);
  await select(head, false);
  if (!current()) return;
  while (inFlight) {
    await inFlight;
    if (!current()) return;
  }
  if (!snapshotReady || !continuousOpen()) return;
  if (topic && revealTopic(topic)) return;
  if (!current()) return;
  if (session) await select(session, false);
  else scrollBottom(true);
}

function openContinuous(user = true): void {
  if (user) cancelNavigation();
  item = null;
  const head = headId();
  if (head) return void select(head, false);
  if (unstarted) {
    showChat();
    return setConversationHash();
  }
  ++loadSeq;
  cancelVoice(); // no restoreDraft on this path, and the take is its session's
  saveDraft();
  showChat();
  source?.close();
  source = null;
  currentId = null;
  detached = null;
  currentState = "idle";
  unstarted = true;
  earlier = [];
  resetPane();
  const hint = appendTurn("system", "The continuous conversation — your first message starts it.");
  // Before the first message is when a charter is written: the head it starts reads it.
  const id = chainId;
  if (id !== null) {
    const charter = button("Charter…");
    charter.classList.add("mt-2", "max-md:min-h-11");
    charter.onclick = () => openCharter({ id, name: chainList?.chains.find((c) => c.id === id)?.name ?? id });
    hint.after(charter);
  }
  setConversationHash();
  renderDrawer();
  renderHeader();
  updateComposer();
  focusInput();
}

/** The conversation's pane in one item's company; the rows wait for the head's snapshot to name it. */
function openItemView(problem: string): boolean {
  cancelNavigation();
  const head = headId();
  if (!head) openContinuous(false);
  else void select(head, false, problem);
  return !!head;
}

/** The session just left stays in view above the new head. */
async function followHead(head: string): Promise<void> {
  earlier = [];
  unstarted = false;
  if (chain.length === 1) return select(head, false);
  // No skeleton: the old pane stays up until page() paints its reads at once. Its stream is
  // dropped too, so a select() meanwhile draws the head instead of taking it for loaded.
  setSessionHash(head);
  choose(head);
  source?.close();
  source = null;
  // A head just rotated to holds little more than the message that started it.
  if (!(await page(AUTO_PAGES))) await loadSession(head);
}

/** A head with fewer messages than this opens with up to `AUTO_PAGES` earlier sessions above it. */
const SHORT_HEAD = 6;
const AUTO_PAGES = 2;
const shortHead = (turns: ChatTurn[]): boolean => turns.filter((t) => t.role === "user" || t.role === "assistant").length < SHORT_HEAD;

/** Earlier members' reads, oldest first as `earlier` holds them; a failed read is its entry's `error`. */
async function readEarlier(members: ChainMember[]): Promise<typeof earlier> {
  const reads = await Promise.all(members.map((m) => getJson<{ turns: ChatTurn[]; backgroundRuns: BackgroundRun[] }>(
    `/api/sessions/${m.sessionId}/history`, "Could not load the earlier session", { signal: AbortSignal.timeout(READ_MS) })));
  return reads.map((got, i) => {
    const member = members[i]!;
    return got.ok ? { member, turns: got.value.turns, runs: got.value.backgroundRuns } : { member, turns: [], runs: [], error: got.error };
  }).reverse();
}

/** `count` earlier sessions in above the rest; the head is re-read with them, and the
 *  reader stays where they were. False when it did not start. */
async function page(count = 1): Promise<boolean> {
  const head = headId();
  const members = chain.slice(earlier.length + 1, earlier.length + 1 + count);
  if (paging || !head || !members.length || currentId !== head || !isChatVisible() || paneItem) return false;
  const intent = navigation;
  const generation = loadSeq;
  const current = (): boolean => intent === navigation && generation === loadSeq && currentId === head && headId() === head && isChatVisible();
  paging = true;
  try {
    const reads = await readEarlier(members);
    if (!current()) return true;
    // The reads belong to this navigation; keep the pane and its stream live until they can commit together.
    const snapshot = await getJson<SessionSnapshot>(`/api/sessions/${head}/history`, "failed to load session", { signal: AbortSignal.timeout(READ_MS) });
    if (!current()) return true;
    earlier.unshift(...reads);
    // A head read that failed is read again as a plain load, its loading state on screen instead of the old pane.
    await loadSession(head, snapshot.ok ? snapshot : undefined);
    if (intent === navigation) pagedAt = Date.now();
  } finally {
    paging = false;
  }
  return true;
}

/** Earlier sessions above the head, read-only, each closed by the divider naming the rotation after it. */
function renderEarlier(): void {
  if (earlier.length < chain.length - 1) appendPager(() => void page());
  for (const [i, e] of earlier.entries()) {
    if (e.error) appendTurn("error", e.error);
    renderSnapshot(e.turns, "idle", e.runs, true, { sessionId: e.member.sessionId });
    const next = earlier[i + 1]?.member ?? chain[0]!;
    appendDivider(next.reason, next.startedAt);
  }
}

/** Scrolling to the top pages; not right after a page, whose restore may itself land there. */
turnsPane.addEventListener("scroll", () => {
  if (turnsPane.scrollTop < 40 && continuousOpen() && !loading && Date.now() - pagedAt > 500) void page();
}, { passive: true });

// --- sessions --------------------------------------------------------------------

/** Every session Pi knows, so it replaces the list. */
function commitSessions(rows: SessionInfo[]): void {
  // A title read off an IM prompt still carries its speaker header: every
  // surface downstream reads `title`, so it is made readable once, here.
  dropStaged(sessions.filter((s) => !rows.some((r) => r.id === s.id)).map((s) => s.id));
  sessions = rows.map((s) => ({ ...s, title: readableTitle(s.title) }));
  // By birth only: ordering by `modified` makes rows jump under the pointer.
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  renderDrawer();
  // The header reads the selected session's row too (title, phase), so a
  // re-list is also a repaint.
  renderHeader();
  maybeAckRead();
}

// Thrown, not swallowed: this runs as `void refreshSessions()` from event
// handlers, and report.ts is listening for exactly that rejection — a drawer
// that quietly stopped updating is the shape of bug principle 5 is about.
// coalesce retries it, so one dropped read does not strand the pane on an old head.
const refreshSessions = coalesce(async () => {
  const reading = chainId ?? localStorage.getItem(LAST_CHAIN);
  const signal = AbortSignal.timeout(READ_MS);
  const [rows, list, next, open] = await Promise.all([
    mustGetJson<SessionInfo[]>("/api/sessions", "Could not load sessions", { signal }),
    mustGetJson<ChainList>("/api/chains", "Could not load the chains", { signal }),
    loadChain(reading, signal),
    loadOpenItems(signal),
  ]);
  const following = continuousOpen() && isChatVisible();
  const was = headId();
  chainList = list;
  // A switch meanwhile owns the chain it reads.
  if (chainId === null || chainId === reading) ({ chainId, chain, rotateAt } = next);
  commitOpenItems(open);
  commitSessions(rows);
  renderChains();
  // A rotation — this tab's send or another's — or the first send's new head moves the open conversation there.
  // Not awaited: the move's reads, guarded by their own generation, must not hold every later refresh behind them.
  const head = headId();
  if (following && head && head !== was) {
    endVoice(); // not the user's switch: the take's text stays in the draft it was spoken into
    void (item ? select(head, false, item) : followHead(head));
  }
});

/** The window's own focus/blur, beside `hasFocus()`: a window behind another
 *  app stays `visible` on macOS, and a WebKit `hasFocus()` can stay true there
 *  too; either alone would ack the turn and suppress the push (web/push.ts). */
let windowFocused = document.hasFocus();

function maybeAckRead(): void {
  if (document.visibilityState !== "visible" || !windowFocused || !document.hasFocus() || !isChatVisible()) return;
  const s = sessions.find((x) => x.id === currentId);
  if (!s?.unread) return;
  s.unread = false;
  renderDrawer();
  void fetch(`/api/sessions/${s.id}/read`, { method: "POST" });
}

/** The selected session's persisted summary, when it exists. */
function currentSession(): SessionInfo | undefined {
  return sessions.find((s) => s.id === currentId)
    ?? (detached && detached.id === currentId ? detached : undefined);
}

/** The chain whose run launched a session off the conversation, which its `‹` returns to. */
const launchedFrom = new Map<string, string>();

/** Summary of a selected session the listing does not carry, and the chain only it names. */
async function loadDetached(id: string): Promise<void> {
  const got = await getJson<SessionInfo>(`/api/sessions/${id}`, "failed to load session");
  if (got.ok && got.value.chain) launchedFrom.set(id, got.value.chain);
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
  renderDrawer();
  renderHeader();
}

function setState(state: SessionState): void {
  // Only a turn's end changes the list — an event's, or a reload's snapshot past a turn the shown state missed;
  // re-listing on a load's idle re-reads every chain on each switch.
  const ended = currentState === "streaming" && state === "idle";
  currentState = state;
  const s = sessions.find((x) => x.id === currentId);
  if (s) s.state = state;
  renderDrawer();
  renderHeader();
  updateComposer();
  if (ended) void refreshSessions();
}

// --- event handling ----------------------------------------------------------------

function handleEvent(e: SessionEvent): void {
  if (e.sessionId !== currentId || e.seq <= lastSeq) return; // stale or replayed
  lastSeq = e.seq;
  switch (e.type) {
    case "turn-start":
      turnOpen = true;
      optimistic = false;
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
      completeTurn(e.text, e.meta, e.error);
      // A reply's topic asks again on items read after it (topics.ts); the
      // head's `open-items-changed` may have been answered before it landed.
      if (continuousOpen()) void refreshOpenItems();
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
      appendTurn("error", e.message);
      // A prompt Pi refused before its turn began (no model, no auth) has no
      // state event to follow: the optimistic streaming would never clear.
      if (optimistic) {
        optimistic = false;
        setState("idle");
      }
      break;
    case "state":
      optimistic = false;
      if (e.state === "idle" && turnOpen) {
        // idle without a turn-end: the run was aborted
        turnOpen = false;
        interruptTurn();
      }
      if (e.state === "idle") renderQueue([], []); // delivered or dropped
      setState(e.state);
      break;
  }
  if (e.type !== "text-delta") itemFilter?.();
}

function connectWorkspace(): void {
  const src = new EventSource("/api/events");
  // Any (re)connect may follow a gap: re-list instead of replaying.
  src.onopen = () => {
    void refreshSessions();
    void matchVersion();
  };
  src.onerror = () => streamDied(src, "Workspace", connectWorkspace);
  src.onmessage = (m) => {
    const e = JSON.parse(m.data) as WorkspaceEvent;
    if (e.type === "sessions-changed" || e.type === "chains-changed") {
      void refreshSessions();
      return;
    }
    if (e.type === "tasks-changed" || e.type === "task-run-changed" || e.type === "task-message-changed" || e.type === "task-group-changed") {
      // A run starting or settling changes its launcher's activeRuns dot and its
      // item's status (refreshSessions re-reads the open items with the list).
      if (e.type === "task-run-changed") void refreshSessions();
      return;
    }
    // The whole list: an item's held runs and its sessions' dots must come from one read.
    if (e.type === "open-items-changed") {
      void refreshSessions();
      return;
    }
    if (e.type === "notification") {
      notify(e); // a browser has the push already; only the shell shows this
      return;
    }
    // A session an item holds streaming is that item running.
    if (openItems && [...openItems.items.flatMap((i) => i.runs), ...openItems.unlisted].some((r) => r.targetSessionId === e.sessionId)) {
      void refreshOpenItems();
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
    renderDrawer();
    // The `‹` wears the head's dot.
    if (e.sessionId === headId()) renderHeader();
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
    // The epoch or the ring may have moved on meanwhile: a fresh snapshot, not a cursor.
    if (current()) streamDied(stream, "Session", () => { if (current()) void loadSession(id); });
  };
  source = stream;
}

// --- selection --------------------------------------------------------------------

/** `problem`: the item view of the conversation, at its head. */
async function select(id: string, user = true, problem: string | null = null): Promise<void> {
  if (user) cancelNavigation();
  // Another chain's head opens that chain (a Web Push names the session).
  const other = chainList?.chains.find((c) => c.id !== chainId && c.head?.sessionId === id);
  if (other) return openChain(other.id, problem, false);
  // Any session of the continuous conversation opens the conversation, at its head.
  if (inConversation(id)) id = headId()!;
  if (id !== currentId || unstarted) {
    earlier = [];
    unstarted = false;
  }
  // A session named from a run card is usually not in the list; the
  // snapshot's 404 says whether the id exists and why.
  item = problem;
  showChat();
  if (problem) setItemHash(problem);
  else setSessionHash(id);
  if (id === currentId && (source || loading) && paneItem === item) return;
  choose(id);
  await loadSession(id);
}

/** Selection state — draft, drawer, header — moved to `id`; its pane is the caller's to draw. */
function choose(id: string): void {
  ++loadSeq;
  saveDraft(); // the outgoing session keeps its unsent text
  currentId = id;
  detached = null;
  if (!sessions.some((s) => s.id === id) || (activeChains().length > 1 && !inConversation(id))) void loadDetached(id);
  currentState = sessions.find((s) => s.id === id)?.state ?? "idle";
  restoreDraft(id);
  renderDrawer();
  renderHeader();
  maybeAckRead(); // selecting an unread session is looking at it
}

function resetPane(): void {
  resetChat();
  renderQueue([], [], []);
  setSkills([]);
  resetHeaderState();
  turnOpen = false;
  optimistic = false;
  clearOptimistic();
  lastSeq = 0;
  itemFilter = null;
}

/** The latest load while one runs: its superseded predecessors return early. */
let inFlight: Promise<void> | null = null;

/** (Re)load the current session, the load kept as `inFlight` for a caller that needs its rows. */
function loadSession(id: string, paged?: SnapshotRead): Promise<void> {
  if (currentId !== id) return Promise.resolve();
  const load = drawSession(id, paged).finally(() => {
    if (inFlight === load) inFlight = null;
  });
  inFlight = load;
  return load;
}

/** Fetch the snapshot, paint it and reconnect the event stream. */
async function drawSession(id: string, paged?: SnapshotRead): Promise<void> {
  const keep = paged !== undefined;
  const generation = ++loadSeq;
  source?.close();
  source = null;
  loading = true;
  snapshotReady = false;
  // Ordinary loads paint their loading state; paging already has both snapshots and commits synchronously.
  if (!keep) {
    resetPane();
    chatLoading(true);
  }
  const problem = (paneItem = item);
  // Read first: its `lastSeq` is the cursor, and the head's snapshot read after it is no older.
  const view = problem && chainId ? await getJson<ItemTurns>(itemTurnsUrl(problem, chainId), `Could not load the item "${problem}"`) : null;
  if (currentId !== id || generation !== loadSeq) return;
  const got = paged ?? await getJson<SessionSnapshot>(`/api/sessions/${id}/history`, "failed to load session");
  if (currentId !== id || generation !== loadSeq) return;
  // A near-empty head opens with the sessions before it, read before the one paint; `loading` holds off a scroll's page meanwhile.
  const before = chain.slice(1, 1 + AUTO_PAGES);
  if (!keep && !view && got.ok && !("readonly" in got.value) && continuousOpen() && !earlier.length && before.length && shortHead(got.value.turns)) {
    const read = await readEarlier(before);
    if (currentId !== id || generation !== loadSeq) return;
    earlier = read;
  }
  loading = false;
  // Measured here, not before the fetch: the reader may scroll, an image load or a resize move the pane meanwhile.
  const fromBottom = keep ? turnsPane.scrollHeight - turnsPane.scrollTop : 0;
  // A keyboard page keeps the keyboard on the pager, which the reload replaced.
  const focused = keep && document.activeElement?.id === "chain-pager";
  if (keep) resetPane();
  if (!got.ok) {
    chatLoading(false);
    appendTurn("error", got.error);
    // A head the server found gone has been replaced; the re-read chain moves the pane there.
    if (continuousOpen()) void refreshSessions();
    return;
  }
  if (view && !view.ok) {
    chatLoading(false);
    return itemMissing(view.error, () => openContinuous());
  }
  // The server answers a session rotated past since the chain's read as an earlier member: no cursor to follow.
  if ("readonly" in got.value) {
    if (keep) chatLoading(true);
    void refreshSessions().finally(() => {
      // A follow or a newer navigation took the pane meanwhile.
      if (currentId !== id || generation !== loadSeq) return;
      if (headId() !== id) {
        endVoice(); // a rotation, as refreshSessions' own follow
        return void select(id, false);
      }
      // The chain is unread or still names it: said, not left loading; the retried re-list follows.
      chatLoading(false);
      appendTurn("error", "This session is no longer the conversation's head, and the new head could not be read yet.");
    });
    return;
  }
  snapshotReady = true;
  const snap = got.value;
  const cursor = view?.value ?? snap;
  // A hash naming an alias is the item under its key now: the bar and every stamped send say the key.
  if (view && view.value.problem !== item) {
    item = paneItem = view.value.problem;
    setItemHash(item, true);
    renderHeader();
  }
  if (view) itemFilter = renderItem(view.value, { id, state: snap.state, turns: snap.turns.length }, snap.backgroundRuns);
  else {
    if (continuousOpen()) renderEarlier();
    renderSnapshot(snap.turns, snap.state, snap.backgroundRuns);
  }
  if (keep) {
    keepScroll(fromBottom);
    if (focused) document.getElementById("chain-pager")?.focus({ preventScroll: true });
  }
  lastSeq = cursor.lastSeq;
  // Server is the truth for everything the client would otherwise guess:
  // run state (composer buttons) and the pending queue panel.
  turnOpen = snap.state === "streaming";
  setState(snap.state);
  renderQueue(snap.queue.steering, snap.queue.followUp, snap.queue.parked);
  setSkills(snap.skills);
  // meta is assistant-only (core/types.ts), so the last one that carries it is
  // the last reply — no role test, and none of Array#findLast (web target).
  const lastReply = snap.turns.reduce<number | null>((at, t) => t.meta?.completedAt ?? at, null);
  setHeaderState(snap.model, snap.context, snap.thinkingLevel, lastReply);
  connect(id, `${cursor.epoch}:${cursor.lastSeq}`, generation);
}

// --- wiring ----------------------------------------------------------------------------

// First, before any surface can issue a request: from here on a 401 is the
// login page and not a per-caller error message, and anything that throws on
// the way reaches the server's log instead of only the browser console.
initReport();
initIcons();
guardFetch();
initTheme();

/** This tab's guess at the state its own send caused: the buttons say so before the server does. */
const ownState = (state: SessionState): void => {
  optimistic = state === "streaming";
  setState(state);
};

/** Shared by chat + composer deps: reload only if `id` is still selected. */
const reloadIfCurrent = async (id: string): Promise<void> => {
  if (currentId === id) await loadSession(id);
};

initChat({
  sessionId: () => currentId,
  sessionCwd: () => currentSession()?.cwd ?? null,
  sessionChannel: () => currentSession()?.channel ?? null,
  sessionState: () => currentState,
  continuous: continuousOpen,
  openItem: (target) => void openItem(target),
  itemView: openItemView,
  item: () => item,
  select: (id) => void select(id),
  send: (mode, label, quote) => void send(mode, label, quote),
  ownTurn: (text) => {
    markOptimisticUser(text);
    ownState("streaming"); // an edit resend starts a turn
  },
  reload: reloadIfCurrent,
  quote: setQuote,
});
initComposer({
  sessionId: () => currentId,
  sessionState: () => currentState,
  chatVisible: isChatVisible,
  setState: ownState,
  reload: reloadIfCurrent,
  continuous: continuousOpen,
  item: () => item,
  // The re-list sees the rotation and moves the pane to the new head.
  headMoved: () => void refreshSessions(),
  chain: () => chainId,
  switched: (id) => void openChain(id),
});
initDrawer({
  sessions: () => sessions,
  currentId: () => currentId,
  chain: () => chain,
  chains: () => chainList?.chains ?? [],
  chainId: () => chainId,
  openContinuous,
  open: () => openItems,
  openItem,
  itemView: (problem, id) => void openChain(id ?? chainId, problem),
  reopen: (id, problem) => void unarchive(id).then((why) => {
    if (why) appendTurn("error", why);
    else void openChain(id, problem);
  }),
});
initChains({
  list: () => chainList,
  current: () => chainId,
  go: (id) => void openChain(id),
  refresh: () => void refreshSessions(),
  anchor: () => document.getElementById("chat-title")!,
  docked: renderHeader,
});
// A head keeps the charter it opened with: the pane says so where it is on screen.
onCharterSaved((id, head) => {
  if (head && id === chainId && continuousOpen()) appendTurn("system", "charter saved · applies from the next session — /new starts one");
});
initHeader({
  currentId: () => currentId,
  currentSession,
  openFiles: showFiles,
  toggleFiles,
  openSettings: () => showConsole("settings"),
  continuousOpen,
  rotateAt: () => rotateAt,
  openContinuous,
  back: () => void openChain((currentId && launchedFrom.get(currentId)) || chainId),
  chain: () => chainList?.chains.find((c) => c.id === chainId),
  item: () => item,
});
initViews({
  cancelNavigation,
  currentId: () => currentId,
  currentSession,
  select: (id) => void select(id),
  inConversation,
  chainId: () => chainId,
  openChain: (id, problem) => void openChain(id, problem),
  maybeAckRead,
});

initVersion(bundleVersion);
// Also what makes Pier installable and what answers a navigation with the
// network gone; the notification permission is asked for in Settings, never here.
void initPush();

// The last of the three saying "the workbench does not zoom" (index.html,
// style.css): on a pinch, Safari's own gesture events overrule both.
document.addEventListener("gesturestart", (ev) => ev.preventDefault());
noteDownloads();

// Coming back to a hidden tab — or to an unfocused window — is the other way
// turns get seen.
document.addEventListener("visibilitychange", () => {
  // Not `hasFocus()`, which WebKit can report behind another app; iOS brings a
  // page back with no `focus` event, and with no other app beside it.
  windowFocused = document.visibilityState === "visible" && (windowFocused || isIOS());
  maybeAckRead();
  // A hidden tab may have missed `open-items-changed` and the rest of the stream.
  if (document.visibilityState === "visible") void refreshSessions();
});
window.addEventListener("focus", () => { windowFocused = true; maybeAckRead(); });
window.addEventListener("blur", () => { windowFocused = false; });

connectWorkspace();
void refreshSessions().then(applyRoute);
