// The status panel: what needs you and what is running, counted on the bar's
// status chip and listed in the panel it opens, or docked beside the chat on a
// wide window — the open items and the live sessions no item holds, one row each.

import { $, agoLabel, h } from "./dom.js";
import { closeMenu, listStep, openPanel, walkRows } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { chord, modalOpen } from "./shortcut.js";
import { openItemPresentation } from "../../core/open-items.js";
import { openItemRow } from "./open-items.js";
import { waitsOnYou } from "../../core/reply.js";
import type { ChainMember, LeadPhase, OpenItemPresentation, OpenItemTarget, SessionState } from "../../core/types.js";
import type { OpenItem, OpenItems, OpenRun } from "../../tasks/types.js";

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
  openItem: (target: OpenItemTarget) => void;
}

let deps: DrawerDeps;

const chip = $("#status-chip");
const side = $("#status-side");
const sideHead = $("#status-side-head");
const sideList = $("#status-side-list");

/** Where the list docks instead of floating; style.css `#status-side` holds the same width. */
const WIDE = "(width >= 80rem)";
let wide: MediaQueryList;

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

/** The conversation's head row, whose dot the `‹` wears. */
export const headSession = (): SessionInfo | undefined => {
  const head = deps.chain()[0]?.sessionId;
  return deps.sessions().find((s) => s.id === head);
};

// --- rows ---------------------------------------------------------------------------------

type RowStatus = OpenItemPresentation["status"];

/** A lead with its phase; a session outside the web by the channel it answers. */
const whoOf = (s: SessionInfo | undefined): string =>
  s?.phase ? `lead · ${s.phase}` : s?.channel && s.channel !== "web" ? s.channel : "";

const MARK_ROW: Record<Mark, [RowStatus, (s: SessionInfo) => string]> = {
  working: ["running", () => ""],
  unread: ["waiting on you", () => "turn finished — not viewed yet"],
  runs: ["running", (s) => `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`],
  queued: ["queued", () => "run queued"],
  design: ["waiting on you", () => "Finalize design"],
};

/** A session's mark read as a row status, so a session and an item wait on you by one rule. */
const needsYou = (m: Mark | null): boolean => !!m && waitsOnYou(MARK_ROW[m][0]);

function sessionRow(s: SessionInfo, mark: Mark): OpenItemPresentation {
  const [status, says] = MARK_ROW[mark];
  const p = openItemPresentation({ problem: s.title ?? "untitled", stage: says(s), status, runs: [] }, Date.now(), `session:${s.id}`);
  return { ...p, direct: true, runs: [{ runId: s.id, targetSessionId: s.id }],
    metadata: [whoOf(s), `active ${agoLabel(lastActive(s))}`].filter(Boolean),
    details: [...p.details, { text: `${s.cwd}\ncreated ${new Date(s.createdAt).toLocaleDateString()}` }] };
}

const itemRow = (i: OpenItem, now: number): OpenItemPresentation => openItemPresentation(i, now);

function unlistedRow(r: OpenRun, now: number): OpenItemPresentation {
  return { ...openItemPresentation({ problem: r.name, title: r.title, stage: "", runs: [r], status: r.state === "queued" ? "queued" : "running" }, now, `run:${r.runId}`), direct: true };
}

const rowNodes = new Map<string, HTMLElement>();

/** Items keep their own identity even when they hold the same session; only independent sessions deduplicate. */
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
  const waits = (r: OpenItemPresentation): boolean => waitsOnYou(r.status);
  const waiting = all.filter(waits);
  const keys = new Set(all.map((p) => p.key));
  for (const [key, node] of rowNodes) if (!keys.has(key)) { node.remove(); rowNodes.delete(key); }
  const rows = [...waiting, ...all.filter((r) => !waits(r))].map((p) => {
    const node = openItemRow(p, {
      currentId: deps.currentId(),
      openItem: (target) => { closeMenu(); deps.openItem(target); },
      select: (id) => { closeMenu(); deps.select(id); },
    }, rowNodes.get(p.key));
    rowNodes.set(p.key, node);
    return node;
  });
  return { rows, waiting: waiting.length, runningCount: all.filter((r) => r.status === "running").length, sessions };
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
  sideHead.textContent = chip.textContent;
  side.toggleAttribute("data-empty", !shown);
  chip.classList.toggle("hidden", !shown);
  chip.classList.toggle("block", shown);
  chip.classList.toggle("text-amber-700", waiting > 0);
  chip.classList.toggle("text-neutral-600", waiting === 0);
  if (wide.matches) fill(sideList);
  else if (list?.isConnected && !list.closest("[inert]")) {
    if (!shown) closeMenu();
    else fill(list);
  }
}

/** Refill keeping the focused control focused: Escape has to find its way back. */
function fill(into: HTMLElement): void {
  const focused = into.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const top = into.scrollTop;
  rows.forEach((row, index) => { if (into.children[index] !== row) into.insertBefore(row, into.children[index] ?? null); });
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  into.scrollTop = top;
}

/** Nothing to show is the chip's absence, not an empty panel; docked, opening
 *  is focusing its first row. */
export function openDrawer(): void {
  if (wide.matches) return sideList.querySelector<HTMLElement>(".session-open")?.focus();
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
  wide = window.matchMedia(WIDE);
  // CSS hiding and the menu's resize handler can blur a control before the media event arrives.
  document.addEventListener("focusout", (ev) => {
    if (ev.relatedTarget) return;
    const control = ev.target as HTMLElement;
    const docking = wide.matches && list?.contains(control);
    if (!docking && (wide.matches || !sideList.contains(control))) return;
    queueMicrotask(() => {
      if (document.activeElement !== document.body) return;
      if (docking) { fill(sideList); control.focus(); }
      else chip.focus();
    });
  });
  // One list, moved: docking takes the rows out of any panel still open.
  wide.addEventListener("change", () => {
    const focused = sideList.contains(document.activeElement);
    if (wide.matches) {
      closeMenu();
      fill(sideList);
    } else if (focused) chip.focus();
  });
  sideList.onkeydown = (ev) => {
    const to = listStep(ev);
    if (to !== undefined && walkRows(sideList, to)) ev.preventDefault();
  };
  // Stands down under a modal: it is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
