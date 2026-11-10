// Open-item task facts and their compact status and complete continuation projections.

import { ARROW, openItemMarkers, replyTopic } from "../core/reply.js";
import { openItemPresentation, openItemsText } from "../core/open-items.js";
import type { Router } from "../core/router.js";
import { NOT_IN_LEDGER, NOTHING_OPEN, RUNS_IN_NO_ITEM, TASK_RUN_STATES, type OpenItemsStatus, type TaskRunState } from "../core/types.js";
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
  // The head relays a stage's or a goal's question and the user answers it in the chat.
  const asksInChat = WAITING.test(stage) || runs.some((r) => r.goal?.outcome === "decision" || r.goal?.outcome === "cap");
  if (asksInChat) return { status: "waiting on you" };
  // A design waits only while its newest run succeeded: a failed or cancelled one is stopped, the head's to resume or close.
  const design = runs.find((r) => r.targetSessionId && session.designOpen(r.targetSessionId) && r.state === "succeeded");
  if (design?.targetSessionId) return { status: "waiting on you", waitsIn: design.targetSessionId };
  // A done goal has landed whatever its root run's state: the review ran in another session, and the head merges a clean one itself.
  const landed = (r: OpenRun): boolean => (r.goal ? r.goal.outcome === "done" : phaseOf(r.state) === "succeeded");
  return { status: runs.every(landed) ? "wrapping up" : "stopped" };
}

/** The store reads the list is joined against. */
export type OpenItemReads = Pick<TaskStore, "creationTitles" | "getRun" | "goalOf" | "latestRunForTarget" | "inFlightRuns" | "leads" | "workerCounts" | "openItems">;

/** `chainId`'s items; `members`: that chain, newest first. */
export function openItems(store: OpenItemReads, router: Pick<Router, "stateOf">, members: string[], chainId: string): OpenItems {
  // A session's newest run stands for it, so a lead woken again stays the same item.
  const newest = (sessionId: string | null) => (sessionId ? store.latestRunForTarget(sessionId) : undefined);
  const tracked = new Set<string>();
  const items = store.openItems(chainId).map((row): Unrated => {
    const named = row.runIds.map((id): OpenRun => {
      const own = store.getRun(id);
      tracked.add(own?.targetSessionId ?? id);
      return own ? ledgerRun(newest(own.targetSessionId) ?? own) : { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null };
    }).filter((r, i, all) => all.findIndex((o) => o.runId === r.runId) === i);
    return { problem: row.problem, stage: row.stage, runs: named, ...(row.openedAt === undefined ? {} : { openedAt: row.openedAt }) };
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
      ...(goal ? { goal: { step: goal.step, round: goal.round, cap: goal.cap, outcome: goal.outcome, reason: goal.reason, createdAt: goal.createdAt } } : {}),
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

/** The head's reply's markers, written by `sessionId`, which every item the reply is about records
 *  — a marker's, its topic's, the one holding a run of the results it answers (`runIds`) — so the
 *  item's view finds its rows after a reload. Answers whether a row changed, the keys its `<done>`s
 *  closed, and the `<done>` bodies that named nothing — an arrow's as `old → new` — for the head to be told;
 *  one already settled is neither. `earlier`, the turn's text before its answer, has its markers first. */
export function recordOpenItems(store: Pick<TaskStore, "markOpenItems">, text: string, now: number, sessionId: string, chainId: string, runIds: readonly string[] = [], earlier = ""): { changed: boolean; closed: string[]; unmatched: string[] } {
  const [before, after] = [openItemMarkers(earlier), openItemMarkers(text)];
  const markers = [...before.markers, ...after.markers];
  for (const marker of [...before.dropped, ...after.dropped]) log.warn(`open items: dropped a marker with no text: ${marker}`);
  for (const marker of [...before.unclosed, ...after.unclosed]) log.warn(`open items: read a marker with no closing tag: ${marker}`);
  const { changed, closed } = store.markOpenItems(markers, now, sessionId, chainId, { topic: replyTopic(text), runIds });
  const unmatched = markers.flatMap((m, i) => (m.op === "done" && changed[i] === null ? [m.to === undefined ? m.problem : `${m.problem}${ARROW}${m.to}`] : []));
  for (const problem of unmatched) log.warn(`open items: <done> named no open item: ${problem}`);
  return { changed: changed.some((n) => (n ?? 0) > 0), closed, unmatched };
}

/** The key an unmatched `<done>` body names, an arrow's `old`. */
export const doneOld = (unmatched: string): string => unmatched.split(ARROW)[0]!;

/** The note to the head after a `<done>` closed nothing; an arrow into no open item says so. */
export const unmatchedNote = (unmatched: readonly string[], keys: readonly string[]): string => {
  const named = (p: string) => {
    const to = p.split(ARROW).slice(1).join(ARROW);
    return `<done>${p}</done>${to && !keys.includes(to) ? ` ("${to}" is not open)` : ""}`;
  };
  return `[Pier: ${unmatched.map(named).join(", ")} closed no open item. If it meant one of these, resend <done> with that key exactly; if its item is already closed, send nothing:\n${keys.map((k) => `- ${k}`).join("\n")}]`;
};

/** The items a turn answering `runIds`' results left as they were: one holding a run of a
 *  result's session, no run of its sessions still live, its exact key in none of the turn's markers, `earlier`'s included. */
export function staleItems(store: Pick<TaskStore, "getRun" | "latestRunForTarget" | "openItems">, text: string, runIds: readonly string[], chainId: string, earlier = ""): { runId: string; problem: string }[] {
  const named = new Set([earlier, text].flatMap((t) => openItemMarkers(t).markers).flatMap((m) => (m.op === "done" && m.to !== undefined ? [m.problem, m.to, ...(m.whole === undefined ? [] : [m.whole])] : [m.problem])));
  const sessionOf = (id: string) => store.getRun(id)?.targetSessionId ?? id;
  const live = (id: string) => phaseOf((store.latestRunForTarget(sessionOf(id)) ?? store.getRun(id))?.state ?? "") === "live";
  return store.openItems(chainId).flatMap((item) => {
    const runId = named.has(item.problem) ? undefined : runIds.find((r) => item.runIds.some((id) => sessionOf(id) === sessionOf(r)));
    return runId && !item.runIds.some(live) ? [{ runId, problem: item.problem }] : [];
  });
}

/** The note to the head after it answered a result without updating its item. */
export const staleNote = (stale: readonly { runId: string; problem: string }[]): string =>
  `[Pier: ${stale.map((s) => `run ${s.runId} ended; open item "${s.problem}" still has its old stage`).join("; ")}. Close it with <done>, or <open> it again with a stage saying waiting on you.]`;

/** Complete identities for the model; compact text and Web history share the same presentation.
 *  `unmatched`: `<done>` keys that closed nothing, named in the seed so the head resends the full key. */
export function openItemsStatus(open: OpenItems, now: number, unmatched: readonly string[] = []): OpenItemsStatus {
  const runs = [...open.items.flatMap((i) => i.runs), ...open.unlisted];
  const sessions = Object.fromEntries(runs.flatMap((r) => (r.targetSessionId ? [[r.runId, r.targetSessionId]] : [])));
  const unlisted = open.unlisted.map((r) => ({ problem: r.name, title: r.title, stage: "", runs: [r], status: r.state === "queued" ? "queued" as const : "running" as const }));
  const runLabel = (r: OpenRun) => `run ${r.runId}${r.targetSessionId ? ` · session ${r.targetSessionId}` : ""}`;
  const owed = open.items.length ? unmatched : [];
  const snapshot = { version: 1 as const, items: [
    ...open.items.map((i) => openItemPresentation(i, now)),
    ...unlisted.map((i) => ({ ...openItemPresentation(i, now, `run:${i.runs[0]!.runId}`), direct: true })),
  ], ...(owed.length ? { unmatched: [...owed] } : {}) };
  // The full problem is the key the head's `<done>` names; a run in no item is listed apart, never in a key's place.
  const listed = open.items.map((i) => `- ${i.problem}${i.stage ? ` — ${i.stage}` : ""}${i.runs.length
    ? ` (${i.runs.map(runLabel).join(", ")})` : ""} · ${i.status}`)
    .concat(owed.map((p) => `- unmatched <done>: ${p} (closed nothing; if it meant an item above, <done> that item's key)`))
    .join("\n") || NOTHING_OPEN;
  const seed = unlisted.length
    ? `${listed}\n\n${RUNS_IN_NO_ITEM} — not keys, never <done> one; <open> an item naming a run that is tracked work:\n${unlisted.map((i) => `- ${runLabel(i.runs[0]!)} · ${i.problem} · ${i.status}`).join("\n")}`
    : listed;
  return { text: openItemsText(snapshot), seed, snapshot, sessions };
}
