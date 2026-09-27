// The status panel: what needs you and what is running, counted on the bar's
// status chip and listed in the panel it opens — the open items and the live
// sessions no item holds, one row each. The palette borrows the dots.

import { $, agoLabel, h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { refreshPalette } from "./palette.js";
import { chord, modalOpen } from "./shortcut.js";
import { openRunText } from "../../core/reply.js";
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

/** Amber rows and designs waiting on Finalize; every other row is running. */
const needsYou = (m: Mark | null): boolean => m === "unread" || m === "design";

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
}

function row(r: PanelRow): HTMLElement {
  const li = h("li", ROW);
  const name = h("span", "min-w-0 flex-1 py-1",
    h("span", "flex min-w-0 items-center gap-1.5", h("span", "min-w-0 truncate", r.label), ...(r.who ? tag(r.who, r.who) : [])),
    h("span", "block truncate text-xs leading-4 text-neutral-500", r.detail));
  const status = h("span", `flex-none rounded px-1.5 text-[0.6875rem] font-medium leading-5 ${STATUS_TONE[r.status]}`, r.status);
  const button = h("button", OPEN, name, status);
  button.setAttribute("type", "button");
  button.onclick = () => {
    closeMenu();
    r.open();
  };
  if (r.id === deps.currentId()) button.setAttribute("aria-current", "page");
  li.dataset.sessionId = r.id;
  li.title = r.title;
  li.append(button);
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
    id: target ?? `item:${i.problem}`, label: i.problem, who, detail, status: i.status,
    title: [i.problem, detail, ...i.runs.flatMap((r) => (r.cwd ? [r.cwd] : []))].filter(Boolean).join("\n"),
    open: () => (target ? deps.select(target) : deps.openContinuous()),
  };
}

/** An unlisted run: an item of its own, queued until it starts. */
const unlistedRow = (r: OpenRun, now: number): PanelRow => ({
  ...itemRow({ problem: r.name, stage: "", runs: [r], status: "running" }, now),
  ...(r.state === "queued" ? { status: "queued" as const } : {}),
});

/** The open items, then the unlisted runs, then the live sessions none of them
 *  holds: one row per session, split by who acts next. */
function groups(now: number): { waiting: HTMLElement[]; running: HTMLElement[]; sessions: SessionInfo[] } {
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
  const waits = (r: PanelRow): boolean => r.status === "waiting on you" || r.status === "pending release";
  return { waiting: all.filter(waits).map(row), running: all.filter((r) => !waits(r)).map(row), sessions };
}

// --- the chip and the panel -------------------------------------------------------------

/** The panel's two lists while it is open; a render fills them in place. */
let lists: [HTMLElement, HTMLElement] | null = null;
let rows: [HTMLElement[], HTMLElement[]] = [[], []];
/** Any row: the chip is there, and opens the panel. */
let shown = false;

/** Short-circuit: a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const { waiting, running, sessions } = groups(Date.now());
  rows = [waiting, running];
  // The app icon counts a turn to look at — unread, or a design to finalize —
  // plus the conversation's own unread reply, which the bar stands for instead of a row.
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + (headSession()?.unread ? 1 : 0));
  const counts = [...(running.length ? [`${running.length} running`] : []), ...(waiting.length ? [`${waiting.length} needs you`] : [])];
  const text = counts.join(" · ");
  shown = !!text;
  chip.textContent = text;
  chip.classList.toggle("hidden", !text);
  chip.classList.toggle("block", !!text);
  chip.classList.toggle("text-amber-700", waiting.length > 0);
  chip.classList.toggle("text-neutral-600", waiting.length === 0);
  if (lists?.[0].isConnected && !lists[0].closest("[inert]")) {
    if (!shown) closeMenu();
    else fill(lists);
  }
  refreshPalette(); // its dots read the same sessions
}

/** Refill keeping the focused row focused: Escape has to find its way back.
 *  A group with no rows loses its head. */
function fill(into: [HTMLElement, HTMLElement]): void {
  const focusId = document.activeElement?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  into.forEach((ul, i) => {
    ul.replaceChildren(...rows[i]!);
    ul.previousElementSibling?.classList.toggle("hidden", !rows[i]!.length);
  });
  into[1].previousElementSibling?.classList.toggle("mt-2", rows[0].length > 0);
  if (!focusId) return;
  rows.flat().find((r) => r.dataset.sessionId === focusId)?.querySelector<HTMLElement>(".session-open")?.focus({ preventScroll: true });
}

const HEAD = "px-2 pb-1 text-xs font-semibold leading-5 text-neutral-500";

/** Nothing to show is the chip's absence, not an empty panel. */
export function openDrawer(): void {
  if (chip.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!shown) return;
  const [waiting, running] = [h("ul", ""), h("ul", "")];
  waiting.dataset.list = "waiting";
  running.dataset.list = "running";
  const panel = h("div", "w-[min(32rem,calc(100vw-2rem))] max-sm:w-full font-sans text-sm",
    h("div", HEAD, "Waiting on you"), waiting, h("div", HEAD, "In progress"), running);
  lists = [waiting, running];
  fill(lists);
  openPanel(chip, panel).setAttribute("aria-label", "Status");
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  chip.onclick = openDrawer;
  // Stands down under a modal: the palette is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
