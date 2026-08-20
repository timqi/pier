// Anchored popover: one open at a time, closed by outside pointerdown, Esc,
// scroll or resize. Used by the session context menu and the model picker.

import { h } from "./dom.js";

export interface MenuItem {
  label: string;
  hint?: string; // right-aligned secondary text
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

let panel: HTMLElement | null = null;

function onOutside(ev: Event): void {
  if (panel && !panel.contains(ev.target as Node)) closeMenu();
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") closeMenu();
}

/** Page scroll moves the anchor away; scrolling inside the panel must not. */
function onScroll(ev: Event): void {
  if (panel && !panel.contains(ev.target as Node)) closeMenu();
}

export function closeMenu(): void {
  if (!panel) return;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", closeMenu);
  panel.remove();
  panel = null;
}

/** Float arbitrary content under an anchor, clamped to the viewport. */
export function openPanel(anchor: HTMLElement, content: HTMLElement): void {
  closeMenu();
  panel = h(
    "div",
    "fixed z-50 min-w-52 max-w-80 rounded-lg border border-neutral-200 bg-white py-1 text-[13px] shadow-lg",
  );
  panel.append(content);
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - panel.offsetHeight - 8))}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  // Safe to bind now: the pointerdown that opened this already fired.
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeMenu);
}

export function menuItem(item: MenuItem): HTMLElement {
  const row = h(
    "button",
    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100",
  );
  row.append(
    h("span", "flex-none w-3 text-indigo-600", item.checked ? "\u2713" : ""),
    h("span", "truncate", item.label),
  );
  if (item.hint) row.append(h("span", "ml-auto flex-none text-[11.5px] text-neutral-400", item.hint));
  row.onclick = () => item.onSelect();
  return row;
}

/** Section title + items; call from a click handler with the trigger element. */
export function openMenu(anchor: HTMLElement, sections: MenuSection[]): void {
  const content = h("div", "");
  for (const section of sections) {
    if (section.title) {
      content.append(
        h(
          "div",
          "px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400",
          section.title,
        ),
      );
    }
    content.append(...section.items.map(menuItem));
  }
  openPanel(anchor, content);
}
