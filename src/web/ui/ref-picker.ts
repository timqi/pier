// The one dialog that turns a git question into a diff: pick the two ends,
// get "base ↔ to" back. Two modes cover everything git can name — compare any
// two points (a point is the working tree, HEAD, a branch tip, a tag or a raw
// commit), or one commit against its parent (the `c~1 ↔ c` shortcut). Every
// row carries its commit subject, with the full message as a hover hint.
// Picks apply live; the panel closes like any other (outside click, Esc).

import { h, relTime } from "./dom.js";
import { closeMenu, openPanel } from "./menu.js";

export interface Commit {
  hash: string;
  subject: string;
  body?: string;
  author?: string;
  email?: string;
  at?: number; // epoch ms
}

export interface GitRefs {
  refs: { name: string; subject: string }[];
  commits: Commit[];
}

interface PointOption {
  value: string;
  label?: string; // shown instead of the value ("Working tree")
  subject?: string;
  body?: string;
  author?: string;
  email?: string;
  at?: number;
}

/** Absolute local time, seconds included — "when exactly" is the question a
 *  commit card answers; the rows next to it already carry the relative age. */
const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** The hover card's text for a commit: message in full, then who and when. */
export const commitHint = (c: { subject?: string; body?: string; author?: string; email?: string; at?: number }): string =>
  [
    c.subject,
    c.body,
    [
      [c.author, c.email ? `<${c.email}>` : ""].filter(Boolean).join(" "),
      c.at ? stamp(c.at) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");

// --- hover hint -----------------------------------------------------------------------
// The native title tooltip is unstyled and slow; commit messages deserve a
// readable card. One element, shown for whichever target is hovered.

let tip: HTMLElement | null = null;

function hideHint(): void {
  if (!tip) return;
  tip.remove();
  tip = null;
  document.removeEventListener("pointerdown", hideHint, true);
  window.removeEventListener("scroll", hideHint, true);
}

/** Attach a styled hover hint; empty text means no hint. */
export function hoverHint(el: HTMLElement, text: () => string): void {
  el.onmouseenter = () => {
    hideHint();
    const t = text();
    if (!t) return;
    tip = h("div", "pointer-events-none fixed z-50 max-w-96 whitespace-pre-wrap rounded-lg bg-neutral-800/95 px-3 py-2 font-sans text-[11.5px] leading-snug text-neutral-100 shadow-lg");
    tip.textContent = t;
    document.body.append(tip);
    // mouseleave never fires if the hovered row is removed or its panel closes
    // under the cursor — any press or scroll retires the card instead.
    document.addEventListener("pointerdown", hideHint, true);
    window.addEventListener("scroll", hideHint, true);
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top =
      r.bottom + 6 + tip.offsetHeight > window.innerHeight
        ? `${r.top - tip.offsetHeight - 6}px`
        : `${r.bottom + 6}px`;
  };
  el.onmouseleave = hideHint;
}



// --- the picker -------------------------------------------------------------------------

function pointRow(o: PointOption, current: string, onPick: (v: string) => void): HTMLElement {
  const row = h(
    "button",
    "flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left hover:bg-neutral-100",
    h("span", "w-3 flex-none text-indigo-600", o.value === current ? "\u2713" : ""),
    h("span", "flex-none font-mono text-[11.5px] text-neutral-800", o.label ?? o.value),
  );
  if (o.subject) row.append(h("span", "min-w-0 truncate text-[11px] text-neutral-400", o.subject));
  if (o.author) {
    row.append(h("span", "ml-auto flex-none pl-1.5 text-[10.5px] text-neutral-400", `${o.author} · ${o.at ? relTime(o.at) : ""}`));
  }
  hoverHint(row, () => commitHint(o));
  row.onclick = () => onPick(o.value); // the pointerdown already retired the hint
  return row;
}

export function openDiffPicker(
  anchor: HTMLElement,
  git: GitRefs,
  current: { base: string; head: string },
  onPick: (base: string, head: string) => void,
  /** The repo's main line — one row resets the pick back to "that tip ↔ the
   *  files on disk", which is where the view starts and where you want to be
   *  again after wandering through commits. */
  resetBase: string,
): void {
  let { base, head } = current;
  const asCommit = (): string => (head && base === `${head}~1` ? head : "");
  let mode: "compare" | "commit" = asCommit() ? "commit" : "compare";

  const newest = git.commits[0];
  const points = (worktree: boolean): PointOption[] => [
    ...(worktree ? [{ value: "", label: "Working tree", subject: "the files on disk, uncommitted changes included" }] : []),
    { ...newest, value: "HEAD" },
    ...git.refs.map((r): PointOption => ({ value: r.name, subject: r.subject })),
    ...git.commits.map((c): PointOption => ({ ...c, value: c.hash })),
  ];

  const content = h("div", "flex w-[38rem] max-w-full flex-col");

  function render(): void {
    const tab = (label: string, m: typeof mode): HTMLElement => {
      const el = h(
        "button",
        `cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] ${
          mode === m ? "bg-indigo-50 font-medium text-indigo-700" : "text-neutral-500 hover:bg-neutral-100"
        }`,
        label,
      );
      el.onclick = () => {
        mode = m;
        render();
      };
      return el;
    };
    const column = (label: string, opts: PointOption[], current: string, pick: (v: string) => void): HTMLElement =>
      h(
        "div",
        "flex min-w-0 flex-1 flex-col",
        h("div", "flex-none px-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-400", label),
        h("div", "min-h-0 flex-1 overflow-y-auto", ...opts.map((o) => pointRow(o, current, pick))),
      );
    const body =
      mode === "compare"
        ? h(
            "div",
            "flex h-72 min-h-0 divide-x divide-neutral-200 pb-1",
            column("base", points(false), base, (v) => {
              base = v;
              render();
              onPick(base, head);
            }),
            column("to", points(true), head, (v) => {
              head = v;
              render();
              onPick(base, head);
            }),
          )
        : h(
            "div",
            "flex h-72 min-h-0 flex-col overflow-y-auto pb-1",
            ...git.commits.map((c) =>
              pointRow({ value: c.hash, ...c }, asCommit(), (v) => {
                base = `${v}~1`;
                head = v;
                closeMenu(); // a commit's diff is one pick — done
                onPick(base, head);
              }),
            ),
          );
    // Last row of the compare mode, under both columns: the pick is two values,
    // so it belongs to neither column.
    const reset = h("div", "flex-none border-t border-neutral-200",
      pointRow(
        { value: resetBase, label: `↺ ${resetBase} ↔ Working tree`, subject: "back to the default: the main line's tip vs the files on disk" },
        base === resetBase && head === "" ? resetBase : "",
        () => {
          base = resetBase;
          head = "";
          render();
          onPick(base, head);
        },
      ));
    content.replaceChildren(
      h("div", "flex flex-none items-center gap-1 border-b border-neutral-200 px-2 py-1.5", tab("Compare two points", "compare"), tab("One commit", "commit")),
      body,
      ...(mode === "compare" ? [reset] : []),
    );
  }

  render();
  openPanel(anchor, content);
}
