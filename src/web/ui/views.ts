// Chat ↔ Console switching and the hash router: the Console views, which chat
// elements hide while one is open, and the address bar's copy of "where am I".

import { turnsPane } from "./chat.js";
import { syncQueuePanel } from "./composer.js";
import { $, consoleView, h, type ConsoleView } from "./dom.js";
import { projectCwds } from "../../core/identity.js";
import type { SessionInfo } from "./drawer.js";

/** Everything the view switcher needs from the orchestrator (main.ts). */
export interface ViewsDeps {
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  currentSession: () => SessionInfo | undefined;
  select: (id: string) => void;
  /** One of the continuous conversation's sessions, which its route names instead. */
  inConversation: (id: string) => boolean;
  openContinuous: () => void;
  /** The selected session's turns just came (back) on screen. */
  maybeAckRead: () => void;
}

let deps: ViewsDeps;

const composerForm = $<HTMLFormElement>("#composer");

// Console views hide chat elements but leave session SSE wiring untouched.
const chatEls = [$("#bar"), turnsPane, composerForm];

export const isChatVisible = (): boolean => openName === null;

export type ConsoleName = "settings" | "files";

/** Built so far — a view arrives with its own chunk the first time it opens. */
const views = new Map<ConsoleName, ConsoleView>();
/** In-flight builds, so leaving and reopening a loading view cannot construct
 *  it twice and duplicate its document listeners. */
const building = new Map<ConsoleName, Promise<ConsoleView>>();
/** Which view the route says is open, set before its chunk lands: the overlay
 *  toggles may not wait on a fetch to know where they are. */
let openName: ConsoleName | null = null;
let openRequest = 0;

// Both drop over whatever was on screen and their ✕ returns there — each
// remembers where it was opened from.
const OVERLAYS: ConsoleName[] = ["files", "settings"];
const origins = new Map<ConsoleName, Route>();

const CONSOLE_LABELS: Record<ConsoleName, string> = {
  settings: "Settings",
  files: "Files",
};

/** Open a Console view by name — the ⋯ menu and the search palette both
 *  address them this way rather than clicking each other's buttons. */
export function showConsole(name: ConsoleName, arg?: string, query?: string): void {
  // Switching folders inside an overlay re-enters the same view: not a new origin.
  if (OVERLAYS.includes(name)) {
    const from = parseHash();
    if (from && !(from.kind === "console" && from.name === name)) origins.set(name, from);
  }
  setHash({ kind: "console", name, arg, query });
  openName = name;
  for (const el of chatEls) el.classList.add("hidden");
  syncQueuePanel();
  for (const [built, view] of views) if (built !== name) view.hide();
  void openView(name, arg, query, ++openRequest);
}

/** A view's module loads on first open. A chunk that will not load says so
 *  where the view would have been (§5). */
async function openView(name: ConsoleName, arg: string | undefined, query: string | undefined, request: number): Promise<void> {
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
  view.show(arg, query);
}

/** Entry for the ⋯ menus (session header, project row): browse a cwd — or
 *  none, which reopens where the current session left off. `select` names a
 *  file under it to open (Settings → Agent's Browse files). */
export const showFiles = (dir?: string, select?: string): void =>
  showConsole("files", dir, select ? new URLSearchParams({ select }).toString() : undefined);

/** The chord's version: one key both opens the overlay and, pressed again, is
 *  its ✕. A menu row keeps opening — it names a directory, so it always does. */
const toggleOverlay = (name: ConsoleName, dir?: string): void => {
  if (openName === name) closeOverlay(name);
  else showConsole(name, dir);
};

export const toggleFiles = (dir?: string): void => toggleOverlay("files", dir);

/** An overlay's ✕ and Esc. Back to the route it was opened from — a chat, or
 *  the other overlay — and the current chat when that is unknown (a bookmarked
 *  or reloaded #/files, where there is no "from"). */
function closeOverlay(name: ConsoleName): void {
  const id = deps.currentId();
  const back = origins.get(name) ?? (id ? chatRoute(id) : CONVERSATION);
  origins.delete(name);
  setHash(back); // onhashchange → applyRoute() does the switching
}

export function showChat(): void {
  if (!openName) return;
  openName = null;
  for (const view of views.values()) view.hide();
  for (const el of chatEls) el.classList.remove("hidden");
  syncQueuePanel();
  deps.maybeAckRead(); // the selected session's turns just came (back) on screen
}

// --- routing -----------------------------------------------------------------------
// Hash, not path: the static file server stays a static file server.

// The conversation's own route: its head session rotates, the address does not.
type Route =
  | { kind: "session"; id: string }
  | { kind: "conversation" }
  | { kind: "console"; name: ConsoleName; arg?: string; query?: string };

const CONVERSATION: Route = { kind: "conversation" };

const hashOf = (r: Route): string =>
  r.kind === "session"
    ? `#/session/${encodeURIComponent(r.id)}`
    : r.kind === "conversation"
    ? "#/conversation"
    : `#/${r.name}${r.arg ? `/${encodeURIComponent(r.arg)}` : ""}${r.query ? `?${r.query}` : ""}`;

/** Pre-fold bookmarks still land: the old top-level views are Settings tabs now. */
const FOLDED: Record<string, string> = { config: "files", channels: "channels", providers: "models" };

function parseHash(): Route | null {
  const tail = location.hash.replace(/^#\/?/, "");
  const mark = tail.indexOf("?");
  const [head = "", encoded] = (mark < 0 ? tail : tail.slice(0, mark)).split("/");
  const query = mark < 0 ? undefined : tail.slice(mark + 1) || undefined;
  let arg: string | undefined;
  // A hand-typed hash may not decode; that is the unknown-route fallback, not a crash.
  try { arg = encoded ? decodeURIComponent(encoded) : undefined; } catch { return null; }
  if (FOLDED[head]) return { kind: "console", name: "settings", arg: FOLDED[head] };
  // The labels are the name list too — a route may not wait for a view to be
  // built. hasOwn, not `in`: `#/toString` is a hash anyone can type.
  if (Object.hasOwn(CONSOLE_LABELS, head)) return { kind: "console", name: head as ConsoleName, arg, query };
  if (head === "session" && arg) return { kind: "session", id: arg };
  if (head === "conversation") return CONVERSATION;
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

const chatRoute = (id: string): Route => (deps.inConversation(id) ? CONVERSATION : { kind: "session", id });

export const setSessionHash = (id: string): void => setHash(chatRoute(id));
export const setConversationHash = (): void => setHash(CONVERSATION);

/** Hash → UI. Session routes may name sessions not listed yet; select
 *  verifies them. A bare or unknown hash is the conversation. */
export function applyRoute(): void {
  const route = parseHash() ?? CONVERSATION;
  applyingRoute = true;
  try {
    if (route.kind === "conversation") deps.openContinuous();
    else if (route.kind === "session") {
      if (route.id !== deps.currentId()) deps.select(route.id);
      else showChat();
    } else {
      // An overlay over nothing yet (a reloaded #/settings): the conversation is what it closes to.
      if (!deps.currentId()) deps.openContinuous();
      showConsole(route.name, route.arg, route.query);
    }
  } finally {
    applyingRoute = false;
  }
  // Name where we landed without adding a history entry: a chain member's id is the conversation.
  if (route.kind === "conversation") setHash(CONVERSATION, true);
  else if (route.kind === "session") setHash(chatRoute(route.id), true);
}

/** One dynamic import per view, with the deps it is built from. `deps` is read
 *  when a view opens, not when this table is written, so it is already set. */
const BUILD: Record<ConsoleName, (root: HTMLElement) => Promise<ConsoleView>> = {
  files: async (root) =>
    (await import("./explorer.js")).createExplorerView(
      root,
      // Whose folder+diff to restore: a bare open is "the files of this chat".
      () => deps.currentSession(),
      // Through the router, so Back walks directory switches too.
      (dir) => showConsole("files", dir),
      () => closeOverlay("files"),
    ),
  settings: async (root) =>
    (await import("./settings.js")).createSettingsView(
      root,
      () => projectCwds(deps.sessions()),
      // Through the router, not a local re-render: the hash is the one
      // copy of "where am I", and Back should walk tabs too.
      (t) => showConsole("settings", t),
      showFiles,
      () => closeOverlay("settings"),
    ),
};

export function initViews(d: ViewsDeps): void {
  deps = d;
  window.onhashchange = applyRoute; // Back/forward and hand-edited URLs
}
