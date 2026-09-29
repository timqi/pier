// The status panel: what needs you and what is running, counted on the bar's
// status chip and listed in the panel it opens — the open items and the live
// sessions no item holds, one row each.
// The palette borrows the dots.

import { $, agoLabel, h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { refreshPalette } from "./palette.js";
import { chord, modalOpen } from "./shortcut.js";
import { topicColour } from "./topics.js";
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
  /** Opens the conversation at the topic's latest reply; false when none is on screen,
   *  the pane then at its tail unless `elsewhere` says the caller has somewhere to go. */
  showTopic: (problem: string, elsewhere: boolean) => Promise<boolean>;
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

/** Status is said in words, the tone only repeats it; `running` is the dot's pulse, not a word. */
const STATUS_TONE: Record<Exclude<RowStatus, "running">, string> = {
  // Solid, dark enough for white text: the one status that asks something of the reader.
  "waiting on you": "bg-amber-700 text-white",
  queued: "bg-neutral-100 text-neutral-600",
  "pending release": "bg-neutral-100 text-neutral-600",
  stopped: "bg-neutral-100 text-neutral-600",
};

/** Every panel row reads the same: its dot, what it is, and — as the second
 *  line — where it stands; then its status, unless that is `running`. */
interface PanelRow {
  id: string;
  dot: HTMLElement;
  label: string;
  who: string;
  detail: string;
  status: RowStatus;
  title: string;
  open: () => void;
}

let rowSeq = 0;

function row(r: PanelRow): HTMLElement {
  const li = h("li", ROW);
  const name = h("span", "min-w-0 flex-1 py-1",
    h("span", "flex min-w-0 items-center gap-1.5", h("span", "min-w-0 truncate", r.label), ...(r.who ? tag(r.who, r.who) : [])),
    h("span", "block truncate text-xs leading-4 text-neutral-500", r.detail));
  const button = h("button", OPEN, r.dot, name);
  button.setAttribute("type", "button");
  button.onclick = () => {
    closeMenu();
    r.open();
  };
  if (r.id === deps.currentId()) button.setAttribute("aria-current", "page");
  li.dataset.sessionId = r.id;
  li.title = r.title;
  li.append(button);
  if (r.status !== "running") {
    const status = h("span", `row-status flex-none rounded px-1.5 text-[0.6875rem] font-medium leading-5 ${STATUS_TONE[r.status]}`, r.status);
    // The status sits beside the button, not in it: it is still the button's description.
    status.id = `status-row-${String(++rowSeq)}`;
    button.setAttribute("aria-describedby", status.id);
    li.append(status);
  }
  return li;
}

/** A topic's colour, or grey for a run no item names; it pulses while a run of it is. */
function runDot(problem: string | null, live: boolean): HTMLElement {
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${problem ? "" : "bg-neutral-400"} ${live ? "animate-pulse" : ""}`);
  if (problem) dot.style.background = topicColour(problem);
  return dot;
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
    id: s.id, dot: stateDot(s)[0]!, label: s.title ?? "untitled", who: whoOf(s), status,
    detail: `${says(s)} · active ${agoLabel(lastActive(s))}`,
    title: [s.cwd, `created ${new Date(s.createdAt).toLocaleDateString()}`, ...(s.channel && s.channel !== "web" ? [`answering ${s.channel}`] : [])].join("\n"),
    open: () => deps.select(s.id),
  };
}

/** An open item: its problem and its stage — its runs where it names none, and
 *  on the tooltip with who runs them. It lands on the topic's latest reply, else
 *  its first run's session. */
function itemRow(i: OpenItem, now: number): PanelRow {
  const runs = i.runs.map((r) => openRunText(r, now)).join(" · ");
  const run = i.runs.find((r) => r.targetSessionId);
  const target = run?.targetSessionId ?? undefined;
  const who = run ? whoOf(deps.sessions().find((s) => s.id === target)) || (run.workers ? "lead" : "worker") : "";
  return {
    id: target ?? `item:${i.problem}`, dot: runDot(i.problem, i.runs.some((r) => r.state === "running")),
    label: i.problem, who: "", detail: i.stage || runs, status: i.status,
    title: [i.problem, i.stage, runs, who, ...i.runs.flatMap((r) => (r.cwd ? [r.cwd] : []))].filter(Boolean).join("\n"),
    open: () => void deps.showTopic(i.problem, !!target).then((shown) => {
      if (!shown && target) deps.select(target);
    }),
  };
}

/** An unlisted run: an item of its own, queued until it starts, opening its session. */
function unlistedRow(r: OpenRun, now: number): PanelRow {
  const target = r.targetSessionId;
  return {
    ...itemRow({ problem: r.name, stage: "", runs: [r], status: "running" }, now),
    dot: runDot(null, r.state === "running"),
    open: () => (target ? deps.select(target) : deps.openContinuous()),
    ...(r.state === "queued" ? { status: "queued" as const } : {}),
  };
}

/** The open items, then the unlisted runs, then the live sessions none of them
 *  holds: one row per session, what waits on you first. */
function listed(now: number): { rows: HTMLElement[]; waiting: number; runningCount: number; sessions: SessionInfo[] } {
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
  const waiting = all.filter(waits);
  return { rows: [...waiting, ...all.filter((r) => !waits(r))].map(row), waiting: waiting.length, runningCount: all.filter((r) => r.status === "running").length, sessions };
}

// --- the chip and the panel -------------------------------------------------------------

/** The panel's list while it is open; a render fills it in place. */
let list: HTMLElement | null = null;
let rows: HTMLElement[] = [];

/** Short-circuit: a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const { waiting, runningCount, sessions, ...got } = listed(Date.now());
  rows = got.rows;
  // The app icon counts a turn to look at — unread, or a design to finalize —
  // plus the conversation's own unread reply, which the bar stands for instead of a row.
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + (headSession()?.unread ? 1 : 0));
  // The rows open the panel; the counts are only its copy, and a row neither counts is still an entrance.
  const counts = [...(runningCount ? [`${runningCount} running`] : []), ...(waiting ? [`${waiting} needs you`] : [])];
  const shown = rows.length > 0;
  chip.textContent = counts.join(" · ") || (shown ? `${rows.length} open` : "");
  chip.classList.toggle("hidden", !shown);
  chip.classList.toggle("block", shown);
  chip.classList.toggle("text-amber-700", waiting > 0);
  chip.classList.toggle("text-neutral-600", waiting === 0);
  if (list?.isConnected && !list.closest("[inert]")) {
    if (!shown) closeMenu();
    else fill(list);
  }
  refreshPalette(); // its dots read the same sessions
}

/** Refill keeping the focused control focused: Escape has to find its way back. */
function fill(into: HTMLElement): void {
  const focusId = document.activeElement?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  into.replaceChildren(...rows);
  if (!focusId) return;
  rows.find((r) => r.dataset.sessionId === focusId)?.querySelector<HTMLElement>(".session-open")?.focus({ preventScroll: true });
}

/** Nothing to show is the chip's absence, not an empty panel. */
export function openDrawer(): void {
  if (chip.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!rows.length) return;
  list = h("ul", "");
  list.dataset.list = "status"; // the arrows' walk (menu.ts listIn)
  fill(list);
  openPanel(chip, h("div", "w-[min(32rem,calc(100vw-2rem))] max-sm:w-full font-sans text-sm", list)).setAttribute("aria-label", "Status");
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  chip.onclick = openDrawer;
  // Stands down under a modal: the palette is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
