// The open-item row used by the status panel, its lead in the bar and fixed command cards.

import { Check, CircleAlert, Clock, MessagesSquare, X, type IconNode } from "lucide";
import { openItemDestination, openItemGroups, UNMATCHED_DONE } from "../../core/open-items.js";
import { waitsOnYou } from "../../core/reply.js";
import type { OpenItemPresentation, OpenItemsSnapshot, OpenItemTarget } from "../../core/types.js";
import { agoLabel, h } from "./dom.js";
import { icon } from "./icons.js";
import { topicColour } from "./topics.js";
import { runningDot } from "./turn-activity.js";

interface Actions {
  openItem: (target: OpenItemTarget) => void;
  currentId?: string | null;
  grouped?: boolean;
  /** The status panel's alone: an item row's secondary action, the item view. */
  panelView?: (problem: string) => void;
}

/** A status's word, tone and glyph; running wears the still sky dot every run does.
 *  `stopped` is a run that failed, was cancelled or interrupted: the metadata names which. */
const STATUS: Record<OpenItemPresentation["status"], { label: string; tone: string; glyph: IconNode | null }> = {
  "waiting on you": { label: "waiting on you", tone: "text-amber-700", glyph: CircleAlert },
  running: { label: "in progress", tone: "text-sky-700", glyph: null },
  queued: { label: "queued", tone: "text-neutral-500", glyph: Clock },
  "wrapping up": { label: "wrapping up", tone: "text-green-700", glyph: Check },
  stopped: { label: "failed", tone: "text-red-600", glyph: X },
};

/** The whole second line, the tooltip's: status word, then the stage as worded. */
export const stageLine = (item: OpenItemPresentation): string =>
  [STATUS[item.status].label, item.stage].filter(Boolean).join(" · ");

/** The stage as one short phrase beside the status mark: a wait's place and age leave
 *  (the click goes there, the tooltip keeps them) and the first clause stays, a question
 *  with its mark. */
export function stagePhrase(item: OpenItemPresentation): string {
  const parts = item.stage.split(" · ");
  while (waitsOnYou(item.status) && /^(?:in the design session|<1m|\d+[mhd])$/.test(parts[0] ?? "")) parts.shift();
  const rest = parts.join(" · ");
  const cut = /(?<=[?？!！])|[。；，;]|[.,](?=\s)/.exec(rest);
  return (cut?.index ? rest.slice(0, cut.index) : rest) || (item.waitsIn ? "in the design session" : "");
}

/** The status mark: glyph and word in the status's tone; `labelled` false leaves the glyph.
 *  Only the tone is swapped, so the element keeps its own classes (the bar's lead its size). */
export function paintStatus(el: HTMLElement, item: OpenItemPresentation, labelled = true): void {
  const { label, tone, glyph } = STATUS[item.status];
  el.classList.remove(...Object.values(STATUS).map((s) => s.tone));
  el.classList.add("open-item-status", "inline-flex", "flex-none", "items-center", "gap-1", "font-medium", tone);
  el.replaceChildren(glyph ? icon(glyph, "h-3 w-3") : runningDot(), ...(labelled ? [h("span", "status-label", label)] : []));
}

/** The topic dot, the same on a row and on the bar's lead item. */
export function paintDot(dot: HTMLElement, item: OpenItemPresentation): void {
  dot.style.background = item.key.startsWith("item:") ? topicColour(item.problem) : "var(--color-neutral-400)";
  dot.title = item.status;
}

const updates = new WeakMap<HTMLElement, (p: OpenItemPresentation, actions: Actions) => void>();

/** Reuse the row while facts change: a refresh between pointerdown and click must still activate it. */
export function openItemRow(p: OpenItemPresentation, actions: Actions, existing?: HTMLElement): HTMLElement {
  if (existing) {
    updates.get(existing)!(p, actions);
    return existing;
  }
  const dot = h("span", "open-item-dot h-2 w-2 flex-none rounded-full");
  const title = h("span", "open-item-title block text-sm text-neutral-900");
  const status = h("span", "");
  const phrase = h("span", "open-item-phrase min-w-0 text-neutral-600");
  const stage = h("span", "open-item-stage flex items-center gap-1.5 text-xs", status, phrase);
  const metadata = h("span", "open-item-meta block text-xs text-neutral-500");
  const main = h("button", "session-open flex w-full min-w-0 items-start gap-1.5 text-left", dot, h("span", "min-w-0 flex-1", title, stage, metadata));
  main.setAttribute("type", "button");
  const li = h("li", "open-item", main);
  // A row's key is its identity, so whether it is an item never changes under the row.
  const view = actions.panelView && p.key.startsWith("item:") ? viewButton() : null;
  if (view) li.append(view);
  updates.set(li, (item, a) => {
    li.dataset.rowKey = item.key;
    title.textContent = item.title;
    phrase.textContent = stagePhrase(item);
    // Title and phrase are short; the head's full wording stays one hover away.
    const full = [item.title !== item.problem ? item.problem : "", phrase.textContent !== item.stage ? stageLine(item) : ""];
    if (full.some(Boolean)) main.title = full.filter(Boolean).join("\n");
    else main.removeAttribute("title");
    // A grouped card's head already says `Waiting on you`.
    paintStatus(status, item, !(a.grouped && waitsOnYou(item.status)));
    metadata.textContent = item.metadata.join(" · ");
    metadata.classList.toggle("hidden", !metadata.textContent);
    paintDot(dot, item);
    main.setAttribute("aria-label", `${item.title} · ${STATUS[item.status].label}`);
    const to = openItemDestination(item);
    if (!to.topic && to.session && to.session === a.currentId) main.setAttribute("aria-current", "page");
    else main.removeAttribute("aria-current");
    main.onclick = () => a.openItem(item);
    if (view) {
      view.setAttribute("aria-label", `Item view — ${item.title}`);
      view.onclick = () => a.panelView?.(item.problem);
    }
  });
  updates.get(li)!(p, actions);
  return li;
}

function viewButton(): HTMLElement {
  const b = h("button", "item-view-open flex h-8 w-8 flex-none items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-200", icon(MessagesSquare));
  b.setAttribute("type", "button");
  b.title = "Item view — this item's conversation alone";
  return b;
}

/** A closed item the panel's search found: the view is the only place it has left. */
export function closedItemRow(problem: string, closedAt: number, itemView: (problem: string) => void): HTMLElement {
  const dot = h("span", "open-item-dot h-2 w-2 flex-none rounded-full");
  dot.style.background = topicColour(problem);
  const main = h("button", "session-open flex w-full min-w-0 items-start gap-1.5 text-left", dot, h("span", "min-w-0 flex-1",
    h("span", "open-item-title block text-sm text-neutral-900", problem), h("span", "open-item-meta block text-xs text-neutral-500", `closed ${agoLabel(closedAt)}`)));
  main.setAttribute("type", "button");
  main.onclick = () => itemView(problem);
  const li = h("li", "open-item", main);
  li.dataset.rowKey = `closed:${problem}`;
  return li;
}

export function openItemsCard(snapshot: OpenItemsSnapshot, actions: Actions): HTMLElement {
  const content = h("div", "open-items-card");
  for (const group of openItemGroups(snapshot.items)) {
    content.append(h("h3", "mt-3 mb-2 text-xs text-neutral-500", `${group.title} · ${group.items.length}`),
      h("ul", "", ...group.items.map((p) => openItemRow(p, { ...actions, grouped: true }))));
  }
  if (snapshot.unmatched?.length) content.append(h("h3", "mt-3 mb-2 text-xs text-neutral-500", `${UNMATCHED_DONE} · ${snapshot.unmatched.length}`), h("ul", "", ...snapshot.unmatched.map((p) => h("li", "text-sm text-amber-700", p))));
  if (!snapshot.items.length) content.append(h("p", "text-xs text-neutral-500", "Nothing open."));
  return content;
}
