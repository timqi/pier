// The left rail: the sessions Projects is listing, grouped by repository, the
// search palette that reaches everything (⌘K), and the New-session dialog.
// main.ts owns the session list; this module renders it and reports
// interactions back.

import { sendJson } from "./api.js";
import { pathTrigger, type PathOption } from "./dir-picker.js";
import { $, basename, detailsRow, h, relTime } from "./dom.js";
import { closeMenu, openMenu } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { setAttention } from "./shell.js";
import { shortcut } from "./shortcut.js";
import type { SessionState } from "../../core/types.js";
// A value import, unlike the type-only line above: src/limits.ts is a leaf of
// numbers with no runtime behind it, and a hand-copied 7 in this file is
// exactly the drift it exists to stop.
import { PROJECT_LEASE_MS } from "../../limits.js";

/** GET /api/projects or /api/sessions row: summary + live workspace state. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  title?: string;
  state: SessionState;
  /** In Projects *now*. Not the database's `pinned`, which is ownership and
   *  outlives an expired lease: this is what the rail draws. */
  listed: boolean;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
  /** Exempt from the Projects lease: it stays in the rail however quiet it goes. */
  kept: boolean;
  /** When its last turn finished — what the lease is counted from. */
  lastActive?: number;
  /** The IM channel that owns it, or `"web"` for everything else. */
  channel: string;
  /** Background runs this session launched that are still in flight. */
  activeRuns: number;
  /** Where it was dragged to inside its project; unset = never dragged. */
  sort?: number;
  /** Where its *project* was dragged to; every row of a cwd carries the same
   *  one, so a session's arrival never moves the project it arrived in. */
  projectSort?: number;
  /** The repository behind `cwd` — shared by every worktree of it, which is
   *  what makes them one project here. Absent when cwd is not a checkout. */
  repo?: string;
  /** Which branch that checkout has, when it has one. */
  branch?: string;
}

/** Everything the sidebar needs from the orchestrator (main.ts). */
export interface SidebarDeps {
  sessions: () => SessionInfo[];
  loadSessions: () => Promise<void>;
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

// --- projects (the listed sessions, grouped by repository) --------------------------
// Projects lists what it owns and is still showing — sessions created in Pier
// (pinned on creation) or pinned from the All-sessions dialog, minus the ones
// whose lease ran out — so Pi history never floods the sidebar.

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

function groupBy(list: SessionInfo[], key: (s: SessionInfo) => string): Map<string, SessionInfo[]> {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of list) {
    const at = key(s);
    const existing = groups.get(at);
    if (existing) existing.push(s);
    else groups.set(at, [s]);
  }
  return groups;
}

/** Distinct directories, for the things that address one: the New-session
 *  suggestions and the Files/Terminal pickers. */
export const groupByCwd = (list: SessionInfo[]): Map<string, SessionInfo[]> =>
  groupBy(list, (s) => s.cwd);

// --- one project, however many checkouts ---------------------------------------------
// A project is a repository, not a directory. Parallel work means worktrees —
// sibling checkouts of one repo, one branch each — and one rail entry per
// directory turned a repo worked on three branches into three unrelated
// projects, each with its own place in the order. The grouping key is the
// common git dir the server reports; a directory that is not a checkout is its
// own project, exactly as before.

const groupKey = (s: SessionInfo): string => s.repo ?? s.cwd;

/** The working copy a group key names, when it names one: the key is either a
 *  repository's common git dir (`…/thing/.git`) or a plain directory. */
const mainCheckout = (key: string): string | undefined =>
  key.endsWith("/.git") ? key.slice(0, -5) : undefined;

/** What to call the group: the repository's own directory, not whichever
 *  worktree happens to sort first — `pier`, never `pier.some-branch`. */
const groupName = (key: string, list: SessionInfo[]): string =>
  basename(mainCheckout(key) ?? list[0]?.cwd ?? key);

/** The checkouts in a group, main one first when it is among them: the actions
 *  that take a single directory (files, terminal) mean that one. */
function cwdsOf(key: string, list: SessionInfo[]): string[] {
  const main = mainCheckout(key);
  const cwds = [...new Set(list.map((s) => s.cwd))];
  return main && cwds.includes(main) ? [main, ...cwds.filter((c) => c !== main)] : cwds;
}

// --- manual order -------------------------------------------------------------------
// Two lists, arranged by hand and kept on the server: the projects, and the
// sessions inside each one. Both were derived from creation time before, which
// meant starting a session hoisted its project over everything else — the one
// move that must not rearrange the rail you are reading.

/** Never-dragged sorts first, so a new row lands on top of its list and an
 *  instance that has never been arranged keeps a stable, obvious order. */
function byRank(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a - b;
}

/** Projects in their arranged order, each with its sessions in theirs.
 *  Un-arranged ties break on when the project was *first* seen (newest first)
 *  and when a session was created (newest first) — both immutable, so nothing
 *  below moves because something new appeared above it. */
function orderedProjects(list: SessionInfo[]): [string, SessionInfo[]][] {
  const groups = [...groupBy(list, groupKey)].map(([key, rows]): [string, SessionInfo[]] => [
    key,
    // Same repo, several checkouts: the branch groups the rows inside the
    // project, so switching between two worktrees is not a scan of the list.
    [...rows].sort((a, b) =>
      (a.branch ?? a.cwd).localeCompare(b.branch ?? b.cwd) ||
      byRank(a.sort, b.sort) || b.createdAt - a.createdAt
    ),
  ]);
  // The lowest place any of a group's checkouts was given — not the first one
  // found, which for a multi-worktree project depends on the row order above.
  const rank = (rows: SessionInfo[]): number | undefined => {
    const places = rows.map((s) => s.projectSort).filter((at) => at !== undefined);
    return places.length ? Math.min(...places) : undefined;
  };
  const born = (rows: SessionInfo[]): number => Math.min(...rows.map((s) => s.createdAt));
  return groups.sort(([, a], [, b]) => byRank(rank(a), rank(b)) || born(b) - born(a));
}

/** `key` out, back in above or below `target`. */
function moved(keys: string[], key: string, target: string, after: boolean): string[] {
  const rest = keys.filter((k) => k !== key);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, key);
  return rest;
}

/** What the rail is showing: the listed sessions, arranged. */
const pinnedProjects = (): [string, SessionInfo[]][] =>
  orderedProjects(deps.sessions().filter((s) => s.listed));

/** Those projects as picker candidates: one row per checkout, branch as hint. */
const projectPaths = (): PathOption[] =>
  pinnedProjects().flatMap(([key, list]) =>
    cwdsOf(key, list).map((path) => {
      const branch = list.find((s) => s.cwd === path)?.branch;
      return { path, ...(branch ? { hint: branch } : {}) };
    }),
  );

/** Optimistic, like the pin toggle: the new places are on the rows and drawn
 *  before the write, and whatever the server says wins over them. A rejected
 *  or unreachable write reloads the list, so the order visibly snaps back
 *  rather than lying about having been saved. */
function place(
  order: string[],
  keyOf: (s: SessionInfo) => string,
  set: (s: SessionInfo, at: number) => void,
  body: { sessions?: string[]; projects?: string[] },
): void {
  const rank = new Map(order.map((key, i) => [key, i]));
  for (const s of deps.sessions()) {
    const at = rank.get(keyOf(s));
    if (at !== undefined) set(s, at);
  }
  renderSessions();
  const reload = () => void deps.loadSessions();
  void sendJson("/api/projects/order", body).then((res) => {
    if (!res.ok) reload();
  }, reload);
}

function dropSession(key: string, id: string, target: string, after: boolean): void {
  const rows = pinnedProjects().find(([k]) => k === key);
  if (!rows) return;
  const sessions = moved(rows[1].map((s) => s.id), id, target, after);
  place(sessions, (s) => s.id, (s, at) => (s.sort = at), { sessions });
}

function dropProject(key: string, target: string, after: boolean): void {
  const groups = pinnedProjects();
  const order = moved(groups.map(([k]) => k), key, target, after);
  // The server stamps a place per *directory*, so a group ships every checkout
  // it holds, in its own order: no worktree can be dragged out of its repo.
  const projects = order.flatMap((k) => {
    const rows = groups.find(([g]) => g === k);
    return rows ? cwdsOf(k, rows[1]) : [];
  });
  place(order, groupKey, (s, at) => (s.projectSort = at), { projects });
}

/** Which row is being dragged, and which list it may be dropped in: a session
 *  belongs to its cwd and cannot leave it — the directory is what it *is*. */
let dragging: { list: string; key: string } | null = null;

/** The line the row would land on — inline rather than a class, so it cannot
 *  collide with the borders the project rows already carry. */
function dropLine(row: HTMLElement, after: boolean | null): void {
  row.style.boxShadow = after === null ? "" : `inset 0 ${after ? -2 : 2}px 0 0 #818cf8`;
}

/** Make one row draggable within `list`, dropping above or below whichever
 *  half of a row it is released on. */
function sortable(row: HTMLElement, list: string, key: string, drop: (target: string, after: boolean) => void): void {
  row.draggable = true;
  row.ondragstart = (ev) => {
    ev.stopPropagation(); // a session drag is not also its project's
    dragging = { list, key };
    // Firefox starts no drag at all without payload; the key is the payload.
    ev.dataTransfer?.setData("text/plain", key);
  };
  // Re-render on end, not only on drop: a drag abandoned outside every row
  // leaves the last drop line drawn, and a stray line is an order nobody made.
  row.ondragend = () => {
    dragging = null;
    renderSessions();
  };
  const half = (ev: DragEvent): boolean => {
    const box = row.getBoundingClientRect();
    return ev.clientY > box.top + box.height / 2;
  };
  const droppable = (ev: DragEvent): boolean => {
    if (!dragging || dragging.list !== list || dragging.key === key) return false;
    ev.preventDefault(); // the default is "reject the drop"
    ev.stopPropagation();
    return true;
  };
  row.ondragover = (ev) => {
    if (droppable(ev)) dropLine(row, half(ev));
  };
  row.ondragleave = () => dropLine(row, null);
  row.ondrop = (ev) => {
    const from = dragging?.key;
    dropLine(row, null);
    if (droppable(ev) && from) drop(from, half(ev));
  };
}

/** Row action revealed on hover (resident on touch, which has no hover). */
const HOVER_BTN =
  "hidden flex-none rounded px-1 leading-none text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block pointer-coarse:block";

/** Whole days before the lease runs out. Counted from the same constant the
 *  server enforces (src/limits.ts), not a copy of the number it holds: a
 *  surface promising seven days while the server drops the row at eight is
 *  worse than one that says nothing. Two of them say it — the row's tooltip and
 *  the Keep row in the session menu — so they say it from here. */
export const leaseDaysLeft = (s: SessionInfo): number =>
  Math.max(0, Math.ceil((PROJECT_LEASE_MS - (Date.now() - (s.lastActive ?? s.createdAt))) / DAY_MS));

/** Why this row is in the rail, and for how long. A session leaving on its own
 *  is the point of the lease, so the row says so before it happens rather than
 *  looking like something went missing. */
function leaseNote(s: SessionInfo): string {
  if (s.kept) return "Kept in Projects";
  const days = Math.floor((Date.now() - (s.lastActive ?? s.createdAt)) / DAY_MS);
  return `Quiet ${days === 0 ? "today" : `${days}d`} — leaves Projects in ${
    leaseDaysLeft(s)
  }d unless kept`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Waiting for *you*, which is narrower than `unread`.
 *
 * Unread is a property of a row in Projects and of nothing else. The server
 * marks every session whose turn ends, and most of those have no reader here:
 * a subagent's turn was addressed to its supervisor and delivered by callback,
 * an IM session's to the chat it came from. Nothing ever clears them either —
 * an ack needs the session selected — so drawn as-is they are permanently
 * amber, which is a mark nobody reads. Said once, for the dot and the two
 * badges standing in for it.
 */
const waitingForYou = (s: SessionInfo): boolean => s.unread && s.listed;

/** Attention dot: green = running, amber = finished and waiting for a look,
 *  sky = idle itself but subagents still in flight, grey = idle. */
function stateDot(s: SessionInfo): HTMLElement {
  const [cls, title] =
    s.state === "streaming"
      ? ["bg-green-500 animate-pulse", "working…"]
      : waitingForYou(s)
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : s.activeRuns > 0
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
          : ["bg-neutral-300", "idle"];
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${cls}`);
  dot.title = title;
  return dot;
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

/** Kept = never ages out of the rail. */
export function setKept(s: SessionInfo, kept: boolean): Promise<void> {
  // Not rolled back with the flag: the lease was renewed by asking, and the
  // next Projects read carries the server's own stamp either way.
  s.lastActive = Date.now();
  return optimistic((v) => (s.kept = v), kept, !kept, `/api/sessions/${s.id}/keep`, { kept });
}

/** Unpin keeps the session — it just moves back into the All-sessions list. */
export const setPinned = (s: SessionInfo, pinned: boolean): Promise<void> =>
  optimistic((v) => (s.listed = v), pinned, !pinned, `/api/sessions/${s.id}/pin`, { pinned });

/** The branch checked out in `at`, for the menu row that offers it. Falls back
 *  to the directory's own name, which is what a non-repo project has. */
const branchAt = (list: SessionInfo[], at: string): string =>
  list.find((s) => s.cwd === at)?.branch ?? basename(at);

/** Which checkout this session works in, when its project has more than one.
 *  A single-worktree project would only be telling you its own branch. */
function branchChip(s: SessionInfo, show: boolean): HTMLElement[] {
  if (!show || !s.branch) return [];
  const chip = h(
    "span",
    "flex-none truncate rounded bg-neutral-200/70 px-1 font-mono text-[10px] leading-[15px] text-neutral-500",
    s.branch,
  );
  chip.style.maxWidth = "40%";
  chip.title = s.cwd;
  return [chip];
}

function sessionRow(s: SessionInfo, branches: boolean): HTMLElement {
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
  // The action a throwaway session ends with, one click from the row it is on:
  // it used to be two, inside the ⋯ menu, which is deep enough that the rail
  // filled up instead.
  const done = h("button", HOVER_BTN, "\u2713");
  done.title = "Done — remove from Projects (the session and its transcript stay)";
  done.onclick = (ev) => {
    ev.stopPropagation();
    void setPinned(s, false);
  };
  // Kept has to be visible where the exemption applies, or the rail cannot say
  // why one row outlived the rest. Same idiom as a project's count: resident,
  // and out of the way of the controls on hover.
  // An emoji pushpin would draw its own colour and its own angle; the outline
  // takes the row's grey and points its tip down, which is a pin that is in.
  const badge = h("span", "flex-none text-neutral-400 group-hover:hidden");
  badge.innerHTML =
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5">` +
    `<path d="M8 11.33v3.34"/>` +
    `<path d="M3.33 11.33h9.34v-1.17a1.33 1.33 0 0 0-.74-1.19l-1.19-.6A1.33 1.33 0 0 1 10 7.17V4h.67a1.33 1.33 0 0 0 0-2.67H5.33A1.33 1.33 0 0 0 5.33 4H6v3.17a1.33 1.33 0 0 1-.74 1.19l-1.19.6a1.33 1.33 0 0 0-.74 1.19Z"/></svg>`;
  badge.title = "Kept in Projects";
  li.append(
    stateDot(s),
    h("span", "truncate", s.title ?? "untitled"),
    h(
      "div",
      "ml-auto flex flex-none items-center gap-1",
      ...branchChip(s, branches),
      ...(s.kept ? [badge] : []),
      done,
      more,
    ),
  );
  li.onclick = () => deps.select(s.id);
  li.title = `${leaseNote(s)}\nDrag to reorder`;
  const key = groupKey(s);
  sortable(li, key, s.id, (id, after) => dropSession(key, id, s.id, after));
  return li;
}

/** One collapsible project = one repository (or one plain directory); collapse
 *  state lives in localStorage. */
function projectNode(key: string, list: SessionInfo[]): HTMLElement {
  const cwds = cwdsOf(key, list);
  const cwd = cwds[0] ?? key;
  const count = h(
    "span",
    "flex-none text-[11px] text-neutral-400 group-hover:hidden",
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
      // One row per checkout, because "here" is ambiguous the moment a repo has
      // worktrees, and the branch is what the choice is actually between.
      ...cwds.map((at) => ({
        label: cwds.length > 1 ? `New session in ${branchAt(list, at)}` : "New session here",
        hint: basename(at),
        onSelect: () => {
          closeMenu();
          void deps.createSession(at);
        },
      })),
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
      {
        // Reversible, like the per-session row above it: the sessions and
        // their transcripts stay, All sessions can pin any of them back.
        label: `Remove ${list.length} session${list.length > 1 ? "s" : ""} from Projects`,
        onSelect: () => {
          closeMenu();
          for (const s of list) void setPinned(s, false);
        },
      },
    ]);
  };
  const { el, summary } = detailsRow("border-b border-neutral-200/70", [
    h("span", "truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-neutral-500", groupName(key, list)),
    // On a coarse pointer the ⋯ is resident, so count and button are visible
    // together: two ml-autos would split the free space and leave the count
    // mid-row. One wrapper owns it.
    h("div", "ml-auto flex flex-none items-center gap-1.5", count, more),
  ]);
  summary.className += " group px-3 py-1.5 hover:bg-neutral-100";
  // Every checkout the group covers, because the heading now names a repository
  // and the directories are what a session actually runs in.
  summary.title = `${cwds.join("\n")}\nDrag to reorder`;
  // The summary is the handle and the drop zone: an open project is as tall as
  // its sessions, and "above or below" has to mean above or below its heading.
  sortable(summary, "", key, (from, after) => dropProject(from, key, after));
  el.open = !collapsed.has(key);
  el.ontoggle = () => setCollapsed(key, !el.open);
  const rows = h("ul", "pb-1");
  rows.append(...list.map((s) => sessionRow(s, cwds.length > 1)));
  el.append(rows);
  return el;
}

export function renderSessions(): void {
  const sessions = deps.sessions();
  // The one place the dots are painted, so also the one place the two surfaces
  // that stand in for them off screen are counted: the badge on the sidebar
  // toggle (ui/shell.ts) and the installed app's icon. Both count what carries
  // a dot and nothing else — this array holds far more than the rail draws,
  // because a Projects read merges rather than replaces (ui/main.ts).
  //
  // The icon badge also skips the IM sessions, for the reason web/push.ts skips
  // them: that turn was already delivered to the chat it came from. A pinned IM
  // session's dot still says "new since you last looked here" — but only a
  // Console visit clears one, and a badge on a closed app showing a number no
  // action of yours can clear is not attention state, it is a session counter.
  const waiting = sessions.filter(waitingForYou);
  setAttention(waiting.length);
  setUnreadBadge(waiting.filter((s) => s.channel === "web").length);
  const projects = pinnedProjects();
  projectTree.replaceChildren(
    ...(projects.length
      ? projects.map(([key, list]) => projectNode(key, list))
      : [
          h(
            "p",
            "px-3 py-2 text-[12.5px] leading-snug text-neutral-400",
            "No projects yet — create a session, or pin one from All sessions.",
          ),
        ]),
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

function pinButton(s: SessionInfo): HTMLElement {
  const pin = h(
    "button",
    `flex-none rounded px-1.5 py-0.5 text-[11.5px] ${
      s.listed
        ? "bg-indigo-50 text-indigo-600"
        : "text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
    }`,
    s.listed ? "pinned" : "pin",
  );
  pin.title = s.listed ? "Remove from Projects" : "Pin to Projects";
  pin.onclick = (ev) => {
    ev.stopPropagation();
    void setPinned(s, !s.listed);
  };
  return pin;
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
      pinButton(t.session),
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
    ["Projects", idle.filter((s) => s.listed).sort(byAge).map(target)],
    ["Other sessions", idle.filter((s) => !s.listed).sort(byAge).map(target)],
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
  // The new session nearly always belongs to a project the rail already shows,
  // so the field itself offers those directories in the rail's own order, with
  // the folder tree under them; typing a path still works.
  pathTrigger($<HTMLInputElement>("#new-cwd"), projectPaths);
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
