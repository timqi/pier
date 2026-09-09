// The DOM helpers every UI module shares. Nothing else belongs here.

import { ChevronRight } from "lucide";
import { icon } from "./icons.js";
import DOMPurify from "dompurify";
import { marked } from "marked";

/** Repaint budget for anything painted from a stream — the reply text
 *  (ui/chat.ts) and the thinking row (ui/turn-activity.ts). Text arrives far
 *  faster than it can be read, so both coalesce onto this one cadence. */
export const STREAM_PAINT_MS = 80;

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

/** The age as it reads *beside* a wall clock, where "now" would be a fragment. */
export const agoLabel = (ts: number): string => {
  const age = relTime(ts);
  return age === "now" ? "just now" : `${age} ago`;
};

export function h(tag: string, cls: string, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

/** Last path segment — how every surface names a cwd or a file. */
export const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** A session with no title has had no first message yet; the header and
 *  Activity must spell it the same way. */
export const untitled = (cwd: string): string => `New session in ${basename(cwd)}`;

/** `2026-08-30 19:41:07`: written out rather than left to a locale, which
 *  decides day/month order itself. */
export function stampTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "42s" under a minute, "3m 12s" over — run durations everywhere. */
export function fmtDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What main.ts's view switcher needs from every Console view. */
export interface ConsoleView {
  /** `arg` is the route's path segment (a task, a run, a folder); `query` its
   *  `?k=v` tail, for the one view (Runs) whose state is a filter set. */
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

/** An in-tab navigation drops the composer draft and the event stream, so a
 *  link the agent wrote never takes the tab. Hash routes *are* this page. */
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
export function detailsRow(cls: string, summaryChildren: (HTMLElement | SVGElement)[]): { el: HTMLDetailsElement; summary: HTMLElement } {
  const el = document.createElement("details");
  el.className = cls;
  const summary = h("summary", "flex cursor-pointer select-none items-center gap-1.5");
  summary.append(icon(ChevronRight, "chev h-3 w-3"), ...summaryChildren);
  el.append(summary);
  return { el, summary };
}
