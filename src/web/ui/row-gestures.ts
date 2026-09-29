// A finger on a chat row: swipe right to reply, hold for the row's actions.
// The gutter toolbar (chat.ts rowTools) stays the one list of what a row
// offers — the swipe presses its Reply, the menu lists its buttons — so who
// may edit is decided in one place.

import { Reply } from "lucide";
import { splitReply } from "../../core/reply.js";
import { copy, h, HOLD_MS, HOLD_SLOP } from "./dom.js";
import { icon } from "./icons.js";
import { closeMenu, openMenu, type MenuItem } from "./menu.js";

/** Past this a release replies; the row follows the finger a little further. */
const SWIPE_AT = 56;
const SWIPE_MAX = 80;
/** Safari's back swipe starts at the screen's left edge; a press there is its. */
const EDGE = 24;
const FLASH_MS = 700;

/** Wires the row to its toolbar `tools` and hands the toolbar back. */
export function rowGestures(row: HTMLElement, tools: HTMLElement, node: HTMLElement): HTMLElement {
  let from: { x: number; y: number } | null = null;
  let phase: "idle" | "press" | "swipe" | "held" | "scroll" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hint: HTMLElement | null = null;
  let armed = false;
  const replyButton = (): HTMLButtonElement | null => {
    const b = tools.querySelector<HTMLButtonElement>("[data-action='Reply']");
    return b && !b.hidden ? b : null;
  };
  const reset = (): void => {
    clearTimeout(timer);
    from = null;
    hint?.remove();
    hint = null;
    armed = false;
    delete row.dataset.swiping;
    row.style.transform = "";
  };
  const hold = (): void => {
    phase = "held";
    clearTimeout(timer);
    eatNextClick();
    navigator.vibrate?.(10);
    openMenu(row, menuItems(row, tools, node));
  };
  row.addEventListener("pointerdown", (ev) => {
    // Any new press ends the last gesture — a second finger's included, so a
    // pinch is not a swipe — and a later mouse's bare contextmenu is not a hold's.
    reset();
    phase = "idle";
    // An editing row keeps its textarea's touch, a selecting one the platform's handles.
    if (ev.pointerType !== "touch" || !ev.isPrimary || "editing" in row.dataset || "selecting" in row.dataset) return;
    const target = ev.target as Element;
    if (target.closest("textarea, input") || ev.clientX < EDGE) return;
    from = { x: ev.clientX, y: ev.clientY };
    phase = "press";
    // A code span's own hold copies it (dom.ts holdToCopy); two menus on one press is none.
    if (!target.closest("[data-hold]")) timer = setTimeout(hold, HOLD_MS);
  });
  row.addEventListener("pointermove", (ev) => {
    if (!from || phase === "held" || phase === "scroll") return;
    const dx = ev.clientX - from.x;
    const dy = ev.clientY - from.y;
    if (phase === "press") {
      if (Math.hypot(dx, dy) <= HOLD_SLOP) return;
      clearTimeout(timer);
      if (dx <= 0 || Math.abs(dx) < 2 * Math.abs(dy) || !replyButton()) {
        phase = "scroll";
        return;
      }
      phase = "swipe";
      row.dataset.swiping = "";
      hint = h("div", "swipe-hint", icon(Reply, "h-4 w-4"));
      hint.setAttribute("aria-hidden", "true");
      row.append(hint);
    }
    // Past the threshold the row slows, so the release point is felt, not read.
    const x = dx < SWIPE_AT ? Math.max(0, dx) : Math.min(SWIPE_MAX, SWIPE_AT + (dx - SWIPE_AT) / 3);
    row.style.transform = `translateX(${x}px)`;
    hint!.style.setProperty("--swipe", String(Math.min(1, x / SWIPE_AT)));
    if (x >= SWIPE_AT !== armed) {
      armed = !armed;
      if (armed) navigator.vibrate?.(10);
      hint!.toggleAttribute("data-armed", armed);
    }
  });
  row.addEventListener("pointerup", () => {
    if (phase === "swipe" && armed) replyButton()?.click();
    reset();
  });
  row.addEventListener("pointercancel", reset);
  // Android reads a held finger as a context menu of its own, sometimes after
  // cancelling the pointer; either way the row's menu is the one it gets. A
  // browser that leaves pointerType unset is read by the touch press in flight.
  row.addEventListener("contextmenu", (ev) => {
    const type = (ev as PointerEvent).pointerType;
    const touch = type === "touch" || (!type && (from !== null || phase === "held"));
    if (!touch || "editing" in row.dataset || "selecting" in row.dataset) return;
    ev.preventDefault();
    if (phase === "press" && !(ev.target as Element).closest("[data-hold]")) hold();
  });
  return tools;
}

/** A hold is the whole gesture, yet its release still clicks whatever is under
 *  the finger by then — the sheet's backdrop, which would close the menu it
 *  just opened — so that one click is eaten wherever it lands. A hold with no
 *  release left (Android's contextmenu after a cancel) must not eat the next
 *  tap's: any new press ends it. */
function eatNextClick(): void {
  const capture = { capture: true }; // Node's EventTarget, the tests' document, misreads a bare `true` on removal
  const eat = (ev: Event): void => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    done();
  };
  const done = (): void => {
    document.removeEventListener("click", eat, capture);
    document.removeEventListener("pointerup", released, capture);
    document.removeEventListener("pointercancel", released, capture);
    document.removeEventListener("pointerdown", done, capture);
  };
  const released = (): void => void setTimeout(done, 400);
  document.addEventListener("click", eat, capture);
  document.addEventListener("pointerup", released, capture);
  document.addEventListener("pointercancel", released, capture);
  document.addEventListener("pointerdown", done, capture);
}

/** The toolbar's buttons by their short name, plus the two a hover never
 *  needed: Copy, and Select text — a touch row is unselectable (style.css) so
 *  its own long-press is free for this menu. */
function menuItems(row: HTMLElement, tools: HTMLElement, node: HTMLElement): MenuItem[] {
  const press = (b: HTMLButtonElement): MenuItem => ({
    label: b.dataset.action ?? "",
    onSelect: () => {
      closeMenu();
      b.click();
    },
  });
  const buttons = [...tools.querySelectorAll<HTMLButtonElement>("[data-action]")].filter((b) => !b.hidden);
  const reply = buttons.filter((b) => b.dataset.action === "Reply");
  const rest = buttons.filter((b) => b.dataset.action !== "Reply");
  return [
    ...reply.map(press),
    {
      label: "Copy",
      onSelect: () => {
        closeMenu();
        void copy(copyText(row, node)).then(() => flash(row, "ok"), () => flash(row, "failed"));
      },
    },
    ...rest.map(press),
    {
      label: "Select text",
      onSelect: () => {
        closeMenu();
        selectText(row, node);
      },
    },
  ];
}

/** A reply's words as written, markers and next steps off; a user row's as shown. */
const copyText = (row: HTMLElement, node: HTMLElement): string =>
  row.dataset.kind === "assistant" && node.dataset.raw !== undefined ? splitReply(node.dataset.raw).text : node.textContent ?? "";

/** The outcome on the row itself: the menu that was asked is already gone. */
const flashes = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function flash(row: HTMLElement, outcome: "ok" | "failed"): void {
  row.dataset.copied = outcome;
  // A second copy restarts the flash instead of inheriting the first one's fade.
  clearTimeout(flashes.get(row));
  flashes.set(row, setTimeout(() => delete row.dataset.copied, FLASH_MS));
}

/** Selectable until the selection is gone, then back to a row the finger holds. */
function selectText(row: HTMLElement, node: HTMLElement): void {
  row.dataset.selecting = "";
  getSelection()?.selectAllChildren(node);
  const done = (): void => {
    if (getSelection()?.toString()) return;
    delete row.dataset.selecting;
    document.removeEventListener("selectionchange", done);
  };
  document.addEventListener("selectionchange", done);
}
