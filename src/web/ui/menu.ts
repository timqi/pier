// Anchored popover: one open at a time, closed by outside pointerdown, Esc,
// scroll or resize. Used by the session context menu and the model picker.

import { Check, X } from "lucide";
import { icon } from "./icons.js";
import { h } from "./dom.js";

export interface MenuItem {
  label: string;
  hint?: string; // right-aligned secondary text
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

let panel: HTMLElement | null = null;
let trigger: HTMLElement | null = null;
let backdrop: HTMLElement | null = null;

function onOutside(ev: Event): void {
  if (panel && !panel.contains(ev.target as Node) && ev.target !== backdrop) closeMenu();
}

// Arrows, readline's ⌃P/⌃N, and ⌃J/⌃K because ⌃N is a reserved chord in
// Chrome and Firefox (new window, no `preventDefault` can stop it). Bare Ctrl
// only: ⌃⇧N is the incognito window.
const ARROW_STEP: Record<string, number | undefined> = { ArrowDown: 1, ArrowUp: -1 };
const CTRL_STEP: Record<string, number | undefined> = { n: 1, j: 1, p: -1, k: -1 };

/** A global chord on a list key (⌃K) must stand down while a menu is walking
 *  on it: the chord is a capture listener and would fire first. */
export const menuOpen = (): boolean => panel !== null;

/** Which way this keypress walks a list, if it does. Shared with the palette,
 *  so the menu and the palette answer to the same keys. */
export function listStep(ev: KeyboardEvent): number | undefined {
  if (ev.altKey || ev.metaKey || ev.shiftKey || !ev.key) return undefined; // no `key`: synthetic event
  return ev.ctrlKey ? CTRL_STEP[ev.key.toLowerCase()] : ARROW_STEP[ev.key];
}

/** From outside the list the first step lands on the near end. False when
 *  there is nothing to walk, so the caller can leave the key alone. */
function walkRows(list: HTMLElement, to: number | "first" | "last"): boolean {
  const rows = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  if (!rows.length) return false;
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = to === "first" ? 0 : to === "last" ? rows.length - 1
    : index < 0 ? (to > 0 ? 0 : rows.length - 1)
    : (index + to + rows.length) % rows.length;
  rows[next]?.focus();
  return true;
}

/** A menu is all list; any other panel says which part of it is one
 *  (`data-list`). Handled here rather than by the panel's own content, because
 *  the keys have to walk from wherever the focus sits — the path line above
 *  the tree, or nothing at all. Home/End are the list's only in a menu: a
 *  panel with a text field owes them to the caret. */
function listIn(p: HTMLElement): { rows: HTMLElement; ends: boolean } | null {
  if (p.dataset.menu === "true") return { rows: p, ends: true };
  const rows = p.querySelector<HTMLElement>("[data-list]");
  return rows ? { rows, ends: false } : null;
}

function onKey(ev: KeyboardEvent): void {
  const walk = panel ? listIn(panel) : null;
  if (walk) {
    const end = walk.ends ? (ev.key === "Home" ? "first" : ev.key === "End" ? "last" : undefined) : undefined;
    const to = end ?? listStep(ev);
    if (to !== undefined && walkRows(walk.rows, to)) {
      ev.preventDefault();
      return;
    }
  }
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
  document.removeEventListener("focusin", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", closeMenu);
  const closing = panel;
  panel = null;
  backdrop?.remove();
  backdrop = null;
  if (closing.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
  trigger?.removeAttribute("aria-expanded");
  trigger = null;
  closing.inert = true;
  closing.dataset.closing = "";
  // Pending transitions include an interrupted entrance. Cancellation still
  // removes only this panel, never a replacement opened while it fades out.
  void Promise.allSettled(closing.getAnimations().map((animation) => animation.finished))
    .then(() => closing.remove());
}

/** Follow-up panels keep the prior position if a list re-render removed their anchor. */
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
    `glass-menu fixed z-50 border border-neutral-200 p-2 font-sans leading-6 ${
      sheet
        ? "rounded-3xl inset-x-2 bottom-2 max-h-[70dvh] overflow-y-auto pb-[calc(0.25rem+env(safe-area-inset-bottom))] text-[16px]"
        : "rounded-2xl min-w-60 max-w-[min(42rem,calc(100vw-1rem))] max-h-[calc(100dvh-1rem)] overflow-y-auto text-[15px]"
    }`,
  );
  panel.dataset.presentation = sheet ? "sheet" : "popover";
  panel.append(content);
  // A modal <dialog> paints in the top layer, above anything in the document —
  // so a panel anchored inside one has to live in that dialog, not on body,
  // or no z-index can bring it in front.
  const host = anchor.closest("dialog[open]") ?? document.body;
  if (sheet) {
    backdrop = h("div", "fixed inset-0 z-50 bg-black/15");
    backdrop.onclick = (ev) => {
      ev.stopPropagation();
      closeMenu();
    };
    host.append(backdrop);
  }
  host.append(panel);
  if (!sheet) {
    // Remembered before the clamp: it is where the panel was *meant* to go, and
    // the next panel is a different size with a clamp of its own.
    const box = anchorBox(anchor);
    placed = { anchor, ...box };
    panel.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - panel.offsetHeight - 8))}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  }
  trigger = anchor;
  trigger.setAttribute("aria-expanded", "true");
  panel.tabIndex = -1;
  (panel.querySelector<HTMLElement>("button, input, select, [tabindex='0']") ?? panel).focus({ preventScroll: true });
  // Safe to bind now: the pointerdown that opened this already fired.
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("focusin", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeMenu);
}

function menuItem(item: MenuItem): HTMLElement {
  const row = h(
    "button",
    `flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 text-left transition-colors hover:bg-indigo-50 hover:text-indigo-700 active:bg-indigo-100 ${
      isSheet() ? "min-h-12 py-3" : "min-h-10 py-2"
    }`,
    ...(item.checked === undefined ? [] : [icon(Check, `h-3 w-3 text-indigo-600 ${item.checked ? "" : "invisible"}`)]),
    h("span", "min-w-0 truncate", item.label),
  );
  if (item.hint) {
    const hint = h("span", "ml-auto max-w-28 shrink-[999] truncate text-[13px] text-neutral-500", item.hint);
    hint.title = item.hint;
    row.append(hint);
  }
  row.onclick = () => item.onSelect();
  return row;
}

/** A list of actions; call from a click handler with the trigger element. */
export function openMenu(anchor: HTMLElement, items: MenuItem[], title?: string): void {
  const content = h("div", "");
  if (title && isSheet()) {
    const close = h("button", "icon-btn h-11 w-11", icon(X));
    close.setAttribute("aria-label", "Close session actions");
    close.onclick = closeMenu;
    content.append(h("div", "flex items-center gap-3 border-b border-neutral-200 px-3 pb-1 mb-1",
      h("span", "min-w-0 flex-1 truncate text-sm font-medium text-neutral-500", title), close));
  }
  for (const item of items) {
    if (item.separatorBefore) content.append(h("hr", "my-2 border-neutral-200"));
    content.append(menuItem(item));
  }
  openPanel(anchor, content);
  if (panel) {
    panel.dataset.menu = "true";
    panel.setAttribute("aria-label", title ? `Actions for ${title}` : "Actions");
    panel.setAttribute("role", "group");
  }
}
