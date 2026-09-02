// Chat ↔ Console switching and the hash router. Owns the Console views
// (Tasks, Activity, Boards, Settings — which hosts Providers, Models,
// Channels and Agent files as tabs), which chat elements hide while one is
// open, and the address bar's copy of "where am I" — so refresh, bookmarks
// and back/forward land where the user was. main.ts owns sessions and
// selection and feeds them in through init.

import type { ActivityView } from "./activity.js";
import { turnsPane } from "./chat.js";
import { syncQueuePanel } from "./composer.js";
import { $, consoleView, h, type ConsoleView } from "./dom.js";
import { renderHeader } from "./session-header.js";
import { closeDrawer, setBarTitle } from "./shell.js";
import { groupByCwd, type SessionInfo } from "./sidebar.js";
import type { TasksView } from "./tasks.js";
import { shortcut } from "./shortcut.js";

/** Everything the view switcher needs from the orchestrator (main.ts). */
export interface ViewsDeps {
  sessions: () => SessionInfo[];
  loadSessions: () => Promise<void>;
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

export const isChatVisible = (): boolean => openName === null;

export type ConsoleName = "tasks" | "activity" | "boards" | "settings" | "files" | "terminal";

let tasksView: TasksView | undefined;
let activityView: ActivityView | undefined;
/** Built so far — a view arrives with its own chunk the first time it opens. */
const views = new Map<ConsoleName, ConsoleView>();
/** In-flight builds, so leaving and reopening a loading view cannot construct
 *  it twice and duplicate its document listeners. */
const building = new Map<ConsoleName, Promise<ConsoleView>>();
const consoleBtns = new Map<ConsoleName, HTMLElement>();
/** Which view the route says is open, set before its chunk lands: the top bar
 *  and the overlay toggles may not wait on a fetch to know where they are. */
let openName: ConsoleName | null = null;
let openRequest = 0;

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

// Workspace events fan into whichever of these views is open — and into none
// while a view has never been opened: its first show() loads what it missed.
export const refreshTasks = (taskId?: string): void => tasksView?.refresh(taskId);
export const refreshActivity = (): void => activityView?.refresh();

/** Mobile top bar mirrors the route: a Console view's name, or the chat title
 *  plus its ⋯ menu (the chat header itself is hidden below md). */
export function syncBar(): void {
  if (openName) setBarTitle(CONSOLE_LABELS[openName], false);
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
  openName = name;
  for (const el of chatEls) el.classList.add("hidden");
  syncQueuePanel();
  for (const [built, view] of views) if (built !== name) view.hide();
  // Tasks lives under the Activity menu item (tab strip inside the views).
  for (const [btnName, btn] of consoleBtns) {
    btn.classList.toggle(
      "bg-indigo-50",
      btnName === name || (btnName === "activity" && name === "tasks"),
    );
  }
  syncBar();
  void openView(name, arg, ++openRequest);
}

/** A view's module loads the first time it opens — the Console is five pages
 *  the chat waited for at boot. Everything the route implies has already
 *  happened above, so a slow chunk shows an empty pane rather than a stale
 *  one; a chunk that will not load says so where the view would have been,
 *  because a Console that opens onto nothing is a Console that looks broken. */
async function openView(name: ConsoleName, arg: string | undefined, request: number): Promise<void> {
  let view = views.get(name);
  if (!view) {
    let pending = building.get(name);
    if (!pending) {
      const root = $(`#${name}-view`);
      pending = BUILD[name](root).catch((err: unknown) => {
        // A stub view, not a loose message: the pane still has to hide when the
        // chat comes back. It says reload because a chunk that failed to load
        // will not load until the page does.
        console.warn(`${name} view failed to load`, err);
        return consoleView(root, () =>
          root.replaceChildren(
            h("p", "p-4 text-[13px] text-red-600", `Could not load ${CONSOLE_LABELS[name]} — reload the page.`),
          ),
        );
      });
      building.set(name, pending);
    }
    view = await pending;
    views.set(name, view);
    building.delete(name);
  }
  // The same view may have been left and reopened with a different argument.
  if (openName !== name || request !== openRequest) return;
  view.show(arg);
}

export const showTasks = (taskId?: string): void => showConsole("tasks", taskId);

/** Entry for the ⋯ menus (session header, project row): browse a cwd — or
 *  none, which reopens where the current session left off. */
export const showFiles = (dir?: string): void => showConsole("files", dir);

/** Entry for the project row menu and the sidebar icon: a shell in a cwd. */
export const showTerminal = (dir?: string): void => showConsole("terminal", dir);

/** The chord's version: one key both opens the overlay and, pressed again, is
 *  its ✕. A menu row keeps opening — it names a directory, so it always does. */
const toggleOverlay = (name: ConsoleName, dir?: string): void => {
  if (openName === name) closeOverlay(name);
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
  if (!openName) return;
  openName = null;
  for (const view of views.values()) view.hide();
  for (const btn of consoleBtns.values()) btn.classList.remove("bg-indigo-50");
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
const FOLDED: Record<string, string> = { config: "files", channels: "channels", providers: "models" };

function parseHash(): Route | null {
  const [head = "", arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (FOLDED[head]) return { kind: "console", name: "settings", arg: FOLDED[head] };
  // The labels are the name list too — a route may not wait for a view to be
  // built. hasOwn, not `in`: `#/toString` is a hash anyone can type.
  if (Object.hasOwn(CONSOLE_LABELS, head))
    return { kind: "console", name: head as ConsoleName, arg: arg ? decodeURIComponent(arg) : undefined };
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

/** Hash → UI. Session routes may name non-pinned sessions; select verifies them. */
export function applyRoute(): void {
  const route = parseHash();
  const sessions = deps.sessions();
  const currentId = deps.currentId();
  const wanted = route?.kind === "session" ? route.id : null;
  const id = wanted ?? (currentId ?? (sessions.find((s) => s.listed) ?? sessions[0])?.id ?? null);
  applyingRoute = true;
  try {
    if (id && id !== currentId) deps.select(id);
    if (route?.kind === "console") showConsole(route.name, route.arg);
    else showChat();
    if (!id) renderHeader();
  } finally {
    applyingRoute = false;
  }
  // Boot with no hash: name where we landed without adding a history entry.
  if (route?.kind !== "console" && id) setHash({ kind: "session", id }, true);
}

/** One dynamic import per view, with the deps it is built from. `deps` is read
 *  when a view opens, not when this table is written, so it is already set. */
const BUILD: Record<ConsoleName, (root: HTMLElement) => Promise<ConsoleView>> = {
  tasks: async (root) =>
    (tasksView = (await import("./tasks.js")).createTasksView(
      root,
      () => deps.sessions().map(({ id, cwd, title }) => ({ id, cwd, title })),
      deps.loadSessions,
      deps.select,
      () => deps.currentId(),
      (arg) => showConsole("activity", arg),
    )),
  activity: async (root) =>
    (activityView = (await import("./activity.js")).createActivityView(root, deps.select, showTasks)),
  boards: async (root) => (await import("./boards.js")).createBoardsView(root, deps.select),
  files: async (root) =>
    (await import("./explorer.js")).createExplorerView(
      root,
      // Whose folder+diff to restore: a bare open is "the files of this chat".
      () => deps.currentSession(),
      // Through the router, so Back walks directory switches too.
      (dir) => showConsole("files", dir),
      (dir) => showConsole("terminal", dir),
      () => closeOverlay("files"),
    ),
  terminal: async (root) =>
    (await import("./terminal.js")).createTerminalView(
      root,
      () => [...groupByCwd(deps.sessions()).keys()],
      () => deps.currentSession()?.cwd,
      (dir) => showConsole("terminal", dir),
      (dir) => showConsole("files", dir),
      () => closeOverlay("terminal"),
    ),
  settings: async (root) =>
    (await import("./settings.js")).createSettingsView(
      root,
      () => [...groupByCwd(deps.sessions()).keys()],
      // Through the router, not a local re-render: the hash is the one
      // copy of "where am I", and Back should walk tabs too.
      (t) => showConsole("settings", t),
    ),
};

export function initViews(d: ViewsDeps): void {
  deps = d;
  // The sidebar icon and its chord both toggle. ⌘; and not ⌃`: the backtick
  // chord is what quake-mode terminals and editors grab globally, and a ⌘
  // chord is Pier's own everywhere — including inside Terminal, whose shell
  // keeps every Ctrl chord.
  const termBtn = $("#open-terminal");
  termBtn.onclick = () => toggleTerminal();
  shortcut(termBtn, "meta+;", "Terminal", () => toggleTerminal());
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
