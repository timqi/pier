// Which open item a chat row belongs to: its colour and its tag, dotted while the
// item waits on the user and they have not answered — read off the rows, never stored.

import { h } from "./dom.js";
import { replyTopic, waitsOnYou } from "../../core/reply.js";

/** FNV-1a: the same problem is the same colour in the chat, the panel and after a reload. */
export function topicHue(problem: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < problem.length; i++) hash = Math.imul(hash ^ problem.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % 360;
}

export const topicColour = (problem: string): string => `oklch(0.62 0.15 ${topicHue(problem)})`;

/** The open topics, each whether it waits on the user (`GET /api/continuous/open`); a topic not here is done. */
let open = new Map<string, boolean>();

export const topicOpen = (problem: string): boolean => open.has(problem);

/** Each open item's runs, to the item: a callback's reply is about the item holding its run. */
let runTopics = new Map<string, string>();

/** A tag's click: the row it sits on, to jump back from (chat.ts). */
type Jump = (row: HTMLElement) => void;

function paintTag(label: HTMLElement, problem: string, waiting: boolean): void {
  label.toggleAttribute("data-waiting", waiting);
  label.title = waiting ? `${problem} \u00b7 waiting on you` : problem;
  label.setAttribute("aria-label", `${label.title} \u2014 previous message of this topic`);
}

/** Topics the user has answered since their newest reply on screen: a user row
 *  after it that quotes a row of it (chat.ts `data-answers`) or comes before
 *  any other reply. A later reply of the topic asks again once the items that
 *  came with it say so (`setOpenTopics`), never on the ones it outdates. */
function answeredTopics(rows: HTMLElement[]): Set<string> {
  const answered = new Set<string>();
  let last: string | undefined;
  for (const row of rows) {
    const kind = row.dataset.kind;
    if (kind === "assistant") {
      last = row.dataset.topic;
      if (last && !("topicFresh" in row.dataset)) answered.delete(last);
    } else if (kind === "user") for (const t of [last, row.dataset.answers]) if (t) answered.add(t);
  }
  return answered;
}

/** Repaints every tag's dot on screen from the open items and the rows as they stand. */
export function refreshTopicTags(): void {
  const turns = document.querySelector("#turns");
  if (!turns) return;
  const answered = answeredTopics([...turns.children] as HTMLElement[]);
  for (const label of turns.querySelectorAll<HTMLElement>(".topic-tag")) {
    const problem = label.closest<HTMLElement>("[data-topic]")?.dataset.topic;
    if (problem) paintTag(label, problem, open.get(problem) === true && !answered.has(problem));
  }
}

export function setOpenTopics(items: { problem: string; status: string; runs: { runId: string }[] }[]): void {
  open = new Map(items.map((i) => [i.problem, waitsOnYou(i.status)]));
  runTopics = new Map(items.flatMap((i) => i.runs.map((r) => [r.runId, i.problem] as const)));
  for (const row of document.querySelector("#turns")?.querySelectorAll<HTMLElement>("[data-topic-fresh]") ?? []) delete row.dataset.topicFresh;
  refreshTopicTags();
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
    label = h("button", `topic-tag flex items-center gap-1 cursor-pointer text-left text-[11px] leading-tight ${chipRow ? "" : "mb-1"}`);
    label.setAttribute("type", "button");
    const caption = kids.find((el) => el.classList.contains("speaker-line"));
    if (caption) caption.after(label);
    else (chipRow ?? row).prepend(label);
  }
  label.style.setProperty("--topic", topicColour(problem));
  label.onclick = () => jump(row);
  // The text truncates inside the button, so the button's touch area (style.css) is not clipped with it.
  label.replaceChildren(h("span", "topic-text", problem));
  // The dot waits for `refreshTopicTags`: whether the user answered reads every row.
  paintTag(label, problem, false);
}

const stops = (kind: string | undefined): boolean => kind === "assistant" || kind === "divider" || kind === "pager";

/** The open item holding a run of the callback a reply answers: the nearest
 *  callback (chat.ts `data-runs`) in its bubble or above it, up to a user row or another reply. */
function callbackTopic(row: HTMLElement): string | undefined {
  for (let el: HTMLElement | null = row; el; el = el.previousElementSibling as HTMLElement | null) {
    if (el !== row && (el.dataset.kind === "user" || stops(el.dataset.kind))) return undefined;
    const callback = el.dataset.runs !== undefined ? el : [...el.querySelectorAll<HTMLElement>("[data-runs]")].at(-1);
    if (!callback) continue;
    for (const id of callback.dataset.runs!.split(",")) {
      const topic = runTopics.get(id);
      if (topic) return topic;
    }
    return undefined;
  }
  return undefined;
}

/** A reply names its topic, and the user message it answers inherits; one
 *  naming none is its callback's. `row` is the reply's bubble; `live`, one
 *  that just ended, newer than the items on hand. */
export function tagReply(row: HTMLElement, raw: string, jump: Jump, live = false): void {
  const marked = replyTopic(raw);
  const topic = marked ?? callbackTopic(row);
  if (!topic) return;
  tagRow(row, topic, jump);
  if (live) row.dataset.topicFresh = "";
  if (!marked) return;
  for (let el = row.previousElementSibling as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
    const kind = el.dataset.kind;
    if (stops(kind)) break;
    if (kind !== "user") continue;
    if (!el.dataset.topic) tagRow(el, topic, jump);
    break;
  }
}
