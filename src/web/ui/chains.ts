// The chain list (docs/plans/30-multi-chain.md §列表): one set of rows, floated
// from the bar's title and docked as the wide screen's left rail.

import { Ellipsis } from "lucide";
import { failure, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { icon } from "./icons.js";
import { closeMenu, listStep, openPanel, walkRows } from "./menu.js";
import { chord, modalOpen } from "./shortcut.js";
import type { ChainInfo, ChainList, ChainOpen } from "../types.js";

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
}

let deps: ChainsDeps;

const rail = $("#chain-rail");
/** The floated list's root while it is open. */
let floated: HTMLElement | null = null;

// One state for both surfaces; a surface with a focused field is not redrawn under it.
/** The name being created, drawn as a row before the server answers. */
let pending: string | null = null;
let creating: { value: string; error?: string } | null = null;
let renaming: { id: string; value: string; error?: string } | null = null;
/** The row whose ⋯ actions are showing. */
let actionsOf: string | null = null;
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

const ROW = "chain-row group flex items-start gap-1 rounded-xl";
const PICK = "chain-open flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-xl px-2.5 py-2 text-left";
const SMALL = "cursor-pointer rounded-lg px-2 py-1 text-[13px] text-neutral-600 hover:bg-neutral-100";

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

const error = (text: string): HTMLElement => h("p", "px-2.5 pt-1 text-xs text-red-600", text);

function row(c: ChainInfo): HTMLElement {
  const li = h("li", ROW);
  li.dataset.chain = c.id;
  if (renaming?.id === c.id) {
    const r = renaming;
    li.append(h("div", "min-w-0 flex-1 px-1 py-1",
      field(r.value, `Rename ${c.name}`, (name) => void rename(c, name), (v) => { r.value = v; }, () => { renaming = null; draw(); }),
      ...(r.error ? [error(r.error)] : [])));
    return li;
  }
  const pick = h("button", PICK, dotOf(c), h("span", "chain-name min-w-0 flex-1 text-sm text-neutral-900", c.name),
    ...(c.waiting ? [h("span", "flex-none text-xs text-neutral-500", `${c.waiting} waiting`)] : []));
  pick.setAttribute("type", "button");
  if (c.id === deps.current()) pick.setAttribute("aria-current", "page");
  pick.onclick = () => choose(c.id);
  const more = h("button", "chain-more icon-btn h-9 w-9 flex-none text-neutral-500", icon(Ellipsis, "h-3.5 w-3.5"));
  more.setAttribute("type", "button");
  more.setAttribute("aria-label", `Actions for ${c.name}`);
  more.setAttribute("aria-expanded", String(actionsOf === c.id));
  more.onclick = () => { actionsOf = actionsOf === c.id ? null : c.id; draw(true); };
  const body = h("div", "min-w-0 flex-1", h("div", "flex items-start", pick, more));
  if (actionsOf === c.id) {
    const ren = h("button", SMALL, "Rename");
    ren.onclick = () => { renaming = { id: c.id, value: c.name }; actionsOf = null; draw(true); focusField(); };
    const arch = h("button", SMALL, "Archive");
    arch.onclick = () => void archive(c);
    body.append(h("div", "flex gap-1 px-1.5 pb-1.5", ren, arch));
  }
  li.append(body);
  return li;
}

function archivedRow(c: ChainInfo): HTMLElement {
  const back = h("button", SMALL, "Unarchive");
  back.setAttribute("aria-label", `Unarchive ${c.name}`);
  back.onclick = () => void unarchiveRow(c);
  return h("li", "flex items-center gap-2 px-2.5 py-1", h("span", "chain-name min-w-0 flex-1 text-sm text-neutral-500", c.name), back);
}

/** The list into `root`: active rows by recency, New chain…, then the archived, folded. */
function fill(root: HTMLElement): void {
  const rows = h("ul", "", ...active().map(row));
  rows.dataset.list = ""; // the arrows' walk (menu.ts listIn)
  if (pending) rows.prepend(h("li", `${ROW} opacity-60`, h("span", PICK, h("span", "h-2 w-2 flex-none"), h("span", "chain-name text-sm", pending))));
  const create = creating
    ? h("div", "px-1 py-1", field(creating.value, "New chain name", (name) => void make(name),
      (v) => { if (creating) creating.value = v; }, () => { creating = null; draw(); }), ...(creating.error ? [error(creating.error)] : []))
    : h("button", `${SMALL} w-full px-2.5 py-2 text-left text-sm`, "New chain…");
  if (!creating) create.onclick = () => startCreate();
  const parts: HTMLElement[] = [rows, ...(notice ? [error(notice)] : []), create];
  const old = archived();
  if (old.length) {
    const fold = h("button", `${SMALL} w-full text-left text-xs`, `Archived · ${old.length}`);
    fold.setAttribute("aria-expanded", String(archivedOpen));
    fold.onclick = () => { archivedOpen = !archivedOpen; draw(true); };
    parts.push(h("hr", "my-1 border-neutral-200"), fold, ...(archivedOpen ? [h("ul", "", ...old.map(archivedRow))] : []));
  }
  root.replaceChildren(...parts);
}

/** Laid out and not fading: the rail is display:none below 80rem and off in session mode. */
const shown = (root: HTMLElement | null): root is HTMLElement =>
  !!root?.isConnected && !root.closest("[inert]") && root.getClientRects().length > 0;
const typing = (root: HTMLElement): boolean => root.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";

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

/** The list changed, or which chain is current did. */
export function renderChains(): void {
  rail.toggleAttribute("data-on", deps.list()?.mode === "chain");
  draw();
}

const focusField = (): void => (shown(floated) ? floated : rail).querySelector<HTMLInputElement>("input")?.focus();

function choose(id: string): void {
  closeMenu();
  actionsOf = null;
  if (id !== deps.current()) deps.go(id);
}

/** The floated list under the bar's title: a popover, or a sheet on a phone (menu.ts). */
export function openChains(): void {
  const anchor = deps.anchor();
  if (anchor.getAttribute("aria-expanded") === "true") return closeMenu();
  notice = null;
  const root = h("div", "chain-list w-[min(20rem,calc(100vw-2rem))] max-sm:w-full font-sans");
  floated = root;
  fill(root);
  openPanel(anchor, root).setAttribute("aria-label", "Chains");
  root.querySelector<HTMLElement>("[aria-current]")?.focus({ preventScroll: true });
}

/** New chain…'s field; ⌘⇧O opens the list on it when no list is on screen. */
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

/** Open items ask first (§归档): the server says how many, the confirm repeats it. */
async function archive(c: ChainInfo): Promise<void> {
  notice = null;
  let res = await sendJson(`/api/chains/${c.id}`, { archived: true }, "PATCH");
  if (res.status === 409) {
    const { error: why, open } = (await res.json()) as { error: string; open?: number };
    if (open === undefined) return say(why);
    if (!window.confirm(`Archive ${c.name}? It has ${open} open item${open === 1 ? "" : "s"}; they stay in the status panel, tagged archived.`)) return;
    res = await sendJson(`/api/chains/${c.id}`, { archived: true, force: true }, "PATCH");
  }
  if (!res.ok) return say(await failure(res, "Could not archive the chain"));
  actionsOf = null;
  deps.refresh();
  // The pane leaves an archived chain for the first one, as `/chain archive` does.
  const next = active().filter((x) => x.id !== c.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (c.id === deps.current() && next) deps.go(next.id);
  else draw(true);
}

/** Back into the active list, chain mode with it (the server turns it on). */
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

function say(text: string): void {
  notice = text;
  draw(true);
}

/** The ⋯ menu's switch. Off keeps the current chain and archives the rest, once they were seen. */
export async function setChainMode(on: boolean): Promise<string | null> {
  const keep = deps.current();
  const body = { chain: on, ...(keep ? { keep } : {}) };
  let res = await sendJson("/api/chains/mode", body, "PUT");
  if (res.status === 409) {
    const { error: why, chains } = (await res.json()) as { error: string; chains?: ChainOpen[] };
    if (!chains) return why;
    const lines = chains.map((c) => [c.name, c.open ? `${c.open} open` : "", c.waiting ? `${c.waiting} waiting on you` : ""].filter(Boolean).join(" · "));
    if (!window.confirm(`Turn chain mode off? These chains will be archived:\n\n${lines.join("\n")}`)) return null;
    res = await sendJson("/api/chains/mode", { ...body, force: true }, "PUT");
  }
  if (!res.ok) return failure(res, "Could not switch chain mode");
  deps.refresh();
  return null;
}

/** ⌘⇧[ / ⌘⇧]: the previous or next active chain in the list's order, wrapping. */
function cycle(step: 1 | -1): void {
  const rows = active();
  if (deps.list()?.mode !== "chain" || rows.length < 2) return;
  const at = rows.findIndex((c) => c.id === deps.current());
  const next = rows[(at + step + rows.length) % rows.length];
  if (next) choose(next.id);
}

export function initChains(d: ChainsDeps): void {
  deps = d;
  // The rail walks by the arrows as the floated list does in menu.ts.
  rail.addEventListener("keydown", (ev) => {
    const list = rail.querySelector<HTMLElement>("[data-list]");
    const to = listStep(ev);
    if (list && to !== undefined && !typing(rail) && walkRows(list, to)) ev.preventDefault();
  });
  chord("shift+[", () => cycle(-1), modalOpen);
  chord("shift+]", () => cycle(1), modalOpen);
  chord("shift+o", startCreate, modalOpen);
}
