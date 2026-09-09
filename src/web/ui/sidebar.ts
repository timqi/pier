// The left rail: one flat list of every session Pi lists, the working set on
// top, the search palette that reaches everything (⌘K), and the New-session
// dialog.
// main.ts owns the session list; this module renders it and reports
// interactions back.

import { sendJson } from "./api.js";
import { pathTrigger, type PathOption } from "./dir-picker.js";
import { $, basename, h, relTime, untitled } from "./dom.js";
import { setUnreadBadge } from "./notifications.js";
import { setAttention } from "./shell.js";
import { shortcut } from "./shortcut.js";
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
  loadSessions: () => Promise<void>;
  currentId: () => string | null;
  select: (id: string) => void;
  sessionMenu: (anchor: HTMLElement, s: SessionInfo) => void;
  createSession: (cwd: string) => Promise<void>;
  /** Open a Console view by name — the palette lists them beside sessions. */
  openConsole: (name: "tasks" | "runs" | "activity" | "boards" | "settings") => void;
  /** The selected session's title changed — the chat header draws it too. */
  onTitleChanged: () => void;
}

let deps: SidebarDeps;

const sessionList = $("#session-list");
const archiveDialog = $<HTMLDialogElement>("#archive-dialog");
const archiveList = $("#archive-list");
const archiveSearch = $<HTMLInputElement>("#archive-search");
const archiveCount = $("#archive-count");
const newDialog = $<HTMLDialogElement>("#new-dialog");

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

/** Distinct directories, newest session first: what the New-session picker
 *  and the Settings scope list offer. */
export const distinctCwds = (list: SessionInfo[]): string[] =>
  [...new Set([...list].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.cwd))];

/** Actions take space only while revealed; touch keeps the current row's reachable. */
const HOVER_BTN = "session-more hidden h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700";

/**
 * Waiting for *you*, which is narrower than `unread`.
 *
 * The server marks every session whose turn ends, and most of those have no
 * reader here: a subagent's turn was addressed to its supervisor and delivered
 * by callback, an IM session's to the chat it came from. Nothing ever clears
 * them either — an ack needs the session selected — so drawn as-is they are
 * permanently amber, which is a mark nobody reads. Only the workbench's own
 * sessions carry the dot. Said once, for the dot and the two badges standing
 * in for it.
 */
const waitingForYou = (s: SessionInfo): boolean => s.unread && s.channel === "web";

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
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
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

function sessionRow(s: SessionInfo, more = h("button", HOVER_BTN, "\u22ef")): HTMLElement {
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
  if (archiveDialog.open) renderArchive();
}

// --- the search palette (⌘K): every session, plus the Console -----------------------
// Ordering is the feature. What is running now, then the rail's own order —
// with the cwd on the row.

/** One thing the palette can open. `session` is what makes a row a session
 *  row: the state dot and its age hang off it. */
interface Target {
  label: string;
  detail: string;
  open: () => void;
  session?: SessionInfo;
}

// Searchable by what they are called *and* by what is inside them: "password"
// and "channel" are how someone looks for Settings.
const CONSOLE_TARGETS: { name: "tasks" | "runs" | "activity" | "boards" | "settings"; label: string; detail: string }[] = [
  { name: "tasks", label: "Tasks", detail: "Automation — task definitions and schedules" },
  { name: "runs", label: "Runs", detail: "Automation — executions, subagents, decisions and callbacks" },
  { name: "activity", label: "Activity", detail: "Automation — sessions and relationships" },
  { name: "boards", label: "Boards", detail: "Console — the static pages Pier publishes" },
  { name: "settings", label: "Settings", detail: "Console — models and providers, agent files and extensions, channels, password, sign out, security" },
];

/** Rebuilt on every render; the index is what ↑/↓ and Enter address. */
let rows: { el: HTMLElement; open: () => void }[] = [];
let active = 0;

// Three idioms for the same two moves. The arrows; readline's ⌃P/⌃N, for hands
// that would rather not leave the home row; and ⌃J/⌃K, because ⌃N is a
// *reserved* chord in Chrome and Firefox on Linux and Windows — it opens a new
// window and no `preventDefault` can stop it, so "down" needs a key the browser
// will actually hand over. (⌃P is only print, which is interceptable.)
const ARROW_STEP: Record<string, number | undefined> = { ArrowDown: 1, ArrowUp: -1 };
const CTRL_STEP: Record<string, number | undefined> = { n: 1, j: 1, p: -1, k: -1 };

function setActive(index: number): void {
  if (!rows.length) return;
  active = (index + rows.length) % rows.length;
  for (const [i, { el }] of rows.entries()) {
    el.classList.toggle("bg-indigo-100", i === active);
    el.classList.toggle("border-indigo-500", i === active);
  }
  rows[active]?.el.scrollIntoView({ block: "nearest" });
}

function paletteRow(t: Target): HTMLElement {
  // The transparent bar is always there so gaining it costs no reflow.
  const li = h(
    "li",
    "flex cursor-pointer items-center gap-2 border-l-2 border-transparent px-3 py-1.5 hover:bg-neutral-100",
  );
  if (t.session) li.append(...stateDot(t.session));
  li.append(
    h("span", "min-w-0 flex-1 truncate", t.label),
    h("span", "max-w-[45%] flex-none truncate text-[11.5px] text-neutral-400", t.detail),
  );
  if (t.session) {
    li.append(h("span", "flex-none text-[11px] text-neutral-400", relTime(t.session.createdAt)));
  }
  // Hover is its own grey, and it does not move the selection. Driving one
  // highlight from both pointer and keyboard meant the browser could aim it:
  // after a layout change it re-runs hit-testing and delivers a mouse move at
  // the position the pointer already had, so opening ⌘K with the mouse resting
  // anywhere over the list fired `mouseenter` there and Enter no longer opened
  // the first row. What the keyboard selected is now only ever moved by the
  // keyboard; the pointer opens what it clicks.
  li.onclick = t.open;
  return li;
}

const sectionHead = (title: string): HTMLElement =>
  h(
    "li",
    "px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400",
    title,
  );

function renderArchive(): void {
  const q = archiveSearch.value.trim().toLowerCase();
  const hit = (text: string): boolean => !q || text.toLowerCase().includes(q);
  const open = (run: () => void) => () => {
    archiveDialog.close();
    run();
  };
  // The chat a session answers is both searchable and shown, by its full name
  // here — the palette has room the rail's chip does not, and "telegram" is
  // what someone types. Empty for the workbench's own sessions, which is most
  // of them: `web` in every detail line would only push the cwd out.
  const chatOf = (s: SessionInfo): string => (s.channel && s.channel !== "web" ? s.channel : "");
  const matched = deps.sessions().filter((s) => hit(`${s.title ?? ""} ${s.cwd} ${chatOf(s)}`));
  const byAge = (a: SessionInfo, b: SessionInfo): number => b.createdAt - a.createdAt;
  const target = (s: SessionInfo): Target => ({
    label: s.title ?? untitled(s.cwd),
    detail: [basename(s.cwd), chatOf(s)].filter(Boolean).join(" · "),
    open: open(() => deps.select(s.id)),
    session: s,
  });
  const streaming = matched.filter((s) => s.state === "streaming");
  const idle = orderSessions(matched.filter((s) => s.state !== "streaming"));

  const consoleSection: [string, Target[]] = [
    "Console",
    CONSOLE_TARGETS.filter((t) => hit(`${t.label} ${t.detail}`)).map(({ name, label, detail }) => ({
      label,
      detail,
      open: open(() => deps.openConsole(name)),
    })),
  ];
  const sections: [string, Target[]][] = [
    ["Running", streaming.sort(byAge).map(target)],
    ["Recent", idle.top.map(target)],
    ["Sessions", idle.rest.map(target)],
  ];
  // A query is a question about everything, so the Console answers it up top;
  // an empty box is the session list it has always been, with the Console
  // parked at the bottom where it stays discoverable.
  if (q) sections.unshift(consoleSection);
  else sections.push(consoleSection);

  rows = [];
  const nodes: HTMLElement[] = [];
  for (const [title, targets] of sections) {
    if (!targets.length) continue;
    nodes.push(sectionHead(title));
    for (const t of targets) {
      const el = paletteRow(t);
      rows.push({ el, open: t.open });
      nodes.push(el);
    }
  }
  archiveList.replaceChildren(
    ...(nodes.length
      ? nodes
      : [h("li", "px-3 py-3 text-[13px] text-neutral-400", "Nothing matches.")]),
  );
  archiveCount.textContent = String(rows.length);
  // Held, not reset: a session going streaming re-renders this list, and
  // moving the highlight out from under a pressed Enter is a misfire.
  setActive(active);
}

/** Same control from the button and from ⌘K, so the chord also dismisses it. */
function toggleArchive(): void {
  if (archiveDialog.open) return archiveDialog.close();
  archiveSearch.value = "";
  active = 0;
  renderArchive();
  archiveDialog.showModal();
  archiveSearch.focus();
  void deps.loadSessions().then(() => {
    if (archiveDialog.open) renderArchive();
  });
}

// --- wiring ----------------------------------------------------------------------------

export function initSidebar(d: SidebarDeps): void {
  deps = d;
  // The new session nearly always belongs to a directory the rail already
  // shows, so the field itself offers those, with the folder tree under them;
  // typing a path still works.
  pathTrigger($<HTMLInputElement>("#new-cwd"), (): PathOption[] => distinctCwds(deps.sessions()).map((path) => ({ path })));
  const newBtn = $("#new-session");
  // Prefilled with wherever you are: the next session almost always belongs to
  // the project on screen, and the text is selected so typing another path
  // still costs one keystroke.
  const openNew = (): void => {
    const cwd = deps.sessions().find((s) => s.id === deps.currentId())?.cwd ?? "";
    const input = $<HTMLInputElement>("#new-cwd");
    input.value = cwd;
    newDialog.showModal();
    input.select();
  };
  newBtn.onclick = openNew;
  // ⇧O, not ⇧N: ⌘⇧N / ⌘⇧T are the browser's own windows and cannot be
  // taken back — ⇧O is what the chat apps settled on for the same action.
  shortcut(newBtn, "shift+o", "New session", openNew, () => newDialog.open);
  $("#new-cancel").onclick = () => newDialog.close();
  $<HTMLFormElement>("#new-form").onsubmit = () =>
    void deps.createSession($<HTMLInputElement>("#new-cwd").value.trim());
  const search = $("#open-archive");
  search.onclick = toggleArchive;
  // Once the palette is open the chord belongs to its list (⌃K walks up), so
  // the global binding stands down; Esc is what a <dialog> closes on anyway.
  shortcut(search, "k", "Search sessions and Console", toggleArchive, () => archiveDialog.open);
  $("#archive-close").onclick = () => archiveDialog.close();
  archiveSearch.oninput = () => {
    active = 0; // a new query is a new list; the old position means nothing
    renderArchive();
  };
  // The input keeps focus while the list is walked — typing must never mean
  // "start over because you moved".
  archiveSearch.onkeydown = (ev) => {
    // Bare Ctrl only: ⌃⇧N is the browser's incognito window, and claiming a
    // chord someone meant for the browser is worse than not having it.
    const step = ev.altKey || ev.metaKey || ev.shiftKey || !ev.key // no `key`: synthetic event
      ? undefined
      : (ev.ctrlKey ? CTRL_STEP[ev.key.toLowerCase()] : ARROW_STEP[ev.key]);
    if (step !== undefined) {
      ev.preventDefault();
      setActive(active + step);
      return;
    }
    if (ev.key === "Enter" && !ev.ctrlKey) {
      ev.preventDefault();
      rows[active]?.open();
    }
  };
}
