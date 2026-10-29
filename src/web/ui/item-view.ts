// The item view (docs/design/15-item-view.md): the conversation pane drawn from
// one item's rows, and the live rows its tagging puts in the item, the rest hidden.

import type { ItemTurn } from "../../core/open-items.js";
import type { BackgroundRun, SessionState } from "../../core/types.js";
import { appendTurn, renderSnapshot, turnsPane } from "./chat.js";
import { h } from "./dom.js";
import { button } from "./form.js";
import { runTopic } from "./topics.js";

/** GET /api/continuous/items/:problem/turns — the item's sessions in chain order, the head's up to `lastSeq`. */
export interface ItemTurns {
  problem: string;
  aliases: string[];
  closedAt?: number;
  sessions: { sessionId: string; startedAt: number; turns: ItemTurn[] }[];
  epoch: string;
  lastSeq: number;
}

export const itemTurnsUrl = (problem: string): string => `/api/continuous/items/${encodeURIComponent(problem)}/turns`;

/** Each session's rows as the pane replays them: only the head's, of an open item, take
 *  next steps and its runs; returns the filter each later event runs. `head.turns` is its
 *  snapshot's length: a streaming head's turn in flight is its last, maybe another item's. */
export function renderItem(view: ItemTurns, head: { id: string; state: SessionState; turns: number }, runs: BackgroundRun[]): () => void {
  const keys = new Set([view.problem, ...view.aliases]);
  const held = runs.filter((r) => keys.has(runTopic(r.runId) ?? ""));
  for (const s of view.sessions) {
    const own = s.sessionId === head.id && view.closedAt === undefined;
    const streaming = own && head.state === "streaming" && s.turns.at(-1)?.index === head.turns - 1;
    renderSnapshot(s.turns.map((t) => t.turn), streaming ? "streaming" : "idle", own ? held : [], !own, { sessionId: s.sessionId, indices: s.turns.map((t) => t.index) });
  }
  if (!view.sessions.some((s) => s.turns.length)) appendTurn("system", `Nothing of "${view.problem}" in its sessions' transcripts.`);
  for (const row of [...turnsPane.children] as HTMLElement[]) row.dataset.itemRow = "";
  return () => filterRows(keys);
}

/** A live row is the item's when tagged with a key; a rotation's divider shows; a reply in
 *  flight follows the user row above it; any other row follows the row before it, a clock
 *  the row it stamps. Hidden, never removed: the pane's own transcript is all still there. */
function filterRows(keys: Set<string>): void {
  const rows = [...turnsPane.children] as HTMLElement[];
  let prev: HTMLElement | undefined;
  const shown = rows.map((row) => {
    const { kind, topic } = row.dataset;
    const show = "itemRow" in row.dataset || kind === "divider" || "seed" in row.dataset ? true
      : topic ? keys.has(topic)
      : kind === "user" ? false
      : kind === "assistant" ? "pending" in row.dataset && prev?.dataset.kind === "user" && !("itemHidden" in prev.dataset)
      : !prev || !("itemHidden" in prev.dataset);
    row.toggleAttribute("data-item-hidden", !show);
    if (kind !== "time") prev = row;
    return show;
  });
  rows.forEach((row, i) => { if (row.dataset.kind === "time" && !("itemRow" in row.dataset)) row.toggleAttribute("data-item-hidden", !shown[i + 1]); });
}

/** A problem the route names that could not be shown: the server's sentence and the way back. */
export function itemMissing(why: string, back: () => void): void {
  const way = button("Back to the conversation");
  way.onclick = back;
  const row = h("div", "flex flex-col items-center gap-3 px-5 py-8 text-center text-[13px] text-neutral-500", h("p", "", why), way);
  row.dataset.kind = "missing";
  turnsPane.append(row);
}
