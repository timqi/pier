// The DOM helpers every UI module shares. Nothing else belongs here.

import DOMPurify from "dompurify";
import { marked } from "marked";

export const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

/** Compact age of a timestamp ("now", "12m", "3h", "2d"). Shared so the
 *  sidebar and the Console views age things the same way. */
export function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

export function h(tag: string, cls: string, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

/** Last path segment — how every surface names a cwd or a file. */
export const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** "42s" under a minute, "3m 12s" over — run durations everywhere. */
export function fmtDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What main.ts's view switcher needs from every Console view. */
export interface ConsoleView {
  show(arg?: string): void;
  hide(): void;
  visible: boolean;
}

/** The show/hide plumbing every Console view repeated verbatim: flip the
 *  root's classes, track visibility, load on show, optionally flush on hide. */
export function consoleView(
  root: HTMLElement,
  load: (arg?: string) => void,
  onHide?: () => void,
): ConsoleView {
  return {
    visible: false,
    show(arg) {
      this.visible = true;
      root.classList.remove("hidden");
      root.classList.add("flex");
      load(arg);
    },
    hide() {
      onHide?.();
      this.visible = false;
      root.classList.add("hidden");
      root.classList.remove("flex");
    },
  };
}

/**
 * A line of prose with inline markup — `code`, **bold**, [links](url).
 *
 * Setup walkthroughs are *content*, and building them out of `h()` calls and
 * `append()` costs roughly five lines per sentence while making the wording
 * hard to read in the source. `marked` and DOMPurify are already in the bundle
 * for the chat transcript, so prose can just be prose.
 */
export function prose(markdown: string): HTMLElement {
  const el = h("span", "help");
  el.innerHTML = DOMPurify.sanitize(marked.parseInline(markdown, { async: false }));
  externalLinks(el);
  return el;
}

/** Every link in rendered markdown leaves in a new tab. The page is a live
 *  session — an in-tab navigation drops the composer draft and the event
 *  stream — so a link the agent wrote is never allowed to take the tab. In-app
 *  hash routes are the exception: those *are* this page. */
export function externalLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll("a")) {
    if ((a.getAttribute("href") ?? "").startsWith("#")) continue;
    a.target = "_blank";
    a.rel = "noreferrer";
  }
}

/** navigator.clipboard is secure-context only and the dev target binds 0.0.0.0,
 *  so a LAN-IP visit falls back to the legacy selection trick. */
async function copy(text: string): Promise<void> {
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

/** Chevron + summary skeleton shared by activity groups and project nodes. */
export function detailsRow(cls: string, summaryChildren: HTMLElement[]): { el: HTMLDetailsElement; summary: HTMLElement } {
  const el = document.createElement("details");
  el.className = cls;
  const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
  summary.append(h("span", "chev", "▶"), ...summaryChildren);
  el.append(summary);
  return { el, summary };
}
