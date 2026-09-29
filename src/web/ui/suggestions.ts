// Next-step buttons under an assistant turn. The latest turn offers them in
// full; an earlier turn's stay, muted, only on its open topic's newest reply —
// a later reply of the topic has moved the question on.

import { h } from "./dom.js";
import { topicOpen } from "./topics.js";

let live: HTMLElement | null = null;

// max-w-full + break-words: the labels are written by the agent, and a long one
// is a pill wider than the pane rather than a pill on two lines.
const PILL = "max-w-full cursor-pointer break-words rounded-full border px-2.5 py-0.5 text-left text-[12.5px] transition-colors";
const LIVE = `${PILL} border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100`;
const EARLIER = `${PILL} border-neutral-300 text-neutral-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700`;

/** Forget the live group — the transcript it belonged to is gone. */
export function resetSuggestions(): void {
  live = null;
}

function demote(group: HTMLElement): void {
  group.classList.add("earlier-options");
  for (const btn of group.children) {
    btn.className = EARLIER;
    btn.setAttribute("aria-description", "option from an earlier reply");
  }
}

/** Shows or hides every earlier group on screen from the rows as they stand:
 *  the topic tag (topics.ts) and the open items. */
export function refreshSuggestions(): void {
  const newest = new Set<string>();
  const rows = [...(document.querySelector("#turns")?.children ?? [])] as HTMLElement[];
  for (const row of rows.reverse()) {
    const topic = row.dataset.kind === "assistant" ? row.dataset.topic : undefined;
    const group = row.querySelector<HTMLElement>(".earlier-options");
    if (group) group.hidden = !topic || newest.has(topic) || !topicOpen(topic);
    if (topic) newest.add(topic);
  }
}

/** Append the options to a turn's row. `latest` takes the live slot and mutes
 *  the group that held it; an earlier turn without a topic offers nothing.
 *  An earlier group is shown by the next `refreshSuggestions`. */
export function renderSuggestions(
  row: HTMLElement,
  options: string[],
  onPick: (label: string) => void,
  latest: boolean,
  topic: string | undefined,
): void {
  if (latest) {
    if (live) demote(live);
    live = null;
  }
  if (!options.length || (!latest && !topic)) return;
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
  if (latest) live = group;
  else {
    group.hidden = true;
    demote(group);
  }
}
