// The status panel: what needs you and what is running, led in the bar by its
// most urgent row and listed in the panel that row opens — the open items and
// the live sessions no item holds, one row each — and, from 80rem, the same
// rows as the sidebar's Items section.

import { getJson, refused } from "./api.js";
import { $, agoLabel, h } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";
import { setUnreadBadge } from "./notifications.js";
import { chord, modalOpen } from "./shortcut.js";
import { openItemPresentation } from "../../core/open-items.js";
import { closedItemRow, openItemRow, paintDot, paintStatus, stageLine, stagePhrase } from "./open-items.js";
import { waitsOnYou } from "../../core/reply.js";
import type { ChainMember, LeadPhase, OpenItemPresentation, OpenItemTarget, SessionState } from "../../core/types.js";
import type { ItemSummary, OpenItem, OpenItems, OpenRun } from "../../tasks/types.js";
import type { ChainInfo } from "../types.js";

/** GET /api/sessions row: summary + live workspace state. */
export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  /** The row's tooltip only: it moves with every background turn, so it orders nothing. */
  modified?: number;
  title?: string;
  state: SessionState;
  /** Turn finished, no client has viewed it yet (server-side, all clients agree). */
  unread: boolean;
  /** The IM channel that owns it, or `"web"` for everything else. */
  channel: string;
  /** Background runs this session launched that are still in flight. */
  activeRuns: number;
  /** The chain whose member launched it, which its `‹` returns to (`GET /api/sessions/:id` only). */
  chain?: string;
  /** The chain it is a member of (`GET /api/sessions` only): that chain's row stands for it. */
  member?: string;
  /** A feature lead's session (`pier task run --role lead`): its phase,
   *  designing with the user or building per a doc. */
  phase?: LeadPhase;
  /** That lead's: a run targeting its session is queued or running. */
  runLive?: true;
}

/** Everything the drawer needs from the orchestrator (main.ts). */
interface DrawerDeps {
  /** Newest first, by birth (main.ts `commitSessions`). */
  sessions: () => SessionInfo[];
  currentId: () => string | null;
  /** The current chain's sessions, newest first; its row is the bar's title, not a drawer row. */
  chain: () => ChainMember[];
  /** Every chain, `GET /api/chains`: their heads are their rows in the chain list, not here. */
  chains: () => ChainInfo[];
  /** The chain the pane shows: its rows carry no chain tag. */
  chainId: () => string | null;
  openContinuous: () => void;
  /** `GET /api/continuous/open`; null before it answers. */
  open: () => OpenItems | null;
  /** `chain`: the item's, navigated to first when it is not the current one. */
  openItem: (target: OpenItemTarget, chain?: string) => void;
  /** An item row's secondary action, and a closed item's click: its view. */
  itemView: (problem: string, chain?: string) => void;
  /** An archived chain's item row's secondary action: unarchive it and open the item there. */
  reopen: (chain: string, problem: string) => void;
}

let deps: DrawerDeps;

const lead = $("#status-item");
const leadDot = $("#status-item-dot");
const leadTitle = $("#status-item-title");
const leadState = $("#status-item-state");
const leadStage = $("#status-item-stage");
const leadCount = $("#status-item-count");
const next = $("#status-next");

// --- marks -------------------------------------------------------------------------------

/** A session Pi has not persisted yet has no transcript to date; its creation
 *  is the last thing that happened to it. Tooltip only. */
const lastActive = (s: SessionInfo): number => s.modified ?? s.createdAt;

/** The server marks only a turn the operator sent into, or the conversation's
 *  (web/server.ts), so the flag is the whole rule here. */
const waitingForYou = (s: SessionInfo): boolean => s.unread;

/** A session with something going on in it: running, waiting for a look,
 *  subagents in flight or a lead's run queued — what the dot marks, and what the drawer lists. */
export const isLive = (s: SessionInfo): boolean =>
  s.state === "streaming" || waitingForYou(s) || s.activeRuns > 0 || s.runLive === true;

/** The dot's colour, in precedence order; the chip counts by the same answer. */
type Mark = "working" | "unread" | "runs" | "queued";

function markOf(s: SessionInfo): Mark | null {
  if (s.state === "streaming") return "working";
  if (waitingForYou(s)) return "unread";
  if (s.activeRuns > 0) return "runs";
  return s.runLive ? "queued" : null;
}

/** Green = running, amber = waiting for a look, sky = subagents in flight,
 *  grey = a lead's run queued. Idle has no mark or slot. */
export function stateDot(s: SessionInfo): HTMLElement[] {
  const mark = markOf(s);
  if (!mark) return [];
  return markDot(
    mark === "working"
      ? WORKING
      : mark === "unread"
        ? ["bg-amber-500", "turn finished — not viewed yet"]
        : mark === "runs"
          ? ["bg-sky-500", `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`]
          : ["bg-neutral-400", "lead — run queued"],
  );
}

const WORKING: [string, string] = ["bg-green-500 running-dot", "working…"];

function markDot([cls, title]: [string, string]): HTMLElement[] {
  const dot = h("span", `h-2 w-2 flex-none rounded-full ${cls}`);
  dot.title = title;
  return [dot];
}

/** A lead's phase in English whatever language its title is in; trailing, so a
 *  truncated title never hides it. */
export const phaseTag = (s: SessionInfo): HTMLElement[] => {
  if (!s.phase) return [];
  return tag(s.phase, s.phase === "design" ? "lead — designing with you" : "lead — building per the design");
};

const tag = (text: string, title: string): HTMLElement[] => {
  const el = h("span", "flex-none rounded bg-neutral-100 px-1 text-[0.6875rem] font-medium leading-4 text-neutral-500", text);
  el.title = title;
  return [el];
};

/** The live sessions, less every chain's members, which the bar and the chain list stand for;
 *  a finished lead stays while unread and leaves once viewed. */
export function inProgress(list: SessionInfo[], chain: ChainMember[], chains: ChainInfo[] = []): SessionInfo[] {
  // Only a new head the next `/api/sessions` has not yet marked `member` needs this set.
  const members = new Set([...chain.map((m) => m.sessionId), ...chains.flatMap((c) => (c.head ? [c.head.sessionId] : []))]);
  return list.filter((s) => isLive(s) && s.member === undefined && !members.has(s.id));
}

/** The conversation's head row, whose dot the `‹` wears. */
export const headSession = (): SessionInfo | undefined => {
  const head = deps.chain()[0]?.sessionId;
  return deps.sessions().find((s) => s.id === head);
};

// --- rows ---------------------------------------------------------------------------------

type RowStatus = OpenItemPresentation["status"];

/** A lead with its phase; a session outside the web by the channel it answers. */
const whoOf = (s: SessionInfo | undefined): string =>
  s?.phase ? `lead · ${s.phase}` : s?.channel && s.channel !== "web" ? s.channel : "";

const MARK_ROW: Record<Mark, [RowStatus, (s: SessionInfo) => string]> = {
  working: ["running", () => ""],
  unread: ["waiting on you", () => "turn finished — not viewed yet"],
  runs: ["running", (s) => `${s.activeRuns} subagent${s.activeRuns > 1 ? "s" : ""} running`],
  queued: ["queued", () => "run queued"],
};

/** A session's mark read as a row status, so a session and an item wait on you by one rule. */
const needsYou = (m: Mark | null): boolean => !!m && waitsOnYou(MARK_ROW[m][0]);

function sessionRow(s: SessionInfo, mark: Mark): OpenItemPresentation {
  const [status, says] = MARK_ROW[mark];
  const p = openItemPresentation({ problem: s.title ?? "untitled", stage: says(s), status, runs: [] }, Date.now(), `session:${s.id}`);
  return { ...p, direct: true, runs: [{ runId: s.id, targetSessionId: s.id }],
    metadata: [whoOf(s), `active ${agoLabel(lastActive(s))}`].filter(Boolean) };
}

/** Keyed by chain too: two chains may each hold an item of the same name. */
const itemKey = (problem: string, chain?: string): string => `item:${chain ? `${chain}/` : ""}${problem}`;

const itemRow = (i: OpenItem, now: number): OpenItemPresentation => openItemPresentation(i, now, itemKey(i.problem, i.chain?.id));

/** A row of another chain names it, `· archived` when it is; the current chain's says nothing. */
function chainTag(chain: { id: string; name: string; archived?: boolean } | undefined): string | undefined {
  if (!chain || chain.id === deps.chainId()) return undefined;
  return chain.archived ? `${chain.name} · archived` : chain.name;
}

function unlistedRow(r: OpenRun, now: number): OpenItemPresentation {
  return { ...openItemPresentation({ problem: r.name, title: r.title, stage: "", runs: [r], status: r.state === "queued" ? "queued" : "running" }, now, `run:${r.runId}`), direct: true };
}

/** The two surfaces a row is drawn on; a Close says which asked, so its refusal lands there. */
type Surface = "panel" | "rail";
/** Row nodes by key, one map per surface: a node has one parent, and a row
 *  is reused across renders so a refresh between mousedown and mouseup keeps the click. */
const rowNodes: Record<Surface, Map<string, HTMLElement>> = { panel: new Map(), rail: new Map() };
/** Items a Close took off the list, until the stream's re-read drops them too. Shared: a row closed on one surface leaves both. */
const closing = new Set<string>();
/** A render's rows in order, and the chain of each item row by key. */
interface Listed { ordered: OpenItemPresentation[]; chainOf: Map<string, OpenItem["chain"]> }

/** Items keep their own identity even when they hold the same session; only independent sessions deduplicate.
 *  Waiting on you first, every chain's; then the current chain's rest, then the other chains' (§状态面板). */
function listed(now: number): Listed & { sessions: SessionInfo[] } {
  const open = deps.open() ?? { items: [], unlisted: [] };
  const held = new Set([...open.items.flatMap((i) => i.runs), ...open.unlisted].flatMap((r) => (r.targetSessionId ? [r.targetSessionId] : [])));
  const sessions = inProgress(deps.sessions(), deps.chain(), deps.chains());
  const chainOf = new Map(open.items.map((i) => [itemKey(i.problem, i.chain?.id), i.chain]));
  for (const key of closing) if (!chainOf.has(key)) closing.delete(key);
  const all = [
    ...open.items.map((i) => itemRow(i, now)).filter((p) => !closing.has(p.key)),
    ...open.unlisted.map((r) => unlistedRow(r, now)),
    ...sessions.flatMap((s) => {
      const mark = markOf(s);
      return mark && !held.has(s.id) ? [sessionRow(s, mark)] : [];
    }),
  ];
  const waits = (r: OpenItemPresentation): boolean => waitsOnYou(r.status);
  const elsewhere = (r: OpenItemPresentation): boolean => chainTag(chainOf.get(r.key)) !== undefined;
  const rest = all.filter((r) => !waits(r));
  return { ordered: [...all.filter(waits), ...rest.filter((r) => !elsewhere(r)), ...rest.filter(elsewhere)], chainOf, sessions };
}

/** One surface's row nodes for `ordered`, reused by key; a node whose row left is dropped. */
function rowsOn(surface: Surface, { ordered, chainOf }: Listed): HTMLElement[] {
  const nodes = rowNodes[surface];
  const keys = new Set(ordered.map((p) => p.key));
  for (const [key, node] of nodes) if (!keys.has(key)) { node.remove(); nodes.delete(key); }
  return ordered.map((p) => {
    const chain = chainOf.get(p.key);
    const node = openItemRow(p, {
      currentId: deps.currentId(),
      openItem: (target) => { closeMenu(); deps.openItem(target, chain?.id); },
      panelView: (problem) => toView(problem, chain?.id),
      ...(chain ? { panelClose: (problem: string) => void closeItem(problem, chain.id, surface) } : {}),
      tag: chainTag(chain),
      ...(chain?.archived ? { reopen: () => { closeMenu(); deps.reopen(chain.id, p.problem); } } : {}),
    }, nodes.get(p.key));
    nodes.set(p.key, node);
    return node;
  });
}

// --- the lead and the panel -------------------------------------------------------------

/** The panel's list while it is open; a render fills it in place. */
let list: HTMLElement | null = null;
let rows: HTMLElement[] = [];
let ordered: OpenItemPresentation[] = [];
/** The sidebar's Items section (index.html): its head, its list and its own copy of the rows,
 *  filled by every render — hidden below 80rem and in session mode, where the fill is harmless. */
const railItems = $("#rail-items");
const railHead = h("p", "rail-head", "Items");
railHead.id = "rail-items-head"; // the section's `aria-labelledby`
const railList = h("ul", "");
railList.dataset.list = ""; // the arrows' walk, by section (chains.ts)
const railEmpty = h("p", "px-3 py-1 text-sm text-neutral-500", "Nothing open");
let railRows: HTMLElement[] = [];
/** The last rail Close's refusal, atop its list until the next Close. */
let railError: HTMLElement | null = null;
/** The row the bar leads with: the most urgent until the counter cycles it on,
 *  and again once a different row becomes the most urgent. */
let shownKey: string | null = null;
let topKey: string | null = null;

/** Short-circuit: a rebuild replaces every node, and
 *  one landing between mousedown and mouseup swallows the click. */
const renderKey = (): string =>
  `${[...closing].join("\0")}\n${deps.currentId() ?? ""}\n${JSON.stringify(deps.chain())}\n${JSON.stringify(deps.chains())}\n${JSON.stringify(deps.sessions())}\n${JSON.stringify(deps.open())}`;

let drawn = "";

export function renderDrawer(): void {
  const key = renderKey();
  if (key === drawn) return;
  drawn = key;
  const got = listed(Date.now());
  ordered = got.ordered;
  const sessions = got.sessions;
  rows = rowsOn("panel", got);
  railRows = rowsOn("rail", got);
  // A refusal stands while its row does: an item closed another way takes its sentence with it.
  closeError = standing(closeError);
  railError = standing(railError);
  // A search's open match whose row left — closed here or in the stream — leaves the results with it.
  found &&= found.filter((r) => rows.includes(r) || !r.dataset.rowKey || r.dataset.rowKey.startsWith("closed:"));
  if (found?.length === 0) found = [note("No item matches.")];
  // The app icon counts a turn to look at — an unread one —
  // plus each chain's unread head reply, which the bar and the chain list stand for instead of a row.
  const heads = deps.chains().length ? deps.chains().filter((c) => c.unread).length : headSession()?.unread ? 1 : 0;
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + heads);
  paintLead();
  fillRail();
  if (list?.isConnected && !list.closest("[inert]")) {
    if (!rows.length) closeMenu();
    else fillPanel();
  }
}

const standing = (error: HTMLElement | null): HTMLElement | null =>
  error && ordered.some((p) => p.key === error.dataset.refused) ? error : null;

/** `Items · N` over the rows, or `Nothing open`; N is the lead's count. */
function fillRail(): void {
  railHead.textContent = railRows.length ? `Items \u00b7 ${railRows.length}` : "Items";
  fill(railList, [...(railError ? [railError] : []), ...railRows]);
  railItems.replaceChildren(railHead, railRows.length || railError ? railList : railEmpty);
}

const fillPanel = (): void => { if (list) fill(list, [...(closeError ? [closeError] : []), ...(found ?? rows)]); };

/** Dot, title, status mark and phrase of the shown row; below md the status glyph and the row count only (index.html). */
function paintLead(): void {
  if (ordered[0]?.key !== topKey) shownKey = topKey = ordered[0]?.key ?? null;
  const at = Math.max(0, ordered.findIndex((p) => p.key === shownKey));
  const p = ordered[at];
  shownKey = p?.key ?? null;
  lead.classList.toggle("hidden", !p);
  lead.classList.toggle("flex", !!p);
  next.classList.toggle("hidden", ordered.length < 2);
  if (!p) return;
  paintDot(leadDot, p);
  paintStatus(leadState, p);
  leadTitle.textContent = p.title;
  leadStage.textContent = stagePhrase(p);
  leadCount.textContent = String(ordered.length);
  lead.title = `${p.title} — ${stageLine(p)}`;
  lead.setAttribute("aria-label", `Status: ${ordered.length} open — ${lead.title}`);
  next.textContent = `${at + 1}/${ordered.length}`;
}

function cycleLead(): void {
  const at = ordered.findIndex((p) => p.key === shownKey);
  shownKey = ordered[(at + 1) % ordered.length]?.key ?? null;
  paintLead();
}

/** Refill keeping the focused control focused: Escape has to find its way back. */
function fill(into: HTMLElement, shown: HTMLElement[]): void {
  const focused = into.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const top = into.scrollTop;
  shown.forEach((row, index) => { if (into.children[index] !== row) into.insertBefore(row, into.children[index] ?? null); });
  while (into.children.length > shown.length) into.lastElementChild!.remove();
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  into.scrollTop = top;
}

const toView = (problem: string, chain?: string): void => { closeMenu(); deps.itemView(problem, chain); };

/** The last panel Close's refusal, atop the list until the next Close or opening. */
let closeError: HTMLElement | null = null;

/** Optimistic: the row leaves both surfaces at once and `open-items-changed` reconciles; a refusal puts it back
 *  under its sentence on the surface that asked — the panel reopened if its last row's leaving closed it. */
async function closeItem(problem: string, chain: string, from: Surface): Promise<void> {
  const key = itemKey(problem, chain);
  const root = from === "rail" ? railList : list;
  const row = root ? [...root.children].findIndex((li) => (li as HTMLElement).dataset.rowKey === key) : -1;
  const focused = row >= 0 && root!.children[row]!.contains(document.activeElement);
  // The previous refusal atop the list leaves with this Close: the rows below it move up one.
  const error = from === "rail" ? railError : closeError;
  const at = error && error.parentElement === root ? row - 1 : row;
  closing.add(key);
  closeError = railError = null;
  renderDrawer();
  // Focus stays in the list for the keys' walk: on the row that took the closed one's place. The rail's
  // last row leaves its list for `Nothing open`, so the current chain's row above takes it.
  if (focused) {
    const to = root?.isConnected ? (root.children[at] ?? root.lastElementChild)?.querySelector("button")
      : from === "rail" ? $("#rail-chains").querySelector<HTMLElement>("[aria-current]") ?? $("#rail-chains").querySelector("button") : null;
    to?.focus({ preventScroll: true });
  }
  const refusal = await refused(`/api/continuous/items/${encodeURIComponent(chain)}/${encodeURIComponent(problem)}/close`, "POST", "Could not close the item");
  if (refusal === undefined) return;
  closing.delete(key);
  renderDrawer();
  const said = note(refusal, "text-red-600");
  said.dataset.refused = key;
  if (from === "rail") {
    railError = said;
    return fillRail();
  }
  if (!list?.isConnected) openDrawer();
  closeError = said;
  fillPanel();
}

// --- search -------------------------------------------------------------------------------

/** The search's rows while its field holds words; null shows the panel's own. */
let found: HTMLElement[] | null = null;
let query = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const SEARCH_MS = 250;

const note = (text: string, cls = "text-neutral-500"): HTMLElement => h("li", `px-1.5 py-2 text-xs ${cls}`, text);

/** Open matches are their panel rows, their click the row's; closed ones follow under `Closed`. */
async function search(q: string): Promise<void> {
  query = q;
  const got = q ? await getJson<{ items: ItemSummary[] }>(`/api/continuous/items?q=${encodeURIComponent(q)}`, "Could not search the items") : null;
  if (q !== query || !list) return; // a later keystroke owns the list
  if (!got) found = null;
  else if (!got.ok) found = [note(got.error, "text-red-600")];
  else {
    const open = new Set(got.value.items.filter((i) => i.closedAt === undefined).map((i) => itemKey(i.problem, i.chain)));
    const closed = got.value.items.filter((i) => i.closedAt !== undefined);
    const chains = new Map(deps.chains().map((c) => [c.id, { id: c.id, name: c.name, archived: c.archivedAt !== undefined }]));
    found = [...rows.filter((r) => open.has(r.dataset.rowKey ?? "")),
      ...(closed.length ? [note("Closed"), ...closed.map((i) =>
        closedItemRow(i.problem, i.closedAt!, (problem) => toView(problem, i.chain), chainTag(chains.get(i.chain))))] : [])];
    if (!found.length) found = [note("No item matches.")];
  }
  fillPanel();
}

function searchField(): HTMLInputElement {
  const field = h("input", "mb-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900") as HTMLInputElement;
  field.type = "search";
  field.placeholder = "Search items, closed ones too";
  field.setAttribute("aria-label", "Search items");
  field.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void search(field.value.trim()), SEARCH_MS);
  };
  return field;
}

/** Nothing to show is the lead's absence, not an empty panel. */
export function openDrawer(): void {
  if (lead.getAttribute("aria-expanded") === "true") return closeMenu();
  if (!rows.length) return;
  found = null;
  query = "";
  closeError = null;
  list = h("ul", "");
  list.dataset.list = ""; // the arrows' walk (menu.ts listIn)
  fillPanel();
  openPanel(lead, h("div", "w-[min(32rem,calc(100vw-2rem))] max-sm:w-full font-sans text-sm", searchField(), list)).setAttribute("aria-label", "Status");
  // A finger opening the panel is reading it: the field would raise the keyboard over the rows.
  if (matchMedia("(pointer: coarse)").matches) list.querySelector("button")?.focus({ preventScroll: true });
}

export function initDrawer(d: DrawerDeps): void {
  deps = d;
  lead.onclick = openDrawer;
  next.onclick = cycleLead;
  // Stands down under a modal: it is in the top layer, so this panel would open behind it.
  chord("shift+p", openDrawer, modalOpen);
}
