// The continuous conversation's open items in task-run words: main's markers
// joined to the run ledger by session, a lead's workers counted by state, and
// the one text every surface shows (docs/design/10-continuous-session.md#open-items).

import { openItemMarkers, openRunText } from "../core/reply.js";
import type { Router } from "../core/router.js";
import { LEDGER_WINDOW_MS, NOT_IN_LEDGER, TASK_RUN_STATES, type LedgerRun, type TaskRunState } from "../core/types.js";
import { logger } from "../log.js";
import type { TaskService } from "./service.js";
import type { TaskStore } from "./store.js";
import type { OpenItem, OpenItems, OpenRun, OpenStatus } from "./types.js";

const log = logger("tasks");

const IN_FLIGHT = new Set(["queued", "running"]);

/** The task service's own reads the list is joined against. */
export type OpenItemReads = Pick<TaskService, "ledger"> & { store: Pick<TaskStore, "getRun" | "roleOf" | "openItems"> };

/** `members`: the chain, newest first; `designs`: the open designs of sessions not closed. */
export function openItems(tasks: OpenItemReads, router: Pick<Router, "stateOf">, members: string[], designs: LedgerRun[], now: number): OpenItems {
  const since = now - LEDGER_WINDOW_MS;
  const runs = members.length ? tasks.ledger(members, since) : [];
  const withWorkers = (r: LedgerRun): OpenRun => {
    if (!r.targetSessionId || tasks.store.roleOf(r.targetSessionId) !== "lead") return r;
    const workers = Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])) as Record<TaskRunState, number>;
    for (const w of tasks.ledger([r.targetSessionId], since)) {
      if (w.state in workers) workers[w.state as TaskRunState] += 1;
    }
    return { ...r, workers };
  };
  const awaiting = new Set(designs.flatMap((d) => (d.targetSessionId ? [d.targetSessionId] : [])));
  const statusOf = (named: OpenRun[]): OpenStatus =>
    named.some((r) => IN_FLIGHT.has(r.state) || (r.targetSessionId && router.stateOf(r.targetSessionId) === "streaming"))
      ? "running"
      : named.some((r) => r.targetSessionId && awaiting.has(r.targetSessionId))
        ? "waiting on you"
        : named.length && named.every((r) => r.state === "succeeded") ? "pending release" : "waiting on you";
  // An item names a session through any of its runs: the session's newest run stands for it.
  const tracked = new Set<string>();
  const items = tasks.store.openItems().map((row): OpenItem => {
    const named = row.runIds.map((id): OpenRun => {
      const session = runs.find((r) => r.runId === id)?.targetSessionId ?? tasks.store.getRun(id)?.targetSessionId ?? null;
      tracked.add(session ?? id);
      const run = runs.find((r) => (session ? r.targetSessionId === session : r.runId === id));
      return run
        ? withWorkers(run)
        : { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: session, cwd: null, queuedAt: 0, finishedAt: null };
    }).filter((r, i, all) => all.findIndex((o) => o.runId === r.runId) === i);
    return { problem: row.problem, stage: row.stage, runs: named, status: statusOf(named) };
  });
  const unlisted = runs.filter((r) => IN_FLIGHT.has(r.state) && !tracked.has(r.targetSessionId ?? r.runId)).map(withWorkers);
  for (const r of unlisted) tracked.add(r.targetSessionId ?? r.runId);
  const unheld = designs.filter((d) => !tracked.has(d.targetSessionId ?? d.runId)).map((d): OpenItem => {
    const named = [withWorkers(runs.find((r) => d.targetSessionId && r.targetSessionId === d.targetSessionId) ?? d)];
    return { problem: d.name, stage: "", runs: named, status: statusOf(named) };
  });
  return { items: [...items, ...unheld], unlisted };
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
 *  Grouped as the status panel groups them (web/ui/drawer.ts): what waits on the user first. */
function renderOpenItems({ items, unlisted }: OpenItems, now: number): string {
  if (!items.length && !unlisted.length) return "Nothing open.";
  const waiting = items.filter((i) => i.status !== "running").map((i) => itemLine(i, now));
  const running = [
    ...items.filter((i) => i.status === "running").map((i) => itemLine(i, now)),
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
