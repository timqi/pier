// The open-item row used by status panels and fixed command cards.

import { openItemDestination, openItemGroups } from "../../core/open-items.js";
import type { OpenItemPresentation, OpenItemsSnapshot, OpenItemTarget } from "../../core/types.js";
import { h } from "./dom.js";
import { topicColour } from "./topics.js";

interface Actions {
  openItem: (target: OpenItemTarget) => void;
  currentId?: string | null;
  grouped?: boolean;
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
  const stage = h("span", "open-item-stage block text-xs text-neutral-500");
  const metadata = h("span", "open-item-meta block text-xs text-neutral-500");
  const main = h("button", "session-open flex w-full min-w-0 items-start gap-1.5 text-left", dot, h("span", "min-w-0 flex-1", title, stage, metadata));
  main.setAttribute("type", "button");
  const li = h("li", "open-item", main);
  updates.set(li, (item, a) => {
    li.dataset.rowKey = item.key;
    title.textContent = item.title;
    // The title is short; the head's full wording stays one hover away.
    if (item.title !== item.problem) main.title = item.problem;
    else main.removeAttribute("title");
    const label = a.grouped && item.status === "waiting on you" ? "" : item.statusLabel;
    // "Needs you in the design session · …": the place reads as part of the label.
    stage.textContent = [label, item.stage].filter(Boolean).join(item.waitsIn ? " " : " · ");
    stage.classList.toggle("text-amber-700", item.status === "waiting on you");
    stage.classList.toggle("text-neutral-500", item.status !== "waiting on you");
    stage.classList.toggle("hidden", !stage.textContent);
    metadata.textContent = item.metadata.join(" · ");
    metadata.classList.toggle("hidden", !metadata.textContent);
    dot.style.background = item.key.startsWith("item:") ? topicColour(item.problem) : "var(--color-neutral-400)";
    dot.classList.toggle("animate-pulse", item.status === "running");
    dot.title = item.status;
    main.setAttribute("aria-label", `${item.title} · ${item.status}`);
    const to = openItemDestination(item);
    if (!to.topic && to.session && to.session === a.currentId) main.setAttribute("aria-current", "page");
    else main.removeAttribute("aria-current");
    main.onclick = () => a.openItem(item);
  });
  updates.get(li)!(p, actions);
  return li;
}

export function openItemsCard(snapshot: OpenItemsSnapshot, actions: Actions): HTMLElement {
  const content = h("div", "open-items-card");
  for (const group of openItemGroups(snapshot.items)) {
    content.append(h("h3", "mt-3 mb-2 text-xs text-neutral-500", `${group.title} · ${group.items.length}`),
      h("ul", "", ...group.items.map((p) => openItemRow(p, { ...actions, grouped: true }))));
  }
  if (!snapshot.items.length) content.append(h("p", "text-xs text-neutral-500", "Nothing open."));
  return content;
}
