// The DOM helpers every UI module shares. Nothing else belongs here.

export const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

export function h(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
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
