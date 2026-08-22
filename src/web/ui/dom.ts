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

export function h(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
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
  for (const a of el.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noreferrer";
  }
  return el;
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
