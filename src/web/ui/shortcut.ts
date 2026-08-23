// One reason: a keyboard shortcut and the hint that teaches it are the same
// fact. A chord nobody is told about is a chord nobody presses, so registering
// one here is also what gives its button the hover card naming it — there is
// no way to add the binding and forget the affordance.
//
// The native `title` tooltip cannot show a key cap and waits a second before
// it appears, which is exactly the wrong shape for "this button has a
// shortcut" — so a control that gets a chord loses its title to this card.

import { h } from "./dom.js";

// userAgent, not the deprecated navigator.platform. Only the label depends on
// it; both modifiers are accepted below, because a Linux browser on a Mac
// keyboard is a real thing and refusing it buys nothing.
const APPLE = /Mac|iP(?:hone|ad|od)/.test(navigator.userAgent);
const MOD = APPLE ? "⌘" : "Ctrl+";

const CARD =
  "pointer-events-none fixed z-50 flex items-center gap-2 whitespace-nowrap rounded-md bg-neutral-800 px-2 py-1 text-[11.5px] text-neutral-100 shadow-lg";

/** Hover card naming a control and its chord. Follows the anchor, clamped to
 *  the viewport the way menu.ts clamps its panel. */
function hint(el: HTMLElement, label: string, chord: string): void {
  el.removeAttribute("title"); // two tooltips for one control is one too many
  let card: HTMLElement | null = null;
  const hide = (): void => {
    card?.remove();
    card = null;
  };
  el.addEventListener("pointerenter", (ev) => {
    // Touch has no hover, so a card opened by a tap is an overlay that never
    // goes away; those pointers get the aria-label and nothing else.
    if (ev.pointerType !== "mouse") return;
    hide();
    card = h("div", CARD, label, h("kbd", "rounded bg-white/15 px-1 py-px font-sans text-[10.5px]", chord));
    document.body.append(card);
    const r = el.getBoundingClientRect();
    card.style.top = `${Math.min(r.bottom + 6, window.innerHeight - card.offsetHeight - 8)}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 8))}px`;
  });
  el.addEventListener("pointerleave", hide);
  el.addEventListener("click", hide); // the card would sit over what the click opened
}

/**
 * Bind mod+`key` to `run`, and tell `el` to say so on hover.
 *
 * Capture phase, and `preventDefault` before anything else sees it: ⌘K is the
 * browser's own search bar in Firefox, and a composer with focus must not
 * swallow the chord either.
 *
 * `unless` is how a surface already on screen takes the chord back — the
 * palette walks its own list with ⌘K/⌃K once it is open, and Esc is what
 * closes it. Checked before `preventDefault`, so the claim is real.
 */
export function shortcut(
  el: HTMLElement,
  key: string,
  label: string,
  run: () => void,
  unless?: () => boolean,
): void {
  hint(el, label, `${MOD}${key.toUpperCase()}`);
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key.toLowerCase() !== key || ev.altKey || ev.shiftKey) return;
      if (!ev.metaKey && !ev.ctrlKey) return;
      if (unless?.()) return;
      ev.preventDefault();
      ev.stopPropagation();
      run();
    },
    true,
  );
}
