// The open-item row used by status panels and fixed command cards.

import { openItemGroups } from "../../core/open-items.js";
import type { OpenItemPresentation, OpenItemsSnapshot, OpenItemTarget } from "../../core/types.js";
import { h } from "./dom.js";
import { topicColour } from "./topics.js";

interface Actions {
  openItem: (target: OpenItemTarget) => void;
  select: (id: string) => void;
  currentId?: string | null;
  grouped?: boolean;
}

const updates = new WeakMap<HTMLElement, (p: OpenItemPresentation, actions: Actions) => void>();
let detailId = 0;

/** Reuse every control while facts change: a refresh between pointerdown and click must still activate it. */
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
  main.dataset.control = "main";
  const toggle = h("button", "open-item-toggle text-xs text-neutral-500 hover:text-neutral-900", "Details");
  toggle.setAttribute("type", "button");
  toggle.dataset.control = "details";
  toggle.setAttribute("aria-expanded", "false");
  const detail = h("div", "open-item-details hidden whitespace-pre-wrap break-words text-xs text-neutral-500");
  detail.id = `open-item-details-${String(++detailId)}`;
  toggle.setAttribute("aria-controls", detail.id);
  const li = h("li", "open-item", main, toggle, detail);
  toggle.onclick = () => {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    detail.classList.toggle("hidden", !expanded);
  };
  const entries = new Map<string, HTMLElement>();
  updates.set(li, (item, a) => {
    li.dataset.rowKey = item.key;
    title.textContent = item.title;
    toggle.setAttribute("aria-label", `Details for ${item.title}`);
    const label = a.grouped && item.status === "waiting on you" ? "" : item.statusLabel;
    stage.textContent = [label, item.stage].filter(Boolean).join(" · ");
    stage.classList.toggle("text-amber-700", item.status === "waiting on you");
    stage.classList.toggle("text-neutral-500", item.status !== "waiting on you");
    stage.classList.toggle("hidden", !stage.textContent);
    metadata.textContent = item.metadata.join(" · ");
    metadata.classList.toggle("hidden", !metadata.textContent);
    dot.style.background = item.key.startsWith("item:") ? topicColour(item.problem) : "var(--color-neutral-400)";
    dot.classList.toggle("animate-pulse", item.status === "running");
    dot.title = item.status;
    main.setAttribute("aria-label", `${item.title} · ${item.status}`);
    const direct = item.designSessionId ?? item.waitsIn ?? (item.direct ? item.runs.find((r) => r.targetSessionId)?.targetSessionId : null);
    if (direct && direct === a.currentId) main.setAttribute("aria-current", "page");
    else main.removeAttribute("aria-current");
    main.onclick = () => a.openItem(item);
    const keys = new Set<string>();
    item.details.forEach((d, index) => {
      const key = d.runId ? `run:${d.runId}` : `text:${index}`;
      keys.add(key);
      let entry = entries.get(key);
      if (!entry) {
        entry = h("div", "py-1", h("div", ""), h("button", "open-item-link text-indigo-600 hover:underline"));
        entries.set(key, entry);
      }
      entry.children[0]!.textContent = d.text;
      const link = entry.children[1] as HTMLButtonElement;
      link.type = "button";
      link.dataset.control = key;
      link.classList.toggle("hidden", !d.targetSessionId);
      link.textContent = d.targetSessionId ? `Session ${d.targetSessionId}` : "";
      link.title = d.targetSessionId ?? "";
      link.onclick = () => { if (d.targetSessionId) a.select(d.targetSessionId); };
      if (entry.parentElement !== detail) detail.append(entry);
    });
    for (const [key, entry] of entries) if (!keys.has(key)) { entry.remove(); entries.delete(key); }
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
