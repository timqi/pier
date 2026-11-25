// The item view (docs/design/15-item-view.md): the conversation pane drawn from
// one item's rows, and the live rows its tagging puts in the item, the rest hidden.

import type { ItemTurn } from "../../core/open-items.js";
import { TASK_RUN_STATES, type BackgroundRun, type SessionState, type TaskRunState } from "../../core/types.js";
import type { TreeRun } from "../../tasks/types.js";
import { appendTurn, chatLoading, renderSnapshot, turnsPane } from "./chat.js";
import { agoLabel, h } from "./dom.js";
import { badge, button } from "./form.js";
import { stateBadge } from "./tasks.js";
import { runTopic, setViewTopics } from "./topics.js";

/** GET /api/continuous/items/:chain/:problem/turns — the item's sessions in chain order, the head's up to `lastSeq`. */
export interface ItemTurns {
  chain: string;
  problem: string;
  aliases: string[];
  closedAt?: number;
  sessions: { sessionId: string; startedAt: number; turns: ItemTurn[] }[];
  /** Every run behind the item, newest first: its sessions' own and the ones they launched (`itemRunTree`). */
  runs: TreeRun[];
  /** The whole tree counted: `runs` stops at the newest 200. */
  runCount: { total: number; running: number };
  epoch: string;
  lastSeq: number;
}

export const itemTurnsUrl = (problem: string, chain: string): string =>
  `/api/continuous/items/${encodeURIComponent(chain)}/${encodeURIComponent(problem)}/turns`;

/** Each session's rows as the pane replays them: only the head's, of an open item, take
 *  next steps and its runs; returns the filter each later event runs. `head.turns` is its
 *  snapshot's length: a streaming head's turn in flight is its last, maybe another item's. */
export function renderItem(view: ItemTurns, head: { id: string; state: SessionState; turns: number }, runs: BackgroundRun[]): () => void {
  const keys = new Set([view.problem, ...view.aliases]);
  setViewTopics(keys);
  const held = runs.filter((r) => keys.has(runTopic(r.runId) ?? ""));
  // Drawn before any session's rows, so the loading rows go first; an item with no session never clears them otherwise.
  chatLoading(false);
  if (view.runs.length) turnsPane.append(runList(view.runs, view.runCount));
  for (const s of view.sessions) {
    const own = s.sessionId === head.id && view.closedAt === undefined;
    const streaming = own && head.state === "streaming" && s.turns.at(-1)?.index === head.turns - 1;
    renderSnapshot(s.turns.map((t) => t.turn), streaming ? "streaming" : "idle", own ? held : [], !own, { sessionId: s.sessionId, indices: s.turns.map((t) => t.index) });
  }
  if (!view.sessions.some((s) => s.turns.length)) appendTurn("system", `Nothing of "${view.problem}" in its sessions' transcripts.`);
  for (const row of [...turnsPane.children] as HTMLElement[]) row.dataset.itemRow = "";
  return () => filterRows(keys);
}

/** The item's run tree, one line a run with its state, opening on the ones still running; a cut list says so. */
function runList(runs: TreeRun[], { total, running }: ItemTurns["runCount"]): HTMLElement {
  const list = h("details", "item-runs my-3 rounded-lg border border-neutral-200 bg-white text-[13px]") as HTMLDetailsElement;
  list.open = running > 0;
  list.dataset.kind = "runs";
  list.append(h("summary", "cursor-pointer px-3 py-2 text-neutral-600",
    `${total} run${total === 1 ? "" : "s"}${running ? `, ${running} running` : ""}${total > runs.length ? `, showing the newest ${runs.length}` : ""}`));
  const rows = h("ul", "flex flex-col border-t border-neutral-200");
  for (const r of runs) {
    const name = r.targetSessionId
      ? Object.assign(h("a", "min-w-0 flex-1 truncate text-indigo-600 hover:underline", r.name), { href: `#/session/${encodeURIComponent(r.targetSessionId)}` })
      : h("span", "min-w-0 flex-1 truncate", r.name);
    const row = h("li", "flex items-center gap-2 px-3 py-1.5 max-md:min-h-11",
      (TASK_RUN_STATES as readonly string[]).includes(r.state) ? stateBadge(r.state as TaskRunState) : badge(r.state, "bg-neutral-100 text-neutral-600 ring-neutral-200"),
      ...(r.launched ? [h("span", "flex-none text-neutral-400", "worker")] : []), name,
      h("span", "flex-none text-neutral-400", agoLabel(r.finishedAt ?? r.queuedAt)));
    row.dataset.runId = r.runId;
    rows.append(row);
  }
  list.append(rows);
  return list;
}

/** A live row is the item's when tagged with a key; a rotation's divider shows; a reply in
 *  flight follows the user row above it; any other row follows the row before it, a clock
 *  the row it stamps. Hidden, never removed: the pane's own transcript is all still there. */
function filterRows(keys: Set<string>): void {
  const rows = [...turnsPane.children] as HTMLElement[];
  let prev: HTMLElement | undefined;
  const shown = rows.map((row) => {
    const show = shows(row, prev, keys);
    row.toggleAttribute("data-item-hidden", !show);
    if (row.dataset.kind !== "time") prev = row;
    return show;
  });
  rows.forEach((row, i) => { if (row.dataset.kind === "time" && !("itemRow" in row.dataset)) row.toggleAttribute("data-item-hidden", !shown[i + 1]); });
}

function shows(row: HTMLElement, prev: HTMLElement | undefined, keys: Set<string>): boolean {
  const { kind, topic } = row.dataset;
  if ("itemRow" in row.dataset || kind === "divider" || "seed" in row.dataset) return true;
  if (topic) return keys.has(topic);
  if (kind === "user") return false;
  const prevShown = !!prev && !("itemHidden" in prev.dataset);
  if (kind === "assistant") return "pending" in row.dataset && prev?.dataset.kind === "user" && prevShown;
  return !prev || prevShown;
}

/** A problem the route names that could not be shown: the server's sentence and the way back. */
export function itemMissing(why: string, back: () => void): void {
  const way = button("Back to the conversation");
  way.onclick = back;
  const row = h("div", "flex flex-col items-center gap-3 px-5 py-8 text-center text-[13px] text-neutral-500", h("p", "", why), way);
  row.dataset.kind = "missing";
  turnsPane.append(row);
}
