// The continuous conversation's open items in task-run words: main's markers
// joined to the run ledger by session, a lead's workers counted by state, and
// the one text every surface shows (docs/design/10-continuous-session.md#open-items).

import { agoLabel, openItemMarkers, relTime } from "../core/reply.js";
import type { Router } from "../core/router.js";
import { LEDGER_WINDOW_MS, TASK_RUN_STATES, type LedgerRun, type TaskRunState } from "../core/types.js";
import { logger } from "../log.js";
import type { TaskService } from "./service.js";
import type { TaskStore } from "./store.js";
import { NOT_IN_LEDGER, type OpenItems, type OpenRun } from "./types.js";

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
  // An item names a session through any of its runs: the session's newest run stands for it.
  const tracked = new Set<string>();
  const items = tasks.store.openItems().map((row) => {
    const named = row.runIds.map((id): OpenRun => {
      const session = runs.find((r) => r.runId === id)?.targetSessionId ?? tasks.store.getRun(id)?.targetSessionId ?? null;
      tracked.add(session ?? id);
      const run = runs.find((r) => (session ? r.targetSessionId === session : r.runId === id));
      return run
        ? withWorkers(run)
        : { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: session, cwd: null, queuedAt: 0, finishedAt: null };
    }).filter((r, i, all) => all.findIndex((o) => o.runId === r.runId) === i);
    const busy = named.some((r) => IN_FLIGHT.has(r.state) || (r.targetSessionId && router.stateOf(r.targetSessionId) === "streaming"));
    return { problem: row.problem, stage: row.stage, runs: named, ...(named.length ? { live: busy ? "running" as const : "idle" as const } : {}) };
  });
  const unlisted = runs.filter((r) => IN_FLIGHT.has(r.state) && !tracked.has(r.targetSessionId ?? r.runId)).map(withWorkers);
  return { items, unlisted, designs };
}

/** The head's reply's markers, written; answers whether a row changed. */
export function recordOpenItems(store: Pick<TaskStore, "markOpenItems">, text: string, now: number): boolean {
  const { markers, dropped } = openItemMarkers(text);
  for (const marker of dropped) log.warn(`open items: dropped a marker with no problem text: ${marker}`);
  return markers.length > 0 && store.markOpenItems(markers, now) > 0;
}

const runStatus = (r: LedgerRun, now: number): string =>
  r.finishedAt === null ? `${r.state} ${relTime(r.queuedAt, now)}` : `${r.state} ${agoLabel(r.finishedAt, now)}`;

function workersText(workers: Record<TaskRunState, number> | undefined): string {
  if (!workers) return "";
  const counts = TASK_RUN_STATES.filter((s) => workers[s] > 0).map((s) => `${String(workers[s])} ${s}`);
  return ` · workers: ${counts.join(", ") || "none"}`;
}

const runText = (r: OpenRun, now: number): string =>
  r.state === NOT_IN_LEDGER
    ? `run ${r.runId} — ${NOT_IN_LEDGER}`
    : `run ${r.runId.length > 8 ? `${r.runId.slice(0, 8)}…` : r.runId} ${runStatus(r, now)}${workersText(r.workers)}`;

/** The one string every surface shows for the open items: `/status` and the seed. */
export function renderOpenItems({ items, unlisted, designs }: OpenItems, now: number): string {
  if (!items.length && !unlisted.length && !designs.length) return "Nothing open.";
  const open = items.map((i) => `- ${i.problem}${i.stage ? ` — ${i.stage}` : ""}${i.live ? ` (${i.live})` : ""}${i.runs.map((r) => ` · ${runText(r, now)}`).join("")}`);
  const rest = unlisted.map((r) => `- ${r.name} — ${runStatus(r, now)}${workersText(r.workers)}`);
  const decide = designs.map((r) => `- ${r.name} · ${runText(r, now)}`);
  return [
    ...(open.length ? ["Open", ...open] : []),
    ...(rest.length ? ["Not on the list", ...rest] : []),
    ...(decide.length ? ["Designs for you to finalize", ...decide] : []),
  ].join("\n");
}

/** `/status`'s card: the text, and run id → session id for every named run and listed design that has one. */
export function openItemsStatus(open: OpenItems, now: number): { text: string; sessions: Record<string, string> } {
  const sessions = Object.fromEntries([...open.items.flatMap((i) => i.runs), ...open.designs]
    .flatMap((r) => (r.targetSessionId ? [[r.runId, r.targetSessionId]] : [])));
  return { text: renderOpenItems(open, now), sessions };
}
