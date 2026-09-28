// The continuous conversation's open items in task-run words: main's markers
// joined to the run ledger by session, a lead's workers counted by state, and
// the one text every surface shows (docs/design/10-continuous-session.md#open-items).

import { openItemMarkers, openRunText, waitsOnYou } from "../core/reply.js";
import type { Router } from "../core/router.js";
import { LEDGER_WINDOW_MS, NOT_IN_LEDGER, TASK_RUN_STATES, type LedgerRun, type TaskRunState } from "../core/types.js";
import { logger } from "../log.js";
import type { TaskService } from "./service.js";
import type { TaskStore } from "./store.js";
import type { OpenItem, OpenItems, OpenRun, OpenStatus } from "./types.js";

const log = logger("tasks");

/** What one run says about its item, for every state a ledger row holds;
 *  a run gone from the ledger (`NOT_IN_LEDGER`) or any other state is `ended`. */
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
 *  run tree — each run, its session, a lead's workers, the only runs below a lead since
 *  workers never delegate — and its stage's `waiting on you` marker. */
export function openStatus(
  { stage, runs }: Unrated,
  session: { streaming: (id: string) => boolean; designOpen: (id: string) => boolean },
): OpenStatus {
  const live = (r: OpenRun): boolean =>
    phaseOf(r.state) === "live" ||
    (!!r.targetSessionId && session.streaming(r.targetSessionId)) ||
    (r.workers?.queued ?? 0) + (r.workers?.running ?? 0) > 0;
  if (runs.some(live)) return "running";
  if (WAITING.test(stage) || runs.some((r) => r.targetSessionId && session.designOpen(r.targetSessionId))) return "waiting on you";
  return runs.every((r) => phaseOf(r.state) === "succeeded") ? "pending release" : "stopped";
}

/** The task service's own reads the list is joined against. */
export type OpenItemReads = Pick<TaskService, "ledger"> & { store: Pick<TaskStore, "getRun" | "leads" | "ledgerRuns" | "openItems"> };

/** `members`: the chain, newest first; `designs`: the open designs of sessions not closed. */
export function openItems(tasks: OpenItemReads, router: Pick<Router, "stateOf">, members: string[], designs: LedgerRun[], now: number): OpenItems {
  const since = now - LEDGER_WINDOW_MS;
  const runs = members.length ? tasks.ledger(members, since) : [];
  const awaiting = new Set(designs.flatMap((d) => (d.targetSessionId ? [d.targetSessionId] : [])));
  // An item names a session through any of its runs: the session's newest run stands for it.
  const tracked = new Set<string>();
  const items = tasks.store.openItems().map((row): Unrated => {
    const named = row.runIds.map((id): OpenRun => {
      const session = runs.find((r) => r.runId === id)?.targetSessionId ?? tasks.store.getRun(id)?.targetSessionId ?? null;
      tracked.add(session ?? id);
      const run = runs.find((r) => (session ? r.targetSessionId === session : r.runId === id));
      return run ?? { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: session, cwd: null, queuedAt: 0, finishedAt: null };
    }).filter((r, i, all) => all.findIndex((o) => o.runId === r.runId) === i);
    return { problem: row.problem, stage: row.stage, runs: named };
  });
  const unlisted = runs.filter((r) => phaseOf(r.state) === "live" && !tracked.has(r.targetSessionId ?? r.runId));
  for (const r of unlisted) tracked.add(r.targetSessionId ?? r.runId);
  const unheld = designs.filter((d) => !tracked.has(d.targetSessionId ?? d.runId)).map((d): Unrated => ({
    problem: d.name, stage: "", runs: [runs.find((r) => d.targetSessionId && r.targetSessionId === d.targetSessionId) ?? d],
  }));
  const all = [...items, ...unheld];
  // Every shown lead's workers in one read: a ledger call per lead grows with the list.
  const leads = tasks.store.leads();
  const leadOf = (r: OpenRun) => (r.state !== NOT_IN_LEDGER && r.targetSessionId && leads.has(r.targetSessionId) ? r.targetSessionId : null);
  const shown = new Set([...all.flatMap((i) => i.runs), ...unlisted].flatMap((r) => leadOf(r) ?? []));
  const counts = new Map([...shown].map((id) => [id, Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])) as Record<TaskRunState, number>]));
  for (const w of shown.size ? tasks.store.ledgerRuns([...shown], since) : []) {
    const c = w.invokedBySessionId ? counts.get(w.invokedBySessionId) : undefined;
    if (c) c[w.state] += 1;
  }
  const withWorkers = (r: OpenRun): OpenRun => {
    const workers = counts.get(leadOf(r) ?? "");
    return workers ? { ...r, workers: { ...workers } } : r;
  };
  const session = { streaming: (id: string) => router.stateOf(id) === "streaming", designOpen: (id: string) => awaiting.has(id) };
  return {
    items: all.map((i) => {
      const rated = { ...i, runs: i.runs.map(withWorkers) };
      return { ...rated, status: openStatus(rated, session) };
    }),
    unlisted: unlisted.map(withWorkers),
  };
}

/** The head's reply's markers, written; answers whether a row changed. */
export function recordOpenItems(store: Pick<TaskStore, "markOpenItems">, text: string, now: number): boolean {
  const { markers, dropped } = openItemMarkers(text);
  for (const marker of dropped) log.warn(`open items: dropped a marker with no problem text: ${marker}`);
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
