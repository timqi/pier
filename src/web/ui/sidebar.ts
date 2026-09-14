// The left rail: one flat list of every session, the working set on top, and
// the New-session menu. The palette borrows its order, dots and menu.

import { Ellipsis } from "lucide";
import { icon } from "./icons.js";
import { sendJson } from "./api.js";
import { openBrowser, openPathMenu } from "./dir-picker.js";
import { projectCwds } from "../../core/identity.js";
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
  /** The row's tooltip only: it moves with every background turn, so it orders nothing. */
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
// The server's working set on top (web/session-state.ts), everything else by
// birth. Nothing reads `modified`: ordering by it makes the rail jump under the pointer.

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

/** Hidden rows included, wrapping at either end; `undefined` when there is
 *  nothing to move to. */
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

/** Actions take space only while revealed; touch keeps the current row's reachable. */
const HOVER_BTN = "session-more hidden h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700";

/** The server marks only the sessions this workbench is the reader of
 *  (web/server.ts), so the flag is the whole rule here. */
const waitingForYou = (s: SessionInfo): boolean => s.unread;

/** One wording for the dot's title and the chat header's running chip. */
export const runsLabel = (runs: number): string => `${runs} subagent${runs > 1 ? "s" : ""} running`;

/** A session with something going on in it: running, waiting for a look, or
 *  subagents in flight — what the dot marks, and what the palette lists first. */
export const isLive = (s: SessionInfo): boolean => s.state === "streaming" || waitingForYou(s) || s.activeRuns > 0;

/** Green = running, amber = waiting for a look, sky = subagents in flight.
 *  Idle has no mark or slot. */
export function stateDot(s: SessionInfo): HTMLElement[] {
  if (!isLive(s)) return [];
  const mark: [string, string] =
    s.state === "streaming"
      ? ["bg-green-500 animate-pulse", "working…"]
      : waitingForYou(s)
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : ["bg-sky-500", runsLabel(s.activeRuns)];
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${mark[0]}`);
  dot.title = mark[1];
  return [dot];
}

// --- row actions ---------------------------------------------------------------------

/** Drawn before the write and taken back if it fails; what a successful write
 *  settles on comes back as a `sessions-changed` re-read. */
export async function renameSession(s: SessionInfo): Promise<void> {
  const typed = window.prompt("Session name — empty resets it to the first message", s.title ?? "");
  if (typed === null) return; // cancelled, which is not the same as cleared
  const previous = s.title;
  const draw = (title: string | undefined): void => {
    s.title = title;
    renderSessions();
    deps.onTitleChanged();
  };
  // A cleared name shows as untitled until the re-read: the fallback title is
  // derived from a transcript this page has not got.
  draw(typed.trim() || undefined);
  if (!(await sendJson(`/api/sessions/${s.id}/rename`, { name: typed })).ok) draw(previous);
}

/** A readable channel initial without a box on every IM row. */
const CHIP = "flex-none text-xs font-medium uppercase leading-5 text-neutral-500";

/** Typing into a Slack thread's session sends to the people in that thread.
 *  `web` is nearly every row, so it is not said; one letter, name in the tooltip. */
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

/** Short-circuit (as in ui/activity.ts): a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string => `${deps.currentId() ?? ""}\n${shown}\n${JSON.stringify(deps.sessions())}`;

let drawn = "";

/** How many rows the rail shows; "Load more" grows it, nothing shrinks it. */
let shown = PAGE;

export function renderSessions(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const sessions = deps.sessions();
  // The badge on the sidebar toggle and the app icon count exactly what carries a dot.
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

/** Picking creates: no form, no second click. Exported for the palette's
 *  "New session in…" row. */
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
  // ⇧O, not ⇧N: ⌘⇧N is the browser's. Stands down under a modal: the palette
  // is in the top layer, so this menu would open behind it.
  shortcut(newBtn, "shift+o", "New session", openNewSession, modalOpen);
  // The tab-switching chord, applied to sessions; the rail itself is the affordance.
  const step = (by: number): void => {
    const next = neighbor(deps.sessions(), deps.currentId(), by);
    if (next) deps.select(next);
  };
  chord("shift+[", () => step(-1), modalOpen);
  chord("shift+]", () => step(1), modalOpen);
}
