// The In progress drawer: what is running and what needs you, counted on the
// bar's status chip and listed in a panel under it. The palette borrows its
// order, dots and Running set.

import { $, h, relTime } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { refreshPalette } from "./palette.js";
import { chord, modalOpen } from "./shortcut.js";
import { type ChainMember, type LeadPhase, type OpenItems, type OpenRun, type SessionState } from "../../core/types.js";

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
export interface DrawerDeps {
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

/** The server marks only the sessions this workbench is the reader of
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

/** A worker's session is never a row, so its run's state picks the mark. */
const runDot = (r: OpenRun): HTMLElement[] => (r.state === "running" ? markDot(WORKING) : []);

const tag = (text: string, title: string): HTMLElement[] => {
  const el = h("span", "flex-none rounded bg-neutral-100 px-1 text-[0.6875rem] font-medium leading-4 text-neutral-500", text);
  el.title = title;
  return [el];
};

/** The palette's Running set, less the conversation's own sessions, which the
 *  bar stands for; a finished lead stays while unread and leaves once viewed. */
export function inProgress(list: SessionInfo[], chain: ChainMember[]): SessionInfo[] {
  const members = new Set(chain.map((m) => m.sessionId));
  return list.filter((s) => isLive(s) && !members.has(s.id));
}

/** The drawer's session rows, for the palette's Running group. */
export const running = (): SessionInfo[] => inProgress(deps.sessions(), deps.chain());

/** The conversation's head row, whose dot the `‹` and the palette's Conversation row wear. */
export const headSession = (): SessionInfo | undefined => {
  const head = deps.chain()[0]?.sessionId;
  return deps.sessions().find((s) => s.id === head);
};

// --- rows ---------------------------------------------------------------------------------

const ROW = "flex items-center gap-1 rounded-[10px] px-1.5 hover:bg-neutral-100";
const OPEN = "session-open flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left";

/** A readable channel initial without a box on every IM row. */
const CHIP = "flex-none text-xs font-medium uppercase leading-5 text-neutral-500";

/** Typing into a Slack thread's session sends to the people in that thread.
 *  `web` is nearly every row, so it is not said; one letter, name in the tooltip. */
const channelChip = (s: SessionInfo): HTMLElement[] =>
  s.channel && s.channel !== "web" ? [h("span", CHIP, s.channel[0] ?? "")] : [];

function row(label: string, marks: HTMLElement[], id: string, title: string, open: () => void, extra: HTMLElement[] = []): HTMLElement {
  const li = h("li", ROW);
  const button = h("button", OPEN, h("span", "min-w-0 flex-1 truncate", label), ...marks);
  button.setAttribute("type", "button");
  button.onclick = () => {
    closeMenu();
    open();
  };
  if (id === deps.currentId()) button.setAttribute("aria-current", "page");
  li.dataset.sessionId = id;
  li.title = title;
  li.append(button, ...extra);
  return li;
}

// The facts the row has no room for, on the native tooltip: where it runs,
// when it last moved, and — for an IM session — who it answers.
const sessionRow = (s: SessionInfo): HTMLElement =>
  row(s.title ?? "untitled", [...phaseTag(s), ...stateDot(s)], s.id, [
    s.cwd,
    `active ${relTime(lastActive(s))} ago · created ${new Date(s.createdAt).toLocaleDateString()}`,
    ...(s.channel && s.channel !== "web" ? [`answering ${s.channel}`] : []),
  ].join("\n"), () => deps.select(s.id), channelChip(s));

const live = (r: OpenRun): boolean => r.state === "running" || r.state === "queued";

/** The open items' live runs no session row stands for (a worker's), after the
 *  session rows; what waits on the user is `/status`'s. */
function openRuns(listed: Set<string>): OpenRun[] {
  const open = deps.open();
  if (!open) return [];
  return [...open.items.flatMap((i) => i.runs), ...open.unlisted]
    .filter((r) => live(r) && !(r.targetSessionId && listed.has(r.targetSessionId)));
}

const runRow = (r: OpenRun): HTMLElement => {
  const target = r.targetSessionId;
  return row(r.name, [...tag("run", `run ${r.runId} · ${r.state}`), ...runDot(r)], `run:${r.runId}`,
    `run ${r.runId} · ${r.state}${r.cwd ? `\n${r.cwd}` : ""}`, () => (target ? deps.select(target) : deps.openContinuous()));
};

// --- the chip and the panel -------------------------------------------------------------

/** The panel's list while it is open; a render fills it in place. */
let list: HTMLElement | null = null;
let rows: HTMLElement[] = [];

/** Short-circuit (as in ui/activity.ts): a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const sessions = inProgress(deps.sessions(), deps.chain());
  const runs = openRuns(new Set(deps.sessions().map((s) => s.id)));
  const waiting = sessions.filter((s) => needsYou(markOf(s))).length;
  const busy = sessions.length + runs.length - waiting;
  rows = [...sessions.map(sessionRow), ...runs.map(runRow)];
  // The app icon counts the chip's set plus the conversation's own unread reply,
  // which the bar stands for instead of a row and is the one most worth a badge.
  setUnreadBadge(waiting + (headSession()?.unread ? 1 : 0));
  const text = [...(busy ? [`${busy} running`] : []), ...(waiting ? [`${waiting} needs you`] : [])].join(" · ");
  chip.textContent = text;
  chip.classList.toggle("hidden", !text);
  chip.classList.toggle("block", !!text);
  chip.classList.toggle("text-amber-700", waiting > 0);
  chip.classList.toggle("text-neutral-600", waiting === 0);
  if (list?.isConnected && !list.closest("[inert]")) {
    if (!rows.length) closeMenu();
    else fill(list);
  }
  refreshPalette(); // it draws the same rows, from the same list
}

/** Refill keeping the focused row focused: Escape has to find its way back. */
function fill(into: HTMLElement): void {
  const focusId = document.activeElement?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  into.replaceChildren(...rows);
  if (!focusId) return;
  rows.find((r) => r.dataset.sessionId === focusId)?.querySelector<HTMLElement>(".session-open")?.focus({ preventScroll: true });
}

/** Nothing to list is the chip's absence, not an empty panel. */
export function openDrawer(): void {
  if (chip.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!rows.length) return;
  const ul = h("ul", "");
  ul.dataset.list = "";
  fill(ul);
  list = ul;
  const panel = h("div", "w-80 max-w-full font-sans text-sm", h("div", "px-2 pb-1 text-xs font-semibold leading-5 text-neutral-500", "In progress"), ul);
  openPanel(chip, panel).setAttribute("aria-label", "In progress");
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  chip.onclick = openDrawer;
  // Stands down under a modal: the palette is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
