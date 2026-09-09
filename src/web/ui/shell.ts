// How the sidebar yields space, and what stands in for it while it is gone:
// a drawer below md, a slim handle column above (body[data-rail="closed"]),
// and the attention badge carrying what the list would have shown.

import { $, h } from "./dom.js";
import { shortcut } from "./shortcut.js";

export interface ShellDeps {
  /** The current session's ⋯ menu, mirrored from the chat header. */
  sessionMenu: (anchor: HTMLElement) => void;
  /** Its info panel — the bar title opens it, as the chat header's title does. */
  sessionInfo: (anchor: HTMLElement) => void;
}

const sidebar = $("#sidebar");
const scrim = $("#drawer-scrim");
const title = $("#mobile-title");
const menuBtn = $("#mobile-menu");
const meta = $("#session-meta");

/** Called from every navigation: picking a destination dismisses the drawer. */
export function closeDrawer(): void {
  delete sidebar.dataset.open;
  scrim.classList.add("hidden");
  syncDrawer();
}

/** The bar names wherever we are — a session's title or the Console view. */
export function setBarTitle(text: string, hasSession: boolean): void {
  title.textContent = text;
  title.classList.toggle("cursor-pointer", hasSession);
  menuBtn.classList.toggle("hidden", !hasSession);
}

// Applied at import time, before first paint — a rail that flashes open and
// then snaps shut reads as a glitch, not a preference.
const RAIL_KEY = "pier.railClosed";
if (localStorage.getItem(RAIL_KEY) === "1") document.body.dataset.rail = "closed";

function setRail(closed: boolean): void {
  document.body.dataset.rail = closed ? "closed" : "";
  localStorage.setItem(RAIL_KEY, closed ? "1" : "0");
  syncDrawer();
}

function toggleDrawer(): void {
  if (sidebar.dataset.open !== undefined) return closeDrawer();
  sidebar.dataset.open = "";
  scrim.classList.remove("hidden");
  syncDrawer();
}

/** Below md the rail attribute does nothing — the sidebar is the drawer there,
 *  so one chord has to mean whichever of the two this width has. */
const drawerMedia = window.matchMedia("(width < 48rem)");
const isDrawer = (): boolean => drawerMedia.matches;

/** One element, moved between headings: session-header.ts keeps rendering
 *  into it, so the phone shows the same chips rather than a second copy. */
function hostMeta(): void {
  if (isDrawer()) $("#mobile-bar").append(meta);
  else $("#chat-menu").before(meta);
}

/** Closed drawers leave the tab order; open drawers own focus until dismissed. */
function syncDrawer(): void {
  const open = isDrawer() && sidebar.dataset.open !== undefined;
  const main = $("main");
  main.inert = open;
  sidebar.inert = isDrawer() ? !open : document.body.dataset.rail === "closed";
  $("#drawer-toggle").setAttribute("aria-expanded", String(open));
  if (open && !sidebar.contains(document.activeElement)) $("#new-session").focus();
  if (sidebar.inert && sidebar.contains(document.activeElement)) $(isDrawer() ? "#drawer-toggle" : "#rail-toggle").focus();
}

// --- attention ----------------------------------------------------------------------
// With the rail off screen a finished turn looks like nothing happening (§5b).
// Only the actionable half: a badge that pulses for every running session is
// one nobody reads.

/** The two ways back to the sidebar — one per breakpoint, so only ever one of
 *  them is on screen. Badging the door is the whole design: no new element,
 *  no new place to look. */
const doors = [$("#rail-toggle"), $("#drawer-toggle")];

/** A dot for one, the number for more: a lone "1" in a 14px circle is noise,
 *  and a bare dot for seven is a lie. Both hang off the button's top-right
 *  corner rather than inside it, where the chevron already is. */
const CORNER = "attention absolute -right-0.5 -top-0.5 rounded-full bg-amber-500";
const badge = (count: number): HTMLElement =>
  count === 1
    ? h("span", `${CORNER} h-2 w-2`)
    : h(
      "span",
      `${CORNER} flex h-3.5 min-w-3.5 items-center justify-center px-0.5 text-[9px] font-semibold text-white`,
      count > 9 ? "9+" : String(count),
    );

/** How many sessions hold a turn nobody has looked at. Called from the one
 *  place the list's own dots are painted (ui/sidebar.ts), so the two agree by
 *  construction rather than by both being maintained. */
export function setAttention(count: number): void {
  for (const door of doors) {
    door.querySelector(".attention")?.remove();
    if (count) door.append(badge(count));
  }
}

/** Where an opening drag may start, and how much of the drawer's width has to
 *  be showing on release for it to stay. */
const EDGE_PX = 20;
const COMMIT = 0.35;
/** Slop before a touch is a drag rather than a tap or the start of a scroll. */
const SLOP = 8;

/** In a standalone PWA the left edge is iOS's back gesture, which slides in a
 *  snapshot of the previous history entry; preventDefault on the first touch
 *  in the strip is the only way to have the swipe. */
function initSwipe(): void {
  let from = -1; // touch x where the gesture started; -1 = not ours
  let fromY = 0;
  let opening = false;
  let dragging = false;
  let width = 1;

  const paint = (shown: number): void => {
    sidebar.style.transition = "none";
    sidebar.style.transform = `translateX(${String(shown - width)}px)`;
    scrim.style.transition = "none";
    scrim.classList.remove("hidden");
    scrim.style.opacity = String(shown / width);
  };

  /** Hand the drawer back to CSS: the transition and the two states there are
   *  what every other way of opening it uses. */
  const settle = (open: boolean): void => {
    sidebar.style.transition = "";
    sidebar.style.transform = "";
    scrim.style.transition = "";
    scrim.style.opacity = "";
    if (open) {
      sidebar.dataset.open = "";
      scrim.classList.remove("hidden");
      syncDrawer();
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
  syncDrawer();
  hostMeta();
  drawerMedia.addEventListener("change", () => {
    closeDrawer();
    hostMeta();
  });
  $("#drawer-toggle").setAttribute("aria-controls", "sidebar");
  sidebar.addEventListener("keydown", (ev) => {
    if (!isDrawer() || sidebar.dataset.open === undefined || ev.defaultPrevented || ev.isComposing) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeDrawer();
    } else if (ev.key === "Tab") {
      const controls = [...sidebar.querySelectorAll<HTMLElement>("button, a[href], summary")]
        .filter((el) => el.getClientRects().length && !el.matches(":disabled"));
      const target = ev.shiftKey ? controls.at(-1) : controls[0];
      const edge = ev.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === edge) {
        ev.preventDefault();
        target?.focus();
      }
    }
  });
  $("#drawer-toggle").onclick = toggleDrawer;
  scrim.onclick = closeDrawer;
  menuBtn.onclick = () => deps.sessionMenu(menuBtn);
  // The handler outlives the title text, and a Console view's name opens
  // nothing — so it asks the flag setBarTitle already writes.
  title.onclick = () => {
    if (!menuBtn.classList.contains("hidden")) deps.sessionInfo(title);
  };
  const rail = $("#rail-toggle");
  rail.onclick = () => setRail(document.body.dataset.rail !== "closed");
  // ⌘ only: Ctrl+B is the backward motion a composer needs to keep.
  shortcut(rail, "meta+b", "Toggle sidebar", () =>
    isDrawer() ? toggleDrawer() : setRail(document.body.dataset.rail !== "closed"));
}
