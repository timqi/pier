// The left rail: pinned sessions grouped by cwd (Projects), the All-sessions
// dialog with pin toggles, and the New-session dialog. main.ts owns the
// session list; this module renders it and reports interactions back.

import { browseButton } from "./dir-picker.js";
import { $, detailsRow, h } from "./dom.js";
import type { SessionState } from "../../core/types.js";

/** GET /api/sessions row: AgentFactory.list() entry + live state + pin flag. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
  pinned: boolean;
}

/** Everything the sidebar needs from the orchestrator (main.ts). */
export interface SidebarDeps {
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  select: (id: string) => void;
  sessionMenu: (anchor: HTMLElement, s: SessionInfo) => void;
  createSession: (cwd: string) => Promise<void>;
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

function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

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

const stateDot = (s: SessionInfo): HTMLElement =>
  h(
    "span",
    `h-2 w-2 flex-none rounded-full ${
      s.state === "streaming" ? "bg-green-500 animate-pulse" : "bg-neutral-300"
    }`,
  );

/** Unpin keeps the session — it just moves back into the All-sessions list. */
export async function setPinned(s: SessionInfo, pinned: boolean): Promise<void> {
  s.pinned = pinned;
  renderSessions();
  deps.onPinsChanged();
  const res = await fetch(`/api/sessions/${s.id}/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
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
  const more = h(
    "button",
    "ml-auto hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block",
    "\u22ef",
  );
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
  // Hover shortcut: new session in this cwd, no dialog — the cwd is the answer
  // the dialog would have asked for.
  const add = h(
    "button",
    "ml-auto hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block",
    "+",
  );
  add.title = `New session in ${cwd}`;
  add.onclick = (ev) => {
    ev.preventDefault(); // a click inside <summary> would toggle the project
    ev.stopPropagation();
    void deps.createSession(cwd);
  };
  const { el, summary } = detailsRow("border-b border-neutral-200/70", [
    h("span", "truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500", basename(cwd)),
    count,
    add,
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
  archiveCount.textContent = String(sessions.length);
  knownProjects.replaceChildren(
    ...[...groupByCwd(sessions).keys()].map((cwd) => {
      const opt = document.createElement("option");
      opt.value = cwd;
      return opt;
    }),
  );
  if (archiveDialog.open) renderArchive();
}

// --- all sessions (everything Pi knows about, pin from here) -----------------------

function archiveRow(s: SessionInfo): HTMLElement {
  const li = h("li", "flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-neutral-100");
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
  li.append(
    stateDot(s),
    h("span", "truncate", s.title ?? "untitled"),
    h("span", "ml-auto flex-none text-[11px] text-neutral-400", relTime(s.createdAt)),
    pin,
  );
  li.onclick = () => {
    archiveDialog.close();
    deps.select(s.id);
  };
  return li;
}

function renderArchive(): void {
  const q = archiveSearch.value.trim().toLowerCase();
  const match = deps.sessions().filter(
    (s) => !q || `${s.title ?? ""} ${s.cwd}`.toLowerCase().includes(q),
  );
  const nodes: HTMLElement[] = [];
  for (const [cwd, list] of groupByCwd(match)) {
    const head = h(
      "li",
      "truncate px-3 pb-0.5 pt-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500",
      basename(cwd),
    );
    head.title = cwd;
    nodes.push(head, ...list.map(archiveRow));
  }
  archiveList.replaceChildren(
    ...(nodes.length
      ? nodes
      : [h("li", "px-3 py-3 text-[13px] text-neutral-400", "No matching sessions.")]),
  );
}

// --- wiring ----------------------------------------------------------------------------

export function initSidebar(d: SidebarDeps): void {
  deps = d;
  // Same picker the channel config uses; the input keeps its own semantics.
  $("#new-cwd-row").append(browseButton($<HTMLInputElement>("#new-cwd")));
  $("#new-session").onclick = () => {
    $<HTMLInputElement>("#new-cwd").value = "";
    newDialog.showModal();
  };
  $("#new-cancel").onclick = () => newDialog.close();
  $<HTMLFormElement>("#new-form").onsubmit = () =>
    void deps.createSession($<HTMLInputElement>("#new-cwd").value.trim());
  $("#open-archive").onclick = () => {
    archiveSearch.value = "";
    renderArchive();
    archiveDialog.showModal();
    archiveSearch.focus();
  };
  $("#archive-close").onclick = () => archiveDialog.close();
  archiveSearch.oninput = () => renderArchive();
}
