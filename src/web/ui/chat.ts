// The turns pane: chat rows, markdown, streaming text, system-input rows and
// inline user-message edit. main.ts owns session state and the event stream;
// turn-activity.ts owns the Activity groups and background-run cards; this
// module only renders into #turns through the functions it exports.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { isSilentReply, silentReason, splitReply, stableBlockEnd, streamBody } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { imageRow, inboundAttachment, renderAttachments, rewriteFileLinks } from "./attachments.js";
import { splitInboundFiles } from "../../core/inbound-file.js";
import { splitSpeaker, type Speaker } from "../../core/identity.js";
import { highlightCode } from "./highlight.js";
import { $, agoLabel, copyBtn, externalLinks, h, stampTime } from "./dom.js";
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
  initTurnActivity(d, { el: turnsPane, append: appendTurn, scroll: scrollBottom, bulk: () => bulk });
}

// --- scrolling -------------------------------------------------------------------
// Stick to the bottom only when the user is already there (avibe behavior);
// force on own sends so the conversation follows the user's action.

/** A whole snapshot is going in: every row and every activity step would
 *  otherwise measure the pane, and reading scrollHeight flushes layout for the
 *  entire transcript — a session with a thousand steps paid that a thousand
 *  times, each flush over a bigger pane. One scroll at the end says the same
 *  thing. */
let bulk = false;

const atBottom = (): boolean =>
  turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;

/** Tail follow. Being at the bottom is a *state*, not a per-append test, and
 *  it is re-applied from what the pane *does* rather than from the handful of
 *  call sites that remember to ask. Both halves are needed: the pane shrinks
 *  under the queue panel, the composer and the keyboard without a scroll event
 *  to notice it, and it grows after the appends are over — a finished turn is
 *  re-rendered with copy buttons, attachment cards and next-step buttons, an
 *  activity group is sealed into the row, code is highlighted — none of which
 *  goes through scrollBottom, which is why the last lines stayed below the
 *  fold. Released the moment the user scrolls away themselves. */
let follow = true;

turnsPane.addEventListener("scroll", () => {
  if (!bulk) follow = atBottom();
}, { passive: true });

/** At most one re-pin per frame: a streaming block mutates every ~80ms and
 *  each scrollTop write flushes layout. 0 = nothing scheduled. */
let pinning = 0;

function repin(): void {
  if (!follow || bulk || pinning) return;
  pinning = requestAnimationFrame(() => {
    pinning = 0;
    // Re-checked: a frame is long enough for the user to have scrolled away.
    if (follow && !bulk) turnsPane.scrollTop = turnsPane.scrollHeight;
  });
}

new ResizeObserver(repin).observe(turnsPane);
// An image or a thumbnail that finishes decoding after its row was appended
// moves the bottom with no mutation of its own. Capture: `load` never bubbles.
turnsPane.addEventListener("load", repin, true);
new MutationObserver(repin).observe(turnsPane, {
  childList: true,
  subtree: true,
  characterData: true,
});

/** Re-arm tail follow when the user comes back to the end — focusing the
 *  composer there means "I'm watching the tail", so keep it in view. */
export function followTail(): void {
  if (atBottom()) follow = true;
}

export function scrollBottom(force = false): void {
  if (bulk) return;
  if (force) follow = true;
  if (follow) turnsPane.scrollTop = turnsPane.scrollHeight;
}

// --- chat rows (Slack-style full-width) ----------------------------------------------
// No sender labels: user rows carry an accent bar + tint, agent rows stay plain.

/** Rows the pane keeps. Nothing ever left it: a workbench open for a day held
 *  every turn, every replayed activity group and every highlighted code block
 *  of every session it visited. The transcript itself lives on the server, and
 *  the tail is what a chat is read from — so the oldest rows leave, and a
 *  reload (or an edit's rewind) draws the tail again from the snapshot. */
const MAX_ROWS = 500;

/** User turns the trim dropped, so the Nth user row *on screen* still names the
 *  right turn of history() in submitEdit. */
let trimmedUserTurns = 0;
let trimmedRows = 0;
/** Says how many rows left, because a transcript that just starts in the middle
 *  is indistinguishable from a transcript that lost its beginning. */
let trimNotice: HTMLElement | null = null;

/** Called after every append: the pane grows only from the bottom. */
function trimRows(): void {
  while (turnsPane.childElementCount > MAX_ROWS) {
    const row = turnsPane.firstElementChild as HTMLElement;
    row.remove();
    if (row === trimNotice) continue; // re-placed at the top below
    if (row.dataset.kind === "user") trimmedUserTurns++;
    trimmedRows++;
  }
  if (!trimmedRows) return;
  if (!trimNotice) {
    trimNotice = h("div", "px-5 py-2 text-center text-[11.5px] italic text-neutral-400");
    trimNotice.dataset.kind = "trim"; // every row in the pane names its kind
  }
  trimNotice.textContent = `${trimmedRows} earlier row${trimmedRows === 1 ? "" : "s"} not shown — still in the transcript, not on this screen`;
  if (turnsPane.firstElementChild !== trimNotice) turnsPane.prepend(trimNotice);
}

const ROW_STYLE: Record<string, { row: string; body: string }> = {
  user: { row: "border-l-indigo-500 bg-indigo-50", body: "text-neutral-900" },
  assistant: { row: "border-l-transparent", body: "text-neutral-900" },
  error: { row: "border-l-red-400 bg-red-50", body: "text-red-700" },
  system: { row: "border-l-cyan-500 bg-cyan-50", body: "text-neutral-800" },
};

// No rules between rows: tint and accent say who is speaking, the gap only says
// whether the speaker changed (4px within a run, 6px across one), and the
// padding is generous — the block breathes, the lines don't.
export function appendTurn(
  kind: keyof typeof ROW_STYLE,
  text: string,
  markdown = false,
  at?: number,
): HTMLElement {
  sealActivity();
  // The steps that just ran are this message's own: they move inside the row
  // as its caption line. Detaching first also restores sender grouping, which
  // a group sitting between two agent rows used to break.
  const steps = kind === "assistant" ? takeActivityGroup() : null;
  const s = ROW_STYLE[kind]!;
  // Only a user row can carry a clock (see stampDue), and only when the gap
  // rule says the time changed something. An untimed row — an error, a block
  // still streaming — is skipped rather than stamped `Date.now()`.
  const stamp = kind === "user" && at !== undefined && stampDue(at) ? at : undefined;
  // Consecutive rows from the same sender read as one block (Slack grouping) —
  // except across a stamp, which is a break in the conversation.
  const grouped = stamp === undefined &&
    (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative border-l-2 px-5 ${grouped ? "pt-1 pb-2.5" : "mt-1.5 py-2.5"} ${s.row}`);
  row.dataset.kind = kind;
  // A user message may end in inbound-file markers (core/inbound-file.ts):
  // the typed text stays a plain bubble, the files render as thumbs/cards
  // below.
  const files = kind === "user" ? splitInboundFiles(text) : null;
  const body = files?.text ?? text;
  // An IM turn carries core/identity.ts's speaker header as its first line.
  // It is written for the model, and read as body text it buries the message
  // under a raw platform id — so it becomes the row's caption instead.
  const speaker = kind === "user" ? splitSpeaker(body) : null;
  const named = speaker?.id || speaker?.when ? speaker : null;
  // A Console turn is headed `operator<web>` so a shared session can tell it
  // from the IM speakers — but here the operator is the reader, and their own
  // name over every message they typed is noise. The header's clock goes with
  // it: `stamp` is the row's own, on the same "only where it changed
  // something" rule identity.ts wrote the header by, and two clocks on one
  // line spelt two ways is worse than either.
  const caption = named?.id && named.id !== "web" ? named : null;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, named?.text ?? body);
  // Editing resends the raw text, markers and header included — stripping them
  // from the bubble must not detach the files, or drop who was speaking.
  if (files?.paths.length || named) node.dataset.raw = text;
  if (markdown) renderMarkdown(node, text);
  // flow-root: the step line floats into the message's first line, and a row
  // that doesn't contain its float leaks it over whatever comes next while the
  // text is still empty.
  if (steps) {
    row.classList.add("flow-root");
    row.append(steps);
  }
  if (caption || stamp !== undefined) row.append(speakerLine(caption, stamp));
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
  trimRows();
  scrollBottom();
  return node;
}

/** The caption above a user message: who (IM only — the mention id on hover is
 *  the one thing the header carries that a name cannot replace) and when. */
function speakerLine(speaker: Omit<Speaker, "text"> | null, at?: number): HTMLElement {
  const line = h("div", "mb-1 flex items-baseline gap-2 text-[11.5px] leading-tight");
  const who = speaker?.name ?? speaker?.id;
  if (who) {
    const label = h("span", "font-semibold text-indigo-700", who);
    if (speaker?.id) label.title = speaker.id;
    line.append(label);
  }
  if (at !== undefined) line.append(stampEl(at, "font-mono text-[11px] text-indigo-600"));
  return line;
}

export function appendSystemInput(text: string, origin: SystemInputOrigin): void {
  const kind = origin.kind === "task-callback"
    ? "Task callback"
    : origin.kind === "task-message"
      ? origin.messageKind === "decision" ? "Decision needed" : `Task ${origin.messageKind.replace("_", " ")}`
      : "Agent task input";
  sealActivity();
  const row = h("div", "group relative mt-1.5 border-l-2 border-l-cyan-500 bg-cyan-50 px-5 py-2.5");
  row.dataset.kind = "system";
  const head = h("div", "mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase text-cyan-800", h("span", "flex-none", kind));
  // What produced it, not just which run did: the task's own name, the model
  // and the effort, all riding in the origin (core/types.ts) so the card never
  // has to fetch a run to say what it is. Same vocabulary as the session
  // header's chips — a model is a chip, an effort is plain text beside it.
  const src = origin.source;
  if (src) head.append(h("span", "min-w-0 truncate font-medium normal-case text-cyan-700", src.taskName));
  if (origin.sourceSessionId && origin.sourceSessionId !== "console") {
    const source = h("button", "truncate font-mono normal-case text-cyan-700 hover:underline", origin.sourceSessionId.slice(0, 12));
    source.title = "Open source session";
    source.onclick = () => deps.select(origin.sourceSessionId!);
    head.append(h("span", "text-cyan-400", "from"), source);
  }
  if (src?.model) {
    const model = h("span", "flex-none rounded bg-cyan-100 px-1.5 py-px font-mono font-medium normal-case text-cyan-800", src.model.id);
    model.title = `${src.model.provider} / ${src.model.id}`;
    head.append(model);
  }
  if (src?.thinking) {
    const effort = h("span", "flex-none font-mono font-normal normal-case text-cyan-600", src.thinking);
    effort.title = "Reasoning effort";
    head.append(effort);
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
  trimRows();
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
  // The Nth user row on screen is the Nth user turn of history() — plus the
  // ones the trim took off the top, which history() still holds.
  const index = trimmedUserTurns + [...turnsPane.querySelectorAll('[data-kind="user"]')].indexOf(row);
  // Drawn before the round trip: reloading the snapshot instead blanked the
  // pane for the length of a fetch, so the transcript flashed away and came
  // back (principle 7). A rewind is exactly "this row and everything under it
  // leaves", and the re-sent text is an ordinary optimistic user turn.
  while (row.nextElementSibling) row.nextElementSibling.remove();
  row.remove();
  deps.ownTurn(text);
  // Timestamped like the composer's optimistic turn: the event this row
  // reconciles never draws a second one, so a row without it would have no
  // clock until the next reload.
  appendTurn("user", text, false, Date.now());
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

// --- when things happened ---------------------------------------------------------
// A clock on every row was chrome nobody read, and on hover it did not exist at
// all on a phone. Two placements instead, and the same rule identity.ts already
// applies to IM headers: a time is written only where it *changed* something.
// A rule across the pane was the third placement and said it loudest, so the
// question "when did this part of the conversation happen" is answered where it
// is asked — on the message that reopened it.

/** A new day, or this much silence, is what makes the clock worth a line. */
const STAMP_GAP_MS = 10 * 60_000;

/** When the last stamped row happened — a stamp is a diff against it. */
let lastStampAt: number | null = null;

const sameDay = (a: number, b: number): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString();

/** Does this row owe a clock? Only user rows ask: an agent turn happens
 *  *because* of the message above it, so its own time restates one already on
 *  screen, and the last reply carries the reading worth copying anyway. The
 *  first row of a transcript always gets one — "when did this start" is the
 *  question a pane you just opened is asking. */
function stampDue(at: number): boolean {
  const prev = lastStampAt;
  lastStampAt = at;
  return prev === null || at - prev >= STAMP_GAP_MS || !sameDay(prev, at);
}

/** Wall clock and age, in the one full spelling Session info uses for "Last
 *  reply" (dom.ts): one fact on two surfaces gets one wording. The moment rides
 *  on the element, so the ticker repaints every stamp in the pane without a
 *  registry to keep in step with the trim. */
function stampEl(at: number, cls: string): HTMLElement {
  const el = h("div", cls);
  el.dataset.at = String(at);
  paintStamp(el);
  stampTimer ??= setInterval(paintStamps, 60_000);
  return el;
}

function paintStamp(el: HTMLElement): void {
  const at = Number(el.dataset.at);
  el.textContent = `${stampTime(at)} · ${agoLabel(at)}`;
}

/** The newest assistant turn, and only it, carries its own clock: the answer
 *  you are looking at is the one whose time you wanted. */
let replyStamp: HTMLElement | null = null;

/** The age half goes stale where it sits, and a reply still claiming "just now"
 *  an hour later is worse than no age at all — so it is repainted, by a ticker
 *  that exists only while a stamp does. */
let stampTimer: ReturnType<typeof setInterval> | undefined;

function paintStamps(): void {
  const stamps = turnsPane.querySelectorAll<HTMLElement>("[data-at]");
  if (!stamps.length) {
    clearInterval(stampTimer);
    stampTimer = undefined;
    return;
  }
  for (const el of stamps) paintStamp(el);
}

function setReplyStamp(node: HTMLElement, meta?: TurnMeta): void {
  if (!meta) return;
  replyStamp?.remove();
  replyStamp = stampEl(meta.completedAt, "mt-1 font-mono text-[11px] text-neutral-400");
  (node.parentElement ?? node).append(replyStamp);
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
        "absolute right-1.5 top-1.5 cursor-pointer rounded border border-black/[0.08] bg-white/85 px-1.5 py-0.5 text-[11px] text-neutral-500 opacity-0 transition-opacity hover:bg-white hover:text-neutral-800 focus:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100 dark:border-neutral-200",
        () => code.textContent ?? "",
      ),
    );
  }
}

/** One markdown fragment, sanitized, in a detached box the caller moves into
 *  place. Attachment links are rewritten to the session's files route first:
 *  the sanitizer drops `file:` URLs (rightly), so they'd vanish otherwise. */
function mdBox(raw: string): HTMLElement {
  const id = deps.sessionId();
  const box = h("div", "");
  box.innerHTML = DOMPurify.sanitize(marked.parse(id ? rewriteFileLinks(raw, id) : raw, { async: false }));
  externalLinks(box);
  return box;
}

/** Swap a plain-text bubble to sanitized rendered markdown. */
function renderMarkdown(node: HTMLElement, raw: string): void {
  node.replaceChildren(...mdBox(raw).childNodes);
  node.classList.remove("whitespace-pre-wrap");
  node.classList.add("md");
  highlightCode(node);
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
  if (offer) {
    renderSuggestions(node.parentElement ?? node, suggestions, (label) => deps.send("auto", label));
  }
  // Last, so the clock reads under the whole turn — buttons included.
  setReplyStamp(node, meta);
  return node;
}

/** The placeholder for a turn that chose to say nothing. */
function renderSilence(node: HTMLElement, reason: string | undefined): void {
  node.classList.remove("md", "whitespace-pre-wrap");
  node.replaceChildren(
    h("span", "text-[12.5px] italic text-neutral-400", reason ? `Stayed silent — ${reason}` : "Stayed silent."),
  );
}

const appendAssistant = (raw: string, meta?: TurnMeta, offer = false): HTMLElement =>
  renderAssistant(appendTurn("assistant", ""), raw, meta, offer);

// --- streaming text ---------------------------------------------------------------

let streamingEl: HTMLElement | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;
let streamDirty = false;
/** Raw chars of the in-flight block already rendered into DOM that is kept,
 *  and how many child nodes that DOM is. */
let streamStable = 0;
let streamNodes = 0;

/** Repaint budget for the in-flight block: parsing and sanitizing on every
 *  delta janks a long turn, and text arrives far faster than it can be read. */
const STREAM_PAINT_MS = 80;

/**
 * Render what has arrived so far as markdown, re-parsing only the tail past
 * the last closed block boundary — the blocks before it keep the DOM they were
 * rendered into once. Re-rendering the *whole* block every tick made a turn
 * cost O(N²): a long reply passes the paint budget somewhere in its middle and
 * from there the text lags the stream by seconds, which is the one thing a
 * stream must not do.
 *
 * Everything either expensive or stateful still waits for the final paint.
 * Highlighting is the expensive one: it re-tokenizes every fence it is handed
 * and each repaint throws the result away — a 40KB turn measured ~2.9s of hljs
 * against ~0.2s of parsing, i.e. the streaming cost was almost entirely colour
 * nobody had time to read. Copy buttons would be recreated mid-click and
 * attachment cards would refetch their bytes, so they wait too.
 *
 * The suggestions block is stripped from the tail — the only place it can be —
 * so a half-typed `[label]` row doesn't flash as body text before it becomes
 * buttons.
 */
function paintStreamText(node: HTMLElement): void {
  const raw = node.dataset.raw ?? "";
  while (node.childNodes.length > streamNodes) node.lastChild!.remove();
  const cut = stableBlockEnd(raw, streamStable);
  if (cut > streamStable) {
    node.append(...mdBox(streamBody(raw.slice(streamStable, cut))).childNodes);
    streamStable = cut;
    streamNodes = node.childNodes.length;
  }
  node.append(...mdBox(splitReply(raw.slice(streamStable)).text).childNodes);
  node.classList.remove("whitespace-pre-wrap");
  node.classList.add("md");
}

/** Leading-edge then coalesced, on the budget above. */
function paintStreaming(): void {
  if (streamTimer) {
    streamDirty = true;
    return;
  }
  streamDirty = false;
  if (streamingEl) {
    paintStreamText(streamingEl);
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
  if (!streamingEl) {
    streamingEl = appendTurn("assistant", "");
    streamStable = 0;
    streamNodes = 0;
  }
  streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + text;
  paintStreaming();
}

/** Finalize the in-flight streamed text block (full markdown render). */
export function finalizeStreaming(offer = false, meta?: TurnMeta): void {
  if (!streamingEl) return;
  const node = streamingEl;
  streamingEl = null;
  stopStreamPaint();
  renderAssistant(node, node.dataset.raw ?? "", meta, offer);
}

/** turn-end presentation. `text` is the authoritative full turn text — a
 *  client that joined mid-turn only holds the deltas it happened to see. */
export function completeTurn(text: string | undefined, meta?: TurnMeta): void {
  finishActivity("done");
  if (streamingEl) {
    if (text) streamingEl.dataset.raw = text;
    // meta goes through the finalize, not around it: the clock has to land
    // after the next-step buttons the same render appends.
    finalizeStreaming(true, meta);
    return;
  }
  if (text) appendAssistant(text, meta, true);
}

/** idle without a turn-end: the run was aborted. */
export function interruptTurn(): void {
  finishActivity("interrupted");
  finalizeStreaming();
}

/** Reset everything before a session snapshot re-render. */
export function resetChat(): void {
  turnsPane.replaceChildren();
  trimmedUserTurns = 0;
  trimmedRows = 0;
  trimNotice = null;
  lastStampAt = null;
  replyStamp = null;
  streamingEl = null;
  stopStreamPaint();
  resetActivity();
  resetSuggestions();
}

/** The pane between selecting a session and its snapshot arriving. An empty
 *  pane there is indistinguishable from an empty session — and a long
 *  transcript keeps it empty long enough to look broken (principle 5b). */
export function chatLoading(on: boolean): void {
  if (!on) {
    turnsPane.querySelector('[data-kind="loading"]')?.remove();
    return;
  }
  const box = h("div", "flex flex-col gap-3 px-5 py-4");
  box.dataset.kind = "loading";
  // Text-shaped bars, not a spinner: the pane fills with what is coming, so
  // the transcript replacing it doesn't read as a jump.
  for (const width of ["w-2/5", "w-4/5", "w-3/5", "w-1/3", "w-2/3"]) {
    box.append(h("div", `skeleton h-3.5 ${width}`));
  }
  turnsPane.append(box);
}

/** Replay a session snapshot into the pane (main.ts fetches, this renders). */
export function renderSnapshot(
  turns: ChatTurn[],
  state: SessionState,
  backgroundRuns: BackgroundRun[],
): void {
  chatLoading(false);
  // Detached run cards are placed where the run entered the conversation, not
  // at the end of the transcript: a reload must not sweep every card a session
  // ever launched to the bottom, below turns that came after it.
  const unplacedRuns = new Map(backgroundRuns.map((run) => [run.runId, run]));
  // A card belongs to the turn that was running when its run was queued: the
  // first turn to finish at or after that moment. Same process, same clock.
  const queuedBy = (completedAt: number): string[] =>
    [...unplacedRuns].filter(([, run]) => run.queuedAt <= completedAt).map(([runId]) => runId);
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
  bulk = true;
  try {
    for (const [i, t] of turns.entries()) {
      // The in-flight turn is the trailing one, recognisable while streaming by a
      // tool call without a result or by activity with no answer yet.
      const live =
        state === "streaming" &&
        i === turns.length - 1 &&
        (!t.text || (t.steps?.some((s) => s.kind === "tool" && !s.done) ?? false));
      const steps = t.steps;
      if (steps?.length) {
        replayActivity(steps, t.meta?.durationMs, live, i);
        // Placed here, between the steps and the answer, because that is where
        // the live stream put the card when the run was queued. Anchoring on
        // the callback instead moved every card down to the end of the
        // conversation on the next reload.
        if (t.meta) placeRuns(queuedBy(t.meta.completedAt));
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
      else appendTurn(t.role, t.text, false, t.at);
    }
    // Whatever is left never appeared in the transcript at all — the bottom is
    // the only honest place for it.
    for (const run of unplacedRuns.values()) renderBackgroundRun(run);
  } finally {
    bulk = false; // a row that threw must not leave the pane unable to scroll
  }
  scrollBottom(true);
}


