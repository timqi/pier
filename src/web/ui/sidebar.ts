// The left rail: one flat list of every session Pi lists, pinned rows on top,
// the search palette that reaches everything (⌘K), and the New-session dialog.
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
  /** When the transcript was last written — what orders the unpinned rows.
   *  Absent from a session Pi has not persisted yet. */
  modified?: number;
  title?: string;
  state: SessionState;
  /** Stuck to the top of the rail. */
  pinned: boolean;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
  /** The IM channel that owns it, or `"web"` for everything else. */
  channel: string;
  /** Background runs this session launched that are still in flight. */
  activeRuns: number;
  /** Where it was dragged to among the pinned rows; unset = never dragged. */
  sort?: number;
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
  /** Pin state changed — the chat header may need re-rendering. */
  onPinsChanged: () => void;
}

let deps: SidebarDeps;

const sessionList = $("#session-list");
const archiveDialog = $<HTMLDialogElement>("#archive-dialog");
const archiveList = $("#archive-list");
const archiveSearch = $<HTMLInputElement>("#archive-search");
const archiveCount = $("#archive-count");
const newDialog = $<HTMLDialogElement>("#new-dialog");

// --- order -------------------------------------------------------------------------
// Two runs of one list. Pinned rows are arranged by hand and kept on the
// server; everything else follows the transcript — most recently written
// first — and nothing anyone does to it is remembered.

/** Rows on the screen before "Load more" is asked for. */
export const PAGE = 20;

/** Never-dragged sorts first, so a newly pinned row lands on top of the pinned
 *  rows and an instance that has never been arranged keeps a stable order. */
function byRank(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a - b;
}

/** A session Pi has not persisted yet has no transcript to date; its creation
 *  is the last thing that happened to it. */
const lastActive = (s: SessionInfo): number => s.modified ?? s.createdAt;

/** Pinned in their arranged order (ties: newest created first), then the rest
 *  by last activity. */
export function orderSessions(list: SessionInfo[]): { pinned: SessionInfo[]; rest: SessionInfo[] } {
  return {
    pinned: list.filter((s) => s.pinned).sort((a, b) => byRank(a.sort, b.sort) || b.createdAt - a.createdAt),
    rest: list.filter((s) => !s.pinned).sort((a, b) => lastActive(b) - lastActive(a)),
  };
}

/** The first `shown` rows of that order, and how many are still behind
 *  "Load more". Pinned rows count against the page like any other. */
export function pageOf(list: SessionInfo[], shown: number): { pinned: SessionInfo[]; rest: SessionInfo[]; hidden: number } {
  const { pinned, rest } = orderSessions(list);
  const visiblePinned = pinned.slice(0, shown);
  const visibleRest = rest.slice(0, Math.max(0, shown - pinned.length));
  return { pinned: visiblePinned, rest: visibleRest, hidden: list.length - visiblePinned.length - visibleRest.length };
}

/** Distinct directories, newest session first: what the New-session picker
 *  and the Settings scope list offer. */
export const distinctCwds = (list: SessionInfo[]): string[] =>
  [...new Set([...list].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.cwd))];

/** `id` out, back in above or below `target`. */
function moved(ids: string[], id: string, target: string, after: boolean): string[] {
  const rest = ids.filter((k) => k !== id);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id);
  return rest;
}

/** Optimistic, like the pin toggle: the new places are on the rows and drawn
 *  before the write, and whatever the server says wins over them. A rejected
 *  or unreachable write reloads the list, so the order visibly snaps back
 *  rather than lying about having been saved. */
function dropSession(id: string, target: string, after: boolean): void {
  const sessions = moved(orderSessions(deps.sessions()).pinned.map((s) => s.id), id, target, after);
  const rank = new Map(sessions.map((key, i) => [key, i]));
  for (const s of deps.sessions()) {
    const at = rank.get(s.id);
    if (at !== undefined) s.sort = at;
  }
  renderSessions();
  const reload = () => void deps.loadSessions();
  void sendJson("/api/sessions/order", { sessions }).then((res) => {
    if (!res.ok) reload();
  }, reload);
}

/** Which pinned row is being dragged. */
let dragging: string | null = null;

/** The line the row would land on — inline rather than a class, so it cannot
 *  collide with the row's own borders. */
function dropLine(row: HTMLElement, after: boolean | null): void {
  row.style.boxShadow = after === null ? "" : `inset 0 ${after ? -2 : 2}px 0 0 #818cf8`;
}

/** Make one pinned row draggable, dropping above or below whichever half of a
 *  row it is released on. */
function sortable(row: HTMLElement, key: string, drop: (target: string, after: boolean) => void): void {
  row.draggable = true;
  row.ondragstart = (ev) => {
    dragging = key;
    // Firefox starts no drag at all without payload; the key is the payload.
    ev.dataTransfer?.setData("text/plain", key);
  };
  // Re-render on end, not only on drop: a drag abandoned outside every row
  // leaves the last drop line drawn, and a stray line is an order nobody made.
  // Forced, because that line is inline style no render model knows about.
  row.ondragend = () => {
    dragging = null;
    renderSessions(true);
  };
  const half = (ev: DragEvent): boolean => {
    const box = row.getBoundingClientRect();
    return ev.clientY > box.top + box.height / 2;
  };
  const droppable = (ev: DragEvent): boolean => {
    if (!dragging || dragging === key) return false;
    ev.preventDefault(); // the default is "reject the drop"
    return true;
  };
  row.ondragover = (ev) => {
    if (droppable(ev)) dropLine(row, half(ev));
  };
  row.ondragleave = () => dropLine(row, null);
  row.ondrop = (ev) => {
    const from = dragging;
    dropLine(row, null);
    if (droppable(ev) && from) drop(from, half(ev));
  };
}

/** Row action revealed on hover (resident on touch, which has no hover). */
const HOVER_BTN =
  "hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block pointer-coarse:block";

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
 *  sky = idle itself but subagents still in flight. Idle draws nothing — but
 *  keeps the slot, so titles line up down the list whatever their row says. */
export function stateDot(s: SessionInfo): HTMLElement {
  const [cls, title] =
    s.state === "streaming"
      ? ["bg-green-500 animate-pulse", "working…"]
      : waitingForYou(s)
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : s.activeRuns > 0
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
          : ["", ""];
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${cls}`);
  dot.title = title;
  return dot;
}

/** One pushpin for every surface that pins: upright and filled when the row is
 *  on top, tilted and hollow when it is not. Inline like the other icons
 *  (index.html, theme.ts); `h` makes HTML elements and an SVG is not one. */
const pinIcon = (pinned: boolean): string =>
  `<svg viewBox="0 0 16 16" fill="${pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5 ${pinned ? "text-indigo-500" : "rotate-45"}"><path d="M6 2v4L4.5 8.5h7L10 6V2z" /><path d="M5 2h6M8 8.5V14" /></svg>`;

function pinButton(s: SessionInfo, cls: string): HTMLElement {
  const pin = h("button", cls);
  pin.innerHTML = pinIcon(s.pinned);
  pin.title = s.pinned ? "Unpin" : "Pin to top";
  pin.onclick = (ev) => {
    ev.stopPropagation();
    void setPinned(s, !s.pinned);
  };
  return pin;
}

// --- row actions ---------------------------------------------------------------------
// All three do the same thing: draw the new state, send it, and let the server
// have the last word. Only the field, the request and whether the answer can
// correct the guess differ.

/** `set` writes the row — with the new value, and again with the old one if the
 *  write failed. What a successful write settles on comes back as a
 *  `sessions-changed` re-read, like every other change to a session. */
async function optimistic<T>(
  set: (value: T) => void,
  next: T,
  previous: T,
  url: string,
  body: Record<string, unknown>,
): Promise<void> {
  const draw = (value: T): void => {
    set(value);
    renderSessions();
    deps.onPinsChanged();
  };
  draw(next);
  if (!(await sendJson(url, body)).ok) draw(previous); // the server is the truth
}

/** Give the session a name. The transcript is where it lands, so it is the
 *  title on every surface and after every restart — including the IM panels,
 *  which read the same listing.
 *
 *  `prompt` is the idiom already in use for a one-line answer (ui/api.ts):
 *  a dialog of our own would be the third place this page asks for a string. */
export async function renameSession(s: SessionInfo): Promise<void> {
  const typed = window.prompt("Session name — empty resets it to the first message", s.title ?? "");
  if (typed === null) return; // cancelled, which is not the same as cleared
  // A cleared name shows as untitled for the moment between here and the
  // re-read: the title it falls back to is derived from a transcript, and this
  // page has none.
  await optimistic<string | undefined>(
    (title) => (s.title = title),
    typed.trim() || undefined,
    s.title,
    `/api/sessions/${s.id}/rename`,
    { name: typed },
  );
}

/** Unpin keeps the session — it just drops back into the list below. */
export const setPinned = (s: SessionInfo, pinned: boolean): Promise<void> =>
  optimistic((v) => (s.pinned = v), pinned, !pinned, `/api/sessions/${s.id}/pin`, { pinned });

const CHIP = "flex-none rounded bg-neutral-200/70 px-1 font-mono text-[10px] uppercase leading-[15px] text-neutral-500";

/** Which conversation a session answers, when it is not this workbench. Typing
 *  into a Slack thread's session sends to the people in that thread, and the
 *  row is the last place to notice — but `web` is nearly every row, so saying
 *  it would be the constant that means nothing. One letter: the row has no
 *  room for a word, and the title carries the name. */
function channelChip(s: SessionInfo): HTMLElement[] {
  if (!s.channel || s.channel === "web") return [];
  const chip = h("span", CHIP, s.channel[0] ?? "");
  chip.title = `answering ${s.channel}`;
  return [chip];
}

function sessionRow(s: SessionInfo): HTMLElement {
  const active = s.id === deps.currentId();
  const li = h(
    "li",
    `group flex cursor-pointer items-center gap-1.5 px-3 py-1.5 hover:bg-neutral-100 ${
      active ? "bg-indigo-50 hover:bg-indigo-50" : ""
    }`,
  );
  // Touch has no hover, so a hover-revealed control there is unreachable —
  // pointer-coarse makes it resident instead.
  const pin = pinButton(s, HOVER_BTN);
  const more = h("button", HOVER_BTN, "\u22ef");
  more.title = "Session actions";
  more.onclick = (ev) => {
    ev.stopPropagation();
    deps.sessionMenu(more, s);
  };
  li.append(
    stateDot(s),
    // Not the header's `untitled(cwd)`: the row's title attribute already
    // names the directory, and the long form would truncate to "New session i…".
    h("span", "truncate", s.title ?? "untitled"),
    h("div", "ml-auto flex flex-none items-center gap-1", ...channelChip(s), pin, more),
  );
  li.onclick = () => deps.select(s.id);
  li.title = basename(s.cwd);
  if (s.pinned) sortable(li, s.id, (id, after) => dropSession(id, s.id, after));
  return li;
}

/** The render model as one string — every field of a row the rail or the
 *  palette draws, plus which row is selected and how many rows are asked for.
 *  Same short-circuit the Activity view uses (ui/activity.ts): a rebuild
 *  replaces every node, so it drops the drag handlers and the hover the pointer
 *  is on, and one landing between a mousedown and its mouseup swallows the
 *  click that was already happening — and ~12 call sites reach here on state
 *  events that changed none of this. */
const renderKey = (): string => `${deps.currentId() ?? ""}\n${shown}\n${JSON.stringify(deps.sessions())}`;

let drawn = "";

/** How many rows the rail shows; "Load more" grows it, nothing shrinks it. */
let shown = PAGE;

/** `force` redraws whatever the key says — the drag handlers' only way back. */
export function renderSessions(force = false): void {
  const key = renderKey();
  if (key === drawn && !force) return;
  drawn = key;
  const sessions = deps.sessions();
  // The one place the dots are painted, so also the one place the two surfaces
  // that stand in for them off screen are counted: the badge on the sidebar
  // toggle (ui/shell.ts) and the installed app's icon. Both count what carries
  // a dot and nothing else.
  const waiting = sessions.filter(waitingForYou);
  setAttention(waiting.length);
  setUnreadBadge(waiting.length);
  const { pinned, rest, hidden } = pageOf(sessions, shown);
  const nodes: HTMLElement[] = pinned.map(sessionRow);
  if (pinned.length && rest.length) nodes.push(h("li", "my-1 border-t border-neutral-200/70"));
  nodes.push(...rest.map(sessionRow));
  if (hidden > 0) {
    const more = h("li", "cursor-pointer px-3 py-1.5 text-[12.5px] text-neutral-400 hover:bg-neutral-100", `Load more (${hidden})`);
    more.onclick = () => {
      shown += PAGE;
      renderSessions();
    };
    nodes.push(more);
  }
  sessionList.replaceChildren(
    ...(nodes.length
      ? [h("ul", "pb-1", ...nodes)]
      : [h("p", "px-3 py-2 text-[12.5px] leading-snug text-neutral-400", "No sessions yet — create one.")]),
  );
  if (archiveDialog.open) renderArchive();
}

// --- the search palette (⌘K): every session, plus the Console -----------------------
// Ordering is the feature. What is running now, then what is pinned, then
// everything else newest-first — with the cwd on the row.

/** One thing the palette can open. `session` is what makes a row a session
 *  row: the state dot, its age and the pin toggle all hang off it. */
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
  // A Console row keeps the dot's width so both kinds of row start on the
  // same column; only a session has a state to report there.
  li.append(t.session ? stateDot(t.session) : h("span", "h-2 w-2 flex-none"));
  li.append(
    h("span", "min-w-0 flex-1 truncate", t.label),
    h("span", "max-w-[45%] flex-none truncate text-[11.5px] text-neutral-400", t.detail),
  );
  if (t.session) {
    li.append(
      h("span", "flex-none text-[11px] text-neutral-400", relTime(t.session.createdAt)),
      pinButton(t.session, "flex-none rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"),
    );
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
  const idle = matched.filter((s) => s.state !== "streaming");

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
    ["Pinned", idle.filter((s) => s.pinned).sort(byAge).map(target)],
    ["Sessions", idle.filter((s) => !s.pinned).sort(byAge).map(target)],
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
