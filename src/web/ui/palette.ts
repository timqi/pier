// The ⌘K launcher. The answer is always a session (or a place to go); a
// matched message is the reason a session is listed, not a result of its own.

import { FolderPlus, LayoutDashboard, ListTodo, MessageSquare, Settings, type IconNode } from "lucide";
import { getJson } from "./api.js";
import { revealTurn } from "./chat.js";
import { $, basename, h, relTime, untitled } from "./dom.js";
import { icon } from "./icons.js";
import { listStep, menuOpen } from "./menu.js";
import { isLive, openNewSession, orderSessions, projectCwds, stateDot, type SessionInfo } from "./sidebar.js";
import { shortcut } from "./shortcut.js";
import type { ConsoleName } from "./views.js";
import type { SearchHit } from "../../core/types.js";

/** Everything the palette needs from the orchestrator (main.ts). */
export interface PaletteDeps {
  sessions: () => SessionInfo[];
  loadSessions: () => Promise<void>;
  currentId: () => string | null;
  /** Resolves once the session's transcript is on screen, so a hit can scroll
   *  to its turn afterwards. */
  select: (id: string) => Promise<void>;
  createSession: (cwd: string) => Promise<void>;
  openConsole: (name: ConsoleName) => void;
}

let deps: PaletteDeps;

const dialog = $<HTMLDialogElement>("#palette");
const input = $<HTMLInputElement>("#palette-input");
const list = $("#palette-list");
const count = $("#palette-count");

// --- what a row can be -----------------------------------------------------------------

/** One thing the palette can open. `session` is what makes a row a session
 *  row: the state dot and its age hang off it; `hit` is why a session is
 *  listed when its name did not match, and adds the line that shows it. */
interface Target {
  icon: IconNode;
  label: string;
  detail: string;
  open: () => void;
  session?: SessionInfo;
  hit?: SearchHit;
}

// Searchable by what they are called *and* by what is inside them: "password"
// and "channel" are how someone looks for Settings.
const CONSOLE_TARGETS: { name: ConsoleName; icon: IconNode; label: string; detail: string }[] = [
  { name: "tasks", icon: ListTodo, label: "Tasks", detail: "Automation — task definitions and schedules" },
  { name: "runs", icon: ListTodo, label: "Runs", detail: "Automation — executions, subagents and callbacks" },
  { name: "activity", icon: ListTodo, label: "Activity", detail: "Automation — sessions and relationships" },
  { name: "boards", icon: LayoutDashboard, label: "Boards", detail: "Console — the static pages Pier publishes" },
  { name: "settings", icon: Settings, label: "Settings", detail: "Console — models and providers, agent files and extensions, channels, password, sign out, security" },
];

/** Rows under Recent with nothing typed: the top of the rail, which is what
 *  "the thing I was just in" almost always is. */
const RECENT = 7;
/** Directories a query may offer a new session in; the rail's own menu has the
 *  full list. */
const NEW_IN = 3;
/** Sessions a query lists: those matched by name first, then those matched
 *  by what was said in them, up to this many in all. */
const SESSIONS = 8;
/** How long after the last keystroke the server is asked. Long enough that a
 *  word typed at speed costs one request, short enough not to read as a wait. */
const DEBOUNCE_MS = 80;

// --- the search itself -------------------------------------------------------------------
// Local answers on the keystroke; the server's join when it answers. One
// request in flight: the next keystroke aborts it.

type Answer = { hits: SearchHit[] } | { error: string };

/** The one query the server has been asked about, and what it said. */
let asked = "";
let answer: Answer | undefined;
let inflight: AbortController | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;

function ask(q: string): void {
  if (asked === q) return; // same question, whatever its state: nothing to redo
  clearTimeout(debounce);
  inflight?.abort();
  inflight = undefined;
  asked = q;
  answer = undefined;
  if (!q) return;
  debounce = setTimeout(() => {
    const controller = (inflight = new AbortController());
    void getJson<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, "Search unavailable", {
      signal: controller.signal,
    }).then((got) => {
      // Aborted means superseded: the answer that matters is on its way.
      if (controller.signal.aborted || asked !== q) return;
      inflight = undefined;
      answer = got.ok ? { hits: got.value.hits } : { error: got.error };
      if (dialog.open) render();
    });
  }, DEBOUNCE_MS);
}

// --- rows ----------------------------------------------------------------------------------

/** Rebuilt on every render; the index is what ↑/↓ and Enter address. */
let rows: { el: HTMLElement; open: () => void }[] = [];
let active = 0;

function setActive(index: number): void {
  if (!rows.length) return;
  active = (index + rows.length) % rows.length;
  for (const [i, { el }] of rows.entries()) {
    el.classList.toggle("bg-indigo-50", i === active); // ink and weight follow in style.css, as on the rail
    el.setAttribute("aria-selected", String(i === active));
  }
  rows[active]?.el.scrollIntoView({ block: "nearest" });
}

/** The row's own age: when a hit was said, else when the session was born. */
const ageOf = (t: Target): number | undefined => t.hit?.at ?? t.session?.createdAt;

/** A snippet the way the server marks it — \u0001…\u0002 around each match —
 *  drawn as text with the matches in weight and ink, never a highlighter. */
function snippet(text: string): HTMLElement {
  const line = h("span", "min-w-0 flex-1 truncate text-neutral-500");
  for (const part of text.replaceAll(/\s+/g, " ").split("\u0001")) {
    const [match = "", after] = part.split("\u0002", 2);
    // The head of the line, before any mark, is text like any unmarked tail.
    if (after === undefined) line.append(match);
    else line.append(h("span", "font-medium text-neutral-800", match), after);
  }
  return line;
}

/** The detail gives way entirely before the label loses a letter: a stray
 *  letter of a directory name reads as a typo. */
const PHRASE = "flex min-w-0 flex-1 items-baseline gap-2";
const LABEL = "shrink-0 truncate";
const DETAIL = "min-w-[2.5em] truncate text-[0.8125rem] text-neutral-400";
const MARK = "flex-none text-[0.75rem] tabular-nums text-neutral-400";
/** Every row opens on a tile — what Spotlight's app icon does for it: the
 *  eye finds the row by the tile, so the rows need no line between them, and
 *  the tile says what kind of thing the row opens before the label is read. */
const TILE = "flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-neutral-100 text-neutral-500";

function paletteRow(t: Target): HTMLElement {
  const li = h("li", `palette-row flex cursor-pointer items-center gap-3 rounded-[10px] px-2 leading-5 ${t.hit ? "py-1.5" : "min-h-10"}`);
  li.setAttribute("role", "option");
  li.append(h("span", TILE, icon(t.icon, "h-4 w-4")));
  const body = h("div", "flex min-w-0 flex-1 flex-col");
  const head = h("div", "flex items-center gap-2");
  if (t.session) head.append(...stateDot(t.session));
  const phrase = h("span", PHRASE, h("span", `${LABEL} ${t.detail ? "max-w-[calc(100%-3em)]" : "max-w-full"}`, t.label));
  if (t.detail) phrase.append(h("span", DETAIL, t.detail));
  head.append(phrase);
  const age = ageOf(t);
  if (age !== undefined) head.append(h("span", MARK, relTime(age)));
  body.append(head);
  if (t.hit) {
    body.append(h("div", "flex items-baseline gap-2 text-[0.8125rem] leading-5",
      h("span", "flex-none text-[0.75rem] text-neutral-400", t.hit.role === "user" ? "You" : "Agent"),
      snippet(t.hit.snippet),
    ));
  }
  li.append(body);
  // Hover does not move the selection: after a layout change the browser
  // re-runs hit-testing and fires `mouseenter` under a resting pointer.
  li.onclick = t.open;
  return li;
}

/** A group's name, not a row: smaller, heavier and greyer than what it heads,
 *  set off by space alone — the tiles give the rows their edges. */
const sectionHead = (title: string): HTMLElement =>
  h("li", "px-2 pb-1.5 pt-4 text-[0.6875rem] font-semibold leading-4 tracking-[0.02em] text-neutral-400 first:pt-2", title);

/** A line that is not a row: what the Sessions section says about the part of
 *  its answer still on its way, or missing. Nothing that happened may look
 *  like nothing happening. */
function note(text: string, title?: string): HTMLElement {
  const li = h("li", "px-2 py-2 pl-12 text-[0.8125rem] leading-5 text-neutral-400", text);
  if (title) li.title = title;
  return li;
}

// --- sections ------------------------------------------------------------------------------

/** Empty for the workbench's own sessions: `web` in every line would only push
 *  the cwd out. */
const chatOf = (s: SessionInfo): string => (s.channel && s.channel !== "web" ? s.channel : "");

function render(): void {
  const q = input.value.trim();
  // Whitespace splits the query the way the server splits it: every term has
  // to be in the row, in any order and any of the fields joined into it.
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text: string): boolean => {
    const haystack = text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const open = (run: () => void) => () => {
    dialog.close();
    run();
  };
  const sessions = deps.sessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const { top, rest } = orderSessions(sessions);
  const ordered = [...top, ...rest];
  const sessionRow = (s: SessionInfo): Target => ({
    icon: MessageSquare,
    label: s.title ?? untitled(s.cwd),
    detail: [basename(s.cwd), chatOf(s)].filter(Boolean).join(" · "),
    open: open(() => void deps.select(s.id)),
    session: s,
  });
  const newIn = (cwd: string): Target => ({
    icon: FolderPlus,
    label: untitled(cwd),
    detail: cwd,
    open: open(() => void deps.createSession(cwd)),
  });
  const consoleRows = CONSOLE_TARGETS.filter((t) => !q || hit(`${t.label} ${t.detail}`))
    .map(({ name, icon, label, detail }) => ({ icon, label, detail, open: open(() => deps.openConsole(name)) }));
  // The rail's own menu, from here: the dialog goes first, so the menu has a
  // page to anchor on rather than a top layer to hide under.
  const newAnywhere: Target = { icon: FolderPlus, label: "New session in…", detail: "Pick a directory", open: open(openNewSession) };

  const sections: [string, (Target | HTMLElement)[]][] = [];
  if (!q) {
    const current = byId.get(deps.currentId() ?? "");
    sections.push(
      ["Running", ordered.filter(isLive).map(sessionRow)],
      ["Recent", ordered.filter((s) => !isLive(s)).slice(0, RECENT).map(sessionRow)],
      ["Actions", [...(current ? [newIn(current.cwd)] : []), newAnywhere]],
      ["Console", consoleRows],
    );
  } else {
    const dirs = projectCwds(sessions).filter((cwd) => hit(basename(cwd))).slice(0, NEW_IN);
    // Named sessions first in the rail's order, then the server's hits as they
    // arrive; until then, or when it cannot, the list says so in its place.
    const named = ordered.filter((s) => hit(`${s.title ?? ""} ${s.cwd} ${chatOf(s)}`)).slice(0, SESSIONS);
    const shown = new Set(named.map((s) => s.id));
    const found: (Target | HTMLElement)[] = named.map(sessionRow);
    if (asked !== q || !answer) found.push(note("Searching messages…"));
    else if ("error" in answer) found.push(note("Message search unavailable", answer.error));
    else {
      for (const said of answer.hits) {
        if (found.length >= SESSIONS) break;
        const s = byId.get(said.sessionId);
        if (!s || shown.has(s.id)) continue;
        found.push({
          ...sessionRow(s),
          hit: said,
          // The transcript is on screen when select resolves; a turn that is
          // no longer in it (compacted, edited, trimmed) just opens the session.
          open: open(() => void deps.select(s.id).then(() => revealTurn(said.role, said.at))),
        });
      }
      if (!found.length) found.push(note("No sessions match"));
    }
    sections.push(
      ["Actions", [...dirs.map(newIn), ...(hit(newAnywhere.label) ? [newAnywhere] : []), ...consoleRows]],
      ["Sessions", found],
    );
  }

  rows = [];
  const nodes: HTMLElement[] = [];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    nodes.push(sectionHead(title));
    for (const item of items) {
      if (item instanceof HTMLElement) {
        nodes.push(item);
        continue;
      }
      const el = paletteRow(item);
      rows.push({ el, open: item.open });
      nodes.push(el);
    }
  }
  list.replaceChildren(...(nodes.length ? nodes : [note("Nothing matches")]));
  count.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  // Held, not reset: a session going streaming re-renders this list, and
  // moving the highlight out from under a pressed Enter is a misfire. Clamped,
  // because the server's answer landing can shorten the list under it.
  setActive(Math.min(active, Math.max(0, rows.length - 1)));
}

/** Re-drawn by the rail when the sessions change under an open palette. */
export function refreshPalette(): void {
  if (dialog.open) render();
}

/** Same control from the button and from ⌘K, so the chord also dismisses it. */
function toggle(): void {
  if (dialog.open) return dialog.close();
  input.value = "";
  active = 0;
  ask("");
  render();
  dialog.showModal();
  input.focus();
  void deps.loadSessions().then(refreshPalette);
}

// --- wiring ----------------------------------------------------------------------------

export function initPalette(d: PaletteDeps): void {
  deps = d;
  const search = $("#open-palette");
  search.onclick = toggle;
  // Open, the chord belongs to the list (⌃K walks up); an anchored menu's
  // rows walk on ⌃K too.
  shortcut(search, "k", "Search sessions, messages and Console", toggle, () => dialog.open || menuOpen());
  // The dialog is its own backdrop's hit target: a click that lands on the
  // element itself, not on a descendant, landed outside the panel.
  dialog.onclick = (ev) => {
    if (ev.target === dialog) dialog.close();
  };
  dialog.onclose = () => ask(""); // nothing in flight for a palette nobody sees
  input.oninput = () => {
    active = 0; // a new query is a new list; the old position means nothing
    ask(input.value.trim());
    render();
  };
  // The input keeps focus while the list is walked — typing must never mean
  // "start over because you moved".
  input.onkeydown = (ev) => {
    const step = listStep(ev); // the same keys the anchored menus walk on
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
