// Anchored popover: one open at a time, closed by outside pointerdown, Esc,
// scroll or resize. Used by the session context menu and the model picker.

import { h } from "./dom.js";

export interface MenuItem {
  label: string;
  hint?: string; // right-aligned secondary text
  checked?: boolean;
  onSelect: () => void;
}

let panel: HTMLElement | null = null;

function onOutside(ev: Event): void {
  if (panel && !panel.contains(ev.target as Node)) closeMenu();
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  // The topmost overlay consumes Escape: a panel anchored inside a modal
  // <dialog> must not dismiss the dialog underneath it on the way out.
  ev.preventDefault();
  ev.stopPropagation();
  closeMenu();
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

/** Where the last panel was placed, and what it was placed against.
 *
 *  A follow-up panel — Session info, the model picker — is opened from inside
 *  the menu it replaces, and by then the pointer is on the menu rather than on
 *  the row that owns the anchor. In the Projects rail the ⋯ is revealed on
 *  hover, so it is `display: none` again and measures 0×0; the same is true of
 *  a row the list re-rendered under the open menu. Anchoring to a box like that
 *  put the panel in the top-left corner of the window, which is how this was
 *  found. The panel it replaces belongs in the same place, so that is the
 *  fallback. */
let placed: { anchor: HTMLElement; top: number; left: number } | null = null;

/** Under the anchor, or where the panel this one replaces already sat when the
 *  anchor is no longer laid out. */
function anchorBox(anchor: HTMLElement): { top: number; left: number } {
  const r = anchor.getBoundingClientRect();
  const under = { top: r.bottom + 4, left: r.left };
  if (r.width || r.height) return under;
  return placed?.anchor === anchor ? { top: placed.top, left: placed.left } : under;
}

/** A narrow screen has no room beside the anchor and thumbs reach the bottom,
 *  so the panel becomes a sheet there — anchoring below is a desktop idea, and
 *  a sheet's rows are sized for a fingertip rather than a cursor. */
const isSheet = (): boolean => window.innerWidth < 640;

/** Float arbitrary content under an anchor, clamped to the viewport. */
export function openPanel(anchor: HTMLElement, content: HTMLElement): void {
  closeMenu();
  const sheet = isSheet();
  panel = h(
    "div",
    `fixed z-50 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg ${
      sheet
        ? "inset-x-2 bottom-2 max-h-[70dvh] overflow-y-auto pb-[calc(0.25rem+env(safe-area-inset-bottom))] text-[16px]"
        : "min-w-52 max-w-[min(42rem,calc(100vw-1rem))] text-[13px]"
    }`,
  );
  panel.append(content);
  // A modal <dialog> paints in the top layer, above anything in the document —
  // so a panel anchored inside one has to live in that dialog, not on body,
  // or no z-index can bring it in front (the folder picker in New session).
  (anchor.closest("dialog[open]") ?? document.body).append(panel);
  if (!sheet) {
    // Remembered before the clamp: it is where the panel was *meant* to go, and
    // the next panel is a different size with a clamp of its own.
    const box = anchorBox(anchor);
    placed = { anchor, ...box };
    panel.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - panel.offsetHeight - 8))}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  }
  // Safe to bind now: the pointerdown that opened this already fired.
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeMenu);
}

function menuItem(item: MenuItem): HTMLElement {
  const row = h(
    "button",
    `flex w-full cursor-pointer items-center gap-2 px-3 text-left hover:bg-neutral-100 active:bg-neutral-100 ${
      isSheet() ? "py-3" : "py-1.5"
    }`,
    h("span", "flex-none w-3 text-indigo-600", item.checked ? "\u2713" : ""),
    h("span", "truncate", item.label),
  );
  if (item.hint) row.append(h("span", "ml-auto flex-none text-[11.5px] text-neutral-400", item.hint));
  row.onclick = () => item.onSelect();
  return row;
}

/** A list of actions; call from a click handler with the trigger element. */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  openPanel(anchor, h("div", "", ...items.map(menuItem)));
}
