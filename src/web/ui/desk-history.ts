// The top of the turns pane for a desk conversation: the divider that expands
// the previous desk session's transcript in place, and the chain of them
// backwards. Desk only (docs/design/06-desk.md) — a reset is only cheap if it
// costs nothing you could still see, and until now it cost the whole screen.

import { holdTail, renderPast, turnsPane } from "./chat.js";
import { h } from "./dom.js";
import { previousDesk, type SessionInfo } from "./sidebar.js";
import type { ChatTurn } from "../../core/types.js";

/** What this module needs from the orchestrator (main.ts) — nothing it does
 *  not already own: the session list, the desk folder, the selection. */
export interface DeskHistoryDeps {
  sessions: () => SessionInfo[];
  deskDir: () => string | null;
  currentId: () => string | null;
}

let deps: DeskHistoryDeps;

export function initDeskHistory(d: DeskHistoryDeps): void {
  deps = d;
}

/** The pane's first child while an earlier desk conversation is reachable:
 *  every expanded predecessor and the divider that reaches the next one,
 *  oldest at the top. chat.ts knows this kind by name — it is not a row of the
 *  live transcript, so the trim leaves it alone. */
const STACK = "desk-history";

const INVITE =
  "block w-full cursor-pointer border-y border-neutral-200/70 bg-neutral-50/60 px-5 py-1.5 text-center text-[11.5px] italic text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600";
const SEAM =
  "block w-full border-y border-neutral-200/70 bg-neutral-50/60 px-5 py-1.5 text-center text-[11.5px] italic text-neutral-400";
const QUIET = "px-5 py-2 text-center text-[11.5px] italic text-neutral-400";

/** A predecessor is named by what it was about, and by when it was if it never
 *  got a title. Long titles are cut here: the divider is one line. */
function label(s: SessionInfo): string {
  const title = s.title?.trim();
  if (title) return title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return new Date(s.createdAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Put the divider at the top of the pane, if this session has a predecessor.
 * Called after every snapshot render, and again when the desk path lands (it
 * arrives on its own fetch, so a deep link can beat it) — an already-mounted
 * stack is left exactly as the reader left it.
 */
export function mountDeskHistory(): void {
  if (turnsPane.querySelector(`:scope > [data-kind="${STACK}"]`)) return;
  const prev = previousDesk(deps.sessions(), deps.deskDir(), deps.currentId());
  if (!prev) return;
  const stack = h("div", "", divider(prev));
  stack.dataset.kind = STACK;
  turnsPane.prepend(stack);
}

/** The boundary. Before the click it is the invitation; after it, the same
 *  element stays put as the seam between the two conversations, because a
 *  reader coming down through the older one has to see where it ended. */
function divider(prev: SessionInfo): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = INVITE;
  el.textContent = `↑ earlier desk conversation · ${label(prev)}`;
  el.title = `Show it above this one, read-only (${prev.id})`;
  el.onclick = () => void expand(el, prev);
  return el;
}

async function expand(el: HTMLButtonElement, prev: SessionInfo): Promise<void> {
  el.disabled = true;
  // A transcript takes a moment to arrive; a dead divider that says nothing is
  // indistinguishable from a click that did not register (principle 5b).
  el.textContent = `loading earlier desk conversation · ${label(prev)}…`;
  const loaded = await history(prev.id);
  if (!el.isConnected) return; // the pane was reset while the fetch was out
  el.className = SEAM;
  el.textContent = `earlier desk conversation · ${label(prev)}`;
  // Measured here, not before the fetch: everything that changes the pane's
  // height happens in the next three lines, and the divider the user clicked
  // is the one thing that must not move on screen.
  holdTail(); // whatever goes in above must not pull the pane to its bottom
  const before = el.getBoundingClientRect().top;
  const older = previousDesk(deps.sessions(), deps.deskDir(), prev.id);
  const block = typeof loaded === "string"
    ? h("div", QUIET, loaded)
    : renderPast(loaded, prev.id);
  el.before(...(older ? [divider(older), block] : [block]));
  turnsPane.scrollTop += el.getBoundingClientRect().top - before;
}

/** The predecessor's turns, or the one line to show instead. A 404 is a ghost
 *  the server has already cleaned (`ensureLoadable`, web/server.ts) and must
 *  not take the view with it; anything else names its own status, because
 *  "unavailable" and "unreachable" are not the same answer. */
async function history(id: string): Promise<ChatTurn[] | string> {
  try {
    const res = await fetch(`/api/sessions/${id}/history`);
    if (!res.ok) {
      return res.status === 404
        ? "history unavailable — this conversation is gone"
        : `history unavailable — ${res.status}`;
    }
    return ((await res.json()) as { turns: ChatTurn[] }).turns;
  } catch (err) {
    return `history unavailable — ${String(err)}`;
  }
}
