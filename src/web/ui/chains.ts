// The chain list (docs/plans/30-multi-chain.md §列表): one set of rows, floated
// from the bar's title and docked as the wide screen's left rail.

import { Ellipsis, Plus } from "lucide";
import { failure, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { icon } from "./icons.js";
import { closeMenu, listStep, openMenu, openPanel, walkRows } from "./menu.js";
import { chord, modalOpen } from "./shortcut.js";
import { openCharter } from "./charter.js";
import type { ChainInfo, ChainList } from "../types.js";

/** Everything the list needs from the orchestrator (main.ts). */
interface ChainsDeps {
  /** `GET /api/chains`; null before it answers. */
  list: () => ChainList | null;
  /** The chain the conversation pane shows. */
  current: () => string | null;
  /** Navigate to a chain's conversation, `#/chain/<id>`. */
  go: (id: string) => void;
  /** Re-read the list now rather than on the `chains-changed` that follows. */
  refresh: () => void;
  /** The bar's title, which the list floats from. */
  anchor: () => HTMLElement;
  /** The docked sidebar came on or went off screen: the bar's title changes shape (session-header.ts). */
  docked: () => void;
}

let deps: ChainsDeps;

const rail = $("#chain-rail");
/** The rail's chain section; its items section is the drawer's (`renderDrawer`). */
const railChains = $("#rail-chains");
/** ⌘B, the sidebar's key; the ⋯ menu's Sidebar row teaches it (session-header.ts). */
export const SIDEBAR_KEY = "b";
/** `off` while ⌘B has hidden the docked rail; absent is shown, the default. */
const RAIL = "pier.rail";
/** Where the reading column and the sidebar both fit: `--read-w` 46rem + two
 *  `--col-pad` of 1rem + the 16rem rail. A media query reads no custom property,
 *  so style.css carries the same number; change the three together. */
const DOCKED = "(width >= 64rem)";
/** The floated list's root while it is open. */
let floated: HTMLElement | null = null;

// One state for both surfaces; a surface with a focused field is not redrawn under it.
/** The name being created, drawn as a row before the server answers. */
let pending: string | null = null;
let creating: { value: string; error?: string } | null = null;
let renaming: { id: string; value: string; error?: string } | null = null;
let archivedOpen = false;
/** A refused archive or unarchive, said where it was asked. */
let notice: string | null = null;

const active = (): ChainInfo[] => deps.list()?.chains.filter((c) => c.archivedAt === undefined) ?? [];
const archived = (): ChainInfo[] => deps.list()?.chains.filter((c) => c.archivedAt !== undefined) ?? [];

/** Sky: the head is replying; amber: something waits on you there. */
function dotOf(c: ChainInfo): HTMLElement {
  const dot = h("span", "chain-dot h-2 w-2 flex-none rounded-full");
  if (c.head?.state === "streaming") dot.classList.add("bg-sky-500");
  else if (c.waiting > 0 || c.unread) dot.classList.add("bg-amber-500");
  return dot;
}

const ROW = "chain-row group flex items-center";
/** The dot slot stays on an idle row: it puts every name on the items' text line. */
const PICK = "chain-open flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left";
const SMALL = "cursor-pointer rounded-md px-2 py-1 text-[0.8125rem] text-neutral-600 hover:bg-(--row-hover)";

function field(value: string, label: string, save: (v: string) => void, edit: (v: string) => void, cancel: () => void): HTMLInputElement {
  const input = h("input", "w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900") as HTMLInputElement;
  input.value = value;
  input.placeholder = "Name";
  input.maxLength = 40;
  input.setAttribute("aria-label", label);
  input.oninput = () => edit(input.value);
  input.onkeydown = (ev) => {
    if (ev.isComposing) return;
    if (ev.key === "Enter" && input.value.trim()) { ev.preventDefault(); save(input.value.trim()); }
    // The field's own Esc: the list stays open, the row goes back to what it was.
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); }
  };
  return input;
}

const error = (text: string): HTMLElement => h("p", "px-2 pt-1 text-xs text-red-600", text);

/** A row in `root`; a redraw keeps the ⋯ an open menu is anchored to, so Esc still finds it. */
function row(c: ChainInfo, root: HTMLElement): HTMLElement {
  const li = h("li", ROW);
  li.dataset.chain = c.id;
  if (renaming?.id === c.id) {
    const r = renaming;
    li.append(h("div", "min-w-0 flex-1 px-2 py-0.5",
      // Forced: the focus is still in the field, which an unforced draw leaves alone.
      field(r.value, `Rename ${c.name}`, (name) => void rename(c, name), (v) => { r.value = v; }, () => { renaming = null; draw(true); }),
      ...(r.error ? [error(r.error)] : [])));
    return li;
  }
  const pick = h("button", PICK, dotOf(c), h("span", "chain-name min-w-0 flex-1 text-sm text-neutral-900", c.name),
    ...(c.waiting ? [h("span", "flex-none text-xs text-neutral-500", `${c.waiting} waiting`)] : []));
  pick.setAttribute("type", "button");
  if (c.id === deps.current()) pick.setAttribute("aria-current", "page");
  pick.onclick = () => choose(c.id);
  const more = root.querySelector<HTMLElement>(`[data-chain="${c.id}"]`)?.querySelector<HTMLElement>('.chain-more[aria-expanded="true"]')
    ?? h("button", "chain-more icon-btn text-neutral-500", icon(Ellipsis, "h-3.5 w-3.5"));
  more.setAttribute("type", "button");
  more.setAttribute("aria-label", `Actions for ${c.name}`);
  more.onclick = () => openMenu(more, [
    { label: "Rename…", onSelect: () => { closeMenu(); renaming = { id: c.id, value: c.name }; reopen(root); focusField(); } },
    { label: "Charter…", onSelect: () => { closeMenu(); openCharter(c); } },
    { label: "Archive", onSelect: () => { closeMenu(); void archive(c, root); } },
  ], c.name);
  li.append(pick, more);
  return li;
}

/** The floated list is one panel with the row menu, so what the menu led to is shown by opening it again. */
function reopen(root: HTMLElement): void {
  if (root === rail) draw(true);
  else openChains();
}

function archivedRow(c: ChainInfo): HTMLElement {
  const back = h("button", SMALL, "Unarchive");
  back.setAttribute("aria-label", `Unarchive ${c.name}`);
  back.onclick = () => void unarchiveRow(c);
  return h("li", "flex items-center gap-2 py-1 pl-8 pr-2", h("span", "chain-name min-w-0 flex-1 text-sm text-neutral-500", c.name), back);
}

/** The list into `root`: active rows by recency, New chain…, then the archived, folded. */
function fill(root: HTMLElement): void {
  const rows = h("ul", "", ...active().map((c) => row(c, root)));
  rows.dataset.list = ""; // the arrows' walk (menu.ts listIn)
  if (pending) rows.prepend(h("li", `${ROW} opacity-60`, h("span", PICK, h("span", "h-2 w-2 flex-none"), h("span", "chain-name text-sm", pending))));
  // One field for both surfaces, where the pending row is drawn: atop the rail's list, as a row at the floated list's end.
  const create = creating
    ? h("div", "px-2 py-0.5", field(creating.value, "New chain name", (name) => void make(name),
      (v) => { if (creating) creating.value = v; }, () => { creating = null; draw(true); }), ...(creating.error ? [error(creating.error)] : []))
    : h("button", `${PICK} chain-new w-full text-sm text-neutral-600`,
      // The dot's slot, the + centred on it, so the label sits on the names' line.
      h("span", "flex h-2 w-2 flex-none items-center justify-center", icon(Plus, "h-3.5 w-3.5 flex-none")), "New chain…");
  if (!creating) create.onclick = () => startCreate();
  const parts: HTMLElement[] = [...(root === rail ? [create, rows] : [rows, create]), ...(notice ? [error(notice)] : [])];
  const old = archived();
  if (old.length) {
    const fold = h("button", `${SMALL} w-full text-left text-xs`, `Archived · ${old.length}`);
    fold.setAttribute("aria-expanded", String(archivedOpen));
    fold.onclick = () => { archivedOpen = !archivedOpen; draw(true); };
    // The rail's Items section opens on a line of its own, so the fold is the list's plain tail there.
    parts.push(...(root === rail ? [] : [h("hr", "my-1 border-neutral-200")]), fold, ...(archivedOpen ? [h("ul", "", ...old.map(archivedRow))] : []));
  }
  // The rail names its sections, New chain the head's +; the floated list is the chains alone.
  if (root === rail) {
    const label = h("span", "", "Chains");
    label.id = "rail-chains-head"; // the section's `aria-labelledby`
    const add = h("button", "icon-btn ml-auto", icon(Plus, "h-3.5 w-3.5"));
    add.setAttribute("type", "button");
    add.setAttribute("aria-label", "New chain");
    add.title = "New chain";
    add.onclick = () => startCreate();
    railChains.replaceChildren(h("div", "rail-head", label, add), ...(creating ? parts : parts.slice(1)));
  }
  else root.replaceChildren(...parts);
}

/** Laid out and not fading: the rail is display:none below 64rem and off before the list is read. */
const shown = (root: HTMLElement | null): root is HTMLElement =>
  !!root?.isConnected && !root.closest("[inert]") && root.getClientRects().length > 0;
const typing = (root: HTMLElement): boolean => root.contains(document.activeElement) && document.activeElement?.localName === "input";

/** Both surfaces; `force` redraws one holding a field too, keeping the focus where it was by row. */
function draw(force = false): void {
  for (const root of [rail, floated]) {
    if (!shown(root) || (!force && typing(root))) continue;
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const at = focused?.closest<HTMLElement>("[data-chain]")?.dataset.chain;
    const which = focused?.classList.contains("chain-more") ? ".chain-more" : ".chain-open";
    fill(root);
    if (at) root.querySelector(`[data-chain="${at}"]`)?.querySelector<HTMLElement>(which)?.focus({ preventScroll: true });
  }
}

/** The list changed, or which chain is current did; the rail coming on or going off
 *  (the list read, ⌘B) changes the bar title's shape, so it is told here, the one place that flips. */
export function renderChains(): void {
  const was = sidebarDocked();
  rail.toggleAttribute("data-on", deps.list() !== null && localStorage.getItem(RAIL) !== "off");
  draw();
  if (sidebarDocked() !== was) deps.docked();
}

/** The sidebar is on screen beside the column, so the chain list needs no
 *  other way in: the bar's title is a plain heading while this holds. */
export const sidebarDocked = (): boolean => rail.hasAttribute("data-on") && window.matchMedia(DOCKED).matches;

/** ⌘B and the ⋯ menu's Sidebar: one key for "the sidebar" — the docked rail
 *  where it is laid out (its choice kept in `pier.rail`), the floated list below
 *  64rem. Nothing before the list is read. */
export function toggleSidebar(): void {
  if (!deps.list()) return;
  if (!window.matchMedia(DOCKED).matches) return openChains();
  // Focus on the surface this takes away goes to the list's other way in: the title, or the rail's current row.
  const held = rail.contains(document.activeElement) || deps.anchor() === document.activeElement;
  if (localStorage.getItem(RAIL) === "off") localStorage.removeItem(RAIL);
  else localStorage.setItem(RAIL, "off");
  renderChains();
  if (held) (sidebarDocked() ? rail.querySelector<HTMLElement>("[aria-current]") : deps.anchor())?.focus();
}

const focusField = (): void => (shown(floated) ? floated : rail).querySelector<HTMLInputElement>("input")?.focus();

/** The current chain too: from Settings or an item view, its row is the way back to the conversation. */
function choose(id: string): void {
  closeMenu();
  deps.go(id);
}

/** The floated list under the bar's title: a popover, or a sheet on a phone (menu.ts). */
export function openChains(): void {
  const anchor = deps.anchor();
  if (anchor.getAttribute("aria-expanded") === "true") return closeMenu();
  notice = null;
  const root = h("div", "chain-list w-[min(20rem,calc(100vw-2rem))] max-sm:w-full font-sans");
  floated = root;
  fill(root);
  openPanel(anchor, root, "Chains").setAttribute("aria-label", "Chains");
  root.querySelector<HTMLElement>("[aria-current]")?.focus({ preventScroll: true });
}

/** The field of New chain… and the Chains head's +; ⌘⇧O opens the list on it when no list is on screen. */
function startCreate(): void {
  creating = { value: "" };
  if (!shown(floated) && !shown(rail)) openChains();
  draw(true);
  focusField();
}

async function make(name: string): Promise<void> {
  pending = name;
  creating = null;
  draw(true);
  const res = await sendJson("/api/chains", { name });
  pending = null;
  if (!res.ok) {
    creating = { value: name, error: await failure(res, "Could not create the chain") };
    draw(true);
    return focusField();
  }
  const made = (await res.json()) as ChainInfo;
  deps.refresh();
  choose(made.id);
}

async function rename(c: ChainInfo, name: string): Promise<void> {
  const res = await sendJson(`/api/chains/${c.id}`, { name }, "PATCH");
  if (!res.ok) {
    renaming = { id: c.id, value: name, error: await failure(res, "Could not rename the chain") };
    draw(true);
    return focusField();
  }
  renaming = null;
  draw(true);
  deps.refresh();
}

/** Open items ask first (§归档): the server says how many, the confirm repeats it.
 *  A refusal is said on the surface that asked, the floated list reopened for it. */
async function archive(c: ChainInfo, root: HTMLElement): Promise<void> {
  notice = null;
  let res = await sendJson(`/api/chains/${c.id}`, { archived: true }, "PATCH");
  if (res.status === 409) {
    const { error: why, open } = (await res.json()) as { error: string; open?: number };
    if (open === undefined) return say(why, root);
    if (!window.confirm(`Archive ${c.name}? It has ${open} open item${open === 1 ? "" : "s"}; they stay in the status panel, tagged archived.`)) return;
    res = await sendJson(`/api/chains/${c.id}`, { archived: true, force: true }, "PATCH");
  }
  if (!res.ok) return say(await failure(res, "Could not archive the chain"), root);
  deps.refresh();
  // The pane leaves an archived chain for the first one, as `/chain archive` does.
  const next = active().filter((x) => x.id !== c.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (c.id === deps.current() && next) deps.go(next.id);
  else draw(true);
}

/** Back into the active list. */
export async function unarchive(id: string): Promise<string | null> {
  const res = await sendJson(`/api/chains/${id}`, { archived: false }, "PATCH");
  if (!res.ok) return failure(res, "Could not unarchive the chain");
  deps.refresh();
  return null;
}

async function unarchiveRow(c: ChainInfo): Promise<void> {
  const why = await unarchive(c.id);
  if (why) say(why);
}

function say(text: string, root: HTMLElement = rail): void {
  if (root !== rail && !shown(floated)) openChains();
  notice = text;
  draw(true);
}

/** ⌘⇧[ / ⌘⇧]: the previous or next active chain in the list's order, wrapping. */
function cycle(step: 1 | -1): void {
  const rows = active();
  if (rows.length < 2) return;
  const at = rows.findIndex((c) => c.id === deps.current());
  const next = rows[(at + step + rows.length) % rows.length];
  if (next) choose(next.id);
}

export function initChains(d: ChainsDeps): void {
  deps = d;
  // The rail walks by the arrows as the floated list does in menu.ts, within the
  // section the focus is in: Chains or Items (drawer.ts), Tab between them.
  rail.addEventListener("keydown", (ev) => {
    const focused = document.activeElement;
    const section = (rail.contains(focused) ? focused?.closest<HTMLElement>("section") : null) ?? rail;
    const list = section.querySelector<HTMLElement>("[data-list]");
    const to = listStep(ev);
    if (list && to !== undefined && !typing(rail) && walkRows(list, to)) ev.preventDefault();
  });
  chord("shift+[", () => cycle(-1), modalOpen);
  chord("shift+]", () => cycle(1), modalOpen);
  chord("shift+o", startCreate, modalOpen);
  chord(SIDEBAR_KEY, toggleSidebar, modalOpen);
  // A window resized across 64rem docks or floats the list; the title follows.
  window.matchMedia(DOCKED).addEventListener("change", () => { draw(); deps.docked(); });
}
