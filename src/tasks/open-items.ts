// Open-item task facts and their compact status and complete continuation projections.

import { openItemMarkers } from "../core/reply.js";
import { openItemPresentation, openItemsText } from "../core/open-items.js";
import type { Router } from "../core/router.js";
import { NOT_IN_LEDGER, NOTHING_OPEN, TASK_RUN_STATES, type OpenItemsStatus, type TaskRunState } from "../core/types.js";
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
  // A design waits only while its newest run succeeded: a failed or cancelled one is stopped, the head's to resume or close.
  const design = runs.find((r) => r.targetSessionId && session.designOpen(r.targetSessionId) && r.state === "succeeded");
  if (design?.targetSessionId) return { status: "waiting on you", waitsIn: design.targetSessionId };
  // An ended goal still on its run has not landed, unless a legacy merge step ended it: its root run succeeded, the review ran in another session.
  const landed = (r: OpenRun): boolean => (r.goal ? r.goal.outcome === "done" && r.goal.step === "merge" : phaseOf(r.state) === "succeeded");
  return { status: runs.every(landed) ? "pending release" : "stopped" };
}

/** The store reads the list is joined against. */
export type OpenItemReads = Pick<TaskStore, "creationTitles" | "getRun" | "goalOf" | "latestRunForTarget" | "inFlightRuns" | "leads" | "workerCounts" | "openItems">;

/** `members`: the chain, newest first. */
export function openItems(store: OpenItemReads, router: Pick<Router, "stateOf">, members: string[]): OpenItems {
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
  const leads = store.leads();
  const awaiting = new Set([...leads].flatMap(([id, lead]) => (lead.designOpen ? [id] : [])));
  const targets = [...new Set([...items.flatMap((i) => i.runs), ...unlisted].flatMap((r) => r.targetSessionId ?? []))].filter((id) => !leads.has(id));
  const titles = targets.length ? store.creationTitles(targets) : new Map<string, string>();
  for (const [id, lead] of leads) titles.set(id, lead.title);
  // Every shown lead's workers in one read: a read per lead grows with the list.
  const leadOf = (r: OpenRun) => (r.state !== NOT_IN_LEDGER && r.targetSessionId && leads.has(r.targetSessionId) ? r.targetSessionId : null);
  const shown = new Set([...items.flatMap((i) => i.runs), ...unlisted].flatMap((r) => leadOf(r) ?? []));
  const counts = shown.size ? store.workerCounts([...shown]) : new Map<string, Record<TaskRunState, number>>();
  const joined = (r: OpenRun): OpenRun => {
    const workers = counts.get(leadOf(r) ?? "");
    const found = r.state !== NOT_IN_LEDGER && r.targetSessionId ? store.goalOf(r.targetSessionId) : undefined;
    // A run queued after its goal ended carries the user's answer — the merge, most often — and is read as any run.
    const goal = found && !(found.finishedAt !== null && r.queuedAt > found.finishedAt) ? found : undefined;
    return {
      ...r,
      ...(titles.get(r.targetSessionId ?? "") ? { title: titles.get(r.targetSessionId!) } : {}),
      ...(workers ? { workers: { ...workers } } : {}),
      ...(goal ? { goal: { step: goal.step, round: goal.round, cap: goal.cap, outcome: goal.outcome, reason: goal.reason } } : {}),
    };
  };
  const session = { streaming: (id: string) => router.stateOf(id) === "streaming", designOpen: (id: string) => awaiting.has(id) };
  return {
    items: items.map((i) => {
      const rated = { ...i, runs: i.runs.map(joined) };
      const title = i.runs.map((r) => titles.get(r.targetSessionId ?? "")).find(Boolean);
      const designSessionId = i.runs.find((r) => r.targetSessionId && awaiting.has(r.targetSessionId))?.targetSessionId;
      return { ...rated, ...openStatus(rated, session), ...(title ? { title } : {}), ...(designSessionId ? { designSessionId } : {}) };
    }),
    unlisted: unlisted.map(joined),
  };
}

/** The head's reply's markers, written; answers whether a row changed. */
export function recordOpenItems(store: Pick<TaskStore, "markOpenItems">, text: string, now: number): boolean {
  const { markers, dropped } = openItemMarkers(text);
  for (const marker of dropped) log.warn(`open items: dropped a marker with no text: ${marker}`);
  if (!markers.length) return false;
  const changed = store.markOpenItems(markers, now);
  markers.forEach((m, i) => { if (m.op === "done" && !changed[i]) log.warn(`open items: <done> named no open item: ${m.problem}`); });
  return changed.some((n) => n > 0);
}

/** Complete identities for the model; compact text and Web history share the same presentation. */
export function openItemsStatus(open: OpenItems, now: number): OpenItemsStatus {
  const runs = [...open.items.flatMap((i) => i.runs), ...open.unlisted];
  const sessions = Object.fromEntries(runs.flatMap((r) => (r.targetSessionId ? [[r.runId, r.targetSessionId]] : [])));
  const unlisted = open.unlisted.map((r) => ({ problem: r.name, title: r.title, stage: "", runs: [r], status: r.state === "queued" ? "queued" as const : "running" as const }));
  const snapshot = { version: 1 as const, items: [
    ...open.items.map((i) => openItemPresentation(i, now)),
    ...unlisted.map((i) => ({ ...openItemPresentation(i, now, `run:${i.runs[0]!.runId}`), direct: true })),
  ] };
  // The full problem is the key the head's `<done>` names.
  const seed = [...open.items, ...unlisted].map((i) => `- ${i.problem}${i.stage ? ` — ${i.stage}` : ""}${i.runs.length
    ? ` (${i.runs.map((r) => `run ${r.runId}${r.targetSessionId ? ` · session ${r.targetSessionId}` : ""}`).join(", ")})` : ""} · ${i.status}`).join("\n") || NOTHING_OPEN;
  return { text: openItemsText(snapshot), seed, snapshot, sessions };
}
