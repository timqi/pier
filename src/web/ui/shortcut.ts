// A keyboard shortcut and the hint that teaches it are the same fact: there is
// no way to add the binding and forget the affordance. The native `title`
// cannot show a key cap and waits a second, so a control with a chord loses
// its title to this card.

import { h } from "./dom.js";

// Only the label depends on it; both modifiers are accepted, because a Linux
// browser on a Mac keyboard is a real thing.
const APPLE = /Mac|iP(?:hone|ad|od)/.test(navigator.userAgent);
const MOD = APPLE ? "⌘" : "Ctrl+";
const SHIFT = APPLE ? "⇧" : "Shift+";

// `"k"`, `"shift+o"` or `"meta+b"`. `meta+` narrows to ⌘ alone: Ctrl+B is the
// backward motion every Unix text field has.
const parse = (spec: string): { key: string; shift: boolean; meta: boolean } => {
  const meta = spec.startsWith("meta+");
  const rest = meta ? spec.slice(5) : spec;
  return rest.startsWith("shift+")
    ? { key: rest.slice(6), shift: true, meta }
    : { key: rest, shift: false, meta };
};

/** The chord as a person reads it — for the hover card, or for a menu row
 *  that is itself the affordance (menu.ts's `hint`). */
export function chordLabel(spec: string): string {
  const { key, shift, meta } = parse(spec);
  return `${meta ? "⌘" : MOD}${shift ? SHIFT : ""}${key.toUpperCase()}`;
}

/** A chord acting under a modal would leave it floating over a view it was
 *  never opened from. */
export const modalOpen = (): boolean => document.querySelector("dialog[open]") !== null;

/** What Shift turns a bracket into on a US layout — the only non-letter keys
 *  a chord here is written with. */
const SHIFTED: Record<string, string | undefined> = { "[": "{", "]": "}" };

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
    document.removeEventListener("keydown", hide, true);
  };
  el.addEventListener("pointerenter", (ev) => {
    // Touch has no hover, so a card opened by a tap is an overlay that never
    // goes away; those pointers get the aria-label and nothing else.
    if (ev.pointerType !== "mouse") return;
    hide();
    card = h("div", CARD, label, h("kbd", "rounded bg-white/15 px-1 py-px font-sans text-[10.5px]", chord));
    document.body.append(card);
    const r = el.getBoundingClientRect();
    // Above when there is no room below: clamping would drop the card onto the
    // control it names.
    const below = r.bottom + 6;
    const fits = below + card.offsetHeight + 8 <= window.innerHeight;
    card.style.top = `${fits ? below : Math.max(8, r.top - card.offsetHeight - 6)}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 8))}px`;
    // A hand that moved to the keyboard is no longer hovering, but the mouse
    // it left behind still is.
    document.addEventListener("keydown", hide, true);
  });
  el.addEventListener("pointerleave", hide);
  el.addEventListener("pointerdown", hide); // the card would sit over what the click opens
}

/** Capture phase and `preventDefault` first: ⌘K is Firefox's search bar, and a
 *  focused composer must not swallow the chord. `unless` is how an open
 *  surface takes the chord back, checked before `preventDefault`. */
export function shortcut(
  el: HTMLElement,
  key: string,
  label: string,
  run: () => void,
  unless?: () => boolean,
): void {
  hint(el, label, chordLabel(key));
  chord(key, run, unless);
}

/** Not capture phase: every overlay consumes Esc on the way down, and bubbling
 *  last makes this its meaning when nothing is layered above. `when`: the
 *  action has to be live, or the key stays the browser's. */
export function escapeKey(
  el: HTMLElement,
  label: string,
  run: () => void,
  when: () => boolean,
): void {
  hint(el, label, "Esc");
  document.addEventListener("keydown", (ev) => {
    // Esc during IME composition cancels the candidate, nothing else.
    if (ev.key !== "Escape" || ev.isComposing || ev.defaultPrevented) return;
    if (modalOpen() || !when()) return;
    ev.preventDefault();
    run();
  });
}

// A letter typed into one of these is text, never a command.
const TYPING = "input, textarea, select, [contenteditable]";

/** A bare letter: ⌘N/⌘P are the browser's and ↑/↓ are the reader's scrolling.
 *  `when` is the entire claim; a focused text field or an open dialog keeps the
 *  letter regardless. Never unbound, so call once per action from an init path. */
export function letterKey(
  el: HTMLElement,
  keys: [string, ...string[]],
  label: string,
  run: () => void,
  when: () => boolean,
): void {
  hint(el, label, keys[0].toUpperCase());
  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing || ev.defaultPrevented) return;
    // Autofill and some extensions dispatch synthetic keydowns with no `key`;
    // a global listener that dereferences it crashes on every such event.
    if (!ev.key || !keys.includes(ev.key.toLowerCase())) return;
    if ((ev.target as Element | null)?.closest?.(TYPING)) return;
    if (modalOpen() || !when()) return;
    ev.preventDefault();
    run();
  });
}

/** Without the hover card, for an action whose affordance is a menu row: a
 *  card on the ⋯ button would name the wrong control. Never unbound. */
export function chord(spec: string, run: () => void, unless?: () => boolean): void {
  const { key, shift, meta } = parse(spec);
  // A shifted bracket arrives as the character Shift makes of it (`{`), and a
  // binding written as ⇧[ should not have to know the layout's answer.
  const shifted = SHIFTED[key];
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!ev.key || ev.altKey || ev.shiftKey !== shift) return; // no `key`: synthetic event
      const pressed = ev.key.toLowerCase();
      if (pressed !== key && pressed !== shifted) return;
      if (meta ? !ev.metaKey : !ev.metaKey && !ev.ctrlKey) return;
      if (unless?.()) return;
      ev.preventDefault();
      ev.stopPropagation();
      run();
    },
    true,
  );
}
