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
const SHIFT = APPLE ? "⇧" : "Shift+";

// A key spec is `"k"`, `"shift+o"` or `"meta+b"`: Shift is opt-in per binding,
// because every unshifted letter worth having is either taken or the browser's.
// `meta+` narrows the modifier to ⌘ alone — Ctrl+B is the backward motion every
// text field on a Unix desktop has, and a chord may not take that away.
// `ctrl+` narrows to ⌃ alone — for the terminal toggle, whose ⌘ spelling is
// macOS's own window cycling.
const parse = (spec: string): { key: string; shift: boolean; meta: boolean; ctrl: boolean } => {
  const meta = spec.startsWith("meta+");
  const ctrl = spec.startsWith("ctrl+");
  const rest = meta || ctrl ? spec.slice(5) : spec;
  return rest.startsWith("shift+")
    ? { key: rest.slice(6), shift: true, meta, ctrl }
    : { key: rest, shift: false, meta, ctrl };
};

/** The chord as a person reads it — for the hover card, or for a menu row
 *  that is itself the affordance (menu.ts's `hint`). */
export function chordLabel(spec: string): string {
  const { key, shift, meta, ctrl } = parse(spec);
  const mod = meta ? "⌘" : ctrl ? (APPLE ? "⌃" : "Ctrl+") : MOD;
  return `${mod}${shift ? SHIFT : ""}${key.toUpperCase()}`;
}

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
  pierce = false,
): void {
  hint(el, label, chordLabel(key));
  chord(key, run, unless, pierce);
}

/**
 * Esc, for the one action urgent enough to want no modifier: stopping a
 * running turn.
 *
 * Not a chord, and deliberately not capture phase — Esc already means "close
 * the topmost thing", and every overlay here consumes it on the way down
 * (menu.ts, a modal <dialog>). Bubbling last is what makes this the meaning
 * Esc has when nothing is layered above. `when` is the rest of that claim:
 * the action has to be live, or the key stays the browser's.
 */
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
    if (document.querySelector("dialog[open]") || !when()) return;
    ev.preventDefault();
    run();
  });
}

// A letter typed into one of these is text, never a command.
const TYPING = "input, textarea, select, [contenteditable]";

/**
 * A bare letter, for a view that owns the keyboard while it is open — stepping
 * through a diff's changes in the Files view.
 *
 * No modifier is available here: ⌘N/⌘P are the browser's new window and print,
 * and ↑/↓ are the scrolling the reader still needs. `when` is the entire claim
 * to an unmodified key — the view has to be on screen with something to step
 * through — and a focused text field or an open dialog keeps the letter
 * regardless. `keys` may carry aliases (`["n", "j"]`); the first is the one the
 * hover card teaches.
 *
 * Never unbound, so call it once per action from an init path.
 */
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
    if (!keys.includes(ev.key.toLowerCase())) return;
    if ((ev.target as Element | null)?.closest?.(TYPING)) return;
    if (document.querySelector("dialog[open]") || !when()) return;
    ev.preventDefault();
    run();
  });
}

/**
 * The binding without the hover card — for an action whose affordance is a
 * menu row carrying `chordLabel(key)`, where a card on the ⋯ button that
 * opens it would name the wrong control (and a second chord on that button
 * would stack a second card on top of the first).
 *
 * Never unbound, so call it once per action from an init path.
 */
export function chord(spec: string, run: () => void, unless?: () => boolean, pierce = false): void {
  const { key, shift, meta, ctrl } = parse(spec);
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key.toLowerCase() !== key || ev.altKey || ev.shiftKey !== shift) return;
      if (meta ? !ev.metaKey : ctrl ? !ev.ctrlKey || ev.metaKey : !ev.metaKey && !ev.ctrlKey) return;
      // A surface that owns the keyboard keeps Ctrl chords (Ctrl+K is shell
      // kill-line), while Cmd remains Pier's application modifier. `pierce`
      // is for the Ctrl+` toggle, which must close Terminal from inside.
      if (
        !pierce && !ev.metaKey &&
        (ev.target as Element | null)?.closest?.("[data-owns-keyboard]")
      ) return;
      if (unless?.()) return;
      ev.preventDefault();
      ev.stopPropagation();
      run();
    },
    true,
  );
}
