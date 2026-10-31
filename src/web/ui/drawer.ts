// The status panel: what needs you and what is running, led in the bar by its
// most urgent row and listed in the panel that row opens — the open items and
// the live sessions no item holds, one row each.

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

const rowNodes = new Map<string, HTMLElement>();
/** Items the panel's Close took off the list, until the stream's re-read drops them too. */
const closing = new Set<string>();

/** Items keep their own identity even when they hold the same session; only independent sessions deduplicate.
 *  Waiting on you first, every chain's; then the current chain's rest, then the other chains' (§状态面板). */
function listed(now: number): { rows: HTMLElement[]; ordered: OpenItemPresentation[]; sessions: SessionInfo[] } {
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
  const keys = new Set(all.map((p) => p.key));
  for (const [key, node] of rowNodes) if (!keys.has(key)) { node.remove(); rowNodes.delete(key); }
  const rest = all.filter((r) => !waits(r));
  const ordered = [...all.filter(waits), ...rest.filter((r) => !elsewhere(r)), ...rest.filter(elsewhere)];
  const rows = ordered.map((p) => {
    const chain = chainOf.get(p.key);
    const node = openItemRow(p, {
      currentId: deps.currentId(),
      openItem: (target) => { closeMenu(); deps.openItem(target, chain?.id); },
      panelView: (problem) => toView(problem, chain?.id),
      ...(chain ? { panelClose: (problem: string) => void closeItem(problem, chain.id) } : {}),
      tag: chainTag(chain),
      ...(chain?.archived ? { reopen: () => { closeMenu(); deps.reopen(chain.id, p.problem); } } : {}),
    }, rowNodes.get(p.key));
    rowNodes.set(p.key, node);
    return node;
  });
  return { rows, ordered, sessions };
}

// --- the lead and the panel -------------------------------------------------------------

/** The panel's list while it is open; a render fills it in place. */
let list: HTMLElement | null = null;
let rows: HTMLElement[] = [];
let ordered: OpenItemPresentation[] = [];
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
  const { sessions, ...got } = listed(Date.now());
  rows = got.rows;
  ordered = got.ordered;
  // The app icon counts a turn to look at — an unread one —
  // plus each chain's unread head reply, which the bar and the chain list stand for instead of a row.
  const heads = deps.chains().length ? deps.chains().filter((c) => c.unread).length : headSession()?.unread ? 1 : 0;
  setUnreadBadge(sessions.filter((s) => needsYou(markOf(s))).length + heads);
  paintLead();
  if (list?.isConnected && !list.closest("[inert]")) {
    if (!rows.length) closeMenu();
    else fill(list);
  }
}

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
function fill(into: HTMLElement): void {
  const focused = into.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const top = into.scrollTop;
  const shown = [...(closeError ? [closeError] : []), ...(found ?? rows)];
  shown.forEach((row, index) => { if (into.children[index] !== row) into.insertBefore(row, into.children[index] ?? null); });
  while (into.children.length > shown.length) into.lastElementChild!.remove();
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  into.scrollTop = top;
}

const toView = (problem: string, chain?: string): void => { closeMenu(); deps.itemView(problem, chain); };

/** The last Close's refusal, atop the list until the next Close or opening. */
let closeError: HTMLElement | null = null;

/** Optimistic: the row leaves at once and `open-items-changed` reconciles; a refusal puts it back
 *  under its sentence, the panel reopened if its last row's leaving closed it. */
async function closeItem(problem: string, chain: string): Promise<void> {
  const key = itemKey(problem, chain);
  const row = list ? [...list.children].findIndex((li) => (li as HTMLElement).dataset.rowKey === key) : -1;
  const focused = row >= 0 && list!.children[row]!.contains(document.activeElement);
  closing.add(key);
  closeError = null;
  found = found?.filter((r) => r.dataset.rowKey !== key) ?? null;
  renderDrawer();
  // Focus stays in the list for the keys' walk: on the row that took the closed one's place.
  if (focused && list?.isConnected) (list.children[row] ?? list.lastElementChild)?.querySelector("button")?.focus({ preventScroll: true });
  const error = await refused(`/api/continuous/items/${encodeURIComponent(chain)}/${encodeURIComponent(problem)}/close`, "POST", "Could not close the item");
  if (error === undefined) return;
  closing.delete(key);
  renderDrawer();
  if (!list?.isConnected) openDrawer();
  closeError = note(error, "text-red-600");
  if (list) fill(list);
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
  fill(list);
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
  fill(list);
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
