// Lucide rendering for the workbench's decorative control icons.
import {
  ChevronDown, ChevronLeft, ChevronRight, Clock, Ellipsis, LayoutDashboard,
  ListTodo, Menu, Plus, RotateCw, Search, Send, Settings, Square,
  Undo2, X, createElement, type IconNode,
} from "lucide";

/** Labels belong to the control; SVGs never add a second accessible name. */
export const icon = (node: IconNode, cls = "h-3.5 w-3.5"): SVGElement =>
  createElement(node, { class: `flex-none ${cls}`, "aria-hidden": "true", focusable: "false" });

/** The fixed HTML shell is hydrated once; dynamic views create icons directly.
 *  Keep the slots themselves: composer and lightbox cache their IDs on import. */
export function initIcons(): void {
  const shell: Record<string, IconNode> = {
    ChevronLeft, ChevronRight, Clock, Ellipsis, LayoutDashboard, ListTodo,
    Menu, Plus, RotateCw, Search, Send, Settings, Square, Undo2, X,
  };
  for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const node = shell[slot.dataset.icon!];
    if (!node) throw new Error(`Unknown shell icon: ${slot.dataset.icon}`);
    slot.replaceChildren(icon(node, "h-full w-full"));
  }
  // Native selects and directory triggers share this CSS background image.
  const chevron = icon(ChevronDown);
  chevron.setAttribute("stroke", "#737373");
  document.documentElement.style.setProperty("--select-chevron", `url("data:image/svg+xml,${encodeURIComponent(chevron.outerHTML)}")`);
}
