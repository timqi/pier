// The shell around the workbench: how the sidebar yields space. Below md it
// becomes a drawer (the slide is CSS in style.css) with a compact top bar
// standing in for the chat header; at md and up it collapses to a slim handle
// column instead — body[data-rail="closed"], persisted, styled in style.css.

import { $ } from "./dom.js";

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

export function initShell(deps: ShellDeps): void {
  $("#drawer-toggle").onclick = () => {
    if (sidebar.dataset.open !== undefined) return closeDrawer();
    sidebar.dataset.open = "";
    scrim.classList.remove("hidden");
  };
  scrim.onclick = closeDrawer;
  menuBtn.onclick = () => deps.sessionMenu(menuBtn);
  $("#rail-toggle").onclick = () => setRail(document.body.dataset.rail !== "closed");
}
