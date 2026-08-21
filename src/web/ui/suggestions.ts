// Next-step buttons under an assistant turn: core/reply.ts parsed the labels,
// this renders them and a click sends the label as an ordinary user message.
//
// Only the newest group stays live — a click on an older one would answer a
// question the conversation has already moved past. The choice is local UI
// state (no store): after a reload the last turn's options are offered again.

import { h } from "./dom.js";

let live: HTMLElement | null = null;

const BASE =
  "cursor-pointer rounded-full border px-2.5 py-0.5 text-[12.5px] transition-colors";
const LIVE = `${BASE} border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100`;
const SPENT = `${BASE} cursor-default border-neutral-200 bg-neutral-50 text-neutral-400`;

/** Grey a group out and stop it answering. */
function lock(group: HTMLElement): void {
  if (live === group) live = null;
  for (const btn of group.querySelectorAll("button")) {
    btn.disabled = true;
    btn.className = SPENT;
  }
}

/** Mark a user turn as the answer to a clicked option. */
export function markPicked(body: HTMLElement): void {
  body.prepend(
    h(
      "span",
      "mr-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 align-middle text-[11px] text-indigo-600",
      "↩ option",
    ),
  );
}

/** Forget the live group — the transcript it belonged to is gone. */
export function resetSuggestions(): void {
  live = null;
}

/** Append the options to a turn's row; no-op without any. */
export function renderSuggestions(
  row: HTMLElement,
  options: string[],
  onPick: (label: string) => void,
): void {
  if (!options.length) return;
  if (live) lock(live);
  const group = h("div", "mt-1.5 flex flex-wrap gap-1.5");
  for (const label of options) {
    const btn = h("button", LIVE, label) as HTMLButtonElement;
    btn.type = "button";
    btn.onclick = () => {
      // The picked row goes away entirely: the answer is about to show up as
      // the next user turn, so leaving the options behind only repeats it.
      if (live === group) live = null;
      group.remove();
      onPick(label);
    };
    group.append(btn);
  }
  row.append(group);
  live = group;
}
