// The turns pane: chat rows, markdown, streaming text, the reply bubble whose
// chip row carries the turn's causes, steps and runs, and inline user-message
// edit. Renders into #turns only.

import { ArrowUpRight, CornerDownLeft, History, Pencil, RefreshCcw, Reply, SquareSlash, type IconNode } from "lucide";
import { icon } from "./icons.js";
import { isSilentReply, replyTopic, silentReason, splitReply, stableBlockEnd, streamBody, streamTail } from "../../core/reply.js";
import { failure, sendJson } from "./api.js";
import { imageRow, inboundAttachment, markFileRefs, renderAttachments, renderFileRefs, rewriteFileLinks } from "./attachments.js";
import { splitInboundFiles } from "../../core/inbound-file.js";
import { splitQuote, splitSpeaker, withoutHeaderLanguage, withoutLanguage, type Quote, type Speaker } from "../../core/identity.js";
import { highlightCode } from "./highlight.js";
import { $, addCodeCopy, agoLabel, h, holdToCopy, markdownBox, stampTime, STREAM_PAINT_MS } from "./dom.js";
import { button } from "./form.js";
import { refreshSuggestions, renderSuggestions, resetSuggestions } from "./suggestions.js";
import {
  activityLive,
  activityProgress,
  chip,
  finishActivity,
  initTurnActivity,
  linkRuns,
  noteTurnError,
  renderBackgroundRun,
  replayActivity,
  resetActivity,
  runBody,
  runCard,
  runHead,
  sealActivity,
  STATE_STYLE,
  stateGlyph,
} from "./turn-activity.js";
import { dividerLine, foldSeed, foldSilence, unfold } from "./folds.js";
import { refreshTopicTags, tagReply } from "./topics.js";
import { rowGestures } from "./row-gestures.js";
import type {
  BackgroundRun,
  ChainReason,
  ChatTurn,
  SessionState,
  SystemInputOrigin,
  TurnMeta,
} from "../../core/types.js";

/** Everything chat rendering needs from the orchestrator (main.ts). */
export interface ChatDeps {
  sessionId: () => string | null;
  /** Where a `src/x.ts:12` in a reply resolves from; null when unknown. */
  sessionCwd: () => string | null;
  /** The IM channel answering this session, `"web"` or null when unknown. */
  sessionChannel: () => string | null;
  sessionState: () => SessionState;
  select: (id: string) => void;
  /** `quote`: the reply a next-step label answers, sent as a Reply to it. */
  send: (mode: "auto" | "steer", label?: string, quote?: QuoteSource) => void;
  /** A user turn this client just drew itself: ledger it so the `user-message`
   *  event reconciles instead of drawing it twice, and show the run as live. */
  ownTurn: (text: string) => void;
  /** Reload the session snapshot if `id` is still the selected session. */
  reload: (id: string) => Promise<void>;
  /** Reply pressed on a row: the composer takes the source to quote. */
  quote: (source: QuoteSource) => void;
}

/** The row a reply answers, as `withQuote` (core/identity.ts) needs it. */
export interface QuoteSource {
  role: Quote["role"];
  at: number;
  text: string;
}

let deps: ChatDeps;

export const turnsPane = $("#turns");

export function initChat(d: ChatDeps): void {
  deps = d;
  // The pane is handed over rather than imported back: see TurnsPane there.
  initTurnActivity(d, { el: turnsPane, scroll: scrollBottom, bulk: () => bulk, chip: chipInto });
}

// --- the turn's bubble ---------------------------------------------------------------
// The reply bubble is the card: a chip row at its top — one chip per cause,
// steps group and launched run, in arrival order, each its own fold over a
// detail under the row — then the text. The bubble opens at the tail with its
// first chip or delta (`data-pending`) and the body fills it when the turn
// ends; a user bubble in between leaves it a chip-row-only bubble where it was.

const isBubble = (el: HTMLElement | null): el is HTMLElement =>
  el?.dataset.kind === "assistant" || el?.dataset.kind === "error";

/** The tail while it is still this turn's. */
function pendingBubble(): HTMLElement | null {
  const tail = turnsPane.lastElementChild as HTMLElement | null;
  return tail && "pending" in tail.dataset ? tail : null;
}

/** `closed`: a bubble no turn fills, above a turn still in flight, which keeps the tail. */
function openBubble(closed = false): HTMLElement {
  const bubble = h("div", `group relative ${ROW_STYLE.assistant.row}`);
  bubble.dataset.kind = "assistant";
  if (!closed) bubble.dataset.pending = "";
  if (readonlyRows) bubble.dataset.readonly = "";
  if (!bulk) bubble.dataset.enter = "";
  turnsPane.insertBefore(bubble, closed ? pendingBubble() : null);
  return bubble;
}

/** An error row is the turn's result only once nothing is in flight: one
 *  reported mid-tool or mid-text (a notify failure, a title fetch) is not. */
const errorSettles = (): boolean => !streamingEl && !activityLive();

/** The bubble's chip row and the details under it, made on the first chip. A
 *  topic tag already on the bubble moves in as the row's first chip. */
function chipSlots(bubble: HTMLElement): [row: HTMLElement, details: HTMLElement] {
  const kids = [...bubble.children] as HTMLElement[];
  const row = kids.find((el) => el.classList.contains("chip-row"));
  if (row) return [row, row.nextElementSibling as HTMLElement];
  const made = h("div", "chip-row mb-1 flex flex-wrap items-center gap-1.5 text-[11.5px] leading-tight");
  const details = h("div", "chip-details");
  const tag = kids.find((el) => el.classList.contains("topic-tag"));
  if (tag) {
    tag.classList.remove("mb-1"); // the row's gap is the tag's now
    made.append(tag);
  }
  bubble.prepend(made, details);
  return [made, details];
}

/** A chip into the turn's bubble: the tail while it is still this turn's, else
 *  a new one opened there. `join`: a run chip joins the tail bubble even after
 *  its text landed — the run was launched by that reply. `alone`: a closed
 *  bubble of its own. A bubble: that one. */
function chipInto(el: HTMLElement, detail: HTMLElement | null, place?: "join" | "alone" | HTMLElement): void {
  const tail = turnsPane.lastElementChild as HTMLElement | null;
  const bubble = typeof place === "object" ? place : place === "alone" ? openBubble(true) : pendingBubble() ?? (place === "join" && isBubble(tail) ? tail : openBubble());
  const [row, details] = chipSlots(bubble);
  row.append(el);
  if (detail) details.append(detail);
  // A run joining a folded reply is in flight: the fold lets that row go.
  if (!bulk && "silent" in bubble.dataset) foldSilence(turnsPane);
  trimRows();
}

/** A turn that ended without a body leaves its bubble as it stands. */
function endTurn(): void {
  const bubble = pendingBubble();
  if (bubble) delete bubble.dataset.pending;
}

// --- scrolling -------------------------------------------------------------------

/** A whole snapshot is going in: reading scrollHeight per row flushes layout
 *  for the entire transcript, a thousand times over a growing pane. */
let bulk = false;

const atBottom = (): boolean =>
  turnsPane.scrollHeight - turnsPane.scrollTop - turnsPane.clientHeight < 80;

/** Tail follow is a state re-applied from what the pane does, not a per-append
 *  test: the pane shrinks under the keyboard and grows after appends (footers,
 *  buttons, highlighting) with no call site to ask. Released when the user
 *  scrolls up, re-armed when their scroll reaches the end. */
let follow = true;

/** For telling a direction from a position: a pin writes scrollTop too, and by
 *  the time that event lands the content has grown (~100px of footer and
 *  buttons), which judged by the bottom alone reads as "the user left". */
let lastTop = 0;

/** Every write of ours moves `lastTop` with it: a pin taken mid-rebuild (the
 *  streamed block gone, the final reply not yet in) lands above where the
 *  reply then ends, and that event must not read as a drag upward. */
function setTop(top: number): void {
  turnsPane.scrollTop = top;
  lastTop = turnsPane.scrollTop;
}

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
    if (follow && !bulk) setTop(turnsPane.scrollHeight);
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

/** A re-render with rows added above the reader puts them back `fromBottom`
 *  px above the end; follow stays armed only if that is the end, or the next
 *  repin would take them to the tail. */
export function keepScroll(fromBottom: number): void {
  setTop(turnsPane.scrollHeight - fromBottom);
  follow = atBottom();
}

export function scrollBottom(force = false): void {
  if (bulk) return;
  if (force) follow = true;
  if (follow) setTop(turnsPane.scrollHeight);
}

/** How long a revealed row stays lit — the CSS animation's length, kept here
 *  too because reduced motion draws the mark without an animation to end. */
const REVEAL_MS = 1200;

/** How a search hit lands (ui/palette.ts). `false` when no row has the stamp:
 *  compacted away, edited out, or trimmed off the top. */
export function revealTurn(role: "user" | "assistant", at: number): boolean {
  const row = turnsPane.querySelector<HTMLElement>(`[data-kind="${role}"][data-at="${at}"]`);
  if (!row) return false;
  reveal(row);
  return true;
}

/** A topic's newest reply on screen, or the newest above `from`. */
function lastOfTopic(problem: string, from?: HTMLElement): HTMLElement | null {
  const rows = [...turnsPane.children] as HTMLElement[];
  for (let i = (from ? rows.indexOf(from) : rows.length) - 1; i >= 0; i--) {
    if (rows[i]!.dataset.kind === "assistant" && rows[i]!.dataset.topic === problem) return rows[i]!;
  }
  return null;
}

/** How a status panel row lands (ui/drawer.ts). `false` when no reply of the topic is on screen. */
export function revealTopic(problem: string): boolean {
  const row = lastOfTopic(problem);
  if (!row) return false;
  reveal(row);
  return true;
}

/** A tag's click: the topic's previous reply; the earliest on screen lights itself. */
const jumpBack = (row: HTMLElement): void => reveal(lastOfTopic(row.dataset.topic ?? "", row) ?? row);

function reveal(row: HTMLElement): void {
  unfold(row);
  follow = false; // walking back into history is leaving the tail
  // Centred, unless the row is taller than the pane: a long reply centred
  // opens on its middle, and reading starts at the top.
  row.scrollIntoView({ block: row.offsetHeight > turnsPane.clientHeight ? "start" : "center" });
  row.dataset.reveal = "";
  setTimeout(() => delete row.dataset.reveal, REVEAL_MS);
}

// --- chat bubbles ------------------------------------------------------------------
// Direction identifies the speaker; system and error rows keep their status tint.

/** The transcript lives on the server; a reload draws the tail again. */
const MAX_ROWS = 500;

/** User turns the trim dropped, so the Nth user row *on screen* still names the
 *  right turn of history() in submitEdit. */
let trimmedUserTurns = 0;
let trimmedRows = 0;
/** The cwds this conversation's callback cards carried, most recent first: a
 *  reply relays its children's paths as they were written, relative to those. */
let callbackCwds: string[] = [];
/** Says how many rows left, because a transcript that just starts in the middle
 *  is indistinguishable from a transcript that lost its beginning. */
let trimNotice: HTMLElement | null = null;

/** An earlier session of the continuous conversation, rendered read-only above the head. */
let readonlyRows = false;

/** Called after every append: the pane grows only from the bottom. Never while
 *  earlier sessions are paged in above: they are exactly what was asked for. */
function trimRows(): void {
  if (turnsPane.querySelector("[data-readonly]")) return;
  let trimmed = false;
  // A seed card on top lost the divider that opens it (folds.ts foldSeed) and goes too.
  while (turnsPane.childElementCount > MAX_ROWS || (turnsPane.firstElementChild as HTMLElement | null)?.dataset.seed !== undefined) {
    const row = turnsPane.firstElementChild as HTMLElement;
    row.remove();
    if (row === trimNotice) continue; // re-placed at the top below
    if (row.dataset.kind === "user") trimmedUserTurns++;
    trimmedRows++;
    trimmed = true;
  }
  if (trimmed) foldSilence(turnsPane); // the fold line may have gone off the top without its rows
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
  // An error while the turn is still in flight — text streaming, a tool owed or
  // just answered — is not its result: a bare row above the bubble, which stays
  // pending, and the group it interrupts keeps collecting. Decided before the
  // seal, which would close a thinking-only group and read the turn as over.
  const mid = kind === "error" && !errorSettles() ? pendingBubble() : null;
  if (!mid) sealActivity();
  const s = ROW_STYLE[kind];
  // A reply or a failed turn is a turn's result: it fills the bubble the turn's
  // chips opened. A user bubble or a status line closes that bubble as it stands.
  const pending = kind === "assistant" || (kind === "error" && !mid) ? pendingBubble() : null;
  if (!pending && !mid) endTurn();
  // Only user messages introduce a clock separator after a conversation gap.
  const stamp = kind === "user" && at !== undefined && stampDue(at) ? at : undefined;
  // Consecutive rows from the same sender read as one block (Slack grouping) —
  // except across a stamp, which is a break in the conversation.
  const prev = ((pending ?? mid)?.previousElementSibling ?? (pending || mid ? null : turnsPane.lastElementChild)) as HTMLElement | null;
  const grouped = stamp === undefined && prev?.dataset.kind === kind;
  const row = pending ?? h("div", "");
  row.className = `group relative ${s.row}`;
  row.dataset.kind = kind;
  delete row.dataset.pending;
  if (readonlyRows) row.dataset.readonly = "";
  if (grouped) row.dataset.grouped = "";
  if (!bulk && !pending) row.dataset.enter = ""; // History replay must not animate every old message.
  const files = kind === "user" ? splitInboundFiles(text) : null;
  const body = files?.text ?? text;
  // The speaker header (core/identity.ts) is written for the model; as body
  // text it buries the message under a raw platform id.
  const speaker = kind === "user" ? splitSpeaker(body) : null;
  const named = speaker?.id || speaker?.when || speaker?.where || speaker?.lang ? speaker : null;
  const quoted = kind === "user" ? splitQuote(named?.text ?? body) : null;
  // Here the operator is the reader; their own name over every message is noise.
  // A platform with opaque ids names the speaker and nothing else, so the
  // caption cannot be gated on the id.
  const caption = named && (named.id ? named.id !== "web" : !!named.name) ? named : null;
  const node = h("div", `whitespace-pre-wrap break-words ${s.body}`, quoted?.text ?? named?.text ?? body);
  // Editing resends the raw text, markers, header and quote included — stripping
  // them from the bubble must not detach the files, or drop who was speaking.
  if (files?.paths.length || named || quoted?.quote || kind === "assistant") node.dataset.raw = text;
  if (markdown) renderMarkdown(node, text);
  if (at !== undefined) setRowTime(row, at);
  if (caption) row.append(speakerLine(caption));
  if (quoted?.quote) {
    row.append(quoteBlock(quoted.quote));
    // A Reply to a topic's row answers it (topics.ts refreshTopicTags), whatever came between.
    const answers = quoteSource(quoted.quote)?.dataset.topic;
    if (answers) row.dataset.answers = answers;
  }
  row.append(node);
  const sessionId = deps.sessionId();
  if (files?.paths.length && sessionId) {
    const strip = imageRow(row);
    for (const path of files.paths) strip.append(inboundAttachment(sessionId, path));
  }
  if (kind === "user" || kind === "assistant") row.append(rowGestures(row, rowTools(kind, row, node), node));
  if (stamp !== undefined) {
    const time = h("div", "my-3 text-center text-[11px] text-neutral-400");
    time.dataset.kind = "time";
    time.dataset.at = String(stamp);
    paintTime(time);
    timeTimer ??= setInterval(paintTimes, 60_000);
    time.title = stampTime(stamp);
    turnsPane.append(time);
  }
  if (mid) mid.before(row);
  else if (!pending) turnsPane.append(row);
  trimRows();
  if (kind === "user" && !bulk) refreshTopicTags();
  scrollBottom();
  return node;
}

/** The caption identifies the IM speaker; clocks sit outside the bubble. */
function speakerLine(speaker: Omit<Speaker, "text">): HTMLElement {
  const line = h("div", "speaker-line mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px] leading-tight opacity-85");
  const who = speaker?.name ?? speaker?.id;
  if (who) {
    const label = h("span", "font-semibold text-inherit", who);
    if (speaker?.id) label.title = speaker.id;
    line.append(label);
  }
  // A named speaker means the message came through an IM; the header's own
  // `place` appears only on a change, so the session's channel names it.
  const channel = deps.sessionChannel();
  if (channel && channel !== "web") {
    line.append(h("span", "text-[10px] uppercase tracking-wide opacity-60", channel));
  }
  return line;
}

/** The row's toolbar in the gutter beside it: Reply on every chat row, Edit on
 *  a user row that is the head's (an earlier session is read-only). A touch
 *  screen shows it only to a keyboard; a finger has the row's gestures. */
function rowTools(kind: "user" | "assistant", row: HTMLElement, node: HTMLElement): HTMLElement {
  const tools = h("div", `message-tools absolute top-1 flex ${kind === "user" ? "right-full flex-row-reverse" : "left-full"}`);
  const tool = (glyph: IconNode, action: string, label: string, title: string, onclick: () => void): HTMLElement => {
    const b = h("button", "flex h-8 w-8 items-center justify-center rounded-full", icon(glyph));
    b.setAttribute("type", "button");
    b.dataset.action = action; // its name in the touch menu (row-gestures.ts)
    b.setAttribute("aria-label", label);
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  if (kind === "user" && !readonlyRows) {
    cancelEdit?.();
    tools.append(tool(Pencil, "Edit", "Edit message", "Edit message — resends it and drops everything after it", () => startEdit(row, node)));
  }
  // What the bubble shows: a user row's header and markers are not its words.
  const reply = tool(Reply, "Reply", "Reply to this message", "Reply — quotes this message under yours", () =>
    deps.quote({ role: kind, at: Number(row.dataset.at), text: shownText(kind, node) }));
  reply.hidden = !("at" in row.dataset); // a streaming reply has no time yet: setRowTime shows it
  tools.append(reply);
  return tools;
}

/** The text a quote of this row carries, and what `quoteSource` matches on. */
const shownText = (kind: "user" | "assistant", node: HTMLElement): string =>
  (kind === "assistant" ? node.dataset.raw : undefined) ?? node.textContent ?? "";

/** Two clamped lines, so a blank line in the source must not be one of them. */
export const excerptText = (excerpt: string): string => splitReply(excerpt).text.replace(/\n{2,}/g, "\n").trim();

/** The quote at the top of a user bubble: `role · time` and the excerpt as the
 *  source showed it; a click jumps to the source when it is on screen. */
function quoteBlock(quote: Quote): HTMLElement {
  const block = h("button", "quote-block mb-1.5 block w-full cursor-pointer text-left");
  block.setAttribute("type", "button");
  block.append(
    h("div", "font-mono text-[10.5px] leading-tight opacity-70", `${quote.role} · ${quote.when.slice(11)}`),
    h("div", "quote-excerpt text-[12.5px] leading-snug opacity-85", excerptText(quote.excerpt)),
  );
  block.onclick = () => {
    const source = quoteSource(quote);
    if (source) reveal(source);
    else block.title = "Not on this screen — an earlier session, or a message trimmed off the top";
  };
  return block;
}

/** The row a quote names: same role and minute, then the one whose text opens
 *  with the excerpt — two replies in one minute are told apart by their words. */
function quoteSource(quote: Quote): HTMLElement | null {
  const rows = [...turnsPane.querySelectorAll<HTMLElement>(`[data-kind="${quote.role}"][data-at]`)]
    .filter((row) => stampTime(Number(row.dataset.at)).slice(0, 16) === quote.when);
  const head = quote.excerpt.slice(0, 40);
  return rows.find((row) => {
    const node = [...row.children].find((c) => c.classList.contains("md") || c.classList.contains("whitespace-pre-wrap")) as HTMLElement | undefined;
    return !!node && shownText(quote.role, node).trim().startsWith(head);
  }) ?? rows[0] ?? null;
}

/** Glyph and caption per input kind. */
const INPUT_KIND: Record<string, [glyph: IconNode, label: string, cls: string]> = {
  "task-delegation": [ArrowUpRight, "delegation", "text-cyan-700"],
  "task-callback": [CornerDownLeft, "callback", "text-cyan-700"],
  "session-seed": [History, "session seed", "text-cyan-700"],
  "chat-command": [SquareSlash, "command", "text-cyan-700"],
  restart: [RefreshCcw, "restarted \u00b7 continuing", "text-cyan-700"],
};

/** Every task text opens with `Key: value` lines naming the run, which the
 *  head row already says; only a card with no source of its own borrows the
 *  first line as a caption. */
function splitMetaBlock(text: string): [meta: string | null, body: string] {
  const at = text.indexOf("\n\n");
  if (at < 0) return [null, text];
  const meta = text.slice(0, at);
  if (meta.length > 600 || meta.split("\n").length > 6) return [null, text];
  return [meta, text.slice(at + 2)];
}

/** Callbacks and delegations are a cause chip of the turn that answers them,
 *  opening to the exchange: the exchange is the reading, the chip its receipt.
 *  A seed folds into its session's divider. A chat command's answer is what
 *  the user asked to see, so it is a standalone open card and never a turn's. */
export function appendSystemInput(text: string, origin: SystemInputOrigin): void {
  const kindKey = origin.kind === "task-message" ? origin.messageKind : origin.kind;
  const [glyph, label, cls] = INPUT_KIND[kindKey] ?? [CornerDownLeft, kindKey.replace("_", " "), "text-cyan-700"];
  sealActivity();
  const state = origin.kind === "task-callback" ? origin.state : undefined;
  const card = runCard(state ? STATE_STYLE[state].edge : "border-l-cyan-500");
  const [meta, body] = splitMetaBlock(withoutLanguage(text));
  const content = runBody(body);
  const glyphEl = (): SVGElement => (state ? stateGlyph(state) : icon(glyph, `h-3 w-3 ${cls}`));
  const labelCls = state ? STATE_STYLE[state].label : cls;
  const name = origin.kind === "session-seed" ? origin.reason
    : origin.kind === "chat-command" ? undefined
    : origin.source?.taskName ?? meta?.split("\n")[0];
  const head = origin.kind === "session-seed"
    ? runHead({ glyph: glyphEl(), label, labelCls, taskName: name, sessionId: origin.previousSessionId })
    : origin.kind === "chat-command"
    ? runHead({ glyph: glyphEl(), label: `/${origin.command}`, labelCls })
    : runHead({
      glyph: glyphEl(),
      label: state ? `${label} \u00b7 ${state}` : label,
      labelCls,
      ...(name ? { taskName: name } : {}),
      ...(origin.source ? { model: origin.source } : {}),
      ...(state === "failed" || state === "interrupted"
        ? { failure: body.split("\n").find((line) => line.trim())?.trim() ?? state }
        : {}),
      runId: origin.runId,
      sessionId: origin.sourceSessionId,
    });
  if (origin.kind === "chat-command" && origin.sessions) linkRuns(content, origin.sessions, deps.select);
  if (origin.kind === "task-callback") {
    // The child wrote these paths, so they resolve against its cwd, not this session's.
    const codes = markFileRefs(content);
    const id = origin.sourceSessionId ?? deps.sessionId();
    if (id) renderFileRefs(codes, id, origin.cwd ? [origin.cwd] : []);
    if (origin.cwd) callbackCwds = [origin.cwd, ...callbackCwds.filter((cwd) => cwd !== origin.cwd)];
  }
  card.append(head, content);
  if (origin.kind === "chat-command") {
    endTurn();
    card.dataset.kind = "system";
    turnsPane.append(card);
    trimRows();
  } else if (origin.kind === "session-seed") {
    endTurn();
    foldSeed(turnsPane, card, origin.reason);
    trimRows();
  } else {
    const cause = chip({ glyph: glyphEl(), label: state ? `${label} \u00b7 ${state}` : label, labelCls, ...(name ? { name } : {}) }, card);
    Object.assign(cause.dataset, { kind: "system", cause: "" });
    if (state) cause.dataset.state = state;
    // The reply's topic when it names none (topics.ts `tagReply`).
    if (origin.kind === "task-callback") cause.dataset.runs = (origin.runIds ?? [origin.runId]).join(",");
    chipInto(cause, card);
  }
  scrollBottom();
}

// --- edit user message ------------------------------------------------------------

let cancelEdit: (() => void) | null = null;
/** Any user row in the pane: the send rewinds the transcript to it, so the
 *  turns under it leave with it. */
const editable = (row: HTMLElement): boolean => row.isConnected && row.dataset.kind === "user";

const hasBody = (row: HTMLElement): boolean => [...row.children].some((c) => c.classList.contains("break-words"));

/** What the rewind takes with the edited row — invisible from the row itself,
 *  and the whole difference between editing the last message and an older one. */
function droppedAfter(row: HTMLElement): number {
  let n = 0;
  for (let el = row.nextElementSibling as HTMLElement | null; el; el = el.nextElementSibling as HTMLElement | null) {
    const kind = el.dataset.kind;
    // A bubble of chips alone holds no message of its own; its cause chips are messages.
    if ((kind === "user" || kind === "assistant" || kind === "system") && hasBody(el)) n++;
    n += el.querySelectorAll("[data-cause]").length;
  }
  return n;
}

function startEdit(row: HTMLElement, node: HTMLElement): void {
  if (!editable(row)) return;
  if (row.querySelector("textarea")) return;
  // One editor at a time: every row has a pencil, and the open one is only
  // reachable through the closure `cancelEdit` holds.
  cancelEdit?.();
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  const area = document.createElement("textarea");
  area.value = withoutHeaderLanguage(node.dataset.raw ?? node.textContent ?? ""); // user turns are plain text
  area.className =
    "block w-full resize-none rounded-xl border border-indigo-300 bg-white px-3 py-2 text-neutral-900 focus:outline-none";
  // Grow with content like the composer does; same 192px cap (max-h-48).
  area.setAttribute("aria-label", "Edit message");
  const submit = button("Send edit", true);
  const dismiss = button("Cancel");
  const dropped = droppedAfter(row);
  const controls = h("div", "mt-2 flex flex-wrap items-center justify-end gap-2");
  if (dropped) {
    controls.append(h(
      "div",
      "mr-auto text-[11.5px] text-neutral-500",
      `sending drops the ${dropped} message${dropped === 1 ? "" : "s"} after this one`,
    ));
  }
  controls.append(dismiss, submit);
  const editor = h("div", "message-editor", area, controls);
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
    row.querySelector<HTMLButtonElement>(".message-tools button")?.focus({ preventScroll: true });
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
  if (!id || !editable(row)) return;
  if (deps.sessionState() !== "idle") {
    appendTurn("error", "can't edit while streaming — stop the turn first");
    return;
  }
  cancelEdit?.();
  // The Nth user row on screen is the Nth user turn of history() — plus the
  // ones the trim took off the top, which history() still holds.
  const users = [...turnsPane.querySelectorAll<HTMLElement>('[data-kind="user"]:not([data-readonly])')];
  const at = users.indexOf(row);
  const index = trimmedUserTurns + at;
  const previousTime = users[at - 1]?.dataset.at;
  lastStampAt = previousTime === undefined ? null : Number(previousTime);
  const separator = row.previousElementSibling as HTMLElement | null;
  if (separator?.dataset.kind === "time") separator.remove();
  // Drawn before the round trip (principle 7): a rewind is exactly "this row
  // and everything under it leaves".
  while (row.nextElementSibling) row.nextElementSibling.remove();
  row.remove();
  foldSilence(turnsPane);
  deps.ownTurn(text);
  // The reconciling event never draws a second row, so this one needs its clock.
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

/** Only user rows ask: an agent turn's time restates the one above it. The
 *  first row always gets one. */
function stampDue(at: number): boolean {
  const prev = lastStampAt;
  lastStampAt = at;
  return prev === null || at - prev >= STAMP_GAP_MS || !sameDay(prev, at);
}

/** Beside the bubble on hover: a native `title` floats an opaque box over the
 *  message under it. Only the clock; the day is on the separator above. */
function setRowTime(row: HTMLElement, at: number): void {
  row.dataset.at = String(at);
  row.dataset.time = stampTime(at).slice(11);
  const reply = row.querySelector<HTMLElement>("[data-action='Reply']");
  if (reply) reply.hidden = false;
}

/** Attachment links are rewritten to the files route first: the sanitizer
 *  drops `file:` URLs. */
function mdBox(raw: string): HTMLElement {
  const id = deps.sessionId();
  return markdownBox(id ? rewriteFileLinks(raw, id) : raw, false);
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
  // Ahead of renderFileRefs: holding a path copies it instead of opening it,
  // and the hold can only swallow a click it was wired before.
  const codes = [...node.querySelectorAll<HTMLElement>("code")].filter((code) => !code.closest("pre"));
  for (const code of codes) holdToCopy(code, () => code.textContent ?? "");
  renderAttachments(node);
  const id = deps.sessionId();
  const cwd = deps.sessionCwd();
  if (id) renderFileRefs(codes, id, [...(cwd ? [cwd] : []), ...callbackCwds.filter((c) => c !== cwd)]);
}

/** `offer`: the live next-step buttons, on the turn that just ended or the
 *  last one on replay; an older turn's are muted and follow its topic. */
function renderAssistant(
  node: HTMLElement,
  raw: string,
  meta?: TurnMeta,
  offer = false,
): HTMLElement {
  const { text, suggestions } = splitReply(raw);
  node.dataset.raw = raw; // what a reply to this row quotes; appendTurn's "" is the placeholder's
  // An empty bubble reads as a bug; this is the view the operator debugs in.
  const silent = isSilentReply({ text, suggestions });
  node.parentElement?.toggleAttribute("data-silent", silent);
  if (silent) renderSilence(node, silentReason(raw));
  else renderMarkdown(node, text);
  if (!readonlyRows) {
    // A pick answers this reply: sent as a Reply to it, so the model reads which offer was taken.
    const row = node.parentElement ?? node;
    const pick = (label: string): void => deps.send("auto", label, { role: "assistant", at: Number(row.dataset.at), text: raw });
    renderSuggestions(row, suggestions, pick, offer, replyTopic(raw));
  }
  // Last, so the clock reads under the whole turn — buttons included.
  if (meta) setRowTime(node.parentElement ?? node, meta.completedAt);
  return node;
}

/** The placeholder for a turn that chose to say nothing. */
function renderSilence(node: HTMLElement, reason: string | undefined): void {
  node.classList.remove("md", "whitespace-pre-wrap");
  node.replaceChildren(
    h("span", "text-[12.5px] italic text-neutral-400", reason ? `Stayed silent — ${reason}` : "Stayed silent."),
  );
}

function appendAssistant(raw: string, meta?: TurnMeta, offer = false): void {
  const node = renderAssistant(appendTurn("assistant", ""), raw, meta, offer);
  tagReply(node.parentElement!, raw, jumpBack, !bulk);
  if (!bulk) {
    foldSilence(turnsPane);
    refreshSuggestions();
    refreshTopicTags();
  }
}

// --- streaming text ---------------------------------------------------------------

let streamingEl: HTMLElement | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;
let streamDirty = false;
/** Raw chars of the in-flight block already rendered into DOM that is kept,
 *  and how many child nodes that DOM is. */
let streamStable = 0;
let streamNodes = 0;

/** Re-parses only the tail past the last closed block: the whole block every
 *  tick is O(N²) and lags the stream. Highlighting (a 40KB turn: ~2.9s of hljs
 *  vs ~0.2s of parsing), copy buttons and attachment cards wait for the final
 *  paint. The suggestions block is stripped so a half-typed `[label]` row does
 *  not flash as body text. */
function paintStreamText(node: HTMLElement): void {
  const raw = node.dataset.raw ?? "";
  while (node.childNodes.length > streamNodes) node.lastChild!.remove();
  const cut = stableBlockEnd(raw, streamStable);
  if (cut > streamStable) {
    node.append(...mdBox(streamBody(raw.slice(streamStable, cut))).childNodes);
    streamStable = cut;
    streamNodes = node.childNodes.length;
  }
  node.append(...mdBox(splitReply(streamTail(raw.slice(streamStable))).text).childNodes);
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

/** Append a text-delta to the in-flight streamed block: the text of the turn's
 *  bubble, under its chip row, until a boundary says it was an update. */
export function appendDelta(text: string): void {
  if (!streamingEl) {
    streamingEl = h("div", `stream break-words ${ROW_STYLE.assistant.body}`);
    (pendingBubble() ?? openBubble()).append(streamingEl);
    streamStable = 0;
    streamNodes = 0;
  }
  streamingEl.dataset.raw = (streamingEl.dataset.raw ?? "") + text;
  paintStreaming();
}

/** A tool or input boundary confirms this text was an intermediate update: it
 *  leaves the bubble for the steps log. */
export function finalizeStreaming(): void {
  const raw = takeStreaming();
  if (raw !== undefined) activityProgress(Date.now(), raw);
}

/** The streamed text out of the bubble once the turn's outcome is known. */
function takeStreaming(): string | undefined {
  if (!streamingEl) return undefined;
  const raw = streamingEl.dataset.raw;
  streamingEl.remove();
  streamingEl = null;
  stopStreamPaint();
  return raw;
}

/** turn-end carries the authoritative final answer, including after reconnect. */
/** `error`: the turn ended on this failure; the error row that follows is its
 *  result, so the bubble stays pending for it. */
export function completeTurn(text: string | undefined, meta?: TurnMeta, error?: string): void {
  if (text === "") finalizeStreaming(); // no final answer: retain provisional text in the log
  const pending = takeStreaming();
  if (error) noteTurnError();
  finishActivity("done");
  const answer = text ?? pending;
  if (answer) appendAssistant(answer, meta, true);
  else if (!error) endTurn();
}

/** An interrupted partial answer stays readable instead of disappearing; a
 *  turn cut short before it spoke leaves a bubble of its chips. */
export function interruptTurn(): void {
  const partial = takeStreaming();
  finishActivity("interrupted");
  if (partial) appendAssistant(partial);
  else endTurn();
}

/** Reset everything before a session snapshot re-render. */
export function resetChat(): void {
  cancelEdit?.();
  clearInterval(timeTimer);
  timeTimer = undefined;
  turnsPane.replaceChildren();
  trimmedUserTurns = 0;
  trimmedRows = 0;
  callbackCwds = [];
  trimNotice = null;
  lastStampAt = null;
  streamingEl = null;
  stopStreamPaint();
  resetActivity();
  resetSuggestions();
}

/** An empty pane while the snapshot loads is indistinguishable from an empty session (§5). */
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

/** The rotation that started the next session, and when. */
export function appendDivider(reason: ChainReason, at: number): void {
  const line = dividerLine(reason, stampTime(at).slice(0, 16));
  line.title = stampTime(at);
  turnsPane.append(line);
  lastStampAt = null; // the next session's first message gets its own clock
}

/** Pages one earlier session in above the rest; also what scrolling to the top presses. */
export function appendPager(onClick: () => void): HTMLButtonElement {
  const more = button("Earlier session");
  more.id = "chain-pager";
  more.onclick = onClick;
  const row = h("div", "my-3 flex justify-center", more);
  row.dataset.kind = "pager";
  turnsPane.append(row);
  return more;
}

/** Replay a session snapshot into the pane (main.ts fetches, this renders).
 *  `readonly`: an earlier session of the continuous conversation — no edits,
 *  no next-step buttons. */
export function renderSnapshot(
  turns: ChatTurn[],
  state: SessionState,
  backgroundRuns: BackgroundRun[],
  readonly = false,
): void {
  chatLoading(false);
  // Run cards are placed where the run entered the conversation, so a reload
  // does not sweep them all to the bottom.
  const unplacedRuns = new Map(backgroundRuns.map((run) => [run.runId, run]));
  // A card belongs to the turn that was running when its run was queued: the
  // first turn to finish at or after that moment. Same process, same clock.
  // A goal's step no turn launched: its chip finds its goal's (turn-activity.ts).
  const queuedBy = (completedAt: number): string[] =>
    [...unplacedRuns].filter(([, run]) => !run.goalStep && run.queuedAt <= completedAt).map(([runId]) => runId);
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
  // A failed turn offers nothing, so it must not take the row from that answer.
  const lastAssistant = readonly ? -1 : turns.reduce((acc, t, i) => (t.role === "assistant" && t.text && !t.error ? i : acc), -1);
  bulk = true;
  readonlyRows = readonly;
  try {
    for (const [i, t] of turns.entries()) {
      // The last assistant entry of a running snapshot is still provisional.
      const live = state === "streaming" && i === turns.length - 1 && t.role === "assistant";
      const steps = t.steps;
      if (steps?.length) {
        replayActivity(steps, t.meta?.durationMs, live, i, !!t.error);
        // Launched during the turn: chips of the bubble the answer fills.
        if (t.meta) placeRuns(queuedBy(t.meta.completedAt));
        // Cut short before it spoke: the steps chip is the bubble's whole content.
        if (!live && !t.text && !t.error) endTurn();
      }
      if (t.role === "system" && t.origin && t.text) {
        // Launched elsewhere: the callback is the earliest place it can be shown.
        if (t.origin.kind === "restart") { if (t.origin.runId) placeRuns([t.origin.runId]); }
        else if (t.origin.kind !== "session-seed" && t.origin.kind !== "chat-command") placeRuns(t.origin.kind === "task-message" ? [t.origin.runId] : (t.origin.runIds ?? [t.origin.runId]));
        appendSystemInput(t.text, t.origin);
        continue;
      }
      // meta is assistant-only (core/types.ts), so plain turns need no hint.
      if (t.text) {
        if (live) appendDelta(t.text);
        else if (t.role === "assistant") appendAssistant(t.text, t.meta, state === "idle" && i === lastAssistant);
        else appendTurn(t.role, t.text, false, t.at);
      }
      // A refused prompt has no text at all; its row is the reason alone.
      if (t.error) appendTurn("error", t.error);
    }
    // Whatever is left never appeared in the transcript at all — the bottom is
    // the only honest place for it.
    for (const run of unplacedRuns.values()) renderBackgroundRun(run);
  } finally {
    bulk = false; // a row that threw must not leave the pane unable to scroll
    readonlyRows = false;
  }
  foldSilence(turnsPane);
  refreshSuggestions();
  refreshTopicTags();
  scrollBottom(true);
}


