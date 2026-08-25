// Source on screen: numbered gutters, per-line highlighting, diff tones.
//
// One renderer for every place the Console shows a file it did not write —
// the Files view's previews and whole-file diffs, and Settings → Agent's
// read-only skills and extensions. It was the Files view's private closure
// until the second reader arrived with a bare <pre>, which is how a viewer
// ends up with two spellings of a line of code.

import { h } from "./dom.js";
import { lineEl } from "./highlight.js";

/** Past this, per-line highlighting is the slow part — numbers stay, color goes. */
const MAX_HIGHLIGHT_LINES = 20_000;

export type CodeRow = {
  nums: (number | "")[];
  text: string;
  tone: "" | "add" | "del";
  /** Chars [start, end) that actually changed — the intra-line emphasis. */
  mark?: [number, number];
};

/** Every line numbered once and toned not at all: a file, as itself. */
export const plainRows = (lines: string[]): CodeRow[] =>
  lines.map((text, i) => ({ nums: [i + 1], text, tone: "" as const }));

/** Gutter number column(s), toned diff lines, per-line highlighting, long
 *  lines wrapping past the gutter. */
export function codePane(rows: CodeRow[], lang: string | null): HTMLElement {
  const hl = rows.length <= MAX_HIGHLIGHT_LINES ? lang : null;
  // Gutters as wide as the largest number they hold, not a fixed column.
  const digits = Math.max(
    2,
    ...rows.map((r) => r.nums.reduce<number>((w, n) => Math.max(w, String(n).length), 0)),
  );
  // Wrapping, not horizontal scroll: a long line folds under itself, hanging
  // past the gutter, which stays put as the flex row's first column.
  const box = h("div", "py-2 font-mono text-[12px] leading-[1.5]");
  for (const r of rows) {
    const row = h(
      "div",
      `flex pl-2 pr-4 ${r.tone === "add" ? "bg-emerald-50" : r.tone === "del" ? "bg-red-50" : ""}`,
    );
    for (const n of r.nums) {
      const gutter = h(
        "span",
        "flex-none select-none pr-1.5 text-right text-neutral-300",
        n === "" ? "" : String(n),
      );
      gutter.style.width = `calc(${digits}ch + 0.375rem)`; // content + its own pr
      row.append(gutter);
    }
    row.append(codeSpan(r, hl));
    box.append(row);
  }
  return box;
}

/** The line's code cell; a marked row renders as three fragments so the
 *  changed span can carry a deeper tint on top of the row's own. Fragment
 *  highlighting degrades tokens that straddle the mark — per-line hljs is
 *  already an approximation, and the emphasis is worth more. */
function codeSpan(r: CodeRow, hl: string | null): HTMLElement {
  const cls = "min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]";
  if (!r.mark || r.mark[0] >= r.mark[1]) {
    const el = lineEl(r.text, hl);
    el.className = cls;
    return el;
  }
  const [s, e] = r.mark;
  const mid = lineEl(r.text.slice(s, e), hl);
  mid.className = `rounded-xs ${r.tone === "add" ? "bg-emerald-200/80" : "bg-red-200/70"}`;
  return h("span", cls, lineEl(r.text.slice(0, s), hl), mid, lineEl(r.text.slice(e), hl));
}
