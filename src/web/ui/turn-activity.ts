// What a turn did besides speak: the per-turn Activity group (thinking + tool
// steps) and the background runs, rendered as chips in the reply bubble's chip
// row (chat.ts), each chip its own fold over its detail.

import { Check, LoaderCircle, Minus, Pause, X, type IconNode } from "lucide";
import { icon } from "./icons.js";
import { getJson } from "./api.js";
import type { ChatDeps } from "./chat.js";
import { detailsRow, h, STREAM_PAINT_MS } from "./dom.js";
import { MAX_STEP_OUTPUT } from "../../core/types.js";
import type { ActivityStep, BackgroundRun, RunModel } from "../../core/types.js";

/** Handed over at init rather than imported: chat.ts imports this module, and
 *  importing it back is a runtime cycle. */
interface TurnsPane {
  el: HTMLElement;
  scroll: (force?: boolean) => void;
  /** A whole snapshot is being replayed: no step may measure layout. */
  bulk: () => boolean;
  /** A chip and its detail into the turn's bubble: the tail while it is still
   *  this turn's, else a new one opened there. `join`: a run chip joins the
   *  tail bubble even after its text landed; `alone`: a closed bubble of its
   *  own; a bubble: that one. */
  chip: (chip: HTMLElement, detail: HTMLElement | null, place?: "join" | "alone" | HTMLElement) => void;
}

let deps: ChatDeps;
let turns: TurnsPane;

/** Wired by initChat — the two modules share one deps object. */
export function initTurnActivity(d: ChatDeps, pane: TurnsPane): void {
  deps = d;
  turns = pane;
}

// --- the run head ---------------------------------------------------------------------
// Every card that names a run, here and in chat.ts, says the same things in
// the same places.

const shortId = (id: string): string => id.slice(0, 8);

interface RunHead {
  glyph?: SVGElement;
  /** The kind of card or the run's state, whichever the card is about;
   *  absent under a chip that already says it. */
  label?: string;
  labelCls: string;
  taskName?: string;
  /** What the run worked on, as it recorded it: one badge, `tier · id · level`. */
  model?: RunModel;
  /** Plain facts between the name and the ids: mode, duration. */
  note?: string;
  /** Absent on a card no run produced (a session seed). */
  runId?: string;
  /** The session doing the work when it is not this one; "console" is nobody. */
  sessionId?: string | null;
  /** A failed or interrupted run's first line. */
  failure?: string;
}

/** Quiet card body; the coloured edge and labelled chip carry type/status. */
export const runCard = (tone: string): HTMLElement => h("div", `system-card relative rounded-xl px-3 py-2.5 ${tone}`);
export const runBody = (text: string): HTMLElement =>
  h("div", "mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-normal text-neutral-500", text);

/** `/status`'s text names a run as `run <id8>…` (core/reply.ts `openRunText`);
 *  each one whose session `sessions` carries opens it — in the chat card and the Status panel. */
export function linkRuns(content: HTMLElement, sessions: Record<string, string>, open: (sessionId: string) => void): void {
  const text = content.textContent ?? "";
  const parts: (Node | string)[] = [];
  let at = 0;
  for (const m of text.matchAll(/\brun ([\w-]+)(…?)/g)) {
    const [token, id = "", cut] = m;
    const matches = Object.keys(sessions).filter((r) => (cut ? r.startsWith(id) : r === id));
    if (matches.length > 1) {
      parts.push(text.slice(at, m.index), h("span", "", `${token} (ambiguous run prefix — cannot locate session)`));
      at = m.index + token.length;
      continue;
    }
    const runId = matches[0];
    if (!runId) continue;
    const link = h("button", "text-indigo-600 hover:underline", token);
    link.setAttribute("type", "button");
    link.title = `Open run ${runId}'s session`;
    link.onclick = () => open(sessions[runId]!);
    parts.push(text.slice(at, m.index), link);
    at = m.index + token.length;
  }
  if (parts.length) content.replaceChildren(...parts, text.slice(at));
}

/** Anything the caller appends after this lands right of the ids. */
export function runHead(o: RunHead): HTMLElement {
  const head = h("div", "run-head flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500");
  if (o.glyph) head.append(o.glyph);
  if (o.label) head.append(h("span", `run-label flex-none font-semibold ${o.labelCls}`, o.label));
  // `basis-0`: a wrapping flex row breaks before it shrinks an item, and a
  // subagent's name is its whole prompt line.
  if (o.taskName) head.append(h("span", "min-w-0 grow basis-0 truncate text-[12.5px] font-medium text-neutral-800 max-md:order-1 max-md:basis-full max-md:whitespace-normal max-md:line-clamp-2", o.taskName));
  if (o.failure) {
    const failure = h("span", `run-failure min-w-0 truncate text-[12.5px] ${o.labelCls}`, o.failure);
    failure.title = o.failure;
    head.append(failure);
  }
  const { tier, model, thinking } = o.model ?? {};
  if (tier || model || thinking) {
    const badge = h("span", "run-model font-mono text-neutral-500");
    if (tier) badge.append(h("span", "run-tier", tier));
    if (model) badge.append(h("span", "run-model-id", model.id));
    if (thinking) badge.append(h("span", "run-thinking", thinking));
    badge.title = [tier && `Tier ${tier}`, model && `${model.provider} / ${model.id}`, thinking && `Reasoning ${thinking}`].filter(Boolean).join(" · ");
    head.append(h("span", "run-model-line flex-none", badge));
  }
  const meta = h("div", "run-meta ml-auto flex min-w-0 flex-wrap items-center gap-x-2 font-mono");
  if (o.note) meta.append(h("span", "run-note flex-none", o.note));
  // The run id is text; the indigo session chip is the link. What each is
  // stays in its tooltip.
  if (o.runId) {
    const run = h("span", "run-id flex-none", shortId(o.runId));
    run.title = `Run ${o.runId}`;
    meta.append(run);
  }
  if (o.sessionId && o.sessionId !== "console") {
    const id = o.sessionId;
    const session = h("button", "run-session flex-none cursor-pointer text-indigo-600 hover:underline pointer-coarse:min-h-11", shortId(id));
    session.title = `Open session ${id}`;
    session.onclick = () => deps.select(id);
    meta.append(session);
  }
  head.append(meta);
  return head;
}

// --- chips ------------------------------------------------------------------------
// A chip is its fold: the button naming one thing the turn did, and while open
// its detail lies under the chip row. Every chip starts closed and opens only
// by its own click, closing any other open chip in its row: one detail per bubble.
// A replayed steps log fetches its detail on the first one.

/** What a chip says; a chip re-painted keeps its element, detail and state. */
interface ChipSpec {
  glyph?: Element;
  label: string;
  labelCls: string;
  /** The run's name, in the bubble's type. */
  name?: string;
}

const CHIP_CLASS = "chip run-label inline-flex max-w-full items-center gap-1 text-left";
const chipDetails = new WeakMap<Element, HTMLElement>();
const lazyLoaders = new WeakMap<Element, () => void>();

export function chip(o: ChipSpec, detail?: HTMLElement): HTMLElement {
  const el = h("button", CHIP_CLASS);
  el.setAttribute("type", "button");
  paintChip(el, o);
  if (detail) {
    detail.hidden = true;
    chipDetails.set(el, detail);
    el.setAttribute("aria-expanded", "false");
    el.onclick = () => setChipOpen(el, detail.hidden === true);
  }
  return el;
}

export function paintChip(el: HTMLElement, o: ChipSpec): void {
  el.className = `${CHIP_CLASS} ${o.labelCls}`;
  el.replaceChildren(
    ...(o.glyph ? [o.glyph] : []),
    h("span", "flex-none font-semibold", o.label),
    ...(o.name ? [h("span", "chip-name min-w-0 truncate font-medium text-neutral-800", o.name)] : []),
  );
}

export function setChipOpen(el: HTMLElement, open: boolean): void {
  const detail = chipDetails.get(el);
  if (!detail) return;
  if (open) for (const other of el.parentElement?.children ?? []) {
    if (other !== el && other.hasAttribute("data-open")) setChipOpen(other as HTMLElement, false);
  }
  detail.hidden = !open;
  el.setAttribute("aria-expanded", String(open));
  el.toggleAttribute("data-open", open);
  if (open) lazyLoaders.get(el)?.();
}

// --- background runs (detached task calls made from this session) ------------------

/** Run state colours are shared by detached runs and callback summaries. */
export const STATE_STYLE: Record<BackgroundRun["state"], { edge: string; label: string; glyph: IconNode }> = {
  queued: { edge: "border-l-amber-400", label: "text-amber-700", glyph: LoaderCircle },
  running: { edge: "border-l-neutral-400", label: "text-neutral-600", glyph: LoaderCircle },
  succeeded: { edge: "border-l-green-500", label: "text-green-700", glyph: Check },
  failed: { edge: "border-l-red-500", label: "text-red-600", glyph: X },
  cancelled: { edge: "border-l-neutral-300", label: "text-neutral-500", glyph: Minus },
  interrupted: { edge: "border-l-amber-400", label: "text-amber-700", glyph: Pause },
  skipped: { edge: "border-l-neutral-300", label: "text-neutral-500", glyph: Minus },
};

/** The state's glyph: a spinner while it is still moving. */
export const stateGlyph = (state: BackgroundRun["state"]): SVGElement =>
  icon(STATE_STYLE[state].glyph, `h-3 w-3 ${state === "queued" || state === "running" ? "spinner" : ""} ${STATE_STYLE[state].label}`);

const runChips = new Map<string, HTMLElement>();

/** The chip's detail, drawn once and re-headed on every status: a reader who
 *  opened it must not watch it snap shut when the run moves on. */
const runDetails = new WeakMap<HTMLElement, { card: HTMLElement; prompt: HTMLElement | null }>();

export function renderBackgroundRun(run: BackgroundRun): void {
  // Chips leave the pane without telling us (rewind, trim); one held here
  // after the pane let go is where the trimmed DOM survives.
  for (const [id, el] of runChips) if (!el.isConnected) runChips.delete(id);
  let el = runChips.get(run.runId);
  const fresh = !el;
  const spec = { glyph: stateGlyph(run.state), label: `run · ${run.state}`, labelCls: STATE_STYLE[run.state].label, name: run.taskName };
  if (!el) {
    const prompt = run.prompt === null ? null : runBody(run.prompt);
    const card = runCard(STATE_STYLE[run.state].edge);
    el = chip(spec, card);
    el.dataset.kind = "background-run";
    if (run.goalId) el.dataset.goal = run.goalId;
    el.dataset.task = run.taskId;
    runChips.set(run.runId, el);
    runDetails.set(el, { card, prompt });
  } else paintChip(el, spec);
  el.dataset.state = run.state;
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.queuedAt)) / 1000));
  const { card, prompt } = runDetails.get(el)!;
  card.className = runCard(STATE_STYLE[run.state].edge).className;
  // No control on the card: the run's page, one click away on its id, is where
  // a run is stopped.
  const head = runHead({
    glyph: stateGlyph(run.state),
    label: `run · ${run.state}`,
    labelCls: STATE_STYLE[run.state].label,
    taskName: run.taskName,
    note: `${run.sessionMode ?? "task"} · ${String(seconds)}s${run.queuedMessages > 0 ? ` · ${String(run.queuedMessages)} queued` : ""}`,
    model: run,
    runId: run.runId,
    sessionId: run.targetSessionId,
  });
  card.replaceChildren(head, ...(prompt ? [prompt] : []));
  // Pier launched it, not the reply at the tail: it joins the bubble of its
  // goal's latest chip, or outside a goal its task's (a lead's earlier run).
  if (fresh && run.byPier) turns.chip(el, card, kinChips(run).at(-1)?.closest<HTMLElement>("[data-kind='assistant'], [data-kind='error']") ?? "alone");
  else if (fresh) turns.chip(el, card, "join");
  turns.scroll();
}

const kinChips = (run: BackgroundRun): HTMLElement[] =>
  [...turns.el.querySelectorAll<HTMLElement>("[data-kind='background-run']")]
    .filter((c) => (run.goalId ? c.dataset.goal === run.goalId : c.dataset.task === run.taskId));

// --- activity group ------------------------------------------------------------------

type ActivityStatus = "running" | "done" | "failed" | "interrupted";

interface ToolRow {
  el: HTMLDetailsElement;
  statusEl: HTMLElement;
  outputPre: HTMLElement;
}

interface Activity {
  /** The steps chip, `data-kind="activity"`; its detail is `rowsEl`, the log. */
  chip: HTMLElement;
  statusIcon: HTMLElement | SVGElement;
  headline: HTMLElement;
  rowsEl: HTMLElement;
  toolRows: Map<string, ToolRow>;
  thinking: Thinking | null;
  steps: number;
  failedSteps: number;
  startTs: number;
  sawError: boolean; // turn-level error event — fails the whole group
}

let activity: Activity | null = null; // the live (running) group

// --- the thinking row -----------------------------------------------------------------
// Painted on the stream's cadence like the reply text: per token it would
// re-read and re-split the whole tail for a row most turns never open.

/** `text` is everything the row has been handed, painted or not. */
interface Thinking {
  pre: HTMLElement;
  summary: HTMLElement;
  text: string;
}

/** The row deltas are accumulating into. Outlives `activity.thinking`, which a
 *  tool call clears: the tail still owed then belongs to *this* row's pre. */
let think: Thinking | null = null;
let thinkTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function drawThinking(): void {
  if (!think) return;
  think.text = think.text.slice(-4000);
  think.pre.textContent = think.text;
  // Markdown emphasis and heading marks on the label line read as noise.
  const line = (think.text.split("\n").filter(Boolean).pop() ?? "").replace(/^[\s*_#]+|[\s*_]+$/g, "") || "thinking…";
  const label = think.summary.lastElementChild as HTMLElement;
  label.textContent = line.length > 90 ? "…" + line.slice(-90) : line;
}

/** Leading-edge then coalesced, the same shape chat.ts paints text with. */
function paintThinking(): void {
  if (thinkTimer) {
    thinkDirty = true;
    return;
  }
  thinkDirty = false;
  drawThinking();
  thinkTimer = setTimeout(() => {
    thinkTimer = null;
    if (thinkDirty) paintThinking();
  }, STREAM_PAINT_MS);
}

/** Each place a row stops receiving text paints what the last tick still held. */
function flushThinking(): void {
  if (thinkTimer) clearTimeout(thinkTimer);
  thinkTimer = null;
  if (thinkDirty) drawThinking();
  thinkDirty = false;
}

/** Keyed by the steps chip so a transcript reload collects them with it. */
interface DetailRow {
  tool: string;
  call: string;
  preview: HTMLElement;
  argsPre: HTMLElement;
  outputPre: HTMLElement;
}
const detailRows = new WeakMap<HTMLElement, DetailRow[]>();
const rowsOf = (group: HTMLElement): DetailRow[] => {
  const rows = detailRows.get(group) ?? [];
  detailRows.set(group, rows);
  return rows;
};

/** A chat row is going in below: later steps belong to a new group underneath,
 *  or work shows above the answer it came after. A group still waiting on a
 *  tool result stays open for that tool-end. */
export function sealActivity(): void {
  if (activity && !activity.toolRows.size) finishActivity("done");
}

/** A group still collecting steps (a tool result owed): the turn is not over,
 *  so a row going in now is not its result. */
export const activityLive = (): boolean => activity !== null;

/** Reset before a session snapshot re-render (chat.ts resetChat). */
export function resetActivity(): void {
  activity = null;
  think = null; // the pre it was painting goes with the pane
  flushThinking();
  runChips.clear();
}

/** The steps chip's colour names the outcome; running is neutral, the spinner carries the motion. */
const STATUS_STYLE: Record<ActivityStatus, string> = {
  running: "text-neutral-600",
  done: "text-neutral-500",
  failed: "text-red-600",
  interrupted: "text-amber-700",
};

const STATUS_ICON: Record<Exclude<ActivityStatus, "running" | "done">, IconNode> = {
  failed: X,
  interrupted: Pause,
};

function statusIconEl(status: ActivityStatus): HTMLElement | SVGElement {
  if (status === "running") return icon(LoaderCircle, "spinner");
  // Done is the common case and has nothing to say — the step count is the
  // whole message, so only the states that want attention carry a glyph.
  if (status === "done") return h("span", "hidden");
  return icon(STATUS_ICON[status], "h-3 w-3");
}

function ensureActivity(ts: number): Activity {
  if (activity) return activity;
  const statusIcon = statusIconEl("running");
  // Caps at ~10 step rows, then scrolls: an opened log can't swallow the chat.
  const rowsEl = h("div", "activity-log flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain rounded-xl px-2 py-1.5 text-[11.5px] leading-normal ring-1 ring-inset ring-neutral-200 bg-black/[0.02] dark:bg-neutral-100");
  const el = chip({ glyph: statusIcon, label: "working…", labelCls: STATUS_STYLE.running }, rowsEl);
  const headline = el.lastElementChild as HTMLElement;
  headline.classList.add("min-w-0", "truncate");
  el.dataset.kind = "activity";
  el.dataset.status = "running";
  tailFollow(el, rowsEl);
  turns.chip(el, rowsEl);
  turns.scroll();
  activity = { chip: el, statusIcon, headline, rowsEl, toolRows: new Map(), thinking: null, steps: 0, failedSteps: 0, startTs: ts, sawError: false };
  return activity;
}

/** Text a tool or reasoning boundary confirmed as an update, not the reply:
 *  it leaves the bubble for the log (chat.ts finalizeStreaming). */
export function activityProgress(ts: number, text: string): void {
  const a = ensureActivity(ts);
  flushThinking();
  a.thinking = null;
  a.steps += 1;
  const node = h("div", "whitespace-pre-wrap break-words text-[12.5px] text-neutral-600", text);
  // 2px edge + pl-5 lands the text on the tool rows' column (px-1 + h-3 chevron + gap-1.5);
  // the hairline is the one mark that says the model is speaking.
  const row = h("div", "border-l-2 border-neutral-200 py-0.5 pl-5", node);
  row.dataset.kind = "progress";
  a.rowsEl.append(row);
  activityHeadline(a, "running", "writing…");
  tailSteps(a);
  turns.scroll();
}

/** Opening lands on the newest step and a running group follows the tail;
 *  scrolling off the bottom stops the following until they come back down. */
function tailFollow(el: HTMLElement, rowsEl: HTMLElement): void {
  rowsEl.dataset.follow = "1";
  rowsEl.addEventListener("scroll", () => {
    const atBottom = rowsEl.scrollHeight - rowsEl.scrollTop - rowsEl.clientHeight < 24;
    rowsEl.dataset.follow = atBottom ? "1" : "";
  });
  const toggle = el.onclick;
  el.onclick = (ev) => {
    toggle?.call(el, ev);
    if (rowsEl.hidden) return;
    rowsEl.scrollTop = rowsEl.scrollHeight;
    rowsEl.dataset.follow = "1";
  };
}

/** Skipped on replay and while closed: reading scrollHeight flushes layout for
 *  the whole transcript, once per step, for nothing on screen. */
function tailSteps(a: Activity): void {
  if (turns.bulk() || a.rowsEl.hidden || !a.rowsEl.dataset.follow) return;
  a.rowsEl.scrollTop = a.rowsEl.scrollHeight;
}

function activityHeadline(a: Activity, status: ActivityStatus, latest?: string): void {
  const secs = Math.max(1, Math.round((Date.now() - a.startTs) / 1000));
  // Done has nothing to say: the step count is the whole line.
  const outcome = status === "running" ? "working" : status === "done" ? "" : status;
  const parts = [outcome, a.steps ? `${a.steps} step${a.steps === 1 ? "" : "s"}` : "", `${secs}s`, status === "running" ? latest : ""];
  a.headline.textContent = parts.filter(Boolean).join(" · ");
  a.chip.dataset.status = status;
  a.chip.className = `${CHIP_CLASS} ${STATUS_STYLE[status]}`;
  const icon = statusIconEl(status);
  a.statusIcon.replaceWith(icon);
  a.statusIcon = icon;
}

export function finishActivity(status: ActivityStatus): void {
  if (!activity) return;
  flushThinking(); // the last tokens of the turn are part of the turn
  // Any still-running tool rows were cut short.
  for (const row of activity.toolRows.values()) {
    if (row.el.dataset.state === "running") toolState(row, "interrupted");
  }
  // One failed step doesn't fail the group — its red row says enough. All-red
  // is reserved for every tool step failing, or a turn-level error (sawError),
  // which wins over a tool it cut short so live and replay agree.
  const toolSteps = rowsOf(activity.chip).length;
  const allFailed = toolSteps > 0 && activity.failedSteps === toolSteps;
  activityHeadline(
    activity,
    activity.sawError || (allFailed && status === "done") ? "failed"
      : status === "done" && activity.toolRows.size ? "interrupted" : status,
  );
  activity = null;
}

/** A turn-level error event fails the whole group when it closes. */
export function noteTurnError(): void {
  if (activity) activity.sawError = true;
}

/** Sliced before the collapse so a 200KB `write` argument isn't regex-scanned
 *  for 100 characters. */
function argsPreview(argsText: string): string {
  const short = argsText.slice(0, 400).replace(/\s+/g, " ");
  return short.length > 100 ? short.slice(0, 100) + "…" : short;
}

export function activityToolStart(ts: number, id: string, name: string, args: unknown): void {
  const a = ensureActivity(ts);
  a.steps += 1;
  flushThinking(); // the preceding thinking row stops receiving text here
  a.thinking = null;
  const argsText = JSON.stringify(args, null, 2) ?? "";
  const statusEl = h("span", "ml-auto flex flex-none");
  // min-w-0, or a flex item's min-content floor keeps an unbreakable argument
  // (a path, a URL) at full width and truncate never gets to run.
  const preview = h("span", "min-w-0 truncate text-neutral-500", argsPreview(argsText));
  const { el } = detailsRow("rounded-md px-1 py-0.5 font-mono text-[12.5px] hover:bg-black/[0.03] dark:hover:bg-neutral-100", [
    h("span", "flex-none font-semibold", name),
    preview,
    statusEl,
  ]);
  const argsPre = h("pre", "max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/[0.04] p-1.5 text-[12px] dark:bg-neutral-100", argsText);
  const outputPre = h("pre", "hidden max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded bg-black/[0.04] p-1.5 text-[12px] dark:bg-neutral-100");
  el.append(h("div", "mt-1 flex flex-col gap-1 pl-4", argsPre, outputPre));
  // A replayed row arrives without args or output — they are fetched when the
  // group is opened, and this is where that fill writes.
  rowsOf(a.chip).push({ tool: name, call: id, preview, argsPre, outputPre });
  const row = { el, statusEl, outputPre };
  toolState(row, "running");
  a.toolRows.set(id, row);
  a.rowsEl.append(el);
  tailSteps(a);
  activityHeadline(a, "running", name);
  turns.scroll();
}

/** The row's state is on its element, the glyph its only rendering: the same
 *  vocabulary as a run card's. Failure colours the summary alone, so args and
 *  output below it stay readable. */
function toolState(row: ToolRow, state: "running" | "succeeded" | "failed" | "interrupted"): void {
  row.el.dataset.state = state;
  row.statusEl.replaceChildren(stateGlyph(state));
  row.statusEl.title = state;
  const summary = row.el.firstElementChild as HTMLElement;
  for (const cls of ["rounded", "bg-red-50", "text-red-700"]) summary.classList.toggle(cls, state === "failed");
}

export function activityToolEnd(id: string, isError: boolean, output: string): void {
  const a = activity;
  if (!a) return;
  const row = a.toolRows.get(id);
  a.toolRows.delete(id);
  if (row) {
    toolState(row, isError ? "failed" : "succeeded");
    if (output) {
      row.outputPre.textContent =
        output.length > MAX_STEP_OUTPUT ? output.slice(0, MAX_STEP_OUTPUT) + "…" : output;
      row.outputPre.classList.remove("hidden");
    }
    if (isError) a.failedSteps += 1;
  }
  activityHeadline(a, "running");
}

export function activityThinking(ts: number, text: string): void {
  const a = ensureActivity(ts);
  if (!a.thinking) {
    flushThinking(); // whatever the previous row was still owed
    const { el, summary } = detailsRow("rounded-md px-1 py-0.5 text-[12.5px] italic text-neutral-500 hover:bg-black/[0.03] dark:hover:bg-neutral-100", [
      h("span", "min-w-0 truncate", "thinking…"),
    ]);
    const pre = h("div", "mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words pl-4 not-italic text-neutral-500", "");
    el.append(pre);
    a.rowsEl.append(el);
    a.steps += 1;
    a.thinking = { pre, summary, text: "" };
    think = a.thinking;
    tailSteps(a);
    activityHeadline(a, "running", "thinking…");
  }
  a.thinking.text += text;
  paintThinking();
}

/** Through the same functions the live stream drives, so a reload shows the
 *  same step count and duration. */
let replaySeq = 0;

export function replayActivity(
  steps: ActivityStep[],
  durationMs = 0,
  live = false,
  /** Index of this turn in the snapshot, for fetching its detail on demand.
   *  Absent only for a group with no turn to point at. */
  turnIndex?: number,
  /** The turn ended on an error: the group settles as failed, as the live one did. */
  failed = false,
): void {
  const start = Date.now() - durationMs; // headline duration is now - startTs
  // Detail still on the server: fetched on the first open.
  const lazy = turnIndex !== undefined && steps.some((s) => s.kind === "tool" && s.args === undefined);
  const group = ensureActivity(start).chip;
  if (lazy) group.dataset.lazy = "";
  for (const s of steps) {
    if (s.kind === "progress") {
      activityProgress(start, s.text ?? "");
      continue;
    }
    if (s.kind === "thinking") {
      activityThinking(start, s.text ?? "");
      continue;
    }
    // Real tool call ids when the snapshot has them: a live tool-end for a
    // replayed row then closes that row instead of missing it.
    const id = s.id ?? `replay-${++replaySeq}`;
    activityToolStart(start, id, s.toolName ?? "", s.args);
    // `done` and not "has output": the snapshot carries no output, so reading
    // absence as "cut short" marked every replayed step interrupted.
    if (s.done) activityToolEnd(id, s.isError ?? false, s.output ?? "");
  }
  if (lazy) onFirstOpen(group, turnIndex);
  // The turn still running keeps its group open, so the live stream counts on
  // into it instead of opening a second bubble beneath the replayed one.
  if (live) return;
  if (failed) noteTurnError();
  finishActivity(steps.some((s) => s.kind === "tool" && !s.done) ? "interrupted" : "done");
}

/** Args and output are ~90% of a transcript and live behind this very chip,
 *  so they travel per opened group, one request for the whole group. */
function onFirstOpen(group: HTMLElement, turnIndex: number): void {
  lazyLoaders.set(group, () => {
    lazyLoaders.delete(group);
    void fillDetail(group, turnIndex);
  });
}

async function fillDetail(group: HTMLElement, turnIndex: number): Promise<void> {
  const sessionId = deps.sessionId();
  const rows = rowsOf(group);
  // Steps the live stream delivered in full keep their place but are never overwritten.
  const fillable = new Set(rows.filter((row) => !row.argsPre.textContent));
  const say = (text: string): void => {
    for (const row of fillable) row.argsPre.textContent = text;
  };
  // An evicted session makes this fetch wait on a full reopen; an empty pane
  // would read as a tool that did nothing.
  say("loading…");
  if (!sessionId) return say("no session");
  // A refusal and a fetch that never answered both end up in the pane (§5).
  const got = await getJson<{ steps: ActivityStep[] }>(
    `/api/sessions/${sessionId}/turns/${turnIndex}/steps`,
    "could not load these steps",
  );
  if (!got.ok) return say(got.error);
  delete group.dataset.lazy;
  const steps = got.value.steps;
  const tools = steps.filter((s) => s.kind === "tool");
  for (const [i, row] of rows.entries()) {
    if (!fillable.has(row)) continue;
    const step = tools[i];
    // Position pairs, identity confirms: a rewind under the snapshot makes this
    // index name a different turn, whose output must not show as this tool's.
    const matches = step && (step.id ? step.id === row.call : step.toolName === row.tool);
    if (!matches) {
      row.argsPre.textContent = "detail no longer available — reload the session";
      continue;
    }
    const argsText = JSON.stringify(step.args, null, 2) ?? "";
    row.argsPre.textContent = argsText;
    row.preview.textContent = argsPreview(argsText);
    if (step.output) {
      row.outputPre.textContent = step.output;
      row.outputPre.classList.remove("hidden");
    }
  }
}
