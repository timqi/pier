// Grey lines over turns-pane rows that need no reading — a run of silent
// replies, a session's seed — closed until their click, read off the rows,
// never kept beside them.

import { History } from "lucide";
import { icon } from "./icons.js";
import { h } from "./dom.js";

function foldButton(...kids: (Node | string)[]): HTMLElement {
  const toggle = h("button", "line-fold", ...kids);
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-expanded", "false");
  return toggle;
}

const foldOpen = (line: HTMLElement): boolean => line.querySelector("button")!.getAttribute("aria-expanded") === "true";

/** Where one session of the continuous conversation ends and the next begins. */
export function dividerLine(text: string): HTMLElement {
  const line = h("div", "my-4 text-center text-[11px] text-neutral-400", text);
  line.dataset.kind = "divider";
  return line;
}

/** A seed is what its session opened with, so the divider that opened the
 *  session opens to it; the oldest session on screen has none and draws its own. */
export function foldSeed(pane: HTMLElement, card: HTMLElement, reason: string): void {
  const tail = pane.lastElementChild as HTMLElement | null;
  const line = tail?.dataset.kind === "divider" ? tail : dividerLine(`new session \u00b7 ${reason}`);
  const toggle = foldButton(icon(History, "mr-1 inline h-3 w-3 align-[-2px]"), line.textContent ?? "");
  toggle.title = "The session seed \u2014 what this session opened with";
  toggle.onclick = () => {
    card.hidden = foldOpen(line);
    toggle.setAttribute("aria-expanded", String(!card.hidden));
  };
  line.replaceChildren(toggle);
  card.dataset.kind = "system";
  card.hidden = true;
  pane.append(line, card);
}

// A silent reply's row carries `data-silent` (chat.ts renderAssistant); they
// happened (principle 5), so each run of them keeps one line saying how many.

const isSilent = (row: HTMLElement): boolean => "silent" in row.dataset;

function silenceLine(): HTMLElement {
  const toggle = foldButton();
  toggle.title = "Replies that stayed silent";
  const line = h("div", "my-2 text-[11.5px] leading-tight text-neutral-400", toggle);
  line.dataset.kind = "fold";
  toggle.onclick = () => setFold(line, !foldOpen(line));
  return line;
}

function setFold(line: HTMLElement, open: boolean): void {
  line.querySelector("button")!.setAttribute("aria-expanded", String(open));
  for (let el = line.nextElementSibling as HTMLElement | null; el && isSilent(el); el = el.nextElementSibling as HTMLElement | null) el.hidden = !open;
}

/** Every run of consecutive silent rows behind one line, a new row joining its
 *  run's line as that line stands: open only once clicked. */
export function foldSilence(pane: HTMLElement): void {
  let fold: HTMLElement | null = null;
  let count = 0;
  const seal = (): void => {
    if (fold) fold.querySelector("button")!.textContent = `\u00b7 ${count} background update${count === 1 ? "" : "s"}`;
    fold = null;
    count = 0;
  };
  for (const row of [...pane.children] as HTMLElement[]) {
    if (row.dataset.kind === "fold") {
      seal();
      const next = row.nextElementSibling as HTMLElement | null;
      if (next && isSilent(next)) fold = row;
      else row.remove();
      continue;
    }
    // A hidden neighbour must not pull the next visible row into the fold line.
    if (count) delete row.dataset.grouped;
    if (!isSilent(row)) {
      seal();
      continue;
    }
    if (!fold) {
      fold = silenceLine();
      row.before(fold);
    }
    delete row.dataset.grouped;
    row.hidden = !foldOpen(fold);
    count++;
  }
  seal();
}

/** A jump to a folded reply opens its fold, or it would land on nothing. */
export function unfold(row: HTMLElement): void {
  if (!row.hidden || !isSilent(row)) return;
  let el = row.previousElementSibling as HTMLElement | null;
  while (el && isSilent(el)) el = el.previousElementSibling as HTMLElement | null;
  if (el?.dataset.kind === "fold") setFold(el, true);
}
