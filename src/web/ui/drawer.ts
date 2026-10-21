// The status panel: what needs you and what is running, led in the bar by its
// most urgent row and listed in the panel that row opens — the open items and
// the live sessions no item holds, one row each.

import { $, agoLabel, h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { chord, modalOpen } from "./shortcut.js";
import { openItemPresentation } from "../../core/open-items.js";
import { openItemRow, paintDot, paintStatus, stageLine, stagePhrase } from "./open-items.js";
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
}

/** Everything the drawer needs from the orchestrator (main.ts). */
interface DrawerDeps {
  /** Newest first, by birth (main.ts `commitSessions`). */
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  /** The continuous conversation's sessions, newest first; its row is the bar's title, not a drawer row. */
  chain: () => ChainMember[];
  openContinuous: () => void;
  /** `GET /api/continuous/open`; null before it answers. */
  open: () => OpenItems | null;
  openItem: (target: OpenItemTarget) => void;
}

let deps: DrawerDeps;

const lead = $("#status-item");
const leadDot = $("#status-item-dot");
const leadTitle = $("#status-item-title");
const leadState = $("#status-item-state");
const leadStage = $("#status-item-stage");
const leadCount = $("#status-item-count");
const next = $("#status-next");

// --- marks -------------------------------------------------------------------------------

/** A session Pi has not persisted yet has no transcript to date; its creation
 *  is the last thing that happened to it. Tooltip only. */
const lastActive = (s: SessionInfo): number => s.modified ?? s.createdAt;

/** The server marks only a turn the operator sent into, or the conversation's
 *  (web/server.ts), so the flag is the whole rule here. */
const waitingForYou = (s: SessionInfo): boolean => s.unread;

/** A session with something going on in it: running, waiting for a look,
 *  subagents in flight or a lead's run queued — what the dot marks, and what the drawer lists. */
export const isLive = (s: SessionInfo): boolean =>
  s.state === "streaming" || waitingForYou(s) || s.activeRuns > 0 || s.runLive === true;

/** The dot's colour, in precedence order; the chip counts by the same answer. */
type Mark = "working" | "unread" | "runs" | "queued";

function markOf(s: SessionInfo): Mark | null {
  if (s.state === "streaming") return "working";
  if (waitingForYou(s)) return "unread";
  if (s.activeRuns > 0) return "runs";
  return s.runLive ? "queued" : null;
}

/** Green = running, amber = waiting for a look, sky = subagents in flight,
 *  grey = a lead's run queued. Idle has no mark or slot. */
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
          : ["bg-neutral-400", "lead — run queued"],
  );
}

const WORKING: [string, string] = ["bg-green-500 running-dot", "working…"];

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
};

/** A session's mark read as a row status, so a session and an item wait on you by one rule. */
const needsYou = (m: Mark | null): boolean => !!m && waitsOnYou(MARK_ROW[m][0]);

function sessionRow(s: SessionInfo, mark: Mark): OpenItemPresentation {
  const [status, says] = MARK_ROW[mark];
  const p = openItemPresentation({ problem: s.title ?? "untitled", stage: says(s), status, runs: [] }, Date.now(), `session:${s.id}`);
  return { ...p, direct: true, runs: [{ runId: s.id, targetSessionId: s.id }],
    metadata: [whoOf(s), `active ${agoLabel(lastActive(s))}`].filter(Boolean) };
}

const itemRow = (i: OpenItem, now: number): OpenItemPresentation => openItemPresentation(i, now);

function unlistedRow(r: OpenRun, now: number): OpenItemPresentation {
  return { ...openItemPresentation({ problem: r.name, title: r.title, stage: "", runs: [r], status: r.state === "queued" ? "queued" : "running" }, now, `run:${r.runId}`), direct: true };
}

const rowNodes = new Map<string, HTMLElement>();

/** Items keep their own identity even when they hold the same session; only independent sessions deduplicate. */
function listed(now: number): { rows: HTMLElement[]; ordered: OpenItemPresentation[]; sessions: SessionInfo[] } {
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
  const ordered = [...waiting, ...all.filter((r) => !waits(r))];
  const rows = ordered.map((p) => {
    const node = openItemRow(p, {
      currentId: deps.currentId(),
      openItem: (target) => { closeMenu(); deps.openItem(target); },
    }, rowNodes.get(p.key));
    rowNodes.set(p.key, node);
    return node;
  });
  return { rows, ordered, sessions };
}

// --- the lead and the panel -------------------------------------------------------------

/** The panel's list while it is open; a render fills it in place. */
let list: HTMLElement | null = null;
let rows: HTMLElement[] = [];
let ordered: OpenItemPresentation[] = [];
/** The row the bar leads with: the most urgent until the counter cycles it on,
 *  and again once a different row becomes the most urgent. */
let shownKey: string | null = null;
let topKey: string | null = null;

/** Short-circuit: a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const { sessions, ...got } = listed(Date.now());
  rows = got.rows;
  ordered = got.ordered;
  // The app icon counts a turn to look at — an unread one —
  // plus the conversation's own unread reply, which the bar stands for instead of a row.
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + (headSession()?.unread ? 1 : 0));
  paintLead();
  if (list?.isConnected && !list.closest("[inert]")) {
    if (!rows.length) closeMenu();
    else fill(list);
  }
}

/** Dot, title, status mark and phrase of the shown row; below md the status glyph and the row count only (index.html). */
function paintLead(): void {
  if (ordered[0]?.key !== topKey) shownKey = topKey = ordered[0]?.key ?? null;
  const at = Math.max(0, ordered.findIndex((p) => p.key === shownKey));
  const p = ordered[at];
  shownKey = p?.key ?? null;
  lead.classList.toggle("hidden", !p);
  lead.classList.toggle("flex", !!p);
  next.classList.toggle("hidden", ordered.length < 2);
  if (!p) return;
  paintDot(leadDot, p);
  paintStatus(leadState, p);
  leadTitle.textContent = p.title;
  leadStage.textContent = stagePhrase(p);
  leadCount.textContent = String(ordered.length);
  lead.title = `${p.title} — ${stageLine(p)}`;
  lead.setAttribute("aria-label", `Status: ${ordered.length} open — ${lead.title}`);
  next.textContent = `${at + 1}/${ordered.length}`;
}

function cycleLead(): void {
  const at = ordered.findIndex((p) => p.key === shownKey);
  shownKey = ordered[(at + 1) % ordered.length]?.key ?? null;
  paintLead();
}

/** Refill keeping the focused control focused: Escape has to find its way back. */
function fill(into: HTMLElement): void {
  const focused = into.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const top = into.scrollTop;
  rows.forEach((row, index) => { if (into.children[index] !== row) into.insertBefore(row, into.children[index] ?? null); });
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  into.scrollTop = top;
}

/** Nothing to show is the lead's absence, not an empty panel. */
export function openDrawer(): void {
  if (lead.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!rows.length) return;
  list = h("ul", "");
  list.dataset.list = ""; // the arrows' walk (menu.ts listIn)
  fill(list);
  openPanel(lead, h("div", "w-[min(32rem,calc(100vw-2rem))] max-sm:w-full font-sans text-sm", list)).setAttribute("aria-label", "Status");
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  lead.onclick = openDrawer;
  next.onclick = cycleLead;
  // Stands down under a modal: it is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
