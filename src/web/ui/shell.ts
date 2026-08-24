// The shell around the workbench: how the sidebar yields space. Below md it
// becomes a drawer (the slide is CSS in style.css) with a compact top bar
// standing in for the chat header; at md and up it collapses to a slim handle
// column instead — body[data-rail="closed"], persisted, styled in style.css.

import { $ } from "./dom.js";
import { shortcut } from "./shortcut.js";

export interface ShellDeps {
  /** The current session's ⋯ menu, mirrored from the chat header. */
  sessionMenu: (anchor: HTMLElement) => void;
}

const sidebar = $("#sidebar");
const scrim = $("#drawer-scrim");
const title = $("#mobile-title");
const menuBtn = $("#mobile-menu");

/** Called from every navigation: picking a destination dismisses the drawer. */
export function closeDrawer(): void {
  delete sidebar.dataset.open;
  scrim.classList.add("hidden");
}

/** The bar names wherever we are — a session's title or the Console view. */
export function setBarTitle(text: string, hasSession: boolean): void {
  title.textContent = text;
  menuBtn.classList.toggle("hidden", !hasSession);
}

// Applied at import time, before first paint — a rail that flashes open and
// then snaps shut reads as a glitch, not a preference.
const RAIL_KEY = "pier.railClosed";
if (localStorage.getItem(RAIL_KEY) === "1") document.body.dataset.rail = "closed";

function setRail(closed: boolean): void {
  document.body.dataset.rail = closed ? "closed" : "";
  localStorage.setItem(RAIL_KEY, closed ? "1" : "0");
}

function toggleDrawer(): void {
  if (sidebar.dataset.open !== undefined) return closeDrawer();
  sidebar.dataset.open = "";
  scrim.classList.remove("hidden");
}

/** Below md the rail attribute does nothing — the sidebar is the drawer there,
 *  so one chord has to mean whichever of the two this width has. */
const isDrawer = (): boolean => window.innerWidth < 768;

/** Where an opening drag may start, and how much of the drawer's width has to
 *  be showing on release for it to stay. */
const EDGE_PX = 20;
const COMMIT = 0.35;
/** Slop before a touch is a drag rather than a tap or the start of a scroll. */
const SLOP = 8;

/**
 * The drawer follows the finger.
 *
 * Swiping in from the left edge is what a phone user tries first, and until
 * now iOS answered it: in a standalone PWA that edge is the system's back
 * gesture, so what slid in was its snapshot of the previous history entry — a
 * drawer that was open in a page we already left — and letting go sprang it
 * back. Taking the touch (preventDefault on the first one in the strip) is the
 * only way to have the gesture, and having it is the point: the 40px button in
 * the corner was the sole way in.
 */
function initSwipe(): void {
  let from = -1; // touch x where the gesture started; -1 = not ours
  let fromY = 0;
  let opening = false;
  let dragging = false;
  let width = 1;

  const paint = (shown: number): void => {
    sidebar.style.transition = "none";
    sidebar.style.transform = `translateX(${String(shown - width)}px)`;
    scrim.classList.remove("hidden");
    scrim.style.opacity = String(shown / width);
  };

  /** Hand the drawer back to CSS: the transition and the two states there are
   *  what every other way of opening it uses. */
  const settle = (open: boolean): void => {
    sidebar.style.transition = "";
    sidebar.style.transform = "";
    scrim.style.opacity = "";
    if (open) {
      sidebar.dataset.open = "";
      scrim.classList.remove("hidden");
    } else closeDrawer();
    from = -1;
    dragging = false;
  };

  window.addEventListener("touchstart", (e) => {
    // A second finger mid-drag must not disown the first: dropping the gesture
    // here would leave the drawer parked half-open, with nothing to settle it.
    if (dragging) return;
    from = -1;
    if (!isDrawer() || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const open = sidebar.dataset.open !== undefined;
    width = sidebar.offsetWidth || 1;
    if (open) {
      // Closing starts anywhere on the drawer; the touch stays the page's until
      // a move proves it horizontal, so rows still tap and lists still scroll.
      if (t.clientX > width) return;
    } else {
      if (t.clientX > EDGE_PX) return;
      // Only opening fights the system gesture, and swallowing the touch is the
      // only way to win — at the price of a 20px ribbon that starts no scroll,
      // and of controls in it, whose click a swallowed touchstart never becomes.
      if ((e.target as Element | null)?.closest("button, a, input, textarea, select")) return;
      e.preventDefault();
    }
    from = t.clientX;
    fromY = t.clientY;
    opening = !open;
  }, { passive: false });

  window.addEventListener("touchmove", (e) => {
    if (from < 0) return;
    const t = e.touches[0]!;
    const dx = t.clientX - from;
    if (!dragging) {
      // Vertical wins ties: a list under an open drawer must still scroll.
      if (Math.abs(t.clientY - fromY) > Math.abs(dx)) return void (from = -1);
      if (Math.abs(dx) < SLOP) return;
      dragging = true;
    }
    e.preventDefault(); // the drawer is on the finger now, nothing else moves
    paint(Math.max(0, Math.min(width, opening ? dx : width + dx)));
  }, { passive: false });

  const release = (): void => {
    if (from < 0) return;
    if (!dragging) return void (from = -1); // a tap in the strip painted nothing
    // What is on screen, which is what the finger left behind.
    const shown = sidebar.getBoundingClientRect().right;
    settle(opening ? shown > width * COMMIT : shown > width * (1 - COMMIT));
  };
  window.addEventListener("touchend", release);
  window.addEventListener("touchcancel", release);
}

export function initShell(deps: ShellDeps): void {
  initSwipe();
  $("#drawer-toggle").onclick = toggleDrawer;
  scrim.onclick = closeDrawer;
  menuBtn.onclick = () => deps.sessionMenu(menuBtn);
  const rail = $("#rail-toggle");
  rail.onclick = () => setRail(document.body.dataset.rail !== "closed");
  // ⌘ only: Ctrl+B is the backward motion a composer needs to keep.
  shortcut(rail, "meta+b", "Toggle sidebar", () =>
    isDrawer() ? toggleDrawer() : setRail(document.body.dataset.rail !== "closed"));
}
