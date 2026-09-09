// The left rail: one flat list of every session Pi lists, the working set on
// top, and the New-session menu. main.ts owns the session list; this module
// renders it and reports interactions back. The ⌘K palette (ui/palette.ts)
// borrows the rail's order, dots and menu rather than keeping its own.

import { Ellipsis } from "lucide";
import { icon } from "./icons.js";
import { sendJson } from "./api.js";
import { openBrowser, openPathMenu } from "./dir-picker.js";
import { $, basename, h, relTime } from "./dom.js";
import { closeMenu } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { refreshPalette } from "./palette.js";
import { setAttention } from "./shell.js";
import { chord, modalOpen, shortcut } from "./shortcut.js";
import type { SessionState } from "../../core/types.js";

/** GET /api/sessions row: summary + live workspace state. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  /** When the transcript was last written — the row's tooltip, and nothing
   *  else: it moved with every background turn, so it orders nothing. Absent
   *  from a session Pi has not persisted yet. */
  modified?: number;
  title?: string;
  state: SessionState;
  /** Place in the working set on top of the rail; unset = not in it. */
  rank?: number;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
  /** The IM channel that owns it, or `"web"` for everything else. */
  channel: string;
  /** Background runs this session launched that are still in flight. */
  activeRuns: number;
}

/** Everything the sidebar needs from the orchestrator (main.ts). */
export interface SidebarDeps {
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  select: (id: string) => void;
  sessionMenu: (anchor: HTMLElement, s: SessionInfo) => void;
  createSession: (cwd: string) => Promise<void>;
  /** The selected session's title changed — the chat header draws it too. */
  onTitleChanged: () => void;
}

let deps: SidebarDeps;

const sessionList = $("#session-list");
const newBtn = $("#new-session");

// --- order -------------------------------------------------------------------------
// Two runs of one list, and neither of them moves on its own. On top, the
// working set the server maintains: a session enters it at the front when a
// human speaks to it, members hold their places until one is pushed out of the
// last slot (web/session-state.ts). Below it, everything else by birth, which
// never changes at all. Nothing here reads `modified` — ordering by it is what
// made the rail jump under the pointer.

/** Rows on the screen before "Load more" is asked for. */
export const PAGE = 20;

/** A session Pi has not persisted yet has no transcript to date; its creation
 *  is the last thing that happened to it. Tooltip only. */
const lastActive = (s: SessionInfo): number => s.modified ?? s.createdAt;

/** The working set in its own order, then the rest newest first. */
export function orderSessions(list: SessionInfo[]): { top: SessionInfo[]; rest: SessionInfo[] } {
  return {
    top: list.filter((s) => s.rank !== undefined).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    rest: list.filter((s) => s.rank === undefined).sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** The first `shown` rows of that order, and how many are still behind
 *  "Load more". The working set counts against the page like any other row. */
export function pageOf(list: SessionInfo[], shown: number): { rows: SessionInfo[]; hidden: number } {
  const { top, rest } = orderSessions(list);
  const rows = [...top, ...rest].slice(0, shown);
  return { rows, hidden: list.length - rows.length };
}

/** The session `by` rows from the current one in the rail's order, hidden rows
 *  included, wrapping at either end; the first row when nothing is selected.
 *  Nothing to move to — an empty rail, or a rail of one — is `undefined`. */
export function neighbor(list: SessionInfo[], currentId: string | null, by: number): string | undefined {
  const { top, rest } = orderSessions(list);
  const order = [...top, ...rest];
  if (!order.length) return undefined;
  const at = order.findIndex((s) => s.id === currentId);
  const next = at < 0 ? order[0] : order[(at + by + order.length) % order.length];
  return next && next.id !== currentId ? next.id : undefined;
}

/** How many the New-session menu lists before "Browse…": a menu is scanned,
 *  not scrolled, and the project you want is almost always a recent one. */
const RECENT_CWDS = 8;

/** Distinct directories, newest session first: what the Settings scope list
 *  offers, and the ground `projectCwds` picks from. */
export const distinctCwds = (list: SessionInfo[]): string[] =>
  [...new Set([...list].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.cwd))];

/** Where a new session is offered: the distinct directories less the
 *  worktrees. `wt` puts a branch's checkout beside its repository as
 *  `<repo>.<branch>`, so a directory whose name is a sibling's name plus a
 *  dotted suffix is a branch of that sibling — an agent was sent there for one
 *  task, and the next conversation about the project belongs in the project.
 *  Known from the list alone: a session in the repository is what makes its
 *  worktrees recognizable, and a worktree with no such sibling stays. */
export function projectCwds(list: SessionInfo[]): string[] {
  const all = distinctCwds(list);
  const known = new Set(all);
  return all.filter((cwd) => {
    const slash = cwd.lastIndexOf("/");
    const dot = cwd.indexOf(".", slash + 2); // not a leading dot: `.pier` is a name
    return dot < 0 || !known.has(cwd.slice(0, dot));
  });
}

/** Actions take space only while revealed; touch keeps the current row's reachable. */
const HOVER_BTN = "session-more hidden h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700";

/**
 * Waiting for *you*: a finished turn nobody has looked at. The server marks
 * only the sessions this workbench is the reader of (web/server.ts) — a
 * subagent's turn was addressed to its supervisor and delivered by callback,
 * an IM session's to the chat it came from — so the flag is the whole rule
 * here. Named once, for the dot and the two badges standing in for it.
 */
const waitingForYou = (s: SessionInfo): boolean => s.unread;

/** How every surface counting a session's background runs says it: this dot's
 *  title and the chat header's running chip (session-header.ts). */
export const runsLabel = (runs: number): string => `${runs} subagent${runs > 1 ? "s" : ""} running`;

/** Attention dot: green = running, amber = finished and waiting for a look,
 *  sky = idle itself but subagents still in flight. Idle has no mark or slot;
 *  the rail puts marks after the title so its left edge stays aligned. */
export function stateDot(s: SessionInfo): HTMLElement[] {
  const mark: [string, string] | null =
    s.state === "streaming"
      ? ["bg-green-500 animate-pulse", "working…"]
      : waitingForYou(s)
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : s.activeRuns > 0
          ? ["bg-sky-500", runsLabel(s.activeRuns)]
          : null;
  if (!mark) return [];
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${mark[0]}`);
  dot.title = mark[1];
  return [dot];
}

// --- row actions ---------------------------------------------------------------------

/** Give the session a name. The transcript is where it lands, so it is the
 *  title on every surface and after every restart — including the IM panels,
 *  which read the same listing.
 *
 *  `prompt` is the idiom already in use for a one-line answer (ui/api.ts):
 *  a dialog of our own would be the third place this page asks for a string.
 *
 *  Drawn before the write and taken back if it fails; what a successful write
 *  settles on comes back as a `sessions-changed` re-read, like every other
 *  change to a session. */
export async function renameSession(s: SessionInfo): Promise<void> {
  const typed = window.prompt("Session name — empty resets it to the first message", s.title ?? "");
  if (typed === null) return; // cancelled, which is not the same as cleared
  const previous = s.title;
  const draw = (title: string | undefined): void => {
    s.title = title;
    renderSessions();
    deps.onTitleChanged();
  };
  // A cleared name shows as untitled for the moment between here and the
  // re-read: the title it falls back to is derived from a transcript, and this
  // page has none.
  draw(typed.trim() || undefined);
  if (!(await sendJson(`/api/sessions/${s.id}/rename`, { name: typed })).ok) draw(previous);
}

/** A readable channel initial without a box on every IM row. */
const CHIP = "flex-none text-xs font-medium uppercase leading-5 text-neutral-500";

/** Which conversation a session answers, when it is not this workbench. Typing
 *  into a Slack thread's session sends to the people in that thread, and the
 *  row is the last place to notice — but `web` is nearly every row, so saying
 *  it would be the constant that means nothing. One letter: the row has no
 *  room for a word, and the row's tooltip carries the name. */
const channelChip = (s: SessionInfo): HTMLElement[] =>
  s.channel && s.channel !== "web" ? [h("span", CHIP, s.channel[0] ?? "")] : [];

function sessionRow(s: SessionInfo, more = h("button", HOVER_BTN, icon(Ellipsis))): HTMLElement {
  const active = s.id === deps.currentId();
  const li = h(
    "li",
    `flex items-center gap-1 hover:bg-neutral-100 ${
      active ? "bg-indigo-50 hover:bg-indigo-50" : ""
    }`,
  );
  more.setAttribute("type", "button");
  more.setAttribute("aria-label", `Session actions: ${s.title ?? "untitled"}`);
  more.title = "Session actions";
  more.onclick = (ev) => {
    ev.stopPropagation();
    deps.sessionMenu(more, s);
  };
  const open = h("button", "session-open flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg text-left",
    h("span", "min-w-0 flex-1 truncate", s.title ?? "untitled"),
    ...stateDot(s),
  );
  open.setAttribute("type", "button");
  if (active) open.setAttribute("aria-current", "page");
  open.onclick = () => deps.select(s.id);
  li.dataset.sessionId = s.id;
  li.append(open, ...channelChip(s), more);
  // The facts the row has no room for, on the native tooltip: where it runs,
  // when it last moved, and — for an IM session — who it answers.
  li.title = [
    s.cwd,
    `active ${relTime(lastActive(s))} ago · created ${new Date(s.createdAt).toLocaleDateString()}`,
    ...(s.channel && s.channel !== "web" ? [`answering ${s.channel}`] : []),
  ].join("\n");
  return li;
}

/** The render model as one string — every field of a row the rail or the
 *  palette draws, plus which row is selected and how many rows are asked for.
 *  Same short-circuit the Activity view uses (ui/activity.ts): a rebuild
 *  replaces every node, so it drops the hover the pointer is on, and one
 *  landing between a mousedown and its mouseup swallows the click that was
 *  already happening — and ~12 call sites reach here on state events that
 *  changed none of this. */
const renderKey = (): string => `${deps.currentId() ?? ""}\n${shown}\n${JSON.stringify(deps.sessions())}`;

let drawn = "";

/** How many rows the rail shows; "Load more" grows it, nothing shrinks it. */
let shown = PAGE;

export function renderSessions(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const sessions = deps.sessions();
  // The one place the dots are painted, so also the one place the two surfaces
  // that stand in for them off screen are counted: the badge on the sidebar
  // toggle (ui/shell.ts) and the installed app's icon. Both count what carries
  // a dot and nothing else.
  const waiting = sessions.filter(waitingForYou);
  setAttention(waiting.length);
  setUnreadBadge(waiting.length);
  const { rows, hidden } = pageOf(sessions, shown);
  // Keep an open menu's trigger alive across refreshes so Escape can return focus.
  const expanded = sessionList.querySelector<HTMLElement>(".session-more[aria-expanded='true']");
  const expandedId = expanded?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  const nodes: HTMLElement[] = rows.map((s) => sessionRow(s, s.id === expandedId ? expanded! : undefined));
  if (hidden > 0) {
    const more = h("button", "session-open w-full cursor-pointer rounded-lg text-left text-sm text-neutral-500", `Load more (${hidden})`);
    more.id = "session-load-more";
    more.setAttribute("type", "button");
    more.onclick = () => {
      shown += PAGE;
      renderSessions();
      sessionList.querySelectorAll<HTMLElement>(".session-open")[rows.length]?.focus();
    };
    nodes.push(h("li", "hover:bg-neutral-100", more));
  }
  const focused = document.activeElement;
  const focusId = focused?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  const focusAction = focused?.classList.contains("session-more") ? ".session-more" : ".session-open";
  sessionList.replaceChildren(
    ...(nodes.length
      ? [h("ul", "pb-1", ...nodes)]
      : [h("p", "px-3 py-2 text-sm leading-normal text-neutral-500", "No sessions yet — create one.")]),
  );
  if (focusId) {
    const row = [...sessionList.querySelectorAll<HTMLElement>("[data-session-id]")].find((el) => el.dataset.sessionId === focusId);
    // Focus the row first: its action is hidden until :focus-within reveals it.
    row?.querySelector<HTMLElement>(".session-open")?.focus({ preventScroll: true });
    if (focusAction === ".session-more") row?.querySelector<HTMLElement>(focusAction)?.focus({ preventScroll: true });
  } else if (focused?.id === "session-load-more") {
    (sessionList.querySelector<HTMLElement>("#session-load-more") ?? sessionList.querySelector<HTMLElement>(".session-open") ?? $("#new-session"))
      .focus({ preventScroll: true });
  }
  refreshPalette(); // it draws the same rows, from the same list
}

// --- New session -------------------------------------------------------------------------

/** The new session nearly always belongs to a directory the rail already
 *  shows, so the button opens straight onto those — the current one ticked,
 *  the rest newest first — with the folder tree (which also takes a typed
 *  path) one row below. Picking creates: no form, no second click. Exported
 *  for the palette's "New session in…" row, which is this control by another
 *  route. */
export function openNewSession(): void {
  if (newBtn.getAttribute("aria-expanded") === "true") return closeMenu();
  const current = deps.sessions().find((s) => s.id === deps.currentId())?.cwd;
  const recent = projectCwds(deps.sessions()).slice(0, RECENT_CWDS);
  if (current && !recent.includes(current)) recent.unshift(current);
  // Nothing to choose from yet (a fresh instance): straight to the tree.
  if (!recent.length) return openBrowser(newBtn, undefined, deps.createSession);
  openPathMenu(newBtn, recent.map((path) => ({ path, hint: basename(path) })), current, deps.createSession);
}

// --- wiring ----------------------------------------------------------------------------

export function initSidebar(d: SidebarDeps): void {
  deps = d;
  newBtn.onclick = openNewSession;
  // ⇧O, not ⇧N: ⌘⇧N / ⌘⇧T are the browser's own windows and cannot be
  // taken back — ⇧O is what the chat apps settled on for the same action.
  // Stands down under a modal, like the rail's other chords: the palette is
  // in the top layer, so a menu anchored on this button would open *behind*
  // it — invisible, and unreachable by the keys meant to walk it.
  shortcut(newBtn, "shift+o", "New session", openNewSession, modalOpen);
  // ⌘⇧[ / ⌘⇧] walk the rail in the order it is drawn — the tab-switching
  // chord, applied to sessions. No button carries it: the rail itself is the
  // affordance.
  const step = (by: number): void => {
    const next = neighbor(deps.sessions(), deps.currentId(), by);
    if (next) deps.select(next);
  };
  chord("shift+[", () => step(-1), modalOpen);
  chord("shift+]", () => step(1), modalOpen);
}
