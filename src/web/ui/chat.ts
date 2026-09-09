// The turns pane: chat rows, markdown, streaming text, system-input rows and
// inline user-message edit. main.ts owns session state and the event stream;
// turn-activity.ts owns the Activity groups and background-run cards; this
// module only renders into #turns through the functions it exports.

import { ArrowUpRight, CircleQuestionMark, CornerDownLeft, Pencil, type IconNode } from "lucide";
import { icon } from "./icons.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { isSilentReply, silentReason, splitReply, stableBlockEnd, streamBody } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { imageRow, inboundAttachment, renderAttachments, rewriteFileLinks } from "./attachments.js";
import { splitInboundFiles } from "../../core/inbound-file.js";
import { splitSpeaker, type Speaker } from "../../core/identity.js";
import { highlightCode } from "./highlight.js";
import { $, agoLabel, copyBtn, externalLinks, h, stampTime, STREAM_PAINT_MS } from "./dom.js";
import { button } from "./form.js";
import { renderSuggestions, resetSuggestions } from "./suggestions.js";
import {
  activityProgress,
  clampedBody,
  discardProgress,
  finishActivity,
  initTurnActivity,
  renderBackgroundRun,
  replayActivity,
  resetActivity,
  runCard,
  runHead,
  sealActivity,
  STATE_STYLE,
  stateGlyph,
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
  showRun: (runId: string) => void;
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
 *  fold. Released when the user scrolls up, and re-armed when a scroll of
 *  theirs reaches the end again. */
let follow = true;

/** Where the pane was at the previous scroll event, so a *direction* can be
 *  told from a position: a pin writes scrollTop too, and by the time that
 *  event is delivered the content it aimed at has usually grown another line —
 *  a finished reply gains its footer and next-step buttons, ~100px. Judging
 *  every scroll event by the bottom alone read that growth as "the user left",
 *  so the tail died on the first completed turn and never came back. */
let lastTop = 0;

turnsPane.addEventListener("scroll", () => {
  const top = turnsPane.scrollTop;
  // A few pixels of slack: a pin lands on a fractional offset, and rounding
  // must not pass for a drag upward.
  const up = top < lastTop - 4;
  lastTop = top;
  if (!bulk && (up || atBottom())) follow = atBottom();
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

/** How long a revealed row stays lit — the CSS animation's length, kept here
 *  too because reduced motion draws the mark without an animation to end. */
const REVEAL_MS = 1200;

/** Bring the turn stamped `at` into view and light it for a moment: how a
 *  search hit lands (ui/palette.ts). Rows carry the stamp the hit was indexed
 *  by — a user turn's own, a reply's completion (setRowTime). `false` when no
 *  row has it: compacted away, edited out, or trimmed off the top of the pane. */
export function revealTurn(role: "user" | "assistant", at: number): boolean {
  const row = turnsPane.querySelector<HTMLElement>(`[data-kind="${role}"][data-at="${at}"]`);
  if (!row) return false;
  reveal(row);
  return true;
}

/** Bring the newest still-running background run into view: what the header's
 *  running chip points at (session-header.ts), because a card sits where the
 *  run was launched and scrolls away as the conversation goes on. `false` when
 *  no card is in the pane — the trim dropped it off the top. */
export function revealActiveRun(): boolean {
  const cards = turnsPane.querySelectorAll<HTMLElement>('[data-kind="background-run"][data-active]');
  const card = cards[cards.length - 1];
  if (!card) return false;
  reveal(card);
  return true;
}

function reveal(row: HTMLElement): void {
  follow = false; // walking back into history is leaving the tail
  // Centred, unless the row is taller than the pane: a long reply centred
  // opens on its middle, and reading starts at the top.
  row.scrollIntoView({ block: row.offsetHeight > turnsPane.clientHeight ? "start" : "center" });
  row.dataset.reveal = "";
  setTimeout(() => delete row.dataset.reveal, REVEAL_MS);
}

// --- chat bubbles ------------------------------------------------------------------
// Direction identifies the speaker; system and error rows keep their status tint.

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

const ROW_STYLE = {
  user: { row: "", body: "text-inherit" },
  assistant: { row: "", body: "text-neutral-900" },
  error: { row: "border-l-red-400 bg-red-50", body: "text-red-700" },
  system: { row: "system-card border-l-cyan-500", body: "text-neutral-500" },
};

// Message direction and material live in CSS; data-kind also keeps edits,
// history trimming and tool activity attached to the same row.
export function appendTurn(
  kind: keyof typeof ROW_STYLE,
  text: string,
  markdown = false,
  at?: number,
): HTMLElement {
  sealActivity();
  // Keep the completed work beside its reply, outside the reading bubble.
  const steps = kind === "assistant" ? takeActivityGroup() : null;
  const s = ROW_STYLE[kind];
  // Only user messages introduce a clock separator after a conversation gap.
  const stamp = kind === "user" && at !== undefined && stampDue(at) ? at : undefined;
  // Consecutive rows from the same sender read as one block (Slack grouping) —
  // except across a stamp, which is a break in the conversation.
  const grouped = stamp === undefined &&
    (turnsPane.lastElementChild as HTMLElement | null)?.dataset.kind === kind;
  const row = h("div", `group relative ${s.row}`);
  row.dataset.kind = kind;
  if (grouped) row.dataset.grouped = "";
  if (!bulk) row.dataset.enter = ""; // History replay must not animate every old message.
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
  if (at !== undefined) setRowTime(row, at);
  if (caption) row.append(speakerLine(caption));
  row.append(node);
  const sessionId = deps.sessionId();
  if (files?.paths.length && sessionId) {
    const strip = imageRow(row);
    for (const path of files.paths) strip.append(inboundAttachment(sessionId, path));
  }
  if (kind === "user") {
    cancelEdit?.();
    turnsPane.querySelector(".message-edit")?.remove();
    const edit = h("button", "message-edit absolute right-full top-1 flex h-8 w-8 items-center justify-center rounded-full");
    edit.title = "Edit latest message — resends it and replaces the reply";
    edit.setAttribute("type", "button");
    edit.setAttribute("aria-label", "Edit message");
    edit.append(icon(Pencil));
    edit.onclick = () => startEdit(row, node);
    row.append(edit);
  }
  if (stamp !== undefined) {
    const time = h("div", "my-3 text-center text-[11px] text-neutral-400");
    time.dataset.kind = "time";
    time.dataset.at = String(stamp);
    paintTime(time);
    timeTimer ??= setInterval(paintTimes, 60_000);
    time.title = stampTime(stamp);
    turnsPane.append(time);
  }
  if (steps) turnsPane.append(steps);
  turnsPane.append(row);
  trimRows();
  scrollBottom();
  return node;
}

/** The caption identifies the IM speaker; clocks sit outside the bubble. */
function speakerLine(speaker: Omit<Speaker, "text">): HTMLElement {
  const line = h("div", "mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px] leading-tight opacity-85");
  const who = speaker?.name ?? speaker?.id;
  if (who) {
    const label = h("span", "font-semibold text-inherit", who);
    if (speaker?.id) label.title = speaker.id;
    line.append(label);
  }
  return line;
}

/** Glyph and caption per input kind; the decision is the one that wants a
 *  look, so it alone carries a colour. */
const INPUT_KIND: Record<string, [glyph: IconNode, label: string, cls: string]> = {
  "task-delegation": [ArrowUpRight, "delegated", "text-cyan-700"],
  "task-callback": [CornerDownLeft, "callback", "text-cyan-700"],
  decision: [CircleQuestionMark, "decision needed", "text-amber-700"],
};

/** Every task text (tasks/callbacks.ts, messages.ts, groups.ts, agent.ts) is a
 *  block of `Key: value` lines naming the run, a blank line, then the message.
 *  The head row already says which run, so the block is not drawn; only a
 *  card with no source of its own (a batch, a group) borrows its first line
 *  as a caption. The text itself is untouched — it is what the model saw. */
function splitMetaBlock(text: string): [meta: string | null, body: string] {
  const at = text.indexOf("\n\n");
  if (at < 0) return [null, text];
  const meta = text.slice(0, at);
  if (meta.length > 600 || meta.split("\n").length > 6) return [null, text];
  return [meta, text.slice(at + 2)];
}

export function appendSystemInput(text: string, origin: SystemInputOrigin): void {
  const kindKey = origin.kind === "task-message" ? origin.messageKind : origin.kind;
  const [glyph, label, cls] = INPUT_KIND[kindKey] ?? [CornerDownLeft, kindKey.replace("_", " "), "text-cyan-700"];
  sealActivity();
  const state = origin.kind === "task-callback" ? origin.state : undefined;
  const row = runCard(state ? STATE_STYLE[state].edge : kindKey === "decision" ? "border-l-amber-400" : "border-l-cyan-500");
  row.dataset.kind = "system";
  const [meta, body] = splitMetaBlock(text);
  // What produced it, not just which run did: the task's own name, the model
  // and the effort, all riding in the origin (core/types.ts) so the card never
  // has to fetch a run to say what it is. A callback also says how the run
  // ended, in the run card's own colours, so the two agree at a glance.
  const head = runHead({
    glyph: state ? stateGlyph(state) : icon(glyph, `h-3 w-3 ${cls}`),
    label: state ? `${label} \u00b7 ${state}` : label,
    labelCls: state ? STATE_STYLE[state].label : cls,
    ...(origin.source
      ? { taskName: origin.source.taskName, model: origin.source.model, thinking: origin.source.thinking }
      : meta ? { taskName: meta.split("\n")[0]! } : {}),
    runId: origin.runId,
    sessionId: origin.sourceSessionId,
  });
  row.append(head);
  row.append(...clampedBody(body));
  turnsPane.append(row);
  trimRows();
  scrollBottom();
}

// --- edit user message ------------------------------------------------------------
// Pencil on a user row → inline textarea; Enter rewinds the transcript to just
// before that message server-side and re-sends the edited text, so the old
// message stops polluting the context. Later turns are dropped with it.

let cancelEdit: (() => void) | null = null;
const isLatestUser = (row: HTMLElement): boolean =>
  row.isConnected && turnsPane.querySelector(".message-edit")?.parentElement === row;

function startEdit(row: HTMLElement, node: HTMLElement): void {
  if (!isLatestUser(row)) return;
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  if (row.querySelector("textarea")) return;
  const area = document.createElement("textarea");
  area.value = node.dataset.raw ?? node.textContent ?? ""; // user turns are plain text
  area.className =
    "block w-full resize-none rounded-xl border border-indigo-300 bg-white px-3 py-2 text-neutral-900 focus:outline-none";
  // Grow with content like the composer does; same 192px cap (max-h-48).
  area.setAttribute("aria-label", "Edit latest message");
  const submit = button("Send edit", true);
  const dismiss = button("Cancel");
  const editor = h("div", "message-editor", area, h("div", "mt-2 flex flex-wrap justify-end gap-2", dismiss, submit));
  const grow = (): void => {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 192)}px`;
    submit.disabled = !area.value.trim();
  };
  area.oninput = grow;
  row.dataset.editing = "";
  node.classList.add("hidden");
  node.after(editor);
  grow();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const cancel = (): void => {
    editor.remove();
    node.classList.remove("hidden");
    delete row.dataset.editing;
    cancelEdit = null;
  };
  cancelEdit = cancel;
  dismiss.onclick = () => {
    cancel();
    row.querySelector<HTMLButtonElement>(".message-edit")?.focus({ preventScroll: true });
  };
  submit.onclick = () => {
    const text = area.value.trim();
    if (text) void submitEdit(row, text);
  };
  editor.onkeydown = (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss.click();
    }
    if (ev.key === "Enter" && !ev.shiftKey && ev.target === area) {
      ev.preventDefault();
      submit.click();
    }
  };
}

async function submitEdit(row: HTMLElement, text: string): Promise<void> {
  const id = deps.sessionId();
  if (!id || !isLatestUser(row)) return;
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  cancelEdit?.();
  // The Nth user row on screen is the Nth user turn of history() — plus the
  // ones the trim took off the top, which history() still holds.
  const users = [...turnsPane.querySelectorAll<HTMLElement>('[data-kind="user"]')];
  const index = trimmedUserTurns + users.indexOf(row);
  const previousTime = users[users.length - 2]?.dataset.at;
  lastStampAt = previousTime === undefined ? null : Number(previousTime);
  const separator = row.previousElementSibling as HTMLElement | null;
  if (separator?.dataset.kind === "time") separator.remove();
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
// Clocks separate conversations after a gap; precise message times live in the
// row's gutter on hover so the reading bubbles carry only their content.

/** A new day, or this much silence, is what makes the clock worth a line. */
const STAMP_GAP_MS = 10 * 60_000;

/** When the last stamped row happened — a stamp is a diff against it. */
let lastStampAt: number | null = null;
let timeTimer: ReturnType<typeof setInterval> | undefined;

function paintTime(el: HTMLElement): void {
  const at = Number(el.dataset.at);
  el.textContent = `${stampTime(at).slice(0, 16)} · ${agoLabel(at)}`;
}

function paintTimes(): void {
  const times = turnsPane.querySelectorAll<HTMLElement>('[data-kind="time"]');
  for (const time of times) paintTime(time);
  if (!times.length) { clearInterval(timeTimer); timeTimer = undefined; }
}

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

function setReplyStamp(node: HTMLElement, meta?: TurnMeta): void {
  if (meta) setRowTime(node.parentElement ?? node, meta.completedAt);
}

/** When this row happened. Drawn beside the bubble on hover (style.css): a
 *  native `title` floats an opaque box over the message under it, which is the
 *  one thing a reader hovering a transcript is trying to read. Only the clock
 *  is shown — the day is on the separator line above it. */
function setRowTime(row: HTMLElement, at: number): void {
  row.dataset.at = String(at);
  row.dataset.time = stampTime(at).slice(11);
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
  // Colour lands when its chunk does, which may be after the copy buttons —
  // those hang off <pre>, the element highlightCode() never replaces.
  void highlightCode(node);
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
    streamingEl = activityProgress(Date.now());
    streamStable = 0;
    streamNodes = 0;
  }
  streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + text;
  paintStreaming();
}

/** A tool or input boundary confirms this text was an intermediate update. */
export function finalizeStreaming(): void {
  if (!streamingEl) return;
  const node = streamingEl;
  streamingEl = null;
  stopStreamPaint();
  node.classList.remove("md");
  node.classList.add("whitespace-pre-wrap");
  node.textContent = node.dataset.raw ?? "";
}

/** Move the provisional text out of the log once the turn's outcome is known. */
function takeStreaming(): string | undefined {
  if (!streamingEl) return undefined;
  const raw = streamingEl.dataset.raw;
  discardProgress(streamingEl);
  streamingEl = null;
  stopStreamPaint();
  return raw;
}

/** turn-end carries the authoritative final answer, including after reconnect. */
export function completeTurn(text: string | undefined, meta?: TurnMeta): void {
  if (text === "") finalizeStreaming(); // no final answer: retain provisional text in the log
  const pending = takeStreaming();
  finishActivity("done");
  const answer = text ?? pending;
  if (answer) appendAssistant(answer, meta, true);
}

/** An interrupted partial answer stays readable instead of disappearing. */
export function interruptTurn(): void {
  const partial = takeStreaming();
  finishActivity("interrupted");
  if (partial) appendAssistant(partial);
}

/** Reset everything before a session snapshot re-render. */
export function resetChat(): void {
  cancelEdit?.();
  clearInterval(timeTimer);
  timeTimer = undefined;
  turnsPane.replaceChildren();
  trimmedUserTurns = 0;
  trimmedRows = 0;
  trimNotice = null;
  lastStampAt = null;
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
      // The last assistant entry of a running snapshot is still provisional.
      const live = state === "streaming" && i === turns.length - 1 && t.role === "assistant";
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
      if (live) appendDelta(t.text);
      else if (t.role === "assistant") appendAssistant(t.text, t.meta, state === "idle" && i === lastAssistant);
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


