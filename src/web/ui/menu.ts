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
  const closing = panel;
  panel = null;
  closing.inert = true;
  closing.dataset.closing = "";
  // Pending transitions include an interrupted entrance. Cancellation still
  // removes only this panel, never a replacement opened while it fades out.
  void Promise.allSettled(closing.getAnimations().map((animation) => animation.finished))
    .then(() => closing.remove());
}

/** Where the last panel was placed, and what it was placed against.
 *
 *  A follow-up panel — Session info, the model picker — is opened from inside
 *  the menu it replaces, and by then the pointer is on the menu rather than on
 *  the row that owns the anchor. In the session rail the ⋯ is revealed on
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
  // Replacing a menu is one surface changing content, not stacked exits.
  document.querySelectorAll(".glass-menu[data-closing]").forEach((el) => el.remove());
  const sheet = isSheet();
  panel = h(
    "div",
    `glass glass-menu fixed z-50 rounded-3xl border border-neutral-200 p-2 ${
      sheet
        ? "inset-x-2 bottom-2 max-h-[70dvh] overflow-y-auto pb-[calc(0.25rem+env(safe-area-inset-bottom))] text-[16px]"
        : "min-w-52 max-w-[min(42rem,calc(100vw-1rem))] text-[13px]"
    }`,
  );
  panel.dataset.presentation = sheet ? "sheet" : "popover";
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
    `flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 text-left transition-colors hover:bg-indigo-50 hover:text-indigo-700 active:bg-indigo-100 ${
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
