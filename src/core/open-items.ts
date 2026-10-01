// Open-item presentation shared by live Web rows, command snapshots and IM.

import { agoLabel, relTime, waitsOnYou, workerCounts } from "./reply.js";
import { NOT_IN_LEDGER, NOTHING_OPEN, type LedgerRun, type OpenItemPresentation, type OpenItemsSnapshot, type TaskRunState } from "./types.js";

interface Goal {
  step: "work" | "review" | "merge";
  round: number;
  cap: number;
  outcome: "done" | "decision" | "cap" | "failed" | null;
  reason: string | null;
}

type Run = LedgerRun & { workers?: Record<TaskRunState, number>; goal?: Goal };
interface Item {
  key?: string;
  problem: string;
  title?: string;
  stage: string;
  status: OpenItemPresentation["status"];
  runs: Run[];
  designSessionId?: string;
  waitsIn?: string;
}

const LABELS: Record<Item["status"], string> = {
  running: "", queued: "Queued", "waiting on you": "Needs you", "pending release": "Pending release", stopped: "Stopped",
};

export function goalText(g: Goal): string {
  const review = `${Math.min(g.round + 1, g.cap)}/${g.cap}`;
  switch (g.outcome) {
    case "done": return g.step === "merge" ? "merged" : "review clean";
    case "cap": return "review cap reached · findings remain";
    case "decision": return g.reason ? `decision: ${g.reason}` : "waiting on you";
    case "failed": return g.reason ? `failed: ${g.reason}` : "failed";
    case null: return g.step === "merge" ? "merging" : g.step === "review" ? `review ${review}` : g.round ? `fixing · next review ${review}` : "";
  }
}

const time = (r: Run, now: number): string => {
  if (r.state === NOT_IN_LEDGER) return NOT_IN_LEDGER;
  if (r.state === "queued" || r.state === "running") return `elapsed ${relTime(r.queuedAt, now).replace(/^now$/, "<1m")}`;
  return r.finishedAt === null ? r.state : `${r.state} ${agoLabel(r.finishedAt, now)}`;
};

/** Titles arrive resolved by tasks; neither session lookup nor free-text stage guessing belongs here. */
export function openItemPresentation(i: Item, now: number, key = i.key ?? `item:${i.problem}`): OpenItemPresentation {
  const title = i.title || i.runs.find((r) => r.state !== NOT_IN_LEDGER && r.targetSessionId)?.name
    || i.runs.find((r) => r.state !== NOT_IN_LEDGER)?.name || i.problem;
  const stage = waitsOnYou(i.status) ? i.stage.replace(/^waiting on you:\s*/i, "") : i.stage;
  const metadata = i.runs.length > 1 ? [`${i.runs.length} runs`] : [];
  const details: OpenItemPresentation["details"] = [{ text: title }];
  if (i.problem !== title) details.push({ text: i.problem });
  if (i.stage) details.push({ text: i.stage });
  for (const r of i.runs) {
    const goal = r.goal ? goalText(r.goal) : "";
    const overviewTime = r.goal?.outcome === null && r.state !== "running" && r.state !== "queued" ? "" : time(r, now);
    if (i.runs.length === 1 && overviewTime) metadata.push(overviewTime);
    if (goal && goal !== "waiting on you" && !metadata.includes(goal)) metadata.push(goal);
    if (r.workers) {
      const important = Object.fromEntries(["running", "failed", "interrupted"].map((s) => [s, r.workers![s as TaskRunState]])) as Record<TaskRunState, number>;
      if (Object.values(important).some((n) => n > 0)) metadata.push(`workers: ${workerCounts(important)}`);
    }
    const name = r.state === NOT_IN_LEDGER ? "run" : r.name;
    details.push({ text: [`${name} · ${r.state === "running" || r.state === "queued" ? `${r.state} · ` : ""}${time(r, now)}`, `run ${r.runId}`, r.cwd, goal,
      r.workers ? `workers: ${workerCounts(r.workers)}` : ""].filter(Boolean).join("\n"),
    summary: [name, r.state === "running" || r.state === "queued" ? r.state : "", overviewTime].filter(Boolean).join(" · "), runId: r.runId,
    ...(r.targetSessionId ? { targetSessionId: r.targetSessionId } : {}) });
  }
  return { key, problem: i.problem, title, status: i.status, statusLabel: LABELS[i.status],
    stage: stage || (waitsOnYou(i.status) && i.designSessionId ? "Finalize design" : ""), metadata, details,
    runs: i.runs.map(({ runId, targetSessionId }) => ({ runId, targetSessionId })),
    ...(i.designSessionId ? { designSessionId: i.designSessionId } : {}), ...(i.waitsIn ? { waitsIn: i.waitsIn } : {}) };
}

export function openItemGroups(items: OpenItemPresentation[]): { title: string; items: OpenItemPresentation[] }[] {
  return [
    { title: "Waiting on you", items: items.filter((i) => waitsOnYou(i.status)) },
    { title: "In progress", items: items.filter((i) => i.status === "running" || i.status === "queued") },
    { title: "Other open", items: items.filter((i) => i.status === "pending release" || i.status === "stopped") },
  ].filter((g) => g.items.length);
}

export function openItemsText(snapshot: OpenItemsSnapshot): string {
  return openItemGroups(snapshot.items).map((g) => `${g.title} · ${g.items.length}\n\n${g.items.map((i) => [
    [i.title, waitsOnYou(i.status) ? "" : i.statusLabel].filter(Boolean).join(" · "), i.stage, i.metadata.join(" · "),
    ...(i.runs.length > 1 ? i.details.filter((d) => d.runId).map((d) => d.summary) : []),
  ].filter(Boolean).join("\n")).join("\n\n")}`).join("\n\n") || NOTHING_OPEN;
}

/** Transcript is an external boundary: a bad optional snapshot must not cost its text card. */
export function isOpenItemsSnapshot(value: unknown): value is OpenItemsSnapshot {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
  const optional = (v: Record<string, unknown>, k: string): boolean => v[k] === undefined || typeof v[k] === "string";
  return record(value) && value.version === 1 && Array.isArray(value.items) && value.items.every((i: unknown) =>
    record(i) && ["key", "problem", "title", "statusLabel", "stage"].every((k) => typeof i[k] === "string")
    && typeof i.status === "string" && Object.hasOwn(LABELS, i.status) && strings(i.metadata)
    && optional(i, "designSessionId") && optional(i, "waitsIn") && (i.direct === undefined || typeof i.direct === "boolean")
    && Array.isArray(i.runs) && i.runs.every((r: unknown) => record(r) && typeof r.runId === "string" && (r.targetSessionId === null || typeof r.targetSessionId === "string"))
    && Array.isArray(i.details) && i.details.every((d: unknown) => record(d) && typeof d.text === "string" && optional(d, "summary") && optional(d, "runId") && optional(d, "targetSessionId")));
}
