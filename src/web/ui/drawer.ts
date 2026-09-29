// The status panel: what needs you and what is running, counted on the bar's
// status chip and listed in the panel it opens — the open items and the live
// sessions no item holds, one row each, then the topics the chat saw done.
// The palette borrows the dots.

import { $, agoLabel, h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { refreshPalette } from "./palette.js";
import { chord, modalOpen } from "./shortcut.js";
import { toggle } from "./form.js";
import { recentDone, topicColour } from "./topics.js";
import { openRunText, waitsOnYou } from "../../core/reply.js";
import type { ChainMember, LeadPhase, SessionState } from "../../core/types.js";
import type { OpenItem, OpenItems, OpenRun, OpenStatus } from "../../tasks/types.js";

/** GET /api/sessions row: summary + live workspace state. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  /** The row's tooltip only: it moves with every background turn, so it orders nothing. */
  modified?: number;
  title?: string;
  state: SessionState;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
  /** The IM channel that owns it, or `"web"` for everything else. */
  channel: string;
  /** Background runs this session launched that are still in flight. */
  activeRuns: number;
  /** A feature lead's session (`pier task run --role lead`): its phase,
   *  designing with the user or building per a doc. */
  phase?: LeadPhase;
  /** That lead's: a run targeting its session is queued or running. */
  runLive?: true;
  /** A design lead's that has not reported `Design final:`: the user finalizes it. */
  designOpen?: true;
}

/** Everything the drawer needs from the orchestrator (main.ts). */
interface DrawerDeps {
  /** Newest first, by birth (main.ts `commitSessions`). */
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  select: (id: string) => void;
  /** The continuous conversation's sessions, newest first; its row is the bar's title, not a drawer row. */
  chain: () => ChainMember[];
  openContinuous: () => void;
  /** `GET /api/continuous/open`; null before it answers. */
  open: () => OpenItems | null;
  /** The topics the chat pane has seen (topics.ts), the one it is filtered to, and the switch. */
  topics: () => { problem: string; done: boolean }[];
  filter: () => string | null;
  setFilter: (problem: string | null) => void;
}

let deps: DrawerDeps;

const chip = $("#status-chip");

// --- marks -------------------------------------------------------------------------------

/** A session Pi has not persisted yet has no transcript to date; its creation
 *  is the last thing that happened to it. Tooltip only. */
const lastActive = (s: SessionInfo): number => s.modified ?? s.createdAt;

/** The server marks only a turn the operator sent into, or the conversation's
 *  (web/server.ts), so the flag is the whole rule here. */
const waitingForYou = (s: SessionInfo): boolean => s.unread;

/** A session with something going on in it: running, waiting for a look,
 *  subagents in flight, a lead's run queued, or a design waiting on the user
 *  to finalize — what the dot marks, and what the drawer lists. */
export const isLive = (s: SessionInfo): boolean =>
  s.state === "streaming" || waitingForYou(s) || s.activeRuns > 0 || s.runLive === true || s.designOpen === true;

/** The dot's colour, in precedence order; the chip counts by the same answer. */
type Mark = "working" | "unread" | "runs" | "queued" | "design";

function markOf(s: SessionInfo): Mark | null {
  if (s.state === "streaming") return "working";
  if (waitingForYou(s)) return "unread";
  if (s.activeRuns > 0) return "runs";
  if (s.runLive) return "queued";
  return s.designOpen ? "design" : null;
}

/** Green = running, amber = waiting for a look, sky = subagents in flight,
 *  grey = a lead's run queued or its design waiting on you. Idle has no mark or slot. */
export function stateDot(s: SessionInfo): HTMLElement[] {
  const mark = markOf(s);
  if (!mark) return [];
  return markDot(
    mark === "working"
      ? WORKING
      : mark === "unread"
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : mark === "runs"
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
          : ["bg-neutral-400", mark === "queued" ? "lead — run queued" : "design — waiting for you to finalize"],
  );
}

const WORKING: [string, string] = ["bg-green-500 animate-pulse", "working…"];

function markDot([cls, title]: [string, string]): HTMLElement[] {
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${cls}`);
  dot.title = title;
  return [dot];
}

/** A lead's phase in English whatever language its title is in; trailing, so a
 *  truncated title never hides it. */
export const phaseTag = (s: SessionInfo): HTMLElement[] => {
  if (!s.phase) return [];
  return tag(s.phase, s.phase === "design" ? "lead — designing with you" : "lead — building per the design");
};

const tag = (text: string, title: string): HTMLElement[] => {
  const el = h("span", "flex-none rounded bg-neutral-100 px-1 text-[0.6875rem] font-medium leading-4 text-neutral-500", text);
  el.title = title;
  return [el];
};

/** The live sessions, less the conversation's own, which the bar stands for;
 *  a finished lead stays while unread and leaves once viewed. */
export function inProgress(list: SessionInfo[], chain: ChainMember[]): SessionInfo[] {
  const members = new Set(chain.map((m) => m.sessionId));
  return list.filter((s) => isLive(s) && !members.has(s.id));
}

/** The conversation's head row, whose dot the `‹` and the palette's Pier row wear. */
export const headSession = (): SessionInfo | undefined => {
  const head = deps.chain()[0]?.sessionId;
  return deps.sessions().find((s) => s.id === head);
};

// --- rows ---------------------------------------------------------------------------------

const ROW = "flex items-center gap-1 rounded-[10px] px-1.5 hover:bg-neutral-100";
const OPEN = "session-open flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left";

/** A row's one status: an open item's (tasks/types.ts `OpenStatus`), or a free
 *  session's, whose lead run may still be queued. */
type RowStatus = OpenStatus | "queued";

/** Status is said in words; the tone only repeats it. */
const STATUS_TONE: Record<RowStatus, string> = {
  "waiting on you": "bg-amber-50 text-amber-700",
  running: "bg-green-50 text-green-700",
  queued: "bg-neutral-100 text-neutral-600",
  "pending release": "bg-neutral-100 text-neutral-600",
  stopped: "bg-neutral-100 text-neutral-600",
};

/** Every panel row reads the same: what it is, who works it, and — as the
 *  second line — where it stands and for how long; then its one status. */
interface PanelRow {
  id: string;
  label: string;
  who: string;
  detail: string;
  status: RowStatus;
  title: string;
  open: () => void;
  /** An open item's problem: its dot and its switch. */
  topic?: string;
}

function row(r: PanelRow): HTMLElement {
  const li = h("li", ROW);
  const name = h("span", "min-w-0 flex-1 py-1",
    h("span", "flex min-w-0 items-center gap-1.5", h("span", "min-w-0 truncate", r.label), ...(r.who ? tag(r.who, r.who) : [])),
    h("span", "block truncate text-xs leading-4 text-neutral-500", r.detail));
  const status = h("span", `row-status flex-none rounded px-1.5 text-[0.6875rem] font-medium leading-5 ${STATUS_TONE[r.status]}`, r.status);
  const button = h("button", OPEN, ...(r.topic ? [topicDot(r.topic)] : []), name);
  button.setAttribute("type", "button");
  button.onclick = () => {
    closeMenu();
    r.open();
  };
  if (r.id === deps.currentId()) button.setAttribute("aria-current", "page");
  li.dataset.sessionId = r.id;
  li.title = r.title;
  li.append(button, ...(r.topic ? [topicSwitch(r.topic)] : []), status);
  return li;
}

function topicDot(problem: string): HTMLElement {
  const dot = h("span", "h-2 w-2 flex-none rounded-full");
  dot.style.background = topicColour(problem);
  return dot;
}

/** Radio semantics through the filter: one topic at a time, and the redraw turns the rest off. */
function topicSwitch(problem: string): HTMLElement {
  const sw = toggle("", "", deps.filter() === problem, (on) => deps.setFilter(on ? problem : null));
  sw.classList.add("topic-switch", "flex-none", "pointer-coarse:min-h-11");
  sw.setAttribute("aria-label", "Only this topic in the chat");
  sw.title = "Only this topic in the chat";
  return sw;
}

/** A topic the chat saw a `<done>` for: nothing to open, only its filter. */
function doneRow(problem: string): HTMLElement {
  const li = h("li", `${ROW} min-h-10`, topicDot(problem), h("span", "min-w-0 flex-1 truncate", problem), topicSwitch(problem));
  li.dataset.sessionId = `topic:${problem}`;
  li.title = problem;
  return li;
}

/** A lead with its phase; a session outside the web by the channel it answers. */
const whoOf = (s: SessionInfo | undefined): string =>
  s?.phase ? `lead · ${s.phase}` : s?.channel && s.channel !== "web" ? s.channel : "";

const MARK_ROW: Record<Mark, [RowStatus, (s: SessionInfo) => string]> = {
  working: ["running", () => "working"],
  unread: ["waiting on you", () => "turn finished — not viewed yet"],
  runs: ["running", (s) => `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`],
  queued: ["queued", () => "run queued"],
  design: ["waiting on you", () => "design — finalize when it is ready"],
};

/** A session's mark read as a row status, so a session and an item wait on you by one rule. */
const needsYou = (m: Mark | null): boolean => !!m && waitsOnYou(MARK_ROW[m][0]);

// The facts the row has no room for, on the native tooltip: where it runs,
// when it was created, and — for an IM session — who it answers.
function sessionRow(s: SessionInfo, mark: Mark): PanelRow {
  const [status, says] = MARK_ROW[mark];
  return {
    id: s.id, label: s.title ?? "untitled", who: whoOf(s), status,
    detail: `${says(s)} · active ${agoLabel(lastActive(s))}`,
    title: [s.cwd, `created ${new Date(s.createdAt).toLocaleDateString()}`, ...(s.channel && s.channel !== "web" ? [`answering ${s.channel}`] : [])].join("\n"),
    open: () => deps.select(s.id),
  };
}

/** An open item: its problem, who runs it (the first run's session, a lead's
 *  with its phase), its runs and stage as the second line; it opens that session, else the conversation. */
function itemRow(i: OpenItem, now: number): PanelRow {
  // Runs first: a long stage truncates, and the state and age are what the row must keep.
  const detail = [...i.runs.map((r) => openRunText(r, now)), i.stage].filter(Boolean).join(" · ");
  const run = i.runs.find((r) => r.targetSessionId);
  const target = run?.targetSessionId ?? undefined;
  const who = run ? whoOf(deps.sessions().find((s) => s.id === target)) || (run.workers ? "lead" : "worker") : "";
  return {
    id: target ?? `item:${i.problem}`, label: i.problem, who, detail, status: i.status, topic: i.problem,
    title: [i.problem, detail, ...i.runs.flatMap((r) => (r.cwd ? [r.cwd] : []))].filter(Boolean).join("\n"),
    open: () => (target ? deps.select(target) : deps.openContinuous()),
  };
}

/** An unlisted run: an item of its own, queued until it starts. */
const unlistedRow = (r: OpenRun, now: number): PanelRow => {
  const { topic: _, ...item } = itemRow({ problem: r.name, stage: "", runs: [r], status: "running" }, now);
  return { ...item, ...(r.state === "queued" ? { status: "queued" as const } : {}) };
};

/** The open items, then the unlisted runs, then the live sessions none of them
 *  holds: one row per session, split by who acts next. */
function groups(now: number): { waiting: HTMLElement[]; running: HTMLElement[]; done: HTMLElement[]; runningCount: number; sessions: SessionInfo[] } {
  const open = deps.open() ?? { items: [], unlisted: [] };
  const held = new Set([...open.items.flatMap((i) => i.runs), ...open.unlisted].flatMap((r) => (r.targetSessionId ? [r.targetSessionId] : [])));
  const sessions = inProgress(deps.sessions(), deps.chain());
  const all = [
    ...open.items.map((i) => itemRow(i, now)),
    ...open.unlisted.map((r) => unlistedRow(r, now)),
    ...sessions.flatMap((s) => {
      const mark = markOf(s);
      return mark && !held.has(s.id) ? [sessionRow(s, mark)] : [];
    }),
  ];
  const waits = (r: PanelRow): boolean => waitsOnYou(r.status);
  const listed = new Set(open.items.map((i) => i.problem));
  const done = recentDone(deps.topics()).filter((p) => !listed.has(p)).map(doneRow);
  return { waiting: all.filter(waits).map(row), running: all.filter((r) => !waits(r)).map(row), done, runningCount: all.filter((r) => r.status === "running").length, sessions };
}

// --- the chip and the panel -------------------------------------------------------------

/** The panel's three lists while it is open; a render fills them in place. */
let lists: [HTMLElement, HTMLElement, HTMLElement] | null = null;
let rows: HTMLElement[][] = [[], [], []];
/** Any row: the chip is there, and opens the panel. */
let shown = false;

/** Short-circuit: a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}\n${JSON.stringify(deps.topics())}\n${deps.filter() ?? ""}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const { waiting, running, done, runningCount, sessions } = groups(Date.now());
  rows = [waiting, running, done];
  // The app icon counts a turn to look at — unread, or a design to finalize —
  // plus the conversation's own unread reply, which the bar stands for instead of a row.
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + (headSession()?.unread ? 1 : 0));
  // The rows open the panel; the counts are only its copy, and a row neither counts is still an entrance.
  const total = waiting.length + running.length;
  const counts = [...(runningCount ? [`${runningCount} running`] : []), ...(waiting.length ? [`${waiting.length} needs you`] : [])];
  shown = total > 0 || done.length > 0;
  chip.textContent = counts.join(" · ") || (total ? `${total} open` : shown ? "topics" : "");
  chip.classList.toggle("hidden", !shown);
  chip.classList.toggle("block", shown);
  chip.classList.toggle("text-amber-700", waiting.length > 0);
  chip.classList.toggle("text-neutral-600", waiting.length === 0);
  if (lists?.[0].isConnected && !lists[0].closest("[inert]")) {
    if (!shown) closeMenu();
    else fill(lists);
  }
  refreshPalette(); // its dots read the same sessions
}

/** Refill keeping the focused control focused: Escape has to find its way back.
 *  A group with no rows loses its head. */
function fill(into: HTMLElement[]): void {
  const focused = document.activeElement;
  const focusId = focused?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  const control = focused?.matches("input") ? "input" : ".session-open";
  into.forEach((ul, i) => {
    ul.replaceChildren(...rows[i]!);
    ul.previousElementSibling?.classList.toggle("hidden", !rows[i]!.length);
    ul.previousElementSibling?.classList.toggle("mt-2", i > 0 && rows.slice(0, i).some((r) => r.length > 0));
  });
  if (!focusId) return;
  rows.flat().find((r) => r.dataset.sessionId === focusId)?.querySelector<HTMLElement>(control)?.focus({ preventScroll: true });
}

const HEAD = "px-2 pb-1 text-xs font-semibold leading-5 text-neutral-500";

/** Nothing to show is the chip's absence, not an empty panel. */
export function openDrawer(): void {
  if (chip.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!shown) return;
  const [waiting, running, done] = [h("ul", ""), h("ul", ""), h("ul", "")];
  waiting.dataset.list = "waiting";
  running.dataset.list = "running";
  done.dataset.list = "done";
  const panel = h("div", "w-[min(32rem,calc(100vw-2rem))] max-sm:w-full font-sans text-sm",
    h("div", HEAD, "Waiting on you"), waiting, h("div", HEAD, "In progress"), running, h("div", HEAD, "Recently done"), done);
  lists = [waiting, running, done];
  fill(lists);
  openPanel(chip, panel).setAttribute("aria-label", "Status");
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  chip.onclick = openDrawer;
  // Stands down under a modal: the palette is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
