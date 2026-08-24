// The left rail: pinned sessions grouped by cwd (Projects), the search palette
// that reaches everything (⌘K), and the New-session dialog. main.ts owns the
// session list; this module renders it and reports interactions back.

import { sendJson } from "./api.js";
import { browseButton } from "./dir-picker.js";
import { $, basename, detailsRow, h, relTime } from "./dom.js";
import { closeMenu, openMenu } from "./menu.js";
import { shortcut } from "./shortcut.js";
import type { SessionState } from "../../core/types.js";

/** GET /api/sessions row: AgentFactory.list() entry + live state + pin flag. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
  pinned: boolean;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
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
  /** Open the Files view on a project's cwd (views.ts, wired through main). */
  openFiles: (cwd: string) => void;
  /** Open the Terminal view on a project's cwd (views.ts, wired through main). */
  openTerminal: (cwd: string) => void;
  /** Open a Console view by name — the palette lists them beside sessions. */
  openConsole: (name: "activity" | "boards" | "settings") => void;
  /** Pin state changed — the chat header may need re-rendering. */
  onPinsChanged: () => void;
}

let deps: SidebarDeps;

const projectTree = $("#project-tree");
const archiveDialog = $<HTMLDialogElement>("#archive-dialog");
const archiveList = $("#archive-list");
const archiveSearch = $<HTMLInputElement>("#archive-search");
const archiveCount = $("#archive-count");
const newDialog = $<HTMLDialogElement>("#new-dialog");
const knownProjects = $("#known-projects");

// --- projects (pinned sessions, grouped by cwd) ------------------------------------
// Projects lists pinned sessions only — those created in Pier (auto-pinned) or
// pinned from the All-sessions dialog — so Pi history never floods the sidebar.

const COLLAPSED_KEY = "pier.collapsedProjects";
const collapsed = new Set<string>(loadCollapsed());

function loadCollapsed(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function setCollapsed(cwd: string, closed: boolean): void {
  if (closed) collapsed.add(cwd);
  else collapsed.delete(cwd);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

export function groupByCwd(list: SessionInfo[]): Map<string, SessionInfo[]> {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const existing = groups.get(s.cwd);
    if (existing) existing.push(s);
    else groups.set(s.cwd, [s]);
  }
  return groups;
}

/** Row action revealed on hover (resident on touch, which has no hover). */
const HOVER_BTN =
  "ml-auto hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block pointer-coarse:block";

/** Attention dot: green = running, amber = finished and waiting for a look,
 *  sky = idle itself but subagents still in flight, grey = idle. */
function stateDot(s: SessionInfo): HTMLElement {
  const [cls, title] =
    s.state === "streaming"
      ? ["bg-green-500 animate-pulse", "working…"]
      : s.unread
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : s.activeRuns > 0
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
          : ["bg-neutral-300", "idle"];
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${cls}`);
  dot.title = title;
  return dot;
}

/** Unpin keeps the session — it just moves back into the All-sessions list. */
export async function setPinned(s: SessionInfo, pinned: boolean): Promise<void> {
  s.pinned = pinned;
  renderSessions();
  deps.onPinsChanged();
  const res = await sendJson(`/api/sessions/${s.id}/pin`, { pinned });
  if (!res.ok) {
    s.pinned = !pinned; // reconcile: the server is the truth
    renderSessions();
    deps.onPinsChanged();
  }
}

function sessionRow(s: SessionInfo): HTMLElement {
  const active = s.id === deps.currentId();
  const li = h(
    "li",
    `group flex cursor-pointer items-center gap-1.5 py-1.5 pl-6 pr-3 hover:bg-neutral-100 ${
      active ? "bg-indigo-50 hover:bg-indigo-50" : ""
    }`,
  );
  // Touch has no hover, so a hover-revealed control there is unreachable —
  // pointer-coarse makes it resident instead (same trick on the project +).
  const more = h("button", HOVER_BTN, "\u22ef");
  more.title = "Session actions";
  more.onclick = (ev) => {
    ev.stopPropagation();
    deps.sessionMenu(more, s);
  };
  li.append(stateDot(s), h("span", "truncate", s.title ?? "untitled"), more);
  li.onclick = () => deps.select(s.id);
  return li;
}

/** One collapsible project = one cwd; collapse state lives in localStorage. */
function projectNode(cwd: string, list: SessionInfo[]): HTMLElement {
  const count = h(
    "span",
    "ml-auto flex-none text-[11px] text-neutral-400 group-hover:hidden",
    String(list.length),
  );
  // One control, like the session row above it. A project had grown a bare "+"
  // beside its ⋯, which made the same row teach two different idioms and left
  // no room for the third action.
  const more = h("button", HOVER_BTN, "\u22ef");
  more.title = "Project actions";
  more.onclick = (ev) => {
    ev.preventDefault(); // a click inside <summary> would toggle the project
    ev.stopPropagation();
    openMenu(more, [
      {
        label: "New session here",
        hint: basename(cwd),
        onSelect: () => {
          closeMenu();
          void deps.createSession(cwd);
        },
      },
      {
        label: "Browse files",
        onSelect: () => {
          closeMenu();
          deps.openFiles(cwd);
        },
      },
      {
        label: "Terminal here",
        onSelect: () => {
          closeMenu();
          deps.openTerminal(cwd);
        },
      },
    ]);
  };
  const { el, summary } = detailsRow("border-b border-neutral-200/70", [
    h("span", "truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500", basename(cwd)),
    count,
    more,
  ]);
  summary.className += " group px-3 py-1.5 hover:bg-neutral-100";
  summary.title = cwd;
  el.open = !collapsed.has(cwd);
  el.ontoggle = () => setCollapsed(cwd, !el.open);
  const rows = h("ul", "pb-1");
  rows.append(...list.map(sessionRow));
  el.append(rows);
  return el;
}

export function renderSessions(): void {
  const sessions = deps.sessions();
  const projects = groupByCwd(sessions.filter((s) => s.pinned));
  projectTree.replaceChildren(
    ...(projects.size
      ? [...projects].map(([cwd, list]) => projectNode(cwd, list))
      : [
          h(
            "p",
            "px-3 py-2 text-[12.5px] leading-snug text-neutral-400",
            "No projects yet — create a session, or pin one from All sessions.",
          ),
        ]),
  );
  knownProjects.replaceChildren(
    ...[...groupByCwd(sessions).keys()].map((cwd) => {
      const opt = document.createElement("option");
      opt.value = cwd;
      return opt;
    }),
  );
  if (archiveDialog.open) renderArchive();
}

// --- the search palette (⌘K): every session, plus the Console -----------------------
// Ordering is the feature. What is running now, then what you keep in
// Projects, then everything else newest-first — grouping by cwd (the old
// shape) cannot express any of that, so the cwd moved onto the row instead.

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
const CONSOLE_TARGETS: { name: "activity" | "boards" | "settings"; label: string; detail: string }[] = [
  { name: "activity", label: "Activity", detail: "Console — runs, scheduled tasks, dependencies" },
  { name: "boards", label: "Boards", detail: "Console — the static pages Pier publishes" },
  { name: "settings", label: "Settings", detail: "Console — providers, models, channels, agent files, password, sign out, security" },
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
  rows.forEach(({ el }, i) => el.classList.toggle("bg-indigo-50", i === active));
  rows[active]?.el.scrollIntoView({ block: "nearest" });
}

function pinButton(s: SessionInfo): HTMLElement {
  const pin = h(
    "button",
    `flex-none rounded px-1.5 py-0.5 text-[11.5px] ${
      s.pinned
        ? "bg-indigo-50 text-indigo-600"
        : "text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
    }`,
    s.pinned ? "pinned" : "pin",
  );
  pin.title = s.pinned ? "Remove from Projects" : "Pin to Projects";
  pin.onclick = (ev) => {
    ev.stopPropagation();
    void setPinned(s, !s.pinned);
  };
  return pin;
}

function paletteRow(t: Target): HTMLElement {
  const li = h("li", "flex cursor-pointer items-center gap-2 px-3 py-1.5");
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
      pinButton(t.session),
    );
  }
  // Pointer and keyboard drive the same highlight, so the two never disagree
  // about which row Enter would open.
  li.onmouseenter = () => setActive(rows.findIndex((r) => r.el === li));
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
  const matched = deps.sessions().filter((s) => hit(`${s.title ?? ""} ${s.cwd}`));
  const byAge = (a: SessionInfo, b: SessionInfo): number => b.createdAt - a.createdAt;
  const target = (s: SessionInfo): Target => ({
    label: s.title ?? "untitled",
    detail: basename(s.cwd),
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
    ["Projects", idle.filter((s) => s.pinned).sort(byAge).map(target)],
    ["Other sessions", idle.filter((s) => !s.pinned).sort(byAge).map(target)],
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
}

// --- wiring ----------------------------------------------------------------------------

export function initSidebar(d: SidebarDeps): void {
  deps = d;
  // Same picker the channel config uses; the input keeps its own semantics.
  $("#new-cwd-row").append(browseButton($<HTMLInputElement>("#new-cwd")));
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
    const step = ev.altKey || ev.metaKey || ev.shiftKey
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
