// The DOM helpers every UI module shares. Nothing else belongs here.

import { ChevronRight } from "lucide";
import { icon } from "./icons.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { agoLabel as agoAt, relTime as ageAt } from "../../core/reply.js";

/** Repaint budget for anything painted from a stream — the reply text
 *  (ui/chat.ts) and the thinking row (ui/turn-activity.ts). Text arrives far
 *  faster than it can be read, so both coalesce onto this one cadence. */
export const STREAM_PAINT_MS = 80;

export const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

/** `core/reply.ts`'s compact age, as of now. */
export const relTime = (ts: number): string => ageAt(ts, Date.now());

export const agoLabel = (ts: number): string => agoAt(ts, Date.now());

export function h(tag: string, cls: string, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

/** Last path segment — how every surface names a cwd or a file. */
export const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** A session with no title has had no first message yet; every surface spells it this way. */
export const untitled = (cwd: string): string => `New session in ${basename(cwd)}`;

/** `2026-08-30 19:41:07`: written out rather than left to a locale, which
 *  decides day/month order itself. */
export function stampTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** What main.ts's view switcher needs from every Console view. */
export interface ConsoleView {
  /** `arg` is the route's path segment (a tab, a folder); `query` its `?k=v` tail. */
  show(arg?: string, query?: string): void;
  hide(): void;
  visible: boolean;
}

/** The show/hide plumbing every Console view repeated verbatim: flip the
 *  root's classes, track visibility, load on show, optionally flush on hide. */
export function consoleView(
  root: HTMLElement,
  load: (arg?: string, query?: string) => void,
  onHide?: () => void,
): ConsoleView {
  return {
    visible: false,
    show(arg, query) {
      this.visible = true;
      root.classList.remove("hidden");
      root.classList.add("flex");
      load(arg, query);
    },
    hide() {
      onHide?.();
      this.visible = false;
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
  };
}

/** `marked` and DOMPurify are already in the bundle, so prose can be prose. */
export function prose(markdown: string): HTMLElement {
  const el = h("span", "help");
  el.innerHTML = DOMPurify.sanitize(marked.parseInline(markdown, { async: false }));
  externalLinks(el);
  return el;
}

/** A block of sanitized rendered markdown — a chat reply, a file in Files. */
export function markdownBox(markdown: string): HTMLElement {
  const box = h("div", "");
  box.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
  externalLinks(box);
  return box;
}

/** An in-tab navigation drops the composer draft and the event stream, so a
 *  link the agent wrote never takes the tab. Hash routes *are* this page. */
function externalLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll("a")) {
    if ((a.getAttribute("href") ?? "").startsWith("#")) continue;
    a.target = "_blank";
    a.rel = "noreferrer";
  }
}

/** navigator.clipboard is secure-context only and the dev target binds 0.0.0.0,
 *  so a LAN-IP visit falls back to the legacy selection trick. */
export async function copy(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.className = "fixed opacity-0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("clipboard unavailable");
}

/** Copy affordance whose own label reports the outcome — no toast machinery. */
export function copyBtn(cls: string, text: () => string): HTMLElement {
  const btn = h("button", cls, "Copy");
  btn.title = "Copy to clipboard";
  let timer: ReturnType<typeof setTimeout> | undefined;
  btn.onclick = async (ev) => {
    ev.stopPropagation(); // copying isn't "activate the row this sits in"
    btn.textContent = await copy(text()).then(() => "Copied", () => "Failed");
    clearTimeout(timer);
    timer = setTimeout(() => (btn.textContent = "Copy"), 1200);
  };
  return btn;
}

/** Wrap each fenced block so a copy button can sit in its corner without
 *  scrolling away with the code, and copy the source text, not the tokens. */
export function addCodeCopy(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const wrap = h("div", "group/code relative");
    pre.replaceWith(wrap);
    wrap.append(
      pre,
      copyBtn(
        "absolute right-1.5 top-1.5 cursor-pointer rounded border border-black/[0.08] bg-white/85 px-1.5 py-0.5 text-[11px] text-neutral-500 opacity-0 transition-opacity hover:bg-white hover:text-neutral-800 focus:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100 dark:border-neutral-200",
        () => code.textContent ?? "",
      ),
    );
  }
}

/** Long enough that a press meant as the start of a drag or a selection is
 *  not read as a hold; the slop is what a finger moves while holding still. */
export const HOLD_MS = 450;
export const HOLD_SLOP = 8;
const FLASH_MS = 700;

/** The copy affordance for a span too small to carry a button: press and hold
 *  it, mouse or finger, and it copies itself and flashes the outcome in place.
 *  A press that moves is a selection and cancels; a hold swallows the click it
 *  would have been, so it must be wired *before* any click handler of its own. */
export function holdToCopy(el: HTMLElement, text: () => string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fade: ReturnType<typeof setTimeout> | undefined;
  let from = { x: 0, y: 0 };
  let held = false;
  const stop = (): void => clearTimeout(timer);
  el.dataset.hold = ""; // a row's own hold (row-gestures.ts) stands down on it
  // The outcome where the gesture happened: no toast, and no layout shift. A
  // second hold restarts the flash instead of inheriting the first one's fade.
  const flash = (tone: string): void => {
    el.classList.remove("bg-emerald-100", "bg-red-100");
    el.classList.add(tone);
    clearTimeout(fade);
    fade = setTimeout(() => el.classList.remove(tone), FLASH_MS);
  };
  el.addEventListener("pointerdown", (ev) => {
    held = false;
    from = { x: ev.clientX, y: ev.clientY };
    stop();
    timer = setTimeout(() => {
      held = true;
      void copy(text()).then(() => flash("bg-emerald-100"), () => flash("bg-red-100"));
    }, HOLD_MS);
  });
  el.addEventListener("pointermove", (ev) => {
    if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) > HOLD_SLOP) stop();
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(name, stop);
  el.addEventListener("click", (ev) => {
    if (!held) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  });
}

/** The fold chevron: one element everywhere a row opens, so a column of rows
 *  lines their chevrons up by construction. */
export const chevron = (): SVGElement => icon(ChevronRight, "chev h-3 w-3");

/** Chevron + summary skeleton shared by activity groups and project nodes. */
export function detailsRow(cls: string, summaryChildren: (HTMLElement | SVGElement)[]): { el: HTMLDetailsElement; summary: HTMLElement } {
  const el = document.createElement("details");
  el.className = cls;
  const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
  summary.append(chevron(), ...summaryChildren);
  el.append(summary);
  return { el, summary };
}
