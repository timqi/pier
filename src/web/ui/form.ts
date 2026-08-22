// The Console's form vocabulary: one card, one field, one of each control.
//
// Channels and Tasks each grew their own set — two `field`s with different
// chrome, two input styles — so the two tabs did not look like the same
// product. Lark makes it three surfaces, which is where a shared layer stops
// being speculative, so this absorbs both rather than sitting beside them.
//
// Every control here is uncontrolled and callback-driven: the caller owns the
// state and calls its own render. Nothing in this file knows what a channel or
// a task is.

import { h, prose } from "./dom.js";

const LABEL = "text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400";

/**
 * A button wearing the house chrome. `.btn`/`.btn-primary` are the only custom
 * classes style.css declares, which makes them the Console's button, so this is
 * what a button should be unless it is not button-shaped.
 */
export const button = (label: string, primary = false): HTMLButtonElement =>
  btn(label, `${primary ? "btn btn-primary" : "btn"} text-[12.5px]`);

/**
 * A `<button>` with classes of your own — for the things that are clickable but
 * not buttons: tabs, menu rows, inline links, the help badge. Reach for
 * `button()` first; bespoke chrome is how the Console drifted apart before.
 */
export const btn = (label: string, cls = ""): HTMLButtonElement => {
  const el = h("button", cls, label) as HTMLButtonElement;
  el.type = "button";
  return el;
};

/** A tab in a Console tab strip: house button chrome plus the active tint. */
export function tabButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const el = button(label);
  if (active) el.classList.add("bg-neutral-200");
  el.onclick = onClick;
  return el;
}

/** A titled panel. The subtitle carries the "why", so fields need fewer words. */
// No overflow-hidden: help bubbles escape their card, so the header rounds its
// own top corners instead of being clipped into shape by the section.
export function card(title: string, subtitle: string, ...body: HTMLElement[]): HTMLElement {
  const el = h("section", "rounded-xl border border-neutral-200 bg-white");
  const head = h("div", "rounded-t-xl border-b border-neutral-200/70 bg-neutral-50/70 px-4 py-2.5");
  head.append(h("h2", "text-[13px] font-semibold text-neutral-700", title));
  if (subtitle) head.append(h("p", "mt-0.5 text-[11.5px] leading-snug text-neutral-500", subtitle));
  el.append(head, h("div", "flex flex-col gap-4 px-4 py-3.5", ...body));
  return el;
}

export interface FieldOptions {
  /** One line under the control, for the thing the label cannot say. */
  hint?: string;
  /** A `helpBadge()`, shown beside the label. */
  help?: HTMLElement;
}

/**
 * A labelled control. One chrome for the whole Console: Tasks used to render a
 * plain `<label>` and Channels a micro-caps header, which is most of why the
 * two tabs read as different apps.
 */
export function field(label: string, control: HTMLElement, opts: FieldOptions = {}): HTMLElement {
  const box = h("div", "flex flex-col gap-1.5");
  const head = h("div", "flex items-center gap-1.5", h("span", LABEL, label));
  if (opts.help) head.append(opts.help);
  box.append(head, control);
  if (opts.hint) box.append(h("span", "text-[11.5px] leading-snug text-neutral-400", opts.hint));
  return box;
}

/** The one control skin. Exported so a control that is not an `<input>` — a
 * dropdown trigger, say — stays in step instead of copying the string. */
export const CONTROL =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[12.5px] transition-colors placeholder:text-neutral-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none";

export const textInput = (
  value: string,
  placeholder: string,
  onInput: (v: string) => void,
  mono = false,
): HTMLInputElement => {
  const el = document.createElement("input");
  el.className = mono ? `${CONTROL} font-mono` : CONTROL;
  el.value = value;
  el.placeholder = placeholder;
  el.oninput = () => onInput(el.value);
  return el;
};

/** A bare input for a caller that reads values on submit rather than on change. */
export const input = (value = "", type = "text"): HTMLInputElement => {
  const el = document.createElement("input");
  el.type = type;
  el.className = CONTROL;
  el.value = value;
  return el;
};

export const select = (options: [string, string][], value: string): HTMLSelectElement => {
  const el = document.createElement("select");
  el.className = CONTROL;
  el.append(...options.map(([label, key]) => new Option(label, key)));
  el.value = value;
  return el;
};

export const textarea = (value = "", rows = 4): HTMLTextAreaElement => {
  const el = document.createElement("textarea");
  el.className = `${CONTROL} resize-y font-mono`;
  el.value = value;
  el.rows = rows;
  el.spellcheck = false;
  return el;
};

/** iOS-style switch: a checkbox is too small a target for a security toggle. */
export function toggle(
  label: string,
  hint: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  help?: HTMLElement,
): HTMLElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "peer sr-only";
  box.checked = checked;
  box.onchange = () => onChange(box.checked);
  const track = h(
    "span",
    "relative h-4 w-7 flex-none rounded-full bg-neutral-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-indigo-600 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-200",
  );
  const row = h("label", `flex cursor-pointer gap-2.5 ${label ? "items-start" : "items-center"}`);
  row.append(box, track);
  if (label) {
    const head = h("span", "flex items-center gap-1.5", h("span", "text-[13px] text-neutral-700", label));
    if (help) head.append(help);
    const text = h("span", "flex min-w-0 flex-col", head);
    if (hint) text.append(h("span", "text-[11.5px] leading-snug text-neutral-400", hint));
    row.append(text);
  }
  return row;
}

export const badge = (text: string, cls: string): HTMLElement =>
  h("span", `flex-none rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ring-1 ${cls}`, text);

export const empty = (text: string): HTMLElement =>
  h(
    "p",
    "rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-center text-[12.5px] text-neutral-400",
    text,
  );

/**
 * Help bubble that survives the trip to it: the badge and the bubble are one
 * hover group, and the gap between them is the bubble's own transparent
 * padding, so crossing it never leaves the group. Clicking pins it open —
 * a five-step walkthrough is not something to read against a timer.
 *
 * Steps are markdown; a step that carries a control passes a node instead.
 */
export function helpBadge(
  title: string,
  steps: (string | HTMLElement)[],
  /** Which edge to pin to — "right" for badges living in a narrow column. */
  align: "left" | "right" = "left",
): HTMLElement {
  const wrap = h("span", "group relative inline-flex");
  const badgeEl = btn(
    "?",
    "flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[9px] font-bold text-neutral-400 transition-colors group-hover:border-indigo-400 group-hover:text-indigo-500",
  );
  // pt-1.5 is the bridge; the visible card is the inner element. The width is
  // capped against the viewport so a narrow window cannot push it off-screen.
  const bubble = h(
    "span",
    `absolute ${
      align === "right" ? "right-0" : "left-0"
    } top-full z-20 hidden w-[min(27rem,calc(100vw-3rem))] pt-1.5 group-hover:block`,
  );
  const panel = h(
    "span",
    "flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3.5 text-[12px] font-normal normal-case leading-[1.55] tracking-normal text-neutral-600 shadow-xl",
  );
  panel.append(h("span", "text-[12.5px] font-semibold text-neutral-800", title));
  const list = h("ol", "flex list-decimal flex-col gap-1.5 pl-4");
  for (const step of steps) {
    const li = h("li", "marker:text-neutral-400");
    li.append(typeof step === "string" ? prose(step) : step);
    list.append(li);
  }
  panel.append(list);
  bubble.append(panel);
  badgeEl.onclick = () => {
    // Pinning keeps it up once the pointer leaves. Swapping the two display
    // classes is enough — group-hover:block still wins over hidden while
    // hovering, so unpinning falls straight back to hover behaviour.
    const pinned = bubble.classList.contains("hidden");
    bubble.classList.toggle("hidden", !pinned);
    bubble.classList.toggle("block", pinned);
    badgeEl.classList.toggle("border-indigo-400", pinned);
    badgeEl.classList.toggle("text-indigo-500", pinned);
  };
  wrap.append(badgeEl, bubble);
  return wrap;
}

/** A walkthrough step whose prose is followed by a control. */
export const withControl = (markdown: string, control: HTMLElement): HTMLElement =>
  h("span", "flex flex-col gap-1", prose(markdown), control);
