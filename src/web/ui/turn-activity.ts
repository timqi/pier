// What a turn did besides speak: the per-turn Activity group (thinking + tool
// steps, live and replayed) and the detached background-run cards, both
// rendered into #turns between chat rows. chat.ts owns the rows themselves and
// calls seal/finish/reset here so a group closes when the transcript moves on.

import { getJson, refused } from "./api.js";
import type { ChatDeps } from "./chat.js";
import { detailsRow, h, STREAM_PAINT_MS } from "./dom.js";
import { MAX_STEP_OUTPUT } from "../../core/types.js";
import type { ActivityStep, BackgroundRun, ModelRef } from "../../core/types.js";

/**
 * The bits of the turns pane this module writes into. Handed over at init
 * rather than imported: chat.ts already imports this module, and importing it
 * back made the two a runtime cycle — one concern in two files pretending to
 * be a layering. `ChatDeps` above is a type import, which is erased.
 */
export interface TurnsPane {
  el: HTMLElement;
  /** Append a chat row; this module only ever needs the error kind. */
  append: (kind: "error", text: string) => HTMLElement;
  scroll: (force?: boolean) => void;
  /** A whole snapshot is being replayed: no step may measure layout. */
  bulk: () => boolean;
}

let deps: ChatDeps;
let turns: TurnsPane;

/** Wired by initChat — the two modules share one deps object. */
export function initTurnActivity(d: ChatDeps, pane: TurnsPane): void {
  deps = d;
  turns = pane;
}

// --- the run head ---------------------------------------------------------------------
// Every card that names a run — the detached run card here, the delegation,
// callback and subagent-message cards in chat.ts — says the same things in
// the same places: glyph, kind, task name on the left; model, effort, run and
// session ids on the right. Three cards spelling "which run, where" three
// ways was the bug this section exists to prevent.

const shortId = (id: string): string => id.slice(0, 8);

export interface RunHead {
  glyph: HTMLElement;
  /** The kind of card or the run's state, whichever the card is about. */
  label: string;
  labelCls: string;
  taskName?: string;
  model?: ModelRef;
  thinking?: string;
  /** Plain facts between the name and the ids: mode, depth, duration. */
  note?: string;
  runId: string;
  /** The session doing the work when it is not this one; "console" is nobody. */
  sessionId?: string | null;
}

/** Quiet card body; the coloured edge and labelled chip carry type/status. */
const cardClass = (tone: string): string => `system-card group relative mt-1.5 rounded-xl px-4 py-2.5 ${tone}`;
export const runCard = (tone: string): HTMLElement => h("div", cardClass(tone));

/** Four rendered lines give the topic; the full text stays one click away.
 *  Hidden panes use a conservative guess until their content can be measured. */
export function clampedBody(text: string): HTMLElement[] {
  const long = text.length > 240 || text.split("\n").length > 4;
  const collapsed = ["max-h-[4lh]", "overflow-hidden"];
  const content = h("div", `mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-normal text-neutral-500 ${collapsed.join(" ")}`, text);
  // Measured after the caller appends it: `clientHeight` is 0 until then and
  // the guess decides.
  const toggle = h(
    "button",
    "mt-1 hidden w-fit rounded-md px-1 py-1 text-[11px] pointer-coarse:min-h-11 pointer-coarse:px-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700",
    "Show full message",
  );
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-expanded", "false");
  toggle.onclick = () => {
    const before = content.getBoundingClientRect().height;
    content.getAnimations().forEach((animation) => animation.cancel());
    const clamped = content.classList.toggle(collapsed[0]!);
    const after = content.getBoundingClientRect().height;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    content.animate(
      reduced ? [{ opacity: 0.8 }, { opacity: 1 }] : [{ maxHeight: `${before}px`, opacity: 0.8 }, { maxHeight: `${after}px`, opacity: 1 }],
      { duration: reduced ? 120 : 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    toggle.textContent = clamped ? "Show full message" : "Collapse message";
    toggle.setAttribute("aria-expanded", String(!clamped));
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
  };
  queueMicrotask(() => {
    const clipped = content.clientHeight ? content.scrollHeight > content.clientHeight + 1 : long;
    if (clipped) toggle.classList.remove("hidden");
    else content.classList.remove(...collapsed);
  });
  return [content, toggle];
}

/** Anything the caller appends after this lands right of the ids. */
export function runHead(o: RunHead): HTMLElement {
  const head = h("div", "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500", o.glyph);
  head.append(h("span", `run-label flex-none font-semibold ${o.labelCls}`, o.label));
  // `basis-0`, not just `min-w-0`: a subagent's name is its whole prompt line,
  // and a wrapping flex row breaks *before* it shrinks an item — which pushed
  // the ids and controls onto a second line for the long ones. Zero-basis, the
  // name takes what is left and truncates there, so the head is one line.
  if (o.taskName) head.append(h("span", "min-w-0 grow basis-0 truncate text-[12.5px] font-medium text-neutral-800 max-md:order-1 max-md:basis-full max-md:whitespace-normal max-md:line-clamp-2", o.taskName));
  const meta = h("div", "ml-auto flex min-w-0 flex-wrap items-center gap-x-2 font-mono");
  if (o.note) meta.append(h("span", "flex-none", o.note));
  if (o.model) {
    const model = h("span", "flex-none rounded bg-black/[0.05] px-1.5 py-px font-medium text-neutral-700 dark:bg-neutral-200", o.model.id);
    model.title = `${o.model.provider} / ${o.model.id}`;
    meta.append(model);
  }
  if (o.thinking) {
    const effort = h("span", "flex-none", o.thinking);
    effort.title = "Reasoning effort";
    meta.append(effort);
  }
  // The ids carry no word: a mono 8-char id in the run's own grey opens the
  // run, in indigo the session — the colour boards.ts already spends on a
  // session chip. What each one is stays in its tooltip, where a reader who
  // does not know the convention yet looks anyway.
  const run = h("button", "flex-none hover:underline", shortId(o.runId));
  run.title = `Run ${o.runId}`;
  run.onclick = () => deps.showRun(o.runId);
  meta.append(run);
  if (o.sessionId && o.sessionId !== "console") {
    const id = o.sessionId;
    const session = h("button", "flex-none text-indigo-600 hover:underline", shortId(id));
    session.title = `Open session ${id}`;
    session.onclick = () => deps.select(id);
    meta.append(session);
  }
  head.append(meta);
  return head;
}

// --- background runs (detached task calls made from this session) ------------------

/** Run state colours are shared by detached runs and callback summaries. */
export const STATE_STYLE: Record<BackgroundRun["state"], { edge: string; label: string; glyph: string }> = {
  queued: { edge: "border-l-amber-400", label: "text-amber-700", glyph: "" },
  running: { edge: "border-l-fuchsia-500", label: "text-fuchsia-700", glyph: "" },
  succeeded: { edge: "border-l-green-500", label: "text-green-700", glyph: "\u2713" },
  failed: { edge: "border-l-red-500", label: "text-red-600", glyph: "\u2715" },
  cancelled: { edge: "border-l-neutral-300", label: "text-neutral-500", glyph: "\u00b7" },
  interrupted: { edge: "border-l-amber-400", label: "text-amber-700", glyph: "\u23f8" },
  skipped: { edge: "border-l-neutral-300", label: "text-neutral-500", glyph: "\u00b7" },
};

/** The state's glyph: a spinner while it is still moving. */
export const stateGlyph = (state: BackgroundRun["state"]): HTMLElement =>
  STATE_STYLE[state].glyph
    ? h("span", `w-3 flex-none text-center font-bold ${STATE_STYLE[state].label}`, STATE_STYLE[state].glyph)
    : h("span", `spinner ${STATE_STYLE[state].label}`);

const backgroundRows = new Map<string, HTMLElement>();

/** The prompt is drawn once per card and kept across status re-renders: a
 *  reader who expanded it must not watch it snap shut when the run moves on. */
const promptBodies = new WeakMap<HTMLElement, HTMLElement[]>();

/**
 * Stopping a run reports here, because a control that fails silently is the
 * worst of both worlds: the run did not change and the chat says nothing,
 * which is indistinguishable from a dropped connection.
 */
async function post(url: string, fallback: string): Promise<void> {
  const error = await refused(url, "POST", fallback);
  if (error) turns.append("error", error);
}

export function renderBackgroundRun(run: BackgroundRun): void {
  // Rows leave the pane without telling us: an edit rewinds the transcript, the
  // trim (chat.ts) drops the oldest. A card that went with them is drawn again
  // rather than updated where nobody can see it — and none of them may be held
  // here after the pane let go, or this map is where the trimmed DOM survives.
  for (const [id, el] of backgroundRows) if (!el.isConnected) backgroundRows.delete(id);
  let row = backgroundRows.get(run.runId);
  if (!row) {
    row = runCard(STATE_STYLE[run.state].edge);
    row.dataset.kind = "background-run";
    turns.el.append(row);
    backgroundRows.set(run.runId, row);
  }
  row.className = cardClass(STATE_STYLE[run.state].edge);
  const active = run.state === "queued" || run.state === "running";
  const runUrl = `/api/task-runs/${run.runId}`;
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.queuedAt)) / 1000));
  const head = runHead({
    glyph: stateGlyph(run.state),
    label: `run · ${run.state}`,
    labelCls: STATE_STYLE[run.state].label,
    taskName: run.taskName,
    note: `${run.sessionMode ?? "task"} · depth ${String(run.depth)} · ${String(seconds)}s`,
    runId: run.runId,
    sessionId: run.targetSessionId,
  });
  // Stop is the card's only control: anything with a message in it — steering
  // the run, continuing it, answering its decision — is typed in this session,
  // which is the session that delegated the run and can say so to its agent.
  const controls = h("div", "flex flex-none items-center gap-2 text-[11px] font-semibold text-neutral-700");
  if (active) {
    const cancel = h("button", "hover:underline", "Stop");
    // One click from the end of a running agent, so it asks first.
    cancel.onclick = () => {
      if (window.confirm(`Stop "${run.taskName}"?`)) void post(`${runUrl}/cancel`, "could not stop the run");
    };
    controls.append(cancel);
  }
  if (controls.childElementCount) head.append(controls);
  // This card sits where the delegating turn sent the message, so it is the
  // message: the prompt, clamped to a glance like a delegation card's is.
  let body = promptBodies.get(row);
  if (!body && run.prompt !== null) {
    body = clampedBody(run.prompt);
    promptBodies.set(row, body);
  }
  row.replaceChildren(head, ...(body ?? []));
  turns.scroll();
}

// --- activity group ------------------------------------------------------------------
// One collapsible bubble per turn collects thinking + tool activity
// (avibe's AgentActivityGroup: status icon + chevron, steps, duration,
// each step itself an expandable details row).

type ActivityStatus = "running" | "done" | "failed" | "interrupted";

interface ToolRow {
  el: HTMLDetailsElement;
  statusEl: HTMLElement;
  outputPre: HTMLElement;
}

interface Activity {
  el: HTMLDetailsElement;
  statusIcon: HTMLElement;
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
// Thinking arrives token by token, so it is painted on the stream's cadence
// like the reply text is (ui/chat.ts): the per-delta path read the whole tail
// back off the DOM, re-sliced it to 4000 chars and re-split it into lines,
// once per token, for a row most turns never open.

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
  const line = think.text.split("\n").filter(Boolean).pop() ?? "thinking…";
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

/** A row stops receiving text at the turn's end, at the next thinking row and
 *  at a reset. What is on screen then has to be all of it, so every one of
 *  those paints what the last tick still held. */
function flushThinking(): void {
  if (thinkTimer) clearTimeout(thinkTimer);
  thinkTimer = null;
  if (thinkDirty) drawThinking();
  thinkDirty = false;
}

/** Every tool row of a group, in the order they ran — what a later detail fetch
 *  writes into. Keyed by the group element so it is collected with it: a
 *  transcript reload drops thousands of these and must not leak them. */
interface DetailRow {
  tool: string;
  call: string;
  preview: HTMLElement;
  argsPre: HTMLElement;
  outputPre: HTMLElement;
}
const detailRows = new WeakMap<HTMLDetailsElement, DetailRow[]>();
const rowsOf = (group: HTMLDetailsElement): DetailRow[] => {
  const rows = detailRows.get(group) ?? [];
  detailRows.set(group, rows);
  return rows;
};

/**
 * Close the live group because a chat row is going in below it. A group is
 * rendered where it opened, so once anything else follows it on screen the
 * steps that come next belong to a *new* group underneath — appending them to
 * this one would show work happening above the answer it came after. A group
 * still waiting on a tool result stays open, so that tool-end can land.
 */
export function sealActivity(): void {
  if (activity && !activity.toolRows.size) finishActivity("done");
}

/** The most recent group, live or just closed, until a row takes it. */
let lastGroup: HTMLElement | null = null;

/** Reset before a session snapshot re-render (chat.ts resetChat). */
export function resetActivity(): void {
  activity = null;
  lastGroup = null;
  think = null; // the pre it was painting goes with the pane
  flushThinking();
  backgroundRows.clear();
}

/**
 * Hand the pending group to the assistant row about to be appended, which is
 * the message those steps produced.
 */
export function takeActivityGroup(): HTMLElement | null {
  const el = lastGroup;
  // A group still collecting steps stays put: what it is about to receive
  // happened *after* this message, so it cannot be its caption.
  if (!el || activity?.el === el) return null;
  lastGroup = null;
  // Anything appended after the group — an error row, a background-run card —
  // means moving it now would reorder the transcript.
  if (el !== turns.el.lastElementChild) return null;
  el.remove();
  el.dataset.adopted = "1";
  styleGroup(el, el.dataset.status as ActivityStatus);
  return el;
}

/** Work stays on its own line above the reply; status colour names the outcome. */
const STATUS_STYLE: Record<ActivityStatus, string> = {
  running: "text-green-700 open:bg-green-50",
  done: "text-neutral-400 hover:text-neutral-600 open:bg-black/[0.02] open:text-neutral-500 dark:open:bg-neutral-100",
  failed: "text-red-600 open:bg-red-50",
  interrupted: "text-amber-700 open:bg-amber-50",
};

/** Expanding shows an independent work log, never a disclosure inside prose. */
function styleGroup(el: HTMLElement, status: ActivityStatus): void {
  el.dataset.status = status;
  el.className = `px-2 py-1 rounded-xl text-[11.5px] leading-normal open:border open:border-neutral-200 open:px-3 open:py-2 ${STATUS_STYLE[status]}`;
}

const STATUS_ICON: Record<Exclude<ActivityStatus, "running" | "done">, string> = {
  failed: "✕",
  interrupted: "⏸",
};

function statusIconEl(status: ActivityStatus): HTMLElement {
  if (status === "running") return h("span", "spinner");
  // Done is the common case and has nothing to say — the step count is the
  // whole message, so only the states that want attention carry a glyph.
  if (status === "done") return h("span", "hidden");
  return h("span", "flex-none text-[12px] font-bold", STATUS_ICON[status]);
}

function ensureActivity(ts: number): Activity {
  if (activity) return activity;
  const statusIcon = statusIconEl("running");
  const headline = h("span", "min-w-0 truncate", "working…");
  const { el } = detailsRow("", [statusIcon, headline]);
  el.dataset.kind = "activity";
  styleGroup(el, "running");
  // Caps at ~10 step rows, then scrolls: an expanded group can't swallow the chat.
  const rowsEl = h("div", "mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain border-t border-black/5 pt-1.5 dark:border-neutral-200");
  el.append(rowsEl);
  tailFollow(el, rowsEl);
  turns.el.append(el);
  lastGroup = el;
  turns.scroll();
  activity = { el, statusIcon, headline, rowsEl, toolRows: new Map(), thinking: null, steps: 0, failedSteps: 0, startTs: ts, sawError: false };
  return activity;
}

/** Assistant text is provisional until turn-end: keep it with the work log. */
export function activityProgress(ts: number, text = ""): HTMLElement {
  const a = ensureActivity(ts);
  flushThinking();
  a.thinking = null;
  const node = h("div", "whitespace-pre-wrap break-words text-[13px] text-neutral-600", text);
  node.dataset.raw = text;
  const row = h("div", "rounded-lg bg-neutral-50 px-2 py-1.5", h("span", "text-[10px] font-medium text-neutral-400", "Update"), node);
  row.dataset.kind = "progress";
  a.rowsEl.append(row);
  activityHeadline(a, "running", "writing…");
  tailSteps(a);
  turns.scroll();
  return node;
}

/** Promoting the final text must not leave a duplicate or an empty work log. */
export function discardProgress(node: HTMLElement): void {
  const group = node.closest<HTMLDetailsElement>('details[data-kind="activity"]');
  node.parentElement?.remove();
  if (group && !group.lastElementChild?.childElementCount) {
    if (activity?.el === group) activity = null;
    if (lastGroup === group) lastGroup = null;
    group.remove();
  }
}

/**
 * What a group is opened for is its newest step — the one running, or the last
 * one that ran — so opening lands at the bottom of the list instead of at a
 * step from a minute ago, and a still-running group keeps following the tail.
 * Scrolling off the bottom is the reader saying they want to stay where they
 * are, and stops the following until they come back down.
 */
function tailFollow(el: HTMLDetailsElement, rowsEl: HTMLElement): void {
  rowsEl.dataset.follow = "1";
  rowsEl.addEventListener("scroll", () => {
    const atBottom = rowsEl.scrollHeight - rowsEl.scrollTop - rowsEl.clientHeight < 24;
    rowsEl.dataset.follow = atBottom ? "1" : "";
  });
  el.addEventListener("toggle", () => {
    if (!el.open) return;
    rowsEl.scrollTop = rowsEl.scrollHeight;
    rowsEl.dataset.follow = "1";
  });
}

/** Follow the newest step, if the group is showing one and nobody scrolled
 *  away. Skipped on replay and while closed — reading scrollHeight flushes
 *  layout for the whole transcript, once per step, for nothing on screen. */
function tailSteps(a: Activity): void {
  if (turns.bulk() || !a.el.open || !a.rowsEl.dataset.follow) return;
  a.rowsEl.scrollTop = a.rowsEl.scrollHeight;
}

function activityHeadline(a: Activity, status: ActivityStatus, latest?: string): void {
  const secs = Math.max(1, Math.round((Date.now() - a.startTs) / 1000));
  const base = `${a.steps ? `${a.steps} step${a.steps === 1 ? "" : "s"}` : "Progress"} · ${secs}s`;
  a.headline.textContent =
    status === "running" && latest
      ? `${base} · ${latest}`
      : status === "done"
        ? `Completed · ${base}`
        : `${base} · ${status}`;
  styleGroup(a.el, status);
  const icon = statusIconEl(status);
  a.statusIcon.replaceWith(icon);
  a.statusIcon = icon;
}

export function finishActivity(status: ActivityStatus): void {
  if (!activity) return;
  flushThinking(); // the last tokens of the turn are part of the turn
  // Any still-running tool rows were cut short.
  for (const { statusEl } of activity.toolRows.values()) {
    if (statusEl.textContent === "running…") statusEl.textContent = "interrupted";
  }
  // One failed step doesn't fail the group — its red row says enough. All-red
  // is reserved for every step failing, or a turn-level error (sawError).
  const allFailed = activity.steps > 0 && activity.failedSteps === activity.steps;
  activityHeadline(
    activity,
    (activity.sawError || allFailed) && status === "done" ? "failed"
      : status === "done" && activity.toolRows.size ? "interrupted" : status,
  );
  activity = null;
}

/** A turn-level error event fails the whole group when it closes. */
export function noteTurnError(): void {
  if (activity) activity.sawError = true;
}

/** The args, on one line, as much of it as the summary shows. Sliced before
 *  the collapse so a 200KB `write` argument isn't regex-scanned for 100
 *  characters — and shared with the detail fill below, so replayed and live
 *  rows cannot spell the same line two ways. */
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
  const statusEl = h("span", "ml-auto flex-none text-neutral-400", "running…");
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
  rowsOf(a.el).push({ tool: name, call: id, preview, argsPre, outputPre });
  a.toolRows.set(id, { el, statusEl, outputPre });
  a.rowsEl.append(el);
  tailSteps(a);
  activityHeadline(a, "running", name);
  turns.scroll();
}

export function activityToolEnd(id: string, isError: boolean, output: string): void {
  const a = activity;
  if (!a) return;
  const row = a.toolRows.get(id);
  a.toolRows.delete(id);
  if (row) {
    row.statusEl.textContent = isError ? "failed" : "ok";
    row.statusEl.className = `ml-auto flex-none ${isError ? "text-red-600" : "text-green-700"}`;
    row.el.classList.toggle("bg-red-50", isError);
    row.el.classList.toggle("text-red-700", isError);
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
    a.thinking = { pre, summary, text: "" };
    think = a.thinking;
    tailSteps(a);
    activityHeadline(a, "running", "thinking…");
  }
  a.thinking.text += text;
  paintThinking();
}

/**
 * Rebuild a finished turn's Activity group from the snapshot, through the same
 * functions the live stream drives — so a reload shows the real step count and
 * duration instead of restarting at zero.
 */
let replaySeq = 0;

export function replayActivity(
  steps: ActivityStep[],
  durationMs = 0,
  live = false,
  /** Index of this turn in the snapshot, for fetching its detail on demand.
   *  Absent only for a group with no turn to point at. */
  turnIndex?: number,
): void {
  const start = Date.now() - durationMs; // headline duration is now - startTs
  const group = ensureActivity(start).el;
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
  if (turnIndex !== undefined && steps.some((s) => s.kind === "tool" && s.args === undefined)) {
    onFirstOpen(group, turnIndex);
  }
  // The turn still running keeps its group open, so the live stream counts on
  // into it instead of opening a second bubble beneath the replayed one.
  if (live) return;
  finishActivity(steps.some((s) => s.kind === "tool" && !s.done) ? "interrupted" : "done");
}

/** Args and output are ~90% of a transcript and live behind this very toggle,
 *  so they travel per opened group instead of per page load. One request for
 *  the whole group: a curious click must not become one round trip per step. */
function onFirstOpen(group: HTMLDetailsElement, turnIndex: number): void {
  const load = (): void => {
    if (!group.open) return;
    group.removeEventListener("toggle", load);
    void fillDetail(group, turnIndex);
  };
  group.addEventListener("toggle", load);
}

async function fillDetail(group: HTMLDetailsElement, turnIndex: number): Promise<void> {
  const sessionId = deps.sessionId();
  const rows = rowsOf(group);
  // A group can also hold steps the live stream delivered in full: those keep
  // their place in the pairing below, but nothing here writes over them — not
  // a position match, not an error.
  const fillable = new Set(rows.filter((row) => !row.argsPre.textContent));
  const say = (text: string): void => {
    for (const row of fillable) row.argsPre.textContent = text;
  };
  // The session may have been evicted since the snapshot, and then this fetch
  // waits on a full transcript reopen. An empty pane would read as a tool that
  // did nothing.
  say("loading…");
  if (!sessionId) return say("no session");
  // Silence here reads as "this tool did nothing", which is a lie about the
  // one thing the user opened the group to see — so a refusal and a fetch that
  // never answered both end up in the pane.
  const got = await getJson<{ steps: ActivityStep[] }>(
    `/api/sessions/${sessionId}/turns/${turnIndex}/steps`,
    "could not load these steps",
  );
  if (!got.ok) return say(got.error);
  const steps = got.value.steps;
  const tools = steps.filter((s) => s.kind === "tool");
  for (const [i, row] of rows.entries()) {
    if (!fillable.has(row)) continue;
    const step = tools[i];
    // Position pairs the two lists; identity only confirms it. An edit or a
    // compaction can rewind the transcript under a snapshot, and then this
    // index names a different turn — whose output must not be shown here as if
    // it were this tool's. The transcript is also the source of both sides, so
    // a step with no id of its own is checked by name (`replay-N` is ours).
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
