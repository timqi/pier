// The turns pane: chat rows, markdown, streaming text, system-input rows and
// inline user-message edit. main.ts owns session state and the event stream;
// turn-activity.ts owns the Activity groups and background-run cards; this
// module only renders into #turns through the functions it exports.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { formatTurnMeta, isSilentReply, silentReason, splitReply } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { imageRow, inboundAttachment, renderAttachments, rewriteFileLinks } from "./attachments.js";
import { splitInboundFiles } from "../../core/inbound-file.js";
import { highlightCode } from "./highlight.js";
import { $, copyBtn, h } from "./dom.js";
import { renderSuggestions, resetSuggestions } from "./suggestions.js";
import {
  decisionReplyBtn,
  finishActivity,
  initTurnActivity,
  renderBackgroundRun,
  replayActivity,
  resetActivity,
  sealActivity,
  takeActivityGroup,
} from "./turn-activity.js";
import type {
  BackgroundRun,
  ChatTurn,
  SessionState,
  SystemInputOrigin,
  TurnMeta,
} from "../../core/types.js";

/** Everything chat rendering needs from the orchestrator (main.ts). */
export interface ChatDeps {
  sessionId: () => string | null;
  sessionState: () => SessionState;
  select: (id: string) => void;
  showTasks: (taskId?: string) => void;
  send: (mode: "auto" | "steer", label?: string) => void;
  /** A user turn this client just drew itself: ledger it so the `user-message`
   *  event reconciles instead of drawing it twice, and show the run as live. */
  ownTurn: (text: string) => void;
  /** Reload the session snapshot if `id` is still the selected session. */
  reload: (id: string) => Promise<void>;
}

let deps: ChatDeps;

export const turnsPane = $("#turns");

export function initChat(d: ChatDeps): void {
  deps = d;
  // The pane is handed over rather than imported back: see TurnsPane there.
  initTurnActivity(d, { el: turnsPane, append: appendTurn, scroll: scrollBottom });
}

// --- scrolling -------------------------------------------------------------------
// Stick to the bottom only when the user is already there (avibe behavior);
// force on own sends so the conversation follows the user's action.

export function scrollBottom(force = false): void {
  const near = turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;
  if (force || near) turnsPane.scrollTop = turnsPane.scrollHeight;
}

// --- chat rows (Slack-style full-width) ----------------------------------------------
// No sender labels: user rows carry an accent bar + tint, agent rows stay plain.

const ROW_STYLE: Record<string, { row: string; body: string }> = {
  user: { row: "border-l-indigo-500 bg-indigo-50", body: "text-neutral-900" },
  assistant: { row: "border-l-transparent", body: "text-neutral-900" },
  error: { row: "border-l-red-400 bg-red-50", body: "text-red-700" },
  system: { row: "border-l-cyan-500 bg-cyan-50", body: "text-neutral-800" },
};

// No rules between rows: tint and accent say who is speaking, the gap only says
// whether the speaker changed (4px within a run, 6px across one), and the
// padding is generous — the block breathes, the lines don't.
export function appendTurn(kind: keyof typeof ROW_STYLE, text: string, markdown = false): HTMLElement {
  sealActivity();
  // The steps that just ran are this message's own: they move inside the row
  // as its caption line. Detaching first also restores sender grouping, which
  // a group sitting between two agent rows used to break.
  const steps = kind === "assistant" ? takeActivityGroup() : null;
  const s = ROW_STYLE[kind]!;
  // Consecutive rows from the same sender read as one block (Slack grouping).
  const grouped = (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative border-l-2 px-5 ${grouped ? "pt-1 pb-2.5" : "mt-1.5 py-2.5"} ${s.row}`);
  row.dataset.kind = kind;
  // A user message may end in inbound-file markers (core/inbound-file.ts):
  // the typed text stays a plain bubble, the files render as thumbs/cards
  // below.
  const files = kind === "user" ? splitInboundFiles(text) : null;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, files?.text ?? text);
  // Editing resends the raw text, markers included — stripping them from the
  // bubble must not detach the files from the message.
  if (files?.paths.length) node.dataset.raw = text;
  if (markdown) renderMarkdown(node, text);
  // flow-root: the step line floats into the message's first line, and a row
  // that doesn't contain its float leaks it over whatever comes next while the
  // text is still empty.
  if (steps) {
    row.classList.add("flow-root");
    row.append(steps);
  }
  row.append(node);
  const sessionId = deps.sessionId();
  if (files?.paths.length && sessionId) {
    const strip = imageRow(row);
    for (const path of files.paths) strip.append(inboundAttachment(sessionId, path));
  }
  if (kind === "user") {
    const edit = h("button", "absolute right-2 top-1 hidden h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:flex pointer-coarse:flex");
    edit.title = "Edit — resends from here; this message and later turns leave the context";
    edit.setAttribute("aria-label", "Edit message");
    edit.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="m10.7 2.3 3 3L6 13H3v-3l7.7-7.7zM9.3 3.7l3 3"/></svg>';
    edit.onclick = () => startEdit(row, node);
    row.append(edit);
  }
  turnsPane.append(row);
  scrollBottom();
  return node;
}

export function appendSystemInput(text: string, origin: SystemInputOrigin): void {
  const kind = origin.kind === "task-callback"
    ? "Task callback"
    : origin.kind === "task-message"
      ? origin.messageKind === "decision" ? "Decision needed" : `Task ${origin.messageKind.replace("_", " ")}`
      : "Agent task input";
  sealActivity();
  const row = h("div", "mt-1.5 border-l-2 border-l-cyan-500 bg-cyan-50 px-5 py-2.5");
  row.dataset.kind = "system";
  const head = h("div", "mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-cyan-800", h("span", "", kind));
  if (origin.sourceSessionId && origin.sourceSessionId !== "console") {
    const source = h("button", "truncate font-mono normal-case text-cyan-700 hover:underline", origin.sourceSessionId.slice(0, 12));
    source.title = "Open source session";
    source.onclick = () => deps.select(origin.sourceSessionId!);
    head.append(h("span", "text-cyan-400", "from"), source);
  }
  const run = h("button", "ml-auto flex-none font-mono normal-case text-cyan-700 hover:underline", `run ${origin.runId.slice(0, 8)}`);
  run.onclick = () => deps.showTasks(origin.taskId);
  head.append(run);
  if (origin.kind === "task-message" && origin.messageKind === "decision") {
    head.append(decisionReplyBtn(origin.messageId));
  }
  const collapsed = ["max-h-[min(18rem,40dvh)]", "overflow-hidden"];
  const content = h("div", `whitespace-pre-wrap break-words text-[14px] text-neutral-800 ${collapsed.join(" ")}`, text);
  row.append(head, content);
  turnsPane.append(row);
  // Hidden chat panes cannot be measured, so an approximate text gate catches
  // inputs likely to exceed the cap; visible panes use their rendered height.
  const long = text.length > 800 || text.split("\n").length > 12;
  const clipped = content.clientHeight
    ? content.scrollHeight > content.clientHeight + 1
    : long;
  if (clipped) {
    const toggle = h(
      "button",
      "mx-auto mt-1.5 block w-fit rounded border border-cyan-200 bg-white px-2 py-1 text-[12px] font-medium text-cyan-800 shadow-sm hover:bg-cyan-100 pointer-coarse:py-3.5",
      "Show full message",
    );
    toggle.setAttribute("type", "button");
    toggle.onclick = () => {
      const clamped = content.classList.toggle(collapsed[0]!);
      content.classList.toggle(collapsed[1]!, clamped);
      toggle.textContent = clamped ? "Show full message" : "Collapse message";
      content.tabIndex = -1;
      content.focus({ preventScroll: true });
    };
    row.append(toggle);
  } else {
    content.classList.remove(...collapsed);
  }
  scrollBottom();
}

// --- edit user message ------------------------------------------------------------
// Pencil on a user row → inline textarea; Enter rewinds the transcript to just
// before that message server-side and re-sends the edited text, so the old
// message stops polluting the context. Later turns are dropped with it.

function startEdit(row: HTMLElement, node: HTMLElement): void {
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  if (row.querySelector("textarea")) return;
  const area = document.createElement("textarea");
  area.value = node.dataset.raw ?? node.textContent ?? ""; // user turns are plain text
  area.className =
    "block w-full resize-none rounded-md border border-indigo-300 bg-white px-2 py-1 focus:outline-none";
  // Grow with content like the composer does; same 192px cap (max-h-48).
  const grow = (): void => {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 192)}px`;
  };
  area.oninput = grow;
  node.classList.add("hidden");
  node.after(area);
  grow();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const cancel = (): void => {
    area.remove();
    node.classList.remove("hidden");
  };
  area.onkeydown = (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Escape") cancel();
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const text = area.value.trim();
      if (!text) return cancel();
      void submitEdit(row, text);
    }
  };
}

async function submitEdit(row: HTMLElement, text: string): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  // The Nth user row on screen is the Nth user turn of history().
  const index = [...turnsPane.querySelectorAll('[data-kind="user"]')].indexOf(row);
  // Drawn before the round trip: reloading the snapshot instead blanked the
  // pane for the length of a fetch, so the transcript flashed away and came
  // back (principle 7). A rewind is exactly "this row and everything under it
  // leaves", and the re-sent text is an ordinary optimistic user turn.
  while (row.nextElementSibling) row.nextElementSibling.remove();
  row.remove();
  deps.ownTurn(text);
  appendTurn("user", text);
  scrollBottom(true);
  const res = await sendJson(`/api/sessions/${id}/turns/${index}/edit`, { text });
  if (!res.ok) {
    // The optimistic prune was a lie — the server still holds those turns. The
    // reload wipes the pane, so the reason goes in after it, not before.
    const why = await failure(res, "edit failed");
    await deps.reload(id);
    appendTurn("error", why);
  }
}

/** Row-hover meta chip on agent turns: completion time · duration · tokens. */
function setMetaHint(node: HTMLElement, meta?: TurnMeta): void {
  if (!meta) return;
  // 24-hour, local timezone.
  const time = new Date(meta.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  (node.parentElement ?? node).append(h(
    "span",
    "absolute -top-2.5 right-3 z-10 hidden rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[11.5px] text-neutral-500 shadow-sm group-hover:inline",
    `${time} · ${formatTurnMeta(meta)}`,
  ));
}

/** Wrap each fenced block so a copy button can sit in its corner without
 *  scrolling away with the code, and copy the source text, not the tokens. */
function addCodeCopy(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const wrap = h("div", "group/code relative");
    pre.replaceWith(wrap);
    wrap.append(
      pre,
      copyBtn(
        "absolute right-1.5 top-1.5 cursor-pointer rounded border border-black/[0.08] bg-white/85 px-1.5 py-0.5 text-[11px] text-neutral-500 opacity-0 transition-opacity hover:bg-white hover:text-neutral-800 focus:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100",
        () => code.textContent ?? "",
      ),
    );
  }
}

/** Swap a plain-text bubble to sanitized rendered markdown. `streaming` marks
 *  a mid-turn repaint of a block that is still growing. */
function renderMarkdown(node: HTMLElement, raw: string, streaming = false): void {
  // Attachment links are rewritten to the session's files route first: the
  // sanitizer drops `file:` URLs (rightly), so they'd vanish otherwise.
  const id = deps.sessionId();
  const md = id ? rewriteFileLinks(raw, id) : raw;
  node.innerHTML = DOMPurify.sanitize(marked.parse(md, { async: false }));
  node.classList.remove("whitespace-pre-wrap");
  node.classList.add("md");
  highlightCode(node);
  // A streaming block is rewritten every frame-ish, so the two upgrades that
  // own state of their own wait for the final paint: copy buttons would be
  // recreated mid-click, and attachment cards refetch their bytes.
  if (streaming) return;
  addCodeCopy(node);
  renderAttachments(node);
}

/** An assistant turn: markdown bubble, hover meta, and — for the turn that
 *  just ended or the transcript's last assistant turn on replay (`offer`) —
 *  next-step buttons. A mid-turn text block or an older history turn never
 *  offers them: the run has moved on. */
function renderAssistant(
  node: HTMLElement,
  raw: string,
  meta?: TurnMeta,
  offer = false,
): HTMLElement {
  const { text, suggestions } = splitReply(raw);
  // A deliberate non-answer still happened, and an empty bubble reads as a
  // bug. IM surfaces post nothing at all; the workbench says so instead, with
  // the reason the agent gave, because this is the view the operator debugs in.
  if (isSilentReply({ text, suggestions })) renderSilence(node, silentReason(raw));
  else renderMarkdown(node, text);
  setMetaHint(node, meta);
  if (offer) {
    renderSuggestions(node.parentElement ?? node, suggestions, (label) => deps.send("auto", label));
  }
  return node;
}

/** The placeholder for a turn that chose to say nothing. */
function renderSilence(node: HTMLElement, reason: string | undefined): void {
  node.classList.remove("md", "whitespace-pre-wrap");
  node.replaceChildren(
    h("span", "text-[12.5px] italic text-black/40", reason ? `Stayed silent — ${reason}` : "Stayed silent."),
  );
}

const appendAssistant = (raw: string, meta?: TurnMeta, offer = false): HTMLElement =>
  renderAssistant(appendTurn("assistant", ""), raw, meta, offer);

// --- streaming text ---------------------------------------------------------------

let streamingEl: HTMLElement | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;
let streamDirty = false;

/** Repaint budget for the in-flight block: parsing, sanitizing and
 *  highlighting the whole block on every delta janks a long turn, and text
 *  arrives far faster than it can be read. */
const STREAM_PAINT_MS = 80;

/** Render what has arrived so far as markdown, leading-edge then coalesced.
 *  The suggestions block is stripped here too, so a half-typed `[label]` row
 *  doesn't flash as body text before it becomes buttons. */
function paintStreaming(): void {
  if (streamTimer) {
    streamDirty = true;
    return;
  }
  streamDirty = false;
  if (streamingEl) {
    renderMarkdown(streamingEl, splitReply(streamingEl.dataset.raw ?? "").text, true);
    scrollBottom();
  }
  streamTimer = setTimeout(() => {
    streamTimer = null;
    if (streamDirty) paintStreaming();
  }, STREAM_PAINT_MS);
}

function stopStreamPaint(): void {
  if (streamTimer) clearTimeout(streamTimer);
  streamTimer = null;
  streamDirty = false;
}

/** Append a text-delta to the in-flight streamed block. */
export function appendDelta(text: string): void {
  if (!streamingEl) streamingEl = appendTurn("assistant", "");
  streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + text;
  paintStreaming();
}

/** Finalize the in-flight streamed text block (full markdown render). */
export function finalizeStreaming(offer = false): void {
  if (!streamingEl) return;
  const node = streamingEl;
  streamingEl = null;
  stopStreamPaint();
  renderAssistant(node, node.dataset.raw ?? "", undefined, offer);
}

/** turn-end presentation. `text` is the authoritative full turn text — a
 *  client that joined mid-turn only holds the deltas it happened to see. */
export function completeTurn(text: string | undefined, meta?: TurnMeta): void {
  finishActivity("done");
  if (streamingEl) {
    if (text) streamingEl.dataset.raw = text;
    setMetaHint(streamingEl, meta);
  } else if (text) {
    appendAssistant(text, meta, true);
  }
  finalizeStreaming(true);
}

/** idle without a turn-end: the run was aborted. */
export function interruptTurn(): void {
  finishActivity("interrupted");
  finalizeStreaming();
}

/** Reset everything before a session snapshot re-render. */
export function resetChat(): void {
  turnsPane.replaceChildren();
  streamingEl = null;
  stopStreamPaint();
  resetActivity();
  resetSuggestions();
}

/** Replay a session snapshot into the pane (main.ts fetches, this renders). */
export function renderSnapshot(
  turns: ChatTurn[],
  state: SessionState,
  backgroundRuns: BackgroundRun[],
): void {
  // Detached run cards are placed where the run entered the conversation, not
  // at the end of the transcript: a reload must not sweep every card a session
  // ever launched to the bottom, below turns that came after it.
  const unplacedRuns = new Map(backgroundRuns.map((run) => [run.runId, run]));
  const placeRuns = (runIds: string[]): void => {
    for (const runId of runIds) {
      const run = unplacedRuns.get(runId);
      if (!run) continue;
      renderBackgroundRun(run);
      unplacedRuns.delete(runId);
    }
  };
  // The final assistant turn keeps its next-step buttons across reloads and
  // on every client — an idle session is still waiting on exactly that choice.
  const lastAssistant = turns.reduce((acc, t, i) => (t.role === "assistant" ? i : acc), -1);
  for (const [i, t] of turns.entries()) {
    // The in-flight turn is the trailing one, recognisable while streaming by a
    // tool call without a result or by activity with no answer yet.
    const live =
      state === "streaming" &&
      i === turns.length - 1 &&
      (!t.text || (t.steps?.some((s) => s.kind === "tool" && s.output === undefined) ?? false));
    const steps = t.steps;
    if (steps?.length) {
      replayActivity(steps, t.meta?.durationMs, live);
      // A card belongs under the tool call that launched the run — the result
      // that named its id — because that is where the live stream put it when
      // the run was queued. Anchoring on the callback instead moved every card
      // down to the end of the conversation on the next reload.
      placeRuns([...unplacedRuns.keys()].filter((run) => steps.some((s) => s.output?.includes(run))));
    }
    if (!t.text) continue;
    if (t.role === "system" && t.origin) {
      // Launched elsewhere (cron, another session, an IM turn): the callback
      // that delivered it is the earliest place it can be shown. A batched one
      // carries every run id it delivers.
      placeRuns(t.origin.kind === "task-message" ? [t.origin.runId] : (t.origin.runIds ?? [t.origin.runId]));
      appendSystemInput(t.text, t.origin);
      continue;
    }
    // meta is assistant-only (core/types.ts), so plain turns need no hint.
    if (t.role === "assistant") appendAssistant(t.text, t.meta, state === "idle" && i === lastAssistant);
    else appendTurn(t.role, t.text);
  }
  // Whatever is left never appeared in the transcript at all — the bottom is
  // the only honest place for it.
  for (const run of unplacedRuns.values()) renderBackgroundRun(run);
  scrollBottom(true);
}


