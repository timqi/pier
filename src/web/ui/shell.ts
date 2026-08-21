// Mobile shell. Below the md breakpoint the sidebar becomes a drawer (the
// slide itself is CSS in style.css) and a compact top bar stands in for the
// chat header, which hides there — so a Console view and a chat share one way
// back to the drawer, and the ⋯ session menu stays one tap away. Desktop runs
// none of this: the bar is md:hidden and the drawer CSS is media-queried.

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

export function initShell(deps: ShellDeps): void {
  $("#drawer-toggle").onclick = () => {
    if (sidebar.dataset.open !== undefined) return closeDrawer();
    sidebar.dataset.open = "";
    scrim.classList.remove("hidden");
  };
  scrim.onclick = closeDrawer;
  menuBtn.onclick = () => deps.sessionMenu(menuBtn);
}
