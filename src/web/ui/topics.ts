// Which open item a chat row belongs to: its colour and its tag, which names
// the item's stage while it is open — read off each reply's markers, never stored.

import { h } from "./dom.js";
import { replyTopic } from "../../core/reply.js";

/** FNV-1a: the same problem is the same colour in the chat, the panel and after a reload. */
export function topicHue(problem: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < problem.length; i++) hash = Math.imul(hash ^ problem.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % 360;
}

export const topicColour = (problem: string): string => `oklch(0.62 0.15 ${topicHue(problem)})`;

/** The open items' stages (`GET /api/continuous/open`); a topic not here is done. */
let stages = new Map<string, string>();

/** A tag's click: the row it sits on, to jump back from (chat.ts). */
type Jump = (row: HTMLElement) => void;

function paintTag(label: HTMLElement, problem: string): void {
  const stage = stages.get(problem);
  // The text truncates inside the button, so the button's touch area (style.css) is not clipped with it.
  label.replaceChildren(h("span", "topic-text", problem, ...(stage ? [h("span", "topic-stage", ` \u00b7 ${stage}`)] : [])));
  label.title = stage ? `${problem} \u00b7 ${stage}` : problem;
  label.setAttribute("aria-label", `${label.title} \u2014 previous message of this topic`);
}

/** Repaints every tag on screen: an item's stage moves without its replies. */
export function setTopicStages(items: { problem: string; stage: string }[]): void {
  const next = new Map(items.map((i) => [i.problem, i.stage]));
  if (next.size === stages.size && [...next].every(([p, stage]) => stages.get(p) === stage)) return;
  stages = next;
  for (const label of document.querySelector("#turns")?.querySelectorAll<HTMLElement>(".topic-tag") ?? []) {
    const problem = label.closest<HTMLElement>("[data-topic]")?.dataset.topic;
    if (problem) paintTag(label, problem);
  }
}

/** The tag is the first chip of a reply's chip row (chat.ts chipSlots), or
 *  the bubble's first line where there is no row. */
export function tagRow(row: HTMLElement, problem: string, jump: Jump): void {
  row.dataset.topic = problem;
  let label = row.querySelector<HTMLElement>(".topic-tag");
  if (!label) {
    const kids = [...row.children];
    const chipRow = kids.find((el) => el.classList.contains("chip-row"));
    // In a chip row the row's gap spaces it; alone, its own margin does.
    label = h("button", `topic-tag block cursor-pointer text-left text-[11px] leading-tight ${chipRow ? "" : "mb-1"}`);
    label.setAttribute("type", "button");
    const caption = kids.find((el) => el.classList.contains("speaker-line"));
    if (caption) caption.after(label);
    else (chipRow ?? row).prepend(label);
  }
  label.style.setProperty("--topic", topicColour(problem));
  label.onclick = () => jump(row);
  paintTag(label, problem);
}

/** A reply names its topic, and the user message it answers inherits. `row`
 *  is the reply's bubble. */
export function tagReply(row: HTMLElement, raw: string, jump: Jump): void {
  const topic = replyTopic(raw);
  if (!topic) return;
  tagRow(row, topic, jump);
  for (let el = row.previousElementSibling as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
    const kind = el.dataset.kind;
    if (kind === "assistant" || kind === "divider" || kind === "pager") break;
    if (kind !== "user") continue;
    if (!el.dataset.topic) tagRow(el, topic, jump);
    break;
  }
}
