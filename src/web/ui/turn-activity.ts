// What a turn did besides speak: the per-turn Activity group (thinking + tool
// steps, live and replayed) and the detached background-run cards, both
// rendered into #turns between chat rows. chat.ts owns the rows themselves and
// calls seal/finish/reset here so a group closes when the transcript moves on.

import { failure, promptRun, type Sent } from "./api.js";
import type { ChatDeps } from "./chat.js";
import { detailsRow, h } from "./dom.js";
import { MAX_STEP_OUTPUT } from "../../core/types.js";
import type { ActivityStep, BackgroundRun } from "../../core/types.js";

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

// --- background runs (detached task calls made from this session) ------------------

const RUN_STYLE: Record<BackgroundRun["state"], string> = {
  queued: "border-amber-200 bg-amber-50 text-amber-800",
  running: "border-green-200 bg-green-50 text-green-800",
  succeeded: "border-neutral-200 bg-neutral-50 text-neutral-600",
  failed: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-neutral-200 bg-neutral-50 text-neutral-500",
  interrupted: "border-amber-200 bg-amber-50 text-amber-800",
  skipped: "border-neutral-200 bg-neutral-50 text-neutral-500",
};

const backgroundRows = new Map<string, HTMLElement>();

/**
 * Every control on a background run reports here, because a control that fails
 * silently is the worst of both worlds: the run did not change and the chat
 * says nothing, which is indistinguishable from a dropped connection.
 */
async function say(outcome: Promise<Sent>): Promise<void> {
  const result = await outcome;
  if (result.sent && result.error) turns.append("error", result.error);
}

/** The controls that take no typed message still have to report a refusal. */
async function post(url: string, fallback: string): Promise<void> {
  try {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) turns.append("error", await failure(res, fallback));
  } catch (err) {
    turns.append("error", `${fallback}: ${String(err)}`);
  }
}

async function replyToDecision(messageId: string): Promise<void> {
  const id = deps.sessionId();
  if (!id) return;
  const url = `/api/task-messages/${messageId}/reply`;
  await say(promptRun("Reply to subagent", url, { sourceSessionId: id }, "reply failed"));
}

/** The "Reply" affordance on a decision message (rendered by chat.ts). */
export function decisionReplyBtn(messageId: string): HTMLElement {
  const reply = h("button", "flex-none text-[11px] font-semibold normal-case text-cyan-800 hover:underline", "Reply");
  reply.onclick = () => void replyToDecision(messageId);
  return reply;
}

export function renderBackgroundRun(run: BackgroundRun): void {
  let row = backgroundRows.get(run.runId);
  // An edit rewinds the transcript by removing rows: a card that went with them
  // is drawn again rather than updated where nobody can see it.
  if (row && !row.isConnected) {
    backgroundRows.delete(run.runId);
    row = undefined;
  }
  if (!row) {
    row = h("div", "mx-5 my-1.5 border px-3 py-2 text-[13px]");
    row.dataset.kind = "background-run";
    turns.el.append(row);
    backgroundRows.set(run.runId, row);
  }
  row.className = `mx-5 my-1.5 border px-3 py-2 text-[13px] ${RUN_STYLE[run.state]}`;
  const active = run.state === "queued" || run.state === "running";
  const runUrl = `/api/task-runs/${run.runId}`;
  const status = active ? h("span", "spinner") : h("span", "w-3 flex-none text-center", run.state === "succeeded" ? "✓" : run.state === "failed" ? "✕" : "·");
  const title = h("button", "min-w-0 truncate text-left font-medium hover:underline", run.taskName);
  title.onclick = () => deps.showTasks(run.taskId);
  const head = h("div", "flex items-center gap-2", status, h("span", "flex-none text-[11px] font-semibold uppercase", run.state), title);
  const controls = h("div", "ml-auto flex flex-none items-center gap-2");
  if (run.targetSessionId) {
    const target = h("button", "font-mono text-[11px] hover:underline", "Open");
    target.title = `Open ${run.targetSessionId}`;
    target.onclick = () => deps.select(run.targetSessionId!);
    controls.append(target);
  }
  if (active) {
    const steer = h("button", "text-[11px] font-semibold hover:underline", "Steer");
    const steerBody = { mode: "steer", sourceSessionId: deps.sessionId() };
    steer.onclick = () =>
      void say(promptRun("Steer subagent", `${runUrl}/steer`, steerBody, "could not steer the run"));
    const cancel = h("button", "text-[11px] font-semibold hover:underline", "Stop");
    cancel.onclick = () => void post(`${runUrl}/cancel`, "could not stop the run");
    controls.append(steer, cancel);
  } else if (run.targetSessionId && run.sessionMode !== null) {
    const resume = h("button", "text-[11px] font-semibold hover:underline", "Continue");
    const body = { sourceSessionId: deps.sessionId() };
    resume.onclick = () =>
      void say(promptRun("Continue subagent", `${runUrl}/resume`, body, "could not continue"));
    controls.append(resume);
  }
  head.append(controls);
  const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.queuedAt)) / 1000));
  row.replaceChildren(
    head,
    h("div", "mt-1 text-[11px] opacity-70", `${run.sessionMode ?? "task"} · depth ${run.depth} · ${seconds}s · ${run.runId}`),
  );
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
  thinking: { pre: HTMLElement; summary: HTMLElement } | null;
  steps: number;
  failedSteps: number;
  startTs: number;
  sawError: boolean; // turn-level error event — fails the whole group
}

let activity: Activity | null = null; // the live (running) group

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

/**
 * The steps ran *for* the message that follows them, so the group is adopted
 * into that row as its caption line (`takeActivityGroup`) and styled as one:
 * no card, no colour of its own once it is done — a card between two rows read
 * as a third speaker and left "whose steps are these?" unanswerable. Only the
 * states worth a glance keep a tint, and opening any of them draws a box
 * around the steps.
 */
const STATUS_STYLE: Record<ActivityStatus, string> = {
  running: "text-green-700 open:bg-green-50",
  done: "text-neutral-400 hover:text-neutral-600 open:bg-black/[0.02] open:text-neutral-500",
  failed: "text-red-600 open:bg-red-50",
  interrupted: "text-amber-700 open:bg-amber-50",
};

/**
 * An adopted group floats into the first line of its own message, so the
 * transcript is messages and nothing else: closed, it costs no line at all.
 * Opening it drops the float and gives the steps their own block. A group
 * still waiting for its message keeps the pane's gutter and rhythm.
 */
function styleGroup(el: HTMLElement, status: ActivityStatus): void {
  el.dataset.status = status;
  // Front, not end: the steps ran before the message, and a gutter of them is
  // a dim column the eye can skip. The label stays one left-aligned unit and
  // the gutter's min width does the aligning, so the slack falls between the
  // label and the message instead of splitting the chevron off it.
  const placement = el.dataset.adopted
    ? "float-left min-w-[6.5rem] pr-3 tabular-nums mt-[3px] open:float-none open:mt-0 open:mb-1.5 open:min-w-0 open:pr-0"
    : "mx-5 my-1.5";
  el.className = `${placement} rounded-md text-[11.5px] leading-[1.35] open:border open:border-black/[0.06] open:px-2 open:py-1.5 ${STATUS_STYLE[status]}`;
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
  const headline = h("span", "truncate", "working…");
  const { el } = detailsRow("", [statusIcon, headline]);
  el.dataset.kind = "activity";
  styleGroup(el, "running");
  // Caps at ~10 step rows, then scrolls: an expanded group can't swallow the chat.
  const rowsEl = h("div", "mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain border-t border-black/5 pt-1.5");
  el.append(rowsEl);
  tailFollow(el, rowsEl);
  turns.el.append(el);
  lastGroup = el;
  turns.scroll();
  activity = { el, statusIcon, headline, rowsEl, toolRows: new Map(), thinking: null, steps: 0, failedSteps: 0, startTs: ts, sawError: false };
  return activity;
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
  const base = `${a.steps} step${a.steps === 1 ? "" : "s"} · ${secs}s`;
  a.headline.textContent =
    status === "running" && latest
      ? `${base} · ${latest}`
      : status === "done"
        ? base
        : `${base} · ${status}`;
  styleGroup(a.el, status);
  const icon = statusIconEl(status);
  a.statusIcon.replaceWith(icon);
  a.statusIcon = icon;
}

export function finishActivity(status: ActivityStatus): void {
  if (!activity) return;
  // Any still-running tool rows were cut short.
  for (const { statusEl } of activity.toolRows.values()) {
    if (statusEl.textContent === "running…") statusEl.textContent = "interrupted";
  }
  // One failed step doesn't fail the group — its red row says enough. All-red
  // is reserved for every step failing, or a turn-level error (sawError).
  const allFailed = activity.steps > 0 && activity.failedSteps === activity.steps;
  activityHeadline(
    activity,
    (activity.sawError || allFailed) && status === "done" ? "failed" : status,
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
  a.thinking = null;
  const argsText = JSON.stringify(args, null, 2) ?? "";
  const statusEl = h("span", "ml-auto flex-none text-black/40", "running…");
  const preview = h("span", "truncate text-black/50", argsPreview(argsText));
  const { el } = detailsRow("rounded-md px-1 py-0.5 font-mono text-[12.5px] hover:bg-black/[0.03]", [
    h("span", "flex-none font-semibold", name),
    preview,
    statusEl,
  ]);
  const argsPre = h("pre", "max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-black/[0.04] p-1.5 text-[12px]", argsText);
  const outputPre = h("pre", "hidden max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-black/[0.04] p-1.5 text-[12px]");
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
    const { el, summary } = detailsRow("rounded-md px-1 py-0.5 text-[12.5px] italic text-black/50 hover:bg-black/[0.03]", [
      h("span", "truncate", "thinking…"),
    ]);
    const pre = h("div", "mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap pl-4 not-italic text-black/60", "");
    el.append(pre);
    a.rowsEl.append(el);
    a.thinking = { pre, summary };
    tailSteps(a);
    activityHeadline(a, "running", "thinking…");
  }
  const t = a.thinking;
  t.pre.textContent = ((t.pre.textContent ?? "") + text).slice(-4000);
  const line = (t.pre.textContent ?? "").split("\n").filter(Boolean).pop() ?? "thinking…";
  const label = t.summary.lastElementChild as HTMLElement;
  label.textContent = line.length > 90 ? "…" + line.slice(-90) : line;
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
  let steps: ActivityStep[];
  try {
    const res = await fetch(`/api/sessions/${sessionId}/turns/${turnIndex}/steps`);
    if (!res.ok) return say(await failure(res, "could not load these steps"));
    steps = ((await res.json()) as { steps: ActivityStep[] }).steps;
  } catch (err) {
    // Silence here reads as "this tool did nothing", which is a lie about the
    // one thing the user opened the group to see.
    return say(`could not load these steps: ${String(err)}`);
  }
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
