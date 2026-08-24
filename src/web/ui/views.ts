// Chat ↔ Console switching and the hash router. Owns the Console views
// (Tasks, Activity, Boards, Settings — which hosts Providers, Models,
// Channels and Agent files as tabs), which chat elements hide while one is
// open, and the address bar's copy of "where am I" — so refresh, bookmarks
// and back/forward land where the user was. main.ts owns sessions and
// selection and feeds them in through init.

import { createActivityView, type ActivityView } from "./activity.js";
import { createBoardsView } from "./boards.js";
import { createExplorerView } from "./explorer.js";
import { turnsPane } from "./chat.js";
import { syncQueuePanel } from "./composer.js";
import { $, type ConsoleView } from "./dom.js";
import { renderHeader } from "./session-header.js";
import { createSettingsView } from "./settings.js";
import { closeDrawer, setBarTitle } from "./shell.js";
import { groupByCwd, type SessionInfo } from "./sidebar.js";
import { createTasksView, type TasksView } from "./tasks.js";
import { createTerminalView } from "./terminal.js";
import { shortcut } from "./shortcut.js";

/** Everything the view switcher needs from the orchestrator (main.ts). */
export interface ViewsDeps {
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  currentSession: () => SessionInfo | undefined;
  select: (id: string) => void;
  /** The selected session's turns just came (back) on screen. */
  maybeAckRead: () => void;
}

let deps: ViewsDeps;

const chatHeader = $("#chat-header");
const chatTitle = $("#chat-title");
const composerForm = $<HTMLFormElement>("#composer");

// Console views hide chat elements but leave session SSE wiring untouched.
const chatEls = [chatHeader, turnsPane, composerForm];
let chatVisible = true;

export const isChatVisible = (): boolean => chatVisible;

export type ConsoleName = "tasks" | "activity" | "boards" | "settings" | "files" | "terminal";

let tasksView: TasksView;
let activityView: ActivityView;
let consoleViews: { name: ConsoleName; view: ConsoleView }[] = [];
const consoleBtns = new Map<ConsoleName, HTMLElement>();

// Whichever of the Activity item's two views (Activity or Tasks) showed last;
// the views themselves keep their tab/selection state.
let lastActivityConsole: ConsoleName = "activity";

// Files and Terminal drop over whatever was on screen and their ✕ returns
// there — each remembers where it was opened from.
const OVERLAYS: ConsoleName[] = ["files", "terminal"];
const origins = new Map<ConsoleName, Route>();

const CONSOLE_LABELS: Record<ConsoleName, string> = {
  tasks: "Tasks",
  activity: "Activity",
  boards: "Boards",
  settings: "Settings",
  files: "Files",
  terminal: "Terminal",
};

// Workspace events fan into whichever of these views is open.
export const refreshTasks = (taskId?: string): void => tasksView.refresh(taskId);
export const refreshActivity = (): void => activityView.refresh();

/** Mobile top bar mirrors the route: a Console view's name, or the chat title
 *  plus its ⋯ menu (the chat header itself is hidden below md). */
export function syncBar(): void {
  const open = consoleViews.find((entry) => entry.view.visible);
  if (open) setBarTitle(CONSOLE_LABELS[open.name], false);
  else setBarTitle(chatTitle.textContent ?? "", deps.currentSession() !== undefined);
}

/** Open a Console view by name — the sidebar's rows and the search palette
 *  both address them this way rather than clicking each other's buttons. */
export function showConsole(name: ConsoleName, arg?: string): void {
  if (name === "tasks" || name === "activity") lastActivityConsole = name;
  // Switching folders inside an overlay re-enters the same view: not a new origin.
  if (OVERLAYS.includes(name)) {
    const from = parseHash();
    if (from && !(from.kind === "console" && from.name === name)) origins.set(name, from);
  }
  setHash({ kind: "console", name, arg });
  closeDrawer();
  chatVisible = false;
  for (const el of chatEls) el.classList.add("hidden");
  syncQueuePanel();
  for (const entry of consoleViews) {
    if (entry.name === name) entry.view.show(arg);
    else entry.view.hide();
  }
  // Tasks lives under the Activity menu item (tab strip inside the views).
  for (const [btnName, btn] of consoleBtns) {
    btn.classList.toggle(
      "bg-indigo-50",
      btnName === name || (btnName === "activity" && name === "tasks"),
    );
  }
  syncBar();
}

export const showTasks = (taskId?: string): void => showConsole("tasks", taskId);

/** Entry for the ⋯ menus (session header, project row): browse a cwd. */
export const showFiles = (dir?: string): void => showConsole("files", dir);

/** Entry for the project row menu and the sidebar icon: a shell in a cwd. */
export const showTerminal = (dir?: string): void => showConsole("terminal", dir);

/** The chord's version: one key both opens the overlay and, pressed again, is
 *  its ✕. A menu row keeps opening — it names a directory, so it always does. */
const toggleOverlay = (name: ConsoleName, dir?: string): void => {
  if (consoleViews.find((entry) => entry.name === name)?.view.visible) closeOverlay(name);
  else showConsole(name, dir);
};

export const toggleFiles = (dir?: string): void => toggleOverlay("files", dir);
export const toggleTerminal = (dir?: string): void => toggleOverlay("terminal", dir);

/** An overlay's ✕. Back to the route it was opened from — a session's chat, or
 *  the Console view you came from — and the current session when that is
 *  unknown (a bookmarked or reloaded #/files, where there is no "from"). */
function closeOverlay(name: ConsoleName): void {
  const id = deps.currentId();
  const back: Route | null = origins.get(name) ?? (id ? { kind: "session", id } : null);
  origins.delete(name);
  if (back) setHash(back); // onhashchange → applyRoute() does the switching
  else {
    history.replaceState(null, "", "#/"); // no session to name; don't let the hash lie
    showChat();
  }
}

export function showChat(): void {
  if (!consoleViews.some(({ view }) => view.visible)) return;
  for (const { view } of consoleViews) view.hide();
  for (const btn of consoleBtns.values()) btn.classList.remove("bg-indigo-50");
  chatVisible = true;
  for (const el of chatEls) el.classList.remove("hidden");
  syncQueuePanel();
  syncBar();
  deps.maybeAckRead(); // the selected session's turns just came (back) on screen
}

// --- routing (the hash is the address bar's copy of "where am I") ---------------------
// Every view is addressable — a session's chat, each Console view, one task
// inside it. Hash, not path: the static file server stays a static file server.

type Route = { kind: "session"; id: string } | { kind: "console"; name: ConsoleName; arg?: string };

const hashOf = (r: Route): string =>
  r.kind === "session"
    ? `#/session/${encodeURIComponent(r.id)}`
    : `#/${r.name}${r.arg ? `/${encodeURIComponent(r.arg)}` : ""}`;

/** Pre-fold bookmarks still land: the old top-level views are Settings tabs now. */
const FOLDED: Record<string, string> = { config: "files", channels: "channels", providers: "providers" };

function parseHash(): Route | null {
  const [head = "", arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (FOLDED[head]) return { kind: "console", name: "settings", arg: FOLDED[head] };
  const name = consoleViews.find((v) => v.name === head)?.name;
  if (name) return { kind: "console", name, arg: arg ? decodeURIComponent(arg) : undefined };
  if (head === "session" && arg) return { kind: "session", id: decodeURIComponent(arg) };
  return null; // unknown or empty → the fallback in applyRoute()
}

// While a route is applied the UI must not rewrite the hash it is reading; the
// guard spans only the synchronous view switch, never the history fetch.
let applyingRoute = false;

function setHash(r: Route, replace = false): void {
  if (applyingRoute) return;
  const next = hashOf(r);
  if (location.hash === next) return;
  if (replace) history.replaceState(null, "", next);
  else location.hash = next; // pushes an entry, so Back returns to the last view
}

export const setSessionHash = (id: string): void => setHash({ kind: "session", id });

/** Hash → UI. A missing or stale route falls back to the first pinned session. */
export function applyRoute(): void {
  const route = parseHash();
  const sessions = deps.sessions();
  const currentId = deps.currentId();
  const wanted = route?.kind === "session" ? route.id : null;
  const id =
    wanted && sessions.some((s) => s.id === wanted)
      ? wanted
      : (currentId ?? (sessions.find((s) => s.pinned) ?? sessions[0])?.id ?? null);
  applyingRoute = true;
  try {
    if (id && id !== currentId) deps.select(id);
    if (route?.kind === "console") showConsole(route.name, route.arg);
    else showChat();
    if (!id) renderHeader();
  } finally {
    applyingRoute = false;
  }
  // Boot with no hash, or a session that no longer exists: name where we landed
  // without adding a history entry.
  if (route?.kind !== "console" && id) setHash({ kind: "session", id }, true);
}

export function initViews(d: ViewsDeps): void {
  deps = d;
  tasksView = createTasksView(
    $("#tasks-view"),
    () => deps.sessions().map(({ id, cwd, title }) => ({ id, cwd, title })),
    d.select,
    () => deps.currentId(),
    (arg) => showConsole("activity", arg),
  );
  activityView = createActivityView($("#activity-view"), d.select, showTasks);
  consoleViews = [
    { name: "tasks", view: tasksView },
    { name: "activity", view: activityView },
    { name: "boards", view: createBoardsView($("#boards-view"), d.select) },
    {
      name: "files",
      view: createExplorerView(
        $("#files-view"),
        () => [...groupByCwd(deps.sessions()).keys()],
        // Through the router, so Back walks directory switches too.
        (dir) => showConsole("files", dir),
        () => closeOverlay("files"),
      ),
    },
    {
      name: "terminal",
      view: createTerminalView(
        $("#terminal-view"),
        () => [...groupByCwd(deps.sessions()).keys()],
        () => deps.currentSession()?.cwd,
        (dir) => showConsole("terminal", dir),
        () => closeOverlay("terminal"),
      ),
    },
    {
      name: "settings",
      view: createSettingsView(
        $("#settings-view"),
        () => [...groupByCwd(deps.sessions()).keys()],
        // Through the router, not a local re-render: the hash is the one
        // copy of "where am I", and Back should walk tabs too.
        (t) => showConsole("settings", t),
      ),
    },
  ];
  // The sidebar icon and its chord both toggle — pierce: this Ctrl chord must
  // close Terminal from inside it; other Ctrl chords stay with the shell.
  const termBtn = $("#open-terminal");
  termBtn.onclick = () => toggleTerminal();
  shortcut(termBtn, "ctrl+`", "Terminal", () => toggleTerminal(), undefined, true);
  // The Activity button reopens whichever of its two views was showing last.
  for (const name of ["activity", "boards", "settings"] as const) {
    const btn = $(`#open-${name}`);
    consoleBtns.set(name, btn);
    btn.onclick = () => showConsole(name === "activity" ? lastActivityConsole : name);
  }
  const consoleSection = $<HTMLDetailsElement>("#console-section");
  consoleSection.open = localStorage.getItem("pier.consoleCollapsed") !== "1";
  consoleSection.ontoggle = () =>
    localStorage.setItem("pier.consoleCollapsed", consoleSection.open ? "0" : "1");
  window.onhashchange = applyRoute; // Back/forward and hand-edited URLs
}
