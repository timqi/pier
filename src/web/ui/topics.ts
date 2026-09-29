// Which open item a chat row belongs to: its colour, its tag, the filter and
// the topics the pane has seen — read off each reply's markers, never stored.

import { X } from "lucide";
import { icon } from "./icons.js";
import { h } from "./dom.js";
import { openItemMarkers, replyTopic } from "../../core/reply.js";

/** FNV-1a: the same problem is the same colour in the chat, the panel and after a reload. */
export function topicHue(problem: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < problem.length; i++) hash = Math.imul(hash ^ problem.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % 360;
}

export const topicColour = (problem: string): string => `oklch(0.62 0.15 ${topicHue(problem)})`;

// --- the registry ---------------------------------------------------------------------

/** Map order is done order for done topics: marking one done re-inserts it. */
const seen = new Map<string, boolean>();
let listener: (() => void) | null = null;

/** The one reader, the status panel: redrawn when a topic or the filter changes. */
export function onTopicsChanged(cb: () => void): void {
  listener = cb;
}

export function noteTopic(problem: string, o: { done?: boolean } = {}): void {
  const done = o.done ?? seen.get(problem) ?? false;
  if (seen.get(problem) === done) return;
  if (done) seen.delete(problem);
  seen.set(problem, done);
  listener?.();
}

export const seenTopics = (): { problem: string; done: boolean }[] =>
  [...seen].map(([problem, done]) => ({ problem, done }));

/** Most recently done first. */
export const recentDone = (list = seenTopics(), n = 5): string[] =>
  list.filter((t) => t.done).map((t) => t.problem).reverse().slice(0, n);

// --- tagging ----------------------------------------------------------------------------

export function tagRow(row: HTMLElement, problem: string): void {
  row.dataset.topic = problem;
  row.style.setProperty("--topic", topicColour(problem));
  let label = row.querySelector<HTMLElement>(".topic-tag");
  if (!label) {
    label = h("div", "topic-tag mb-1 text-[11px] leading-tight");
    const caption = row.querySelector(".speaker-line");
    if (caption) caption.after(label);
    else row.prepend(label);
  }
  label.textContent = problem;
  label.title = problem;
  applyTopicFilterTo(row);
}

/** A reply names its topic; the user message it answers and the work around it inherit. */
export function tagReply(row: HTMLElement, raw: string): void {
  const topic = replyTopic(raw);
  if (!topic) return;
  noteTopic(topic);
  for (const m of openItemMarkers(raw).markers) noteTopic(m.problem, { done: m.op === "done" });
  tagRow(row, topic);
  const inherit = (el: HTMLElement): void => {
    el.dataset.topic = topic;
    applyTopicFilterTo(el);
  };
  const next = row.nextElementSibling as HTMLElement | null;
  if (next?.dataset.kind === "process") inherit(next);
  const above = row.previousElementSibling as HTMLElement | null;
  if (above?.dataset.kind === "activity") inherit(above);
  for (let el = above; el; el = el.previousElementSibling as HTMLElement | null) {
    const kind = el.dataset.kind;
    if (kind === "assistant" || kind === "divider" || kind === "pager") break;
    if (kind !== "user") continue;
    if (el.dataset.topic) break;
    tagRow(el, topic);
    const time = el.previousElementSibling as HTMLElement | null;
    if (time?.dataset.kind === "time") inherit(time);
    break;
  }
}

// --- the filter -------------------------------------------------------------------------

/** Structure, not conversation: a filtered pane still says where sessions begin and end. */
const FILTERED = new Set(["user", "assistant", "system", "activity", "background-run", "process", "error", "time"]);
let filter: string | null = null;
let barChip: HTMLElement | null = null;

export const topicFilter = (): string | null => filter;

export function applyTopicFilterTo(row: HTMLElement): void {
  row.hidden = filter !== null && !("live" in row.dataset) && FILTERED.has(row.dataset.kind ?? "") && row.dataset.topic !== filter;
}

/** A row appended while the filter is on stays in view whatever its topic: the
 *  switch narrows what was there, and a message just sent, or the reply to it,
 *  must never look like nothing happened (§5). */
export function arriveRow(row: HTMLElement): void {
  if (filter !== null) row.dataset.live = "";
  applyTopicFilterTo(row);
}

export function applyTopicFilter(): void {
  const turns = document.querySelector<HTMLElement>("#turns");
  if (!turns) return;
  if (filter === null) delete turns.dataset.topicFilter;
  else turns.dataset.topicFilter = filter;
  for (const row of turns.children) {
    delete (row as HTMLElement).dataset.live;
    applyTopicFilterTo(row as HTMLElement);
  }
}

export function setTopicFilter(problem: string | null): void {
  if (problem === filter) return;
  filter = problem;
  applyTopicFilter();
  paintBarChip();
  listener?.();
}

/** The filter's state from the chat itself, beside the status chip; its × is the way out. */
function paintBarChip(): void {
  if (!barChip) {
    const status = document.querySelector("#status-chip");
    if (!status) return;
    barChip = h("button", "topic-filter flex max-w-[35vw] flex-none cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium pointer-coarse:min-h-11");
    barChip.setAttribute("type", "button");
    barChip.onclick = () => setTopicFilter(null);
    status.before(barChip);
  }
  barChip.hidden = filter === null;
  if (filter === null) return;
  barChip.style.setProperty("--topic", topicColour(filter));
  barChip.title = `Only “${filter}” in the chat — show every topic`;
  barChip.setAttribute("aria-label", barChip.title);
  barChip.replaceChildren(h("span", "min-w-0 truncate", filter), icon(X, "h-3 w-3 flex-none"));
}

/** A new transcript: the filter is view state, and the registry is read off this one. */
export function resetTopics(): void {
  seen.clear();
  setTopicFilter(null);
  listener?.();
}
