// Next-step buttons under an assistant turn: core/reply.ts parsed the labels,
// this renders them and a click sends the label as an ordinary user message.
//
// Only the latest assistant turn offers options — live after a turn ends, and
// again on replay while the session sits idle, so a reload or another client
// still sees the choice it is waiting on. An older group would answer a
// question the conversation has already moved past, so it is removed rather
// than greyed out. The choice is not recorded anywhere: history renders the
// reply text without its options block and user turns carry no marker.

import { h } from "./dom.js";

let live: HTMLElement | null = null;

// max-w-full + break-words: the labels are written by the agent, and a long one
// is a pill wider than the pane rather than a pill on two lines.
const BTN =
  "max-w-full cursor-pointer break-words rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-left text-[12.5px] text-indigo-700 transition-colors hover:border-indigo-300 hover:bg-indigo-100";

/** Forget the live group — the transcript it belonged to is gone. */
export function resetSuggestions(): void {
  live = null;
}

/** Append the options to a turn's row, dropping any older group. */
export function renderSuggestions(
  row: HTMLElement,
  options: string[],
  onPick: (label: string) => void,
): void {
  live?.remove();
  live = null;
  if (!options.length) return;
  const group = h("div", "mt-1.5 flex flex-wrap gap-1.5");
  for (const label of options) {
    const btn = h("button", BTN, label) as HTMLButtonElement;
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
