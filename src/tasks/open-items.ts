// The continuous conversation's open items in task-run words: main's markers
// joined to the task runs by session, a lead's workers counted by state, and
// the one text every surface shows (docs/design/10-continuous-session.md#open-items).

import { openItemMarkers, openRunText, waitsOnYou } from "../core/reply.js";
import type { Router } from "../core/router.js";
import { NOT_IN_LEDGER, TASK_RUN_STATES, type LedgerRun, type TaskRunState } from "../core/types.js";
import { logger } from "../log.js";
import { ledgerRun } from "./callbacks.js";
import type { TaskStore } from "./store.js";
import type { OpenItem, OpenItems, OpenRun } from "./types.js";

const log = logger("tasks");

/** What one run says about its item, for every state a run holds;
 *  a token naming no run (`NOT_IN_LEDGER`) or any other state is `ended`. */
const RUN_PHASE: Record<TaskRunState, "live" | "succeeded" | "ended"> = {
  queued: "live",
  running: "live",
  succeeded: "succeeded",
  failed: "ended",
  cancelled: "ended",
  interrupted: "ended",
  skipped: "ended",
};
const phaseOf = (state: string) => ((TASK_RUN_STATES as readonly string[]).includes(state) ? RUN_PHASE[state as TaskRunState] : "ended");

/** The head's convention for an item that stopped on the user (agent/roles.ts `DISPATCHER`). */
const WAITING = /\bwaiting on you\b/i;

type Unrated = Omit<OpenItem, "status">;

/** The one reading of an item's status (tasks/types.ts `OpenStatus`), from its whole
 *  run tree — each run, its goal, its session, a lead's workers, the only runs below a
 *  lead since workers never delegate — and its stage's `waiting on you` marker; beside it
 *  `waitsIn`, the child session a wait is answered in, from the same reason. */
export function openStatus(
  { stage, runs }: Unrated,
  session: { streaming: (id: string) => boolean; designOpen: (id: string) => boolean },
): Pick<OpenItem, "status" | "waitsIn"> {
  const live = (r: OpenRun): boolean =>
    (!!r.goal && r.goal.outcome === null) ||
    phaseOf(r.state) === "live" ||
    (!!r.targetSessionId && session.streaming(r.targetSessionId)) ||
    (r.workers?.queued ?? 0) + (r.workers?.running ?? 0) > 0;
  if (runs.some(live)) return { status: "running" };
  // The head relays a stage's or a goal's question and the user answers it in the chat; a clean goal asks for the merge.
  const asksInChat = WAITING.test(stage) || runs.some((r) => r.goal?.outcome === "decision" || r.goal?.outcome === "cap" || (r.goal?.outcome === "done" && r.goal.step !== "merge"));
  if (asksInChat) return { status: "waiting on you" };
  const design = runs.find((r) => r.targetSessionId && session.designOpen(r.targetSessionId));
  if (design?.targetSessionId) return { status: "waiting on you", waitsIn: design.targetSessionId };
  // An ended goal still on its run has not landed, unless a legacy merge step ended it: its root run succeeded, the review ran in another session.
  const landed = (r: OpenRun): boolean => (r.goal ? r.goal.outcome === "done" && r.goal.step === "merge" : phaseOf(r.state) === "succeeded");
  return { status: runs.every(landed) ? "pending release" : "stopped" };
}

/** The store reads the list is joined against. */
export type OpenItemReads = Pick<TaskStore, "getRun" | "goalOf" | "latestRunForTarget" | "inFlightRuns" | "leads" | "workerCounts" | "openItems">;

/** `members`: the chain, newest first; `designs`: the open designs of sessions not closed. */
export function openItems(store: OpenItemReads, router: Pick<Router, "stateOf">, members: string[], designs: LedgerRun[]): OpenItems {
  const awaiting = new Set(designs.flatMap((d) => (d.targetSessionId ? [d.targetSessionId] : [])));
  // A session's newest run stands for it, so a lead woken again stays the same item.
  const newest = (sessionId: string | null) => (sessionId ? store.latestRunForTarget(sessionId) : undefined);
  const tracked = new Set<string>();
  const items = store.openItems().map((row): Unrated => {
    const named = row.runIds.map((id): OpenRun => {
      const own = store.getRun(id);
      tracked.add(own?.targetSessionId ?? id);
      return own ? ledgerRun(newest(own.targetSessionId) ?? own) : { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null };
    }).filter((r, i, all) => all.findIndex((o) => o.runId === r.runId) === i);
    return { problem: row.problem, stage: row.stage, runs: named };
  });
  const unlisted = store.inFlightRuns().filter((r) => members.includes(r.invokedBySessionId ?? "") && !tracked.has(r.targetSessionId ?? r.id)).map(ledgerRun);
  for (const r of unlisted) tracked.add(r.targetSessionId ?? r.runId);
  const unheld = designs.filter((d) => !tracked.has(d.targetSessionId ?? d.runId)).map((d): Unrated => {
    const run = newest(d.targetSessionId);
    return { problem: d.name, stage: "", runs: [run ? ledgerRun(run) : d] };
  });
  const all = [...items, ...unheld];
  // Every shown lead's workers in one read: a read per lead grows with the list.
  const leads = store.leads();
  const leadOf = (r: OpenRun) => (r.state !== NOT_IN_LEDGER && r.targetSessionId && leads.has(r.targetSessionId) ? r.targetSessionId : null);
  const shown = new Set([...all.flatMap((i) => i.runs), ...unlisted].flatMap((r) => leadOf(r) ?? []));
  const counts = shown.size ? store.workerCounts([...shown]) : new Map<string, Record<TaskRunState, number>>();
  const joined = (r: OpenRun): OpenRun => {
    const workers = counts.get(leadOf(r) ?? "");
    const found = r.state !== NOT_IN_LEDGER && r.targetSessionId ? store.goalOf(r.targetSessionId) : undefined;
    // A run queued after its goal ended carries the user's answer — the merge, most often — and is read as any run.
    const goal = found && !(found.finishedAt !== null && r.queuedAt > found.finishedAt) ? found : undefined;
    return {
      ...r,
      ...(workers ? { workers: { ...workers } } : {}),
      ...(goal ? { goal: { step: goal.step, round: goal.round, cap: goal.cap, outcome: goal.outcome, reason: goal.reason } } : {}),
    };
  };
  const session = { streaming: (id: string) => router.stateOf(id) === "streaming", designOpen: (id: string) => awaiting.has(id) };
  return {
    items: all.map((i) => {
      const rated = { ...i, runs: i.runs.map(joined) };
      return { ...rated, ...openStatus(rated, session) };
    }),
    unlisted: unlisted.map(joined),
  };
}

/** The head's reply's markers, written; answers whether a row changed. */
export function recordOpenItems(store: Pick<TaskStore, "markOpenItems">, text: string, now: number): boolean {
  const { markers, dropped } = openItemMarkers(text);
  for (const marker of dropped) log.warn(`open items: dropped a marker with no text: ${marker}`);
  return markers.length > 0 && store.markOpenItems(markers, now) > 0;
}

/** An `unlisted` run's stage: main named it in no item. */
const UNLISTED = "not on the list";

/** `status` is an item's, or `queued` for an unlisted run not started, as the panel tags it. */
const itemLine = (i: Omit<OpenItem, "status"> & { status: string }, now: number): string =>
  `- ${i.problem}${i.stage ? ` — ${i.stage}` : ""} (${i.status})${i.runs.map((r) => ` · ${openRunText(r, now)}`).join("")}`;

/** The one string every surface shows for the open items: `/status` and the seed.
 *  Grouped as the status panel groups them (web/ui/drawer.ts): what waits on the user first,
 *  then everything else. */
function renderOpenItems({ items, unlisted }: OpenItems, now: number): string {
  if (!items.length && !unlisted.length) return "Nothing open.";
  const waiting = items.filter((i) => waitsOnYou(i.status)).map((i) => itemLine(i, now));
  const running = [
    ...items.filter((i) => !waitsOnYou(i.status)).map((i) => itemLine(i, now)),
    ...unlisted.map((r) => itemLine({ problem: r.name, stage: UNLISTED, runs: [r], status: r.state === "queued" ? "queued" : "running" }, now)),
  ];
  return [
    ...(waiting.length ? ["Waiting on you", ...waiting] : []),
    ...(running.length ? ["In progress", ...running] : []),
  ].join("\n");
}

/** `/status`'s card: the text, and run id → session id for every run it names that has one. */
export function openItemsStatus(open: OpenItems, now: number): { text: string; sessions: Record<string, string> } {
  const sessions = Object.fromEntries([...open.items.flatMap((i) => i.runs), ...open.unlisted]
    .flatMap((r) => (r.targetSessionId ? [[r.runId, r.targetSessionId]] : [])));
  return { text: renderOpenItems(open, now), sessions };
}
