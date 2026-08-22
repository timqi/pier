// The turns pane: chat rows, markdown, streaming text, system-input rows and
// inline user-message edit. main.ts owns session state and the event stream;
// turn-activity.ts owns the Activity groups and background-run cards; this
// module only renders into #turns through the functions it exports.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { formatTurnMeta, silentReason, splitReply } from "../../core/reply.js";
import { sendJson } from "./api.js";
import { imageRow, imageThumb, renderAttachments, rewriteFileLinks } from "./attachments.js";
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
  const s = ROW_STYLE[kind]!;
  // Consecutive rows from the same sender read as one block (Slack grouping).
  const grouped = (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative border-l-2 px-5 ${grouped ? "pt-1 pb-2.5" : "mt-1.5 py-2.5"} ${s.row}`);
  row.dataset.kind = kind;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, text);
  if (markdown) renderMarkdown(node, text);
  row.append(node);
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
  row.append(head, h("div", "whitespace-pre-wrap break-words text-[14px] text-neutral-800", text));
  turnsPane.append(row);
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
  area.value = node.textContent ?? ""; // user turns are plain text
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
  const res = await sendJson(`/api/sessions/${id}/turns/${index}/edit`, { text });
  if (!res.ok) {
    appendTurn("error", `edit failed: ${res.status}`);
    return;
  }
  await deps.reload(id); // the transcript was rewound — reload it
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
  // A turn that is only its options is not silence — the buttons are the reply.
  if (text) renderMarkdown(node, text);
  else if (suggestions.length) renderMarkdown(node, "");
  else renderSilence(node, silentReason(raw));
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

export const appendAssistant = (raw: string, meta?: TurnMeta, offer = false): HTMLElement =>
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
  id: string,
): void {
  // Detached run cards are placed where their result entered the conversation,
  // not at the end of the transcript: a reload must not sweep every card a
  // session ever launched to the bottom, below turns that came after it.
  const unplacedRuns = new Map(backgroundRuns.map((run) => [run.runId, run]));
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
    if (t.steps?.length) replayActivity(t.steps, t.meta?.durationMs, live);
    if (!t.text && !t.images?.length) continue;
    if (t.role === "system" && t.origin) {
      // A callback names every run it delivers (batched ones carry `runIds`).
      const delivered = t.origin.kind === "task-message" ? [t.origin.runId] : (t.origin.runIds ?? [t.origin.runId]);
      for (const runId of delivered) {
        const run = unplacedRuns.get(runId);
        if (!run) continue;
        renderBackgroundRun(run);
        unplacedRuns.delete(runId);
      }
      appendSystemInput(t.text, t.origin);
      continue;
    }
    // meta is assistant-only (core/types.ts), so plain turns need no hint.
    const bubble =
      t.role === "assistant"
        ? appendAssistant(t.text, t.meta, state === "idle" && i === lastAssistant)
        : appendTurn(t.role, t.text);
    // Refs only in the snapshot: each thumbnail pulls its own bytes.
    for (const img of t.images ?? []) {
      imageRow(bubble).append(imageThumb(`/api/sessions/${id}/images/${img.ordinal}`));
    }
  }
  // Whatever is left never reported back — still queued or running, so the
  // bottom is where it belongs.
  for (const run of unplacedRuns.values()) renderBackgroundRun(run);
  scrollBottom(true);
}


