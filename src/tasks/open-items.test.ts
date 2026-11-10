// The open items: main's markers, written only from the head's turn ends, and
// joined to stored runs for stable facts, compact status and the full continuation seed.

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { toChatTurns } from "../agent/events.js";
import { openDb } from "../db.js";
import { ItemNotFound } from "../core/chain.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession } from "../core/session.testkit.js";
import { NOT_IN_LEDGER, TASK_RUN_STATES, type AgentFactory, type LedgerRun, type TaskRunState } from "../core/types.js";
import { openItems, openItemsStatus, openStatus, recordOpenItems, staleItems, unmatchedNote, type OpenItemReads } from "./open-items.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { Goal, OpenRun, TaskDefinition, TaskRun } from "./types.js";
import { fakeChains } from "./chain.testkit.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../log.js", async (actual) => {
  const real = await actual<typeof import("../log.js")>();
  return { ...real, logger: (area: string) => ({ ...real.logger(area), warn }) };
});

const MIN = 60_000;
const DAY = 86_400_000;
const run = (runId: string, over: Partial<LedgerRun> = {}): LedgerRun =>
  ({ runId, name: runId, state: "running", targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null, ...over });

const definition = (name: string, lead: boolean, design: boolean): TaskDefinition => ({
  id: "t1", kind: "subagent", name, description: "", enabled: true, archived: false, revision: 1,
  trigger: { type: "manual" }, callback: { type: "origin" }, timeoutSeconds: 900, nextRunAt: null,
  action: { type: "agent", session: { mode: "reuse", sessionId: "h1" }, prompt: "go", ...(lead ? { launch: { role: "lead" as const, ...(design ? { design: true } : {}) } } : {}) },
  creator: "session:h1", createdBySessionId: "h1", createdAt: 0, updatedAt: 0,
});

/** A saved run launched by the head `h1` unless `over` says otherwise; `lead` makes it its session's creating lead run, `design` a design lead's. */
const saved = (id: string, over: Partial<TaskRun> & { name?: string; lead?: boolean; design?: boolean } = {}): TaskRun => {
  const { name = id, design = false, lead = design, ...rest } = over;
  return {
    id, taskId: "t1", taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null,
    triggerSource: "agent", invokedBySessionId: "h1", sourceSessionId: "h1", targetSessionId: null,
    sessionMode: lead ? "fresh" : "reuse", callbackSessionId: "h1", background: true,
    callbackState: null, callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null,
    state: "running", input: null, context: { definition: definition(name, lead, design) }, probe: null, matched: null,
    result: null, error: null, skipReason: null, queuedAt: 0, startedAt: null, finishedAt: null, ...rest,
  };
};

function rig() {
  const db = openDb(":memory:");
  onTestFinished(() => db.close());
  const store = new TaskStore(db);
  const now = Date.now();
  const workerReads: string[][] = [];
  const titleReads: string[][] = [];
  const reads: OpenItemReads = {
    creationTitles: (ids) => { titleReads.push(ids); return store.creationTitles(ids); },
    getRun: (id) => store.getRun(id),
    goalOf: (id) => store.goalOf(id),
    latestRunForTarget: (id) => store.latestRunForTarget(id),
    inFlightRuns: () => store.inFlightRuns(),
    leads: () => store.leads(),
    openItems: () => store.openItems("main"),
    workerCounts: (ids) => {
      workerReads.push(ids);
      return store.workerCounts(ids);
    },
  };
  const save = (...runs: TaskRun[]) => runs.forEach((r) => store.saveRun(r));
  /** `n` workers of `lead` in `state`, finished `ago` before now when not in flight. */
  const workers = (lead: string, state: TaskRunState, n = 1, ago = MIN) => save(...Array.from({ length: n }, (_, i) =>
    saved(`w-${lead}-${state}-${i}`, { invokedBySessionId: lead, state, finishedAt: state === "queued" || state === "running" ? null : now - ago })));
  const router = new Router(new EventHub(), () => Promise.reject(new Error("no session")));
  const item = (problem: string, stage: string, runIds: string[], updatedAt: number) =>
    db.prepare("INSERT INTO open_items(chain_id, problem, stage, run_ids, updated_at) VALUES ('main', ?, ?, ?, ?)").run(problem, stage, JSON.stringify(runIds), updatedAt);
  const list = (members = ["h1"]) => openItems(reads, router, members, "main");
  const goal = (rootRunId: string, over: Partial<Goal> = {}) => store.saveGoal({
    id: `g-${rootRunId}`, rootRunId, supervisorSessionId: "h1", cap: 3, round: 0, step: "work", currentRunId: rootRunId,
    outcome: null, reason: null, reviewModel: null, createdAt: 0, finishedAt: null, ...over,
  });
  return { now, store, save, workers, workerReads, titleReads, router, item, list, goal };
}

/** A TaskService over `store` whose chain `main` has the attached head `h0`; `end` ends one of its turns. */
function head(store = new TaskStore(openDb(":memory:"))) {
  const hub = new EventHub();
  const h0 = fakeSession("h0");
  const router = new Router(hub, () => Promise.resolve(h0));
  router.attach({ channelId: "web", conversationId: "h0" }, h0);
  const service = new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
  const end = (text: string, earlier?: string) => h0.emit({ type: "turn-end", text, ...(earlier === undefined ? {} : { earlier }) });
  const open = () => store.openItems("main").map((i) => i.problem);
  const notes = () => h0.systemInputs.map((i) => i.text);
  return { h0, store, service, end, open, notes };
}

describe("the open items", () => {
  it("joins each run token through the store: found, gone, and a lead with its workers", () => {
    const r = rig();
    const now = r.now;
    r.save(saved("1prwmabcdef", { name: "lead open items", lead: true, targetSessionId: "lead1", queuedAt: now - 23 * MIN }));
    r.workers("lead1", "running");
    r.workers("lead1", "succeeded");
    r.item("open items 视图", "lead designing", ["1prwmabcdef"], 2);
    r.item("model menu 重选", "merged, restart pending", ["gone1"], 1);
    const open = r.list();
    expect(open.items.map((i) => i.problem)).toEqual(["open items 视图", "model menu 重选"]);
    expect(open.items[1]!.runs).toEqual([{ runId: "gone1", name: "gone1", state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }]);
    expect(open.items[0]!.runs[0]!.workers).toEqual({ queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 });
    expect(open.unlisted).toEqual([]);
    expect(r.workerReads).toEqual([["lead1"]]);
    expect(openItemsStatus(open, now).text).toBe([
      "In progress · 1", "", "lead open items", "lead designing", "elapsed 23m · workers: 1 running", "",
      "Other open · 1", "", "model menu 重选 · Stopped", "merged, restart pending", "not in the ledger",
    ].join("\n"));
  });

  it("lists only the in-flight chain runs no item's session holds, never a finished one or another session's", () => {
    const r = rig();
    const now = r.now;
    r.save(
      saved("r-live", { name: "Build it", queuedAt: now - 5 * MIN }),
      saved("r-queued", { name: "Next", state: "queued", queuedAt: now - MIN }),
      saved("r-failed", { name: "Review src/auth", state: "failed", finishedAt: now - 2 * 60 * MIN }),
      saved("r-cancelled", { name: "Dropped", state: "cancelled", finishedAt: now - MIN }),
      saved("r-ok", { name: "Done thing", state: "succeeded", finishedAt: now - MIN }),
      saved("r-named", { name: "Named", state: "failed", finishedAt: now }),
      saved("r-elsewhere", { invokedBySessionId: "other" }),
    );
    r.item("the problem", "", ["r-named"], 1);
    const open = r.list();
    expect(open.unlisted.map((u) => u.runId)).toEqual(["r-live", "r-queued"]);
    expect(openItemsStatus(open, now).text).toBe([
      "In progress · 2", "", "Build it", "elapsed 5m", "", "Next · Queued", "elapsed 1m", "",
      "Other open · 1", "", "Named · Stopped", "failed just now",
    ].join("\n"));
  });

  // A lead woken again (a callback turn, a follow-up run) is the same item: the item follows its session.
  it("follows an item's session to its newest run, however old the named run is", () => {
    const r = rig();
    const now = r.now;
    r.save(
      saved("vdmj112x", { targetSessionId: "lead1", state: "succeeded", queuedAt: now - 3 * DAY, finishedAt: now - 3 * DAY }),
      saved("k4k3jz55", { name: "lead again", targetSessionId: "lead1", queuedAt: now - 2 * MIN, peakTokens: 45_000, compactAt: 100_000, compactions: 1 }),
    );
    r.item("status 归并", "lead building", ["vdmj112x"], 1);
    const open = r.list();
    expect(open.items[0]!.runs.map((x) => [x.runId, x.context])).toEqual([["k4k3jz55", "peak 45% of the compaction point, 1 compaction"]]);
    expect(open.unlisted).toEqual([]);
    expect(openItemsStatus(open, now).text).toBe("In progress · 1\n\nlead again\nlead building\nelapsed 2m");
  });

  it("follows a session of 250 runs to its newest, past any listing's cap", () => {
    const r = rig();
    const now = r.now;
    r.save(...Array.from({ length: 250 }, (_, i) => saved(`s${i}`, {
      targetSessionId: "lead1", state: i === 249 ? "succeeded" : "failed", queuedAt: now - (250 - i) * MIN, finishedAt: now - (250 - i) * MIN + 1,
    })));
    r.item("long lead", "merged", ["s0"], 1);
    const [item] = r.list().items;
    expect(item!.runs.map((x) => [x.runId, x.state])).toEqual([["s249", "succeeded"]]);
    expect(item!.status).toBe("wrapping up");
  });

  // A listing's window is not the work's end: age alone never stops an item.
  it("reads an item whose run succeeded 3 days ago as wrapping up", () => {
    const r = rig();
    r.save(saved("old", { targetSessionId: "s-old", state: "succeeded", queuedAt: r.now - 3 * DAY, finishedAt: r.now - 3 * DAY }));
    r.item("shipped", "merged, restart pending", ["old"], 1);
    expect(r.list().items.map((i) => [i.runs[0]!.runId, i.status])).toEqual([["old", "wrapping up"]]);
  });

  it("reads a token that names no run as not in the ledger, and so stopped", () => {
    const r = rig();
    r.item("typo", "", ["nosuchrun"], 1);
    const [item] = r.list().items;
    expect(item!.runs.map((x) => x.state)).toEqual([NOT_IN_LEDGER]);
    expect(item!.status).toBe("stopped");
  });

  // The status is the runs' and sessions', whatever the stage text says.
  it("reads an item running while its session streams, though its run has finished, and wrapping up once idle", () => {
    const r = rig();
    r.save(saved("r1", { targetSessionId: "lead1", state: "succeeded", finishedAt: r.now - MIN }));
    r.item("fix", "lead building (running)", ["r1"], 1);
    expect(r.list().items[0]!.status).toBe("wrapping up");
    const lead = fakeSession("lead1");
    r.router.attach({ channelId: "task", conversationId: "lead1" }, lead);
    lead.setState("streaming");
    expect(r.list().items[0]!.status).toBe("running");
  });

  // Every state a run can hold, through the one reading every surface groups by.
  it("reads an item's status from its whole run tree and its stage, for every run state", () => {
    const at = (state: string, over: Partial<OpenRun> = {}): OpenRun => ({ ...run("r", { state, targetSessionId: "s" }), ...over });
    const none = (id: string): boolean => id === "";
    const quiet = { streaming: none, designOpen: none };
    const status = (runs: OpenRun[], stage = "", session = quiet) => openStatus({ problem: "p", stage, runs }, session).status;
    expect(Object.fromEntries([...TASK_RUN_STATES, NOT_IN_LEDGER].map((s) => [s, status([at(s)])]))).toEqual({
      queued: "running", running: "running", succeeded: "wrapping up", failed: "stopped",
      cancelled: "stopped", interrupted: "stopped", skipped: "stopped", [NOT_IN_LEDGER]: "stopped",
    });
    expect(status([])).toBe("wrapping up");
    expect(status([at("succeeded"), at("failed")])).toBe("stopped");
    // The stage's marker, a design not final: the only two ways an item waits on the user.
    expect(status([at("succeeded")], "waiting on you: 手动重启还是派 worker")).toBe("waiting on you");
    expect(status([at("failed")], "Waiting on you: 60K or 80K?")).toBe("waiting on you");
    expect(status([at("succeeded")], "", { ...quiet, designOpen: (id) => id === "s" })).toBe("waiting on you");
    // A design whose newest run did not succeed is stopped, the head's to resume or close.
    expect(status([at("failed")], "", { ...quiet, designOpen: (id) => id === "s" })).toBe("stopped");
    // Anything live below the item outranks the marker: a streaming session, a lead's workers in flight.
    expect(status([at("succeeded")], "waiting on you: x", { ...quiet, streaming: (id) => id === "s" })).toBe("running");
    const workers = (over: Partial<Record<TaskRunState, number>>) =>
      ({ ...Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])), ...over }) as Record<TaskRunState, number>;
    expect(status([at("succeeded", { workers: workers({ running: 3 }) })], "lead 实现中")).toBe("running");
    expect(status([at("succeeded", { workers: workers({ queued: 1 }) })])).toBe("running");
    // A finished worker's outcome is its lead's to read: the lead's run decides.
    expect(status([at("succeeded", { workers: workers({ succeeded: 2, failed: 1 }) })])).toBe("wrapping up");
  });

  // The goal, not the stage or the root run's state, says where a goal's item stands.
  it("reads a goal's item from its goal: live, a decision, the cap, clean, failed", () => {
    const r = rig();
    const now = r.now;
    const ends: [string, Partial<Goal>][] = [
      ["live", { step: "review", round: 2, createdAt: now - 40 * MIN }],
      ["decision", { outcome: "decision", finishedAt: now }],
      ["cap", { step: "review", round: 3, outcome: "cap", finishedAt: now }],
      ["done", { step: "review", round: 1, outcome: "done", finishedAt: now }],
      ["failed", { step: "review", outcome: "failed", reason: "no verdict", finishedAt: now }],
    ];
    ends.forEach(([id, over], i) => {
      r.save(saved(id, { targetSessionId: `s-${id}`, state: "succeeded", finishedAt: now - MIN }));
      r.goal(id, over);
      r.item(`goal ${id}`, "worker building", [id], i);
    });
    // The user's yes resumed the clean one's worker, which merged: read as any run, the goal off its line.
    r.save(saved("merged", { targetSessionId: "s-merged", state: "succeeded", finishedAt: now - 3 * MIN }));
    r.goal("merged", { step: "review", outcome: "done", finishedAt: now - 3 * MIN });
    r.save(saved("merge", { targetSessionId: "s-merged", state: "succeeded", queuedAt: now - 2 * MIN, finishedAt: now - MIN }));
    r.item("goal merged", "worker building", ["merged"], ends.length);
    // A goal stored before the loop left the merge to the user, ended by its merge step: landed.
    r.save(saved("legacy", { targetSessionId: "s-legacy", state: "succeeded", finishedAt: now - MIN }));
    r.goal("legacy", { step: "merge", round: 1, outcome: "done", finishedAt: now });
    r.item("goal legacy", "worker building", ["legacy"], ends.length + 1);
    const open = r.list();
    expect(open.items.map((i) => [i.problem, i.status, i.waitsIn])).toEqual([
      ["goal live", "running", undefined],
      ["goal decision", "waiting on you", undefined],
      ["goal cap", "waiting on you", undefined],
      ["goal done", "wrapping up", undefined],
      ["goal failed", "stopped", undefined],
      ["goal merged", "wrapping up", undefined],
      ["goal legacy", "wrapping up", undefined],
    ]);
    const status = openItemsStatus(open, now);
    // An ended goal's ask is the waiting item's second line, not repeated below it.
    expect(status.snapshot.items.map((i) => [i.stage, i.metadata])).toEqual([
      // A waiting item reads how long it has waited, never "succeeded … ago".
      // A live goal's review runs elsewhere: its own time stands beside its wording.
      ["worker building", ["review 3/3", "elapsed 40m"]], ["1m · decision", []],
      ["1m · review cap reached · findings remain", []], ["worker building", ["succeeded 1m ago", "review clean"]],
      ["worker building", ["succeeded 1m ago", "failed: no verdict"]], ["worker building", ["succeeded 1m ago"]],
      ["worker building", ["succeeded 1m ago", "merged"]],
    ]);
    expect(status.text).toContain("Waiting on you · 2");
    expect(status.text).not.toContain("run ");
    expect(status.seed).toContain("run live");
    expect(status.seed).toContain("session s-live");
  });

  it("keeps multi-run review progress and failures consistent in compact text, seed and replay", () => {
    const r = rig();
    r.save(
      saved("root", { name: "Reviewed work", targetSessionId: "root-session", state: "succeeded", finishedAt: r.now - MIN }),
      saved("failed", { name: "First line\nSecond line", state: "failed", finishedAt: r.now - MIN }),
      saved("queued", { name: "Next work", state: "queued", queuedAt: r.now - MIN }),
    );
    r.goal("root", { step: "review", createdAt: r.now - 7 * MIN });
    r.item("original multi-run question", "Authorized scope", ["root", "failed", "queued"], 1);
    const status = openItemsStatus(r.list(), r.now);
    // The newest run, by queue time, stands for the rest: no line per run.
    expect(status.text).toBe("In progress · 1\n\nReviewed work\nAuthorized scope\n3 runs · elapsed 1m · review 1/3");
    expect(status.snapshot.items[0]!.runs.map((r) => r.runId)).toEqual(["queued", "failed", "root"]);
    expect(status.seed).toBe("- original multi-run question — Authorized scope (run root · session root-session, run failed, run queued) · running");
    // The newest a goal's root under review elsewhere: its finish is not the item's time.
    r.item("root newest", "", ["failed", "root"], 2);
    r.save(saved("root", { name: "Reviewed work", targetSessionId: "root-session", state: "succeeded", queuedAt: r.now, finishedAt: r.now - MIN }));
    expect(openItemsStatus(r.list(), r.now).snapshot.items[1]!.metadata).toEqual(["2 runs", "review 1/3", "elapsed 7m"]);
    const reason = "Approval needed\nOnly the current branch is authorized";
    r.goal("root", { outcome: "decision", reason, finishedAt: r.now });
    const decision = openItemsStatus(r.list(), r.now);
    expect(decision.text).toContain(`decision: ${reason}`);
    const replay = toChatTurns([{ role: "custom", customType: "pier.system-input", content: decision.text,
      details: { kind: "chat-command", command: "status", statusSnapshot: decision.snapshot }, timestamp: r.now }]);
    expect(replay[0]!.origin).toMatchObject({ statusSnapshot: decision.snapshot });
  });

  it("names the child session a wait is answered in: a design's lead; never a stage's or a goal's, answered in the chat", () => {
    const r = rig();
    const now = r.now;
    r.save(
      saved("d1", { name: "Rail redesign", design: true, targetSessionId: "s-d1", state: "succeeded", finishedAt: now }),
      saved("w-stage", { name: "stage wait", targetSessionId: "s-stage", state: "succeeded", finishedAt: now }),
      saved("w-goal", { name: "goal wait", targetSessionId: "s-goal", state: "succeeded", finishedAt: now }),
    );
    r.goal("w-goal", { outcome: "decision", finishedAt: now });
    r.item("stage wait", "waiting on you: 60K or 80K?", ["w-stage"], 1);
    r.item("goal wait", "worker building", ["w-goal"], 2);
    r.item("rail", "lead proposed two layouts", ["d1"], 3);
    const open = r.list();
    expect(open.items.map((i) => [i.problem, i.status, i.waitsIn, i.designSessionId])).toEqual([
      ["stage wait", "waiting on you", undefined, undefined],
      ["goal wait", "waiting on you", undefined, undefined],
      ["rail", "waiting on you", "s-d1", "s-d1"],
    ]);
    expect(openItemsStatus(open, now).text).toBe([
      "Waiting on you · 3", "",
      "stage wait", "<1m · 60K or 80K?", "",
      "goal wait", "<1m · decision", "",
      "Rail redesign", "in the design session · <1m · lead proposed two layouts",
    ].join("\n"));
  });

  // A design exists on the list only through the head's item: no marker, no row; its newest run failed, stopped.
  it("lists a design lead only under an item, and reads it stopped once its newest run failed", () => {
    const r = rig();
    const now = r.now;
    r.save(
      saved("d-free", { design: true, targetSessionId: "s-free", state: "succeeded", finishedAt: now }),
      saved("d-held", { name: "Held design", design: true, targetSessionId: "s-held", state: "succeeded", queuedAt: 1, finishedAt: now - 2 * MIN }),
      saved("d-again", { targetSessionId: "s-held", state: "failed", queuedAt: 2, finishedAt: now - MIN }),
    );
    expect(r.list()).toEqual({ items: [], unlisted: [] });
    r.item("held", "", ["d-held"], 1);
    const [item] = r.list().items;
    expect(item).toMatchObject({ problem: "held", status: "stopped", designSessionId: "s-held" });
    expect(item!.waitsIn).toBeUndefined();
    expect(openItemsStatus(r.list(), now).text).toBe("Other open · 1\n\nHeld design · Stopped\nfailed 1m ago");
  });

  it("groups a lead whose turn ended under In progress while its workers run, and a succeeded item under Waiting on you only by its stage", () => {
    const r = rig();
    const now = r.now;
    r.save(
      saved("mmk4jv4p", { lead: true, targetSessionId: "lead1", state: "succeeded", finishedAt: now - MIN }),
      saved("4dyem4jc", { targetSessionId: "w1", state: "succeeded", finishedAt: now - MIN }),
      saved("donedone", { targetSessionId: "w2", state: "succeeded", finishedAt: now - MIN }),
    );
    r.workers("lead1", "running", 3);
    r.item("回调后回复语言跑偏", "waiting on you: 手动重启还是派 worker", ["4dyem4jc"], 1);
    r.item("重启卡住原因", "lead 实现中", ["mmk4jv4p"], 2);
    r.item("已合并", "merged, restart pending", ["donedone"], 3);
    const open = r.list();
    expect(open.items.map((i) => [i.problem, i.status])).toEqual([
      ["回调后回复语言跑偏", "waiting on you"],
      ["重启卡住原因", "running"],
      ["已合并", "wrapping up"],
    ]);
    const text = openItemsStatus(open, now).text;
    expect(text.indexOf("Waiting on you · 1")).toBeLessThan(text.indexOf("In progress · 1"));
    expect(text).toContain("手动重启还是派 worker");
    expect(text).toContain("workers: 3 running");
    expect(text).toContain("Other open · 1");
  });

  it("reads every shown lead's workers in one read, three leads or one", () => {
    const r = rig();
    r.save(
      saved("a", { lead: true, targetSessionId: "l1", queuedAt: 1 }),
      saved("b", { lead: true, targetSessionId: "l2", queuedAt: 2 }),
      saved("c", { lead: true, targetSessionId: "l3", state: "queued", queuedAt: 3 }),
      saved("d", { targetSessionId: "not-a-lead", queuedAt: 4 }),
    );
    r.workers("l1", "running");
    r.workers("l2", "failed");
    r.workers("l3", "queued");
    r.workers("l3", "succeeded");
    r.item("first", "", ["a"], 2);
    r.item("second", "", ["b"], 1);
    const open = r.list();
    expect(r.workerReads).toEqual([["l1", "l2", "l3"]]);
    expect(open.items.map((i) => i.runs[0]!.workers)).toEqual([
      { queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 },
      { queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0, interrupted: 0, skipped: 0 },
    ]);
    expect(open.unlisted.map((u) => [u.runId, u.workers])).toEqual([
      ["c", { queued: 1, running: 0, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 }],
      ["d", undefined],
    ]);
  });

  // A lead's session is one feature's: all its launches count, a probe that found nothing does not.
  it("counts a lead's workers that finished days ago", () => {
    const r = rig();
    r.save(saved("lead-run", { lead: true, targetSessionId: "lead1", state: "succeeded", finishedAt: r.now - 2 * DAY }));
    r.workers("lead1", "succeeded", 2, 2 * DAY);
    r.workers("lead1", "failed", 1, 2 * DAY);
    r.save(saved("probe", { invokedBySessionId: "lead1", state: "succeeded", matched: false, finishedAt: r.now - MIN }));
    r.item("old feature", "", ["lead-run"], 1);
    expect(r.list().items[0]!.runs[0]!.workers)
      .toEqual({ queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0, interrupted: 0, skipped: 0 });
  });

  // An item keeps the place it was opened in, however often the head restates it.
  it("keeps an item's place when an <open> updates it", () => {
    const r = rig();
    const open = (problem: string, stage: string) => ({ op: "open" as const, problem, stage, runIds: [] });
    expect(r.store.markOpenItems([open("first", "a"), open("second", "b")], 1, "h1", "main").changed).toEqual([1, 1]);
    expect(r.store.markOpenItems([open("first", "a2"), { op: "done", problem: "never" }], 2, "h1", "main").changed).toEqual([1, null]);
    expect(r.store.openItems("main").map((i) => [i.problem, i.stage])).toEqual([["first", "a2"], ["second", "b"]]);
  });

  // An item's age is its first <open>'s: a stage update, Pier's rename and an arrow keep it, a reopen starts it again.
  it("keeps an item's opening time across updates, renames and arrows, and starts it again on a reopen", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "", runIds });
    const opened = () => r.store.openItems("main").map((i) => [i.problem, i.openedAt]);
    r.store.markOpenItems([open("VM pairing", "rt1"), open("parser")], 10, "h1", "main");
    r.store.markOpenItems([open("parser")], 20, "h1", "main");
    r.store.markOpenItems([open("VM pairing, also logs", "rt1")], 30, "h1", "main");
    expect(opened()).toEqual([["VM pairing, also logs", 10], ["parser", 10]]);
    r.store.markOpenItems([{ op: "done", problem: "parser", to: "parsing" }, open("parsing")], 40, "h1", "main");
    expect(opened()).toEqual([["VM pairing, also logs", 10], ["parsing", 10]]);
    r.store.markOpenItems([{ op: "done", problem: "parsing" }], 50, "h1", "main");
    r.store.markOpenItems([open("parsing"), open("new one")], 60, "h1", "main");
    expect(opened()).toEqual([["VM pairing, also logs", 10], ["parsing", 60], ["new one", 60]]);
    const status = openItemsStatus(r.list(), 60 + 2 * 60 * MIN);
    // In text the age leads the metadata line.
    expect(status.text).toContain("VM pairing, also logs · Stopped\nopen 2h · not in the ledger");
    const shown = status.snapshot.items.map((i) => [i.problem, i.age]);
    expect(shown).toEqual([["VM pairing, also logs", "open 2h"], ["parsing", "open 2h"], ["new one", "open 2h"]]);
    // A row older than the record reads no age.
    r.item("undated", "", [], 99);
    expect(openItemsStatus(r.list(), r.now).snapshot.items.find((i) => i.problem === "undated")).not.toHaveProperty("age");
  });

  // The head restates an item's problem with the user's added asks: one run, one item.
  it("renames the item a run is behind when an <open> names it under a new key", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "investigating", runIds });
    const rows = () => r.store.openItems("main").map((i) => [i.problem, i.runIds]);
    r.store.markOpenItems([open("before"), open("VM pairing", "rt1"), open("after", "rt9")], 1, "h1", "main");
    expect(r.store.markOpenItems([open("VM pairing, also check logs", "rt1")], 2, "h1", "main").changed).toEqual([2]);
    expect(r.store.markOpenItems([open("VM pairing, logs and retry", "rt1")], 3, "h1", "main").changed).toEqual([2]);
    expect(rows()).toEqual([["before", []], ["VM pairing, logs and retry", ["rt1"]], ["after", ["rt9"]]]);
    // An old name of an open item is no key of it: the head is told the one it holds now.
    expect(r.store.markOpenItems([{ op: "done", problem: "VM pairing" }, { op: "done", problem: "VM pairing, also check logs" }], 4, "h1", "main").changed).toEqual([null, null]);
  });

  // An <open> written with another separator than ` — ` keyed its whole line; the <done> naming its head still closes it.
  it("closes the one item a <done> key starts, followed by a separator a miswritten <open> uses, and none when two are", () => {
    const r = rig();
    const open = (problem: string) => ({ op: "open" as const, problem, stage: "", runIds: [] });
    const done = (problem: string) => ({ op: "done" as const, problem });
    const keys = () => r.store.openItems("main").map((i) => i.problem);
    r.store.markOpenItems([open("顶栏条目关闭匹配。当前进度：排查中"), open("auth：review"), open("fix parser"), open("fix parser tests"), open("dup: a"), open("dup – b"), open("pairing, logs")], 1, "h1", "main");
    expect(r.store.markOpenItems([done("顶栏条目关闭匹配"), done("auth"), done("fix pars"), done("dup"), done("pairing")], 2, "h1", "main"))
      .toEqual({ changed: [1, 1, null, null, null], closed: ["顶栏条目关闭匹配。当前进度：排查中", "auth：review"] });
    expect(keys()).toEqual(["fix parser", "fix parser tests", "dup: a", "dup – b", "pairing, logs"]);
    // A word after the key is another item; the exact key wins over a prefixed one.
    expect(r.store.markOpenItems([done("fix parser")], 3, "h1", "main")).toEqual({ changed: [1], closed: ["fix parser"] });
    expect(keys()).toEqual(["fix parser tests", "dup: a", "dup – b", "pairing, logs"]);
    // A hyphen ends a key only spaced; an em dash in a key is the head's own.
    r.store.markOpenItems([open("gpu-speed3 合并后检查"), open("deploy - staging"), open("fix—web")], 4, "h1", "main");
    expect(r.store.markOpenItems([done("gpu"), done("deploy"), done("fix")], 5, "h1", "main")).toEqual({ changed: [null, 1, null], closed: ["deploy - staging"] });
  });

  it("collapses every item a run is behind into the one an <open> names, and leaves other runs where they are", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "", runIds });
    const rows = () => r.store.openItems("main").map((i) => [i.problem, i.runIds]);
    // Rows written before the rule: one run behind three keys.
    for (const p of ["dup 1", "dup 2", "dup 3"]) r.item(p, "", ["rt1"], 1);
    r.store.markOpenItems([open("pair", "rt2", "rt3")], 1, "h1", "main");
    expect(r.store.markOpenItems([open("dup 2", "rt1")], 2, "h1", "main").changed).toEqual([3]);
    expect(rows()).toEqual([["dup 2", ["rt1"]], ["pair", ["rt2", "rt3"]]]);
    r.store.markOpenItems([open("pair", "rt2", "rt3")], 3, "h1", "main");
    expect(rows()).toEqual([["dup 2", ["rt1"]], ["pair", ["rt2", "rt3"]]]);
    r.store.markOpenItems([open("split", "rt3")], 4, "h1", "main");
    expect(rows()).toEqual([["dup 2", ["rt1"]], ["pair", ["rt2"]], ["split", ["rt3"]]]);
    r.store.markOpenItems([open("pair, restated", "rt2", "rt3")], 5, "h1", "main");
    expect(rows()).toEqual([["dup 2", ["rt1"]], ["pair, restated", ["rt2", "rt3"]]]);
  });

  // A session's newest run stands for it, so a lead woken again under a new key stays one item.
  it("collapses the item a run's session is behind into the one an <open> names with its newer run", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "", runIds });
    const rows = () => r.store.openItems("main").map((i) => [i.problem, i.runIds]);
    r.save(saved("rs1", { targetSessionId: "s1", state: "succeeded" }), saved("rs2", { targetSessionId: "s1" }), saved("rt1", { targetSessionId: "t1" }));
    r.store.markOpenItems([open("lead", "rs1", "rt1"), open("lost", "gone")], 1, "h1", "main");
    expect(r.store.markOpenItems([open("lead, woken again", "rs2")], 2, "h1", "main").changed).toEqual([2]);
    expect(rows()).toEqual([["lead", ["rt1"]], ["lost", ["gone"]], ["lead, woken again", ["rs2"]]]);
    r.store.markOpenItems([open("lead, third time", "rs1")], 3, "h1", "main");
    expect(rows()).toEqual([["lead", ["rt1"]], ["lost", ["gone"]], ["lead, third time", ["rs1"]]]);
  });

  it("keeps a closed item's record, reopens it at the end of the list, and records each writing session once", () => {
    const r = rig();
    const open = (problem: string, stage = "") => ({ op: "open" as const, problem, stage, runIds: [] });
    const keys = () => r.store.openItems("main").map((i) => i.problem);
    r.store.markOpenItems([open("login"), open("parser")], 1, "h1", "main");
    r.store.markOpenItems([open("login", "testing")], 2, "h1", "main");
    expect(r.store.markOpenItems([{ op: "done", problem: "login" }], 3, "h2", "main")).toEqual({ changed: [1], closed: ["login"] });
    expect(keys()).toEqual(["parser"]);
    expect(r.store.itemHistory("main", "login")).toEqual({ chain: "main", problem: "login", aliases: [], closedAt: 3, sessions: ["h1", "h2"], runIds: [] });
    // A closed item is closed: a second <done> of it is settled, no row changed.
    expect(r.store.markOpenItems([{ op: "done", problem: "login" }], 4, "h2", "main").changed).toEqual([0]);
    r.store.markOpenItems([open("login", "again")], 5, "h3", "main");
    expect(keys()).toEqual(["parser", "login"]);
    expect(r.store.itemHistory("main", "login")).toEqual({ chain: "main", problem: "login", aliases: [], sessions: ["h1", "h2", "h3"], runIds: [] });
  });

  it("records the head on the item a reply with no marker is about: its topic's, by key or alias, and its answered run's", () => {
    const r = rig();
    r.store.markOpenItems([{ op: "open", problem: "login", stage: "", runIds: ["rt1"] }, { op: "open", problem: "parser", stage: "", runIds: [] }], 1, "h1", "main");
    r.store.markOpenItems([{ op: "done", problem: "parser", to: "login" }], 2, "h1", "main");
    expect(recordOpenItems(r.store, "Still green.\n<topic>parser</topic>", 3, "h2", "main")).toEqual({ changed: false, closed: [], unmatched: [] });
    recordOpenItems(r.store, "Merged.", 4, "h3", "main", ["rt1"]);
    recordOpenItems(r.store, "Hello.", 5, "h4", "main");
    // `parser`'s topic is the open item that absorbed it.
    expect(r.store.itemHistory("main", "login")?.sessions).toEqual(["h1", "h2", "h3"]);
    expect(r.store.itemHistory("main", "parser")?.problem).toBe("login");
  });

  it("records a stamped send's head on the item under its key when the stamp names an alias", () => {
    const r = rig();
    // Pier's rename leaves the old key no row of its own: only the alias names it.
    r.store.markOpenItems([{ op: "open", problem: "sign in", stage: "", runIds: ["rt1"] }], 1, "h1", "main");
    r.store.markOpenItems([{ op: "open", problem: "login", stage: "", runIds: ["rt1"] }], 2, "h1", "main");
    // What WebDeps.itemSent does (src/main.ts) for a send stamped `[item: sign in]`.
    expect(r.store.markOpenItems([], 3, "h2", "main", { topic: "sign in" })).toEqual({ changed: [], closed: [] });
    expect(r.store.itemHistory("main", "login")).toEqual({ chain: "main", problem: "login", aliases: ["sign in"], sessions: ["h1", "h2"], runIds: ["rt1"] });
  });

  it("closes an arrow's item into the one the reply leaves open, and nothing when that one is not open", () => {
    const r = rig();
    const open = (problem: string) => ({ op: "open" as const, problem, stage: "", runIds: [] });
    const arrow = (problem: string, to: string) => ({ op: "done" as const, problem, to });
    r.store.markOpenItems([open("login"), open("parser")], 1, "h1", "main");
    // The <open> of `new` may follow its arrow in the reply.
    expect(r.store.markOpenItems([arrow("login", "login, also SSO"), open("login, also SSO")], 2, "h2", "main"))
      .toEqual({ changed: [1, 1], closed: ["login"] });
    expect(r.store.markOpenItems([arrow("login, also SSO", "auth")], 3, "h2", "main")).toEqual({ changed: [null], closed: [] });
    expect(r.store.openItems("main").map((i) => i.problem)).toEqual(["parser", "login, also SSO"]);
    r.store.markOpenItems([open("auth"), arrow("login, also SSO", "auth")], 4, "h3", "main");
    expect(r.store.itemHistory("main", "auth")).toEqual({ chain: "main", problem: "auth", aliases: ["login, also SSO", "login"], sessions: ["h1", "h2", "h3"], runIds: [] });
    // An arrow's closed `old` row is `new`'s history: its key opens `new`, a search lists `new` once.
    for (const old of ["login", "login, also SSO"]) expect(r.store.itemHistory("main", old)).toEqual(r.store.itemHistory("main", "auth"));
    expect(r.store.items("login").map((i) => [i.problem, i.closedAt])).toEqual([["auth", undefined]]);
    expect(r.store.items("LOGIN sso").map((i) => i.problem)).toEqual(["auth"]);
    expect(r.store.items("login nothing")).toEqual([]);
    // A closed item nothing absorbed keeps its own record and row; with `new` closed too, `old` is still `new`'s,
    // and so is a stamped send naming it.
    r.store.markOpenItems([{ op: "done", problem: "parser" }, { op: "done", problem: "auth" }], 5, "h3", "main");
    expect(r.store.itemHistory("main", "parser")).toMatchObject({ problem: "parser", closedAt: 5 });
    expect(r.store.itemHistory("main", "login")).toEqual(r.store.itemHistory("main", "auth"));
    expect(r.store.items("").map((i) => i.problem)).toEqual(["auth", "parser"]);
    r.store.markOpenItems([], 6, "h4", "main", { topic: "login" });
    expect(r.store.itemHistory("main", "auth")?.sessions).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("gives a reopened key back its own history: no other item holds it as an alias", () => {
    const r = rig();
    const open = (problem: string) => ({ op: "open" as const, problem, stage: "", runIds: [] });
    r.store.markOpenItems([open("login")], 1, "h1", "main");
    r.store.markOpenItems([open("login v2"), { op: "done", problem: "login", to: "login v2" }], 2, "h2", "main");
    r.store.markOpenItems([open("login")], 3, "h3", "main");
    expect(r.store.itemHistory("main", "login v2")?.aliases).toEqual([]);
    r.store.markOpenItems([{ op: "done", problem: "login" }], 4, "h3", "main");
    expect(r.store.itemHistory("main", "login")).toEqual({ chain: "main", problem: "login", aliases: [], closedAt: 4, sessions: ["h1", "h2", "h3"], runIds: [] });
    expect(r.store.items("login").map((i) => [i.problem, i.closedAt])).toEqual([["login", 4], ["login v2", undefined]]);
  });

  it("gives a renamed item's old key back when an <open> writes it again", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "", runIds });
    r.store.markOpenItems([open("sign in", "rt1")], 1, "h1", "main");
    // Pier's rename: the row takes the new key in place, the old one only an alias.
    r.store.markOpenItems([open("login", "rt1")], 2, "h1", "main");
    expect(r.store.itemHistory("main", "login")?.aliases).toEqual(["sign in"]);
    r.store.markOpenItems([open("sign in")], 3, "h2", "main");
    expect(r.store.itemHistory("main", "login")?.aliases).toEqual([]);
    expect(r.store.itemHistory("main", "sign in")).toEqual({ chain: "main", problem: "sign in", aliases: [], sessions: ["h2"], runIds: [] });
    // Renamed back onto a key it once held, the row holds no alias of itself.
    const back = rig();
    back.store.markOpenItems([open("sign in", "rt1")], 1, "h1", "main");
    back.store.markOpenItems([open("login", "rt1")], 2, "h1", "main");
    back.store.markOpenItems([open("sign in", "rt1")], 3, "h1", "main");
    expect(back.store.items("").map((i) => [i.problem, i.aliases])).toEqual([["sign in", ["login"]]]);
  });

  it("tells the head an arrow into no open item, and counts the arrow's target as named", () => {
    const r = rig();
    r.store.markOpenItems([{ op: "open", problem: "login", stage: "", runIds: ["rt1"] }], 1, "h1", "main");
    const told = recordOpenItems(r.store, "<done>login → auth</done>", 2, "h1", "main");
    expect(told).toEqual({ changed: false, closed: [], unmatched: ["login → auth"] });
    expect(unmatchedNote(told.unmatched, ["login"]))
      .toBe("[Pier: <done>login → auth</done> (\"auth\" is not open) closed no open item. If it meant one of these, resend <done> with that key exactly; if its item is already closed, send nothing:\n- login]");
    r.save(saved("rt1", { state: "succeeded" }));
    expect(staleItems(r.store, "Done.", ["rt1"], "main")).toEqual([{ runId: "rt1", problem: "login" }]);
    expect(staleItems(r.store, "<done>x → login</done>", ["rt1"], "main")).toEqual([]);
  });

  it("closes a key written with an arrow by the <done> of the whole key, and renames an open item an <open> with an arrow names", () => {
    const keys = (s: TaskStore) => s.openItems("main").map((i) => i.problem);
    const kept = rig();
    recordOpenItems(kept.store, "<open>发 1.0.0 版本 → 发 1.0.1 版本 — 发布中 (run r)</open>", 1, "h1", "main");
    expect(keys(kept.store)).toEqual(["发 1.0.0 版本 → 发 1.0.1 版本"]);
    expect(recordOpenItems(kept.store, "<done>发 1.0.0 版本 → 发 1.0.1 版本</done>", 2, "h1", "main"))
      .toEqual({ changed: true, closed: ["发 1.0.0 版本 → 发 1.0.1 版本"], unmatched: [] });
    // With `old` open, the <open> is `new`'s and the arrow; the reply's own arrow of it is settled.
    for (const runs of ["", " (run r)"]) {
      const r = rig();
      recordOpenItems(r.store, `<open>发 1.0.0 版本 — 已发${runs}</open>`, 1, "h1", "main");
      expect(recordOpenItems(r.store, "<open>发 1.0.0 版本 → 发 1.0.1 版本 — x (run r)</open>\n<done>发 1.0.0 版本 → 发 1.0.1 版本</done>", 2, "h1", "main").unmatched).toEqual([]);
      expect(r.store.openItems("main")).toEqual([{ problem: "发 1.0.1 版本", stage: "x", runIds: ["r"], openedAt: 1 }]);
      expect(r.store.itemHistory("main", "发 1.0.1 版本")?.aliases.sort()).toEqual(["发 1.0.0 版本", "发 1.0.0 版本 → 发 1.0.1 版本"]);
    }
  });

  it("keeps one item through an <open> with an arrow written again, and closes it by the <done> of that key", () => {
    const renames = ["<open>old — a (run r1)</open>|<open>old → new — b (run r1)</open>", "<open>old — a</open>|<open>old → new — b</open>", "<open>old — a (run r1)</open>|<done>old → new</done><open>new — b (run r1)</open>"];
    for (const [first, rename] of renames.map((r) => r.split("|") as [string, string])) {
      const r = rig();
      recordOpenItems(r.store, first, 1, "h1", "main");
      recordOpenItems(r.store, rename, 2, "h1", "main");
      expect(recordOpenItems(r.store, "<open>old → new — c</open>", 3, "h1", "main")).toEqual({ changed: true, closed: [], unmatched: [] });
      expect(r.store.openItems("main").map((i) => [i.problem, i.stage])).toEqual([["new", "c"]]);
      // Alone, the arrow is the key the head wrote, not the rename already made.
      expect(recordOpenItems(r.store, "<done>old → new</done>", 4, "h1", "main")).toEqual({ changed: true, closed: ["new"], unmatched: [] });
      expect(r.store.openItems("main")).toEqual([]);
      // Said again, it is settled as any closed key is, a key written with an arrow and closed included.
      recordOpenItems(r.store, "<open>v1 → v2 — x</open>", 5, "h1", "main");
      recordOpenItems(r.store, "<done>v1 → v2</done>", 6, "h1", "main");
      expect(recordOpenItems(r.store, "<done>old → new</done><done>v1 → v2</done><done>v1 → v3</done>", 7, "h1", "main")).toEqual({ changed: false, closed: [], unmatched: ["v1 → v3"] });
    }
  });

  it("settles a rename's arrow when its old key only abbreviates the new one", () => {
    const r = rig();
    recordOpenItems(r.store, "<open>fix — a (run r1)</open>", 1, "h1", "main");
    expect(recordOpenItems(r.store, "<done>fix → fix: part 2</done><open>fix: part 2 — b (run r1)</open>", 2, "h1", "main")).toEqual({ changed: true, closed: [], unmatched: [] });
    expect(r.store.itemHistory("main", "fix: part 2")).toMatchObject({ problem: "fix: part 2", aliases: ["fix"] });
    // With no such old item the arrow still names nothing: the new key is not its own old one.
    expect(recordOpenItems(r.store, "<done>fi → fix: part 2</done><done>fix: part 2 → fix: part 2</done>", 3, "h1", "main").unmatched).toEqual(["fi → fix: part 2", "fix: part 2 → fix: part 2"]);
  });

  it("closes a key that holds a bare em dash by the <done> of the key alone", () => {
    const r = rig();
    recordOpenItems(r.store, "<open>修复登录——web 端 — 进行中</open><open>修复登录 — 另一件</open>", 1, "h1", "main");
    expect(recordOpenItems(r.store, "<done>修复登录——web 端</done>", 2, "h1", "main")).toEqual({ changed: true, closed: ["修复登录——web 端"], unmatched: [] });
    expect(recordOpenItems(r.store, "<done>修复登录——web 端</done>", 3, "h1", "main")).toEqual({ changed: false, closed: [], unmatched: [] });
    expect(recordOpenItems(r.store, "<done>别的——东西</done>", 4, "h1", "main").unmatched).toEqual(["别的——东西"]);
    expect(r.store.openItems("main").map((i) => i.problem)).toEqual(["修复登录"]);
    // With no such key the bare dash is the cut it always was.
    expect(recordOpenItems(r.store, "<done>修复登录——完成</done>", 5, "h1", "main").closed).toEqual(["修复登录"]);
  });

  // The documented rename: Pier's run claim renames `old` in place, and the arrow finds it done.
  it("settles the arrow of a rename whose <open> takes the old item's run, in either order", () => {
    for (const text of ["<done>old key → new key</done>\n<open>new key — working (run r1)</open>", "<open>new key — working (run r1)</open>\n<done>old key → new key</done>"]) {
      const r = rig();
      recordOpenItems(r.store, "<open>old key — working (run r1)</open>", 1, "h1", "main");
      expect(recordOpenItems(r.store, text, 2, "h1", "main")).toEqual({ changed: true, closed: [], unmatched: [] });
      expect(r.store.itemHistory("main", "new key")).toMatchObject({ problem: "new key", aliases: ["old key"] });
      expect(r.store.openItems("main").map((i) => i.problem)).toEqual(["new key"]);
    }
  });

  it("settles a <done> of what is already closed, an arrow's `old` taken into its open `to`, and tells one of an open item's old name", () => {
    const r = rig();
    recordOpenItems(r.store, "<open>a — x</open><open>b — y</open><open>c — z</open><open>new — w</open>", 1, "h1", "main");
    recordOpenItems(r.store, "<done>a</done>", 2, "h1", "main");
    r.store.closeOpenItem("main", "c", 3);
    expect(recordOpenItems(r.store, "Again.\n<done>a</done><done>c</done>", 4, "h1", "main")).toEqual({ changed: false, closed: [], unmatched: [] });
    for (const old of ["a", "c"]) {
      expect(recordOpenItems(r.store, `<done>${old} → new</done>`, 5, "h2", "main")).toEqual({ changed: false, closed: [], unmatched: [] });
    }
    expect(r.store.itemHistory("main", "new")).toMatchObject({ problem: "new", aliases: ["a", "c"], sessions: ["h1", "h2"] });
    // Held as `new`'s alias, `a` is no key a <done> closes; nor is a key never written.
    expect(recordOpenItems(r.store, "<done>a</done><done>a → new</done><done>zz → new</done>", 6, "h1", "main"))
      .toEqual({ changed: false, closed: [], unmatched: ["a", "zz → new"] });
    expect(r.store.openItems("main").map((i) => i.problem)).toEqual(["b", "new"]);
  });

  it("keeps an open item's runs when its <open> names none, and replaces them when it names some", () => {
    const r = rig();
    recordOpenItems(r.store, "<open>k — a (run r1, r2)</open>", 1, "h1", "main");
    recordOpenItems(r.store, "<open>k — b</open>", 2, "h1", "main");
    expect(r.store.openItems("main")).toEqual([{ problem: "k", stage: "b", runIds: ["r1", "r2"], openedAt: 1 }]);
    recordOpenItems(r.store, "<open>k — b (run r2)</open>", 3, "h1", "main");
    expect(r.store.openItems("main")[0]?.runIds).toEqual(["r2"]);
  });

  it("gives a renamed item its old key's runs when the rename's <open> names none", () => {
    for (const rename of ["<done>old → new</done><open>new — b</open>", "<open>new — b</open><done>old → new</done>", "<open>old → new — b</open>"]) {
      const r = rig();
      r.save(saved("r1", { targetSessionId: "s1" }));
      recordOpenItems(r.store, "<open>old — a (run r1)</open>", 1, "h1", "main");
      recordOpenItems(r.store, rename, 2, "h1", "main");
      expect(r.store.openItems("main")).toEqual([{ problem: "new", stage: "b", runIds: ["r1"], openedAt: 1 }]);
      // Its live run is the item's, not one in no item.
      expect(r.list()).toMatchObject({ items: [{ problem: "new", status: "running" }], unlisted: [] });
    }
    // Joined into an item that holds runs, the old key's are not added: its newest run stands for the item.
    const r = rig();
    recordOpenItems(r.store, "<open>old — a (run r1)</open><open>new — b (run r2)</open>", 1, "h1", "main");
    recordOpenItems(r.store, "<done>old → new</done><open>new — c</open>", 2, "h1", "main");
    expect(r.store.openItems("main")).toEqual([{ problem: "new", stage: "c", runIds: ["r2"], openedAt: 1 }]);
  });

  it("records the turn's earlier markers before its answer's, and counts both and a <done>'s whole as named", () => {
    const r = rig();
    r.save(saved("r1", { state: "succeeded" }), saved("r2", { state: "succeeded" }));
    recordOpenItems(r.store, "<open>a — x (run r1)</open>", 1, "h1", "main", [], "<open>a — first</open><open>b — y (run r2)</open>");
    expect(r.store.openItems("main").map((i) => [i.problem, i.stage])).toEqual([["a", "x"], ["b", "y"]]);
    expect(staleItems(r.store, "Done.", ["r1", "r2"], "main")).toEqual([{ runId: "r1", problem: "a" }, { runId: "r2", problem: "b" }]);
    expect(staleItems(r.store, "Done.", ["r1", "r2"], "main", "<open>a — checked</open><done>b</done>")).toEqual([]);
    // A <done> whose arrow split a key that holds one still names it.
    recordOpenItems(r.store, "<open>v1 → v2 — x (run r1)</open>", 2, "h1", "main");
    expect(staleItems(r.store, "<done>v1 → v2</done>", ["r1"], "main")).toEqual([]);
  });

  it("records a marker read without its closing tag, and says so", () => {
    const r = rig();
    warn.mockClear();
    recordOpenItems(r.store, "Working.\n\n<open>a — b (run r1)</parameter>", 1, "h1", "main");
    expect(r.store.openItems("main")).toEqual([{ problem: "a", stage: "b", runIds: ["r1"], openedAt: 1 }]);
    expect(warn).toHaveBeenCalledWith("open items: read a marker with no closing tag: <open>a — b (run r1)</parameter>");
  });

  it("records the old key of the item Pier renames, and closes the rest into it", () => {
    const r = rig();
    const open = (problem: string, ...runIds: string[]) => ({ op: "open" as const, problem, stage: "", runIds });
    for (const p of ["dup 1", "dup 2"]) r.item(p, "", ["rt1"], 1);
    r.store.markOpenItems([open("pair", "rt1")], 2, "h1", "main");
    expect(r.store.openItems("main").map((i) => i.problem)).toEqual(["pair"]);
    expect(r.store.itemHistory("main", "pair")).toEqual({ chain: "main", problem: "pair", aliases: ["dup 1", "dup 2"], sessions: ["h1"], runIds: ["rt1"] });
    // The renamed key is no row of its own, a closed dup's row is the item's history: both find the item.
    expect(r.store.itemHistory("main", "dup 1")?.problem).toBe("pair");
    expect(r.store.itemHistory("main", "dup 2")?.problem).toBe("pair");
    expect(r.store.items("dup").map((i) => i.problem)).toEqual(["pair"]);
  });

  it("says nothing is open when nothing is, and counts no workers when no lead is shown", () => {
    const r = rig();
    expect(openItemsStatus(r.list([]), r.now).text).toBe("Nothing open.");
    expect(r.workerReads).toEqual([]);
  });

  it("carries each named run's session with `/status`, for the card to link", () => {
    const r = rig();
    r.save(saved("r-sess", { targetSessionId: "s-r" }), saved("r-none"));
    r.item("with a session", "running", ["r-sess", "r-none", "r-gone"], 1);
    expect(openItemsStatus(r.list(), r.now).sessions).toEqual({ "r-sess": "s-r" });
  });

  it("keeps creation identity through steering, a running design, snapshot replay and full continuation", () => {
    const r = rig();
    const original = "改进状态卡片，保留原始问题全文以及合并授权边界";
    const design = run("created-design-full", { name: "Open items", targetSessionId: "design-session-full" });
    r.save(
      saved(design.runId, { name: design.name, design: true, targetSessionId: design.targetSessionId, queuedAt: 1, state: "succeeded" }),
      saved("created-worker-full", { name: "Worker title", sessionMode: "fresh", targetSessionId: "worker-session-full", queuedAt: 1, state: "succeeded" }),
      saved("steering-design-full", { name: "A very long new steering prompt", targetSessionId: design.targetSessionId, queuedAt: 2 }),
      saved("steering-worker-full", { name: "Another follow-up", targetSessionId: "worker-session-full", queuedAt: 2 }),
    );
    r.item(original, "waiting on you: 是否合并？授权只限当前分支。", [design.runId, "created-worker-full"], 1);
    const open = r.list();
    expect(open.items[0]).toMatchObject({ title: "Open items", status: "running", designSessionId: "design-session-full" });
    expect(open.items[0]!.waitsIn).toBeUndefined();
    expect(r.titleReads).toEqual([["worker-session-full"]]);
    expect(open.items[0]!.runs.map((v) => v.title)).toEqual(["Open items", "Worker title"]);
    const status = openItemsStatus(open, r.now);
    expect(status.snapshot.items[0]).toMatchObject({ key: `item:${original}`, title: "Open items", problem: original, designSessionId: "design-session-full" });
    expect(status.text).toContain("是否合并？授权只限当前分支。");
    expect(status.text).not.toContain("steering-design-full");
    for (const full of [original, "steering-design-full", "steering-worker-full", "design-session-full", "worker-session-full"]) expect(status.seed).toContain(full);
    const origin = { kind: "chat-command" as const, command: "status" as const, statusSnapshot: status.snapshot, sessions: status.sessions };
    const replay = toChatTurns(JSON.parse(JSON.stringify([{ role: "custom", customType: "pier.system-input", content: status.text, details: origin, timestamp: 1 }])));
    expect(replay).toEqual([{ role: "system", text: status.text, at: 1, origin }]);
    r.save(saved("steering-design-full", { name: "changed again", targetSessionId: design.targetSessionId, queuedAt: 2, state: "failed" }));
    expect(replay[0]!.origin).toEqual(origin);
    const fallback = openItemsStatus({ items: [{ problem: "original", stage: "", status: "stopped", runs: [run("missing", { state: NOT_IN_LEDGER })] }], unlisted: [] }, r.now);
    expect(fallback.snapshot.items[0]!.title).toBe("original");
    expect(fallback.seed).toBe("- original (run missing) · stopped");
  });

  it("seeds a run in no item apart from the keys, with items and without", () => {
    const loose = { items: [], unlisted: [run("u1", { name: "build the parser", targetSessionId: "s-u" }), run("u2", { name: "queued one", state: "queued" })] };
    const runs = "Runs in no item — not keys, never <done> one; <open> an item naming a run that is tracked work:\n- run u1 · session s-u · build the parser · running\n- run u2 · queued one · queued";
    expect(openItemsStatus(loose, 1).seed).toBe(`Nothing open.\n\n${runs}`);
    const both = openItemsStatus({ ...loose, items: [{ problem: "login", stage: "x", status: "running", runs: [run("r1")] }] }, 1, ["logn"]);
    expect(both.seed).toBe(`- login — x (run r1) · running\n- unmatched <done>: logn (closed nothing; if it meant an item above, <done> that item's key)\n\n${runs}`);
    // `/status` and its snapshot still show the runs as rows.
    expect(both.snapshot.items.map((i) => i.key)).toEqual(["item:login", "run:u1", "run:u2"]);
  });

  it("writes the head's markers on its turn end and says so once, a restart's head and a new head alike", () => {
    const hub = new EventHub();
    const workspace: string[] = [];
    hub.subscribeWorkspace((e) => {
      if (e.type === "open-items-changed") workspace.push(e.type);
    });
    const sessions = new Map(["h0", "m1"].map((id) => [id, fakeSession(id)]));
    const router = new Router(hub, (key) => Promise.resolve(sessions.get(key.conversationId)!));
    for (const s of sessions.values()) router.attach({ channelId: "web", conversationId: s.id }, s);
    const members = ["h0"];
    const db = openDb(":memory:");
    const service = new TaskService(new TaskStore(db), {} as AgentFactory, router, hub, {
      modelMenu: () => [],
      ...fakeChains({ main: members }),
    });
    const end = (id: string, text: string) => sessions.get(id)!.emit({ type: "turn-end", text });
    const count = () => db.prepare("SELECT count(*) AS n FROM open_items WHERE closed_at IS NULL").get();

    end("h0", "On it.\n<open>open items — worker running (run r1)</open>");
    expect(db.prepare("SELECT problem, stage, run_ids FROM open_items").all())
      .toEqual([{ problem: "open items", stage: "worker running", run_ids: '["r1"]' }]);
    expect(workspace).toEqual(["open-items-changed"]);

    // Nothing written, nothing said: no marker, a done for no item, a marker with no problem; the stray done is logged.
    warn.mockClear();
    end("h0", "plain <done>never open</done><open> — x</open>");
    end("h0", "");
    expect(workspace).toEqual(["open-items-changed"]);
    expect(warn).toHaveBeenCalledWith("open items: <done> named no open item: never open");
    // The unmatched key reaches the head at once in a turn of its own, with the keys it may resend — the web card's rows — and stays in /status and the seed.
    const h0 = sessions.get("h0")!;
    expect(h0.systemInputs).toEqual([{ mode: "followUp", origin: { kind: "open-items", turn: true, statusSnapshot: expect.objectContaining({ version: 1, items: [expect.objectContaining({ problem: "open items" })] }) },
      text: "[Pier: <done>never open</done> closed no open item. If it meant one of these, resend <done> with that key exactly; if its item is already closed, send nothing:\n- open items]" }]);
    expect(service.unmatchedDone("main")).toEqual(["never open"]);
    const owed = openItemsStatus(service.openItems(), 1, service.unmatchedDone("main"));
    expect(owed.seed.split("\n"))
      .toEqual(["- open items — worker running (run r1) · stopped", "- unmatched <done>: never open (closed nothing; if it meant an item above, <done> that item's key)"]);
    expect(owed.snapshot.unmatched).toEqual(["never open"]);
    expect(owed.text).toMatch(/\n\nUnmatched done · 1\n\nnever open$/);

    // A reply that closes nothing keeps what was owed; one that closes an item owes only its own misses.
    end("h0", "<open>dup: a</open><open>dup: b</open><done>dup</done>");
    expect(service.unmatchedDone("main")).toEqual(["never open", "dup"]);
    expect(h0.systemInputs).toHaveLength(2);
    end("h0", "<done>dup: a</done>");
    expect(service.unmatchedDone("main")).toEqual([]);
    expect(h0.systemInputs).toHaveLength(2);
    workspace.length = 1;

    // A member no longer the head writes nothing.
    members.unshift("m1");
    end("h0", "<done>open items</done>");
    expect(count()).toEqual({ n: 2 });
    end("m1", "Merged.\n<open>open items — merged, restart pending</open>\n<done>open items</done><done>dup: b</done>");
    expect(count()).toEqual({ n: 0 });
    expect(service.unmatchedDone("main")).toEqual([]);
    expect(openItemsStatus(service.openItems(), 1, ["never open"]).seed).toBe("Nothing open.");
    expect(workspace).toEqual(["open-items-changed", "open-items-changed"]);
  });

  it("closes the item the user names \u2014 exactly, else by the words it contains \u2014 says so on the list and tells the head", () => {
    const hub = new EventHub();
    const workspace: string[] = [];
    hub.subscribeWorkspace((e) => { if (e.type === "open-items-changed") workspace.push(e.type); });
    const h0 = fakeSession("h0");
    const router = new Router(hub, () => Promise.resolve(h0));
    router.attach({ channelId: "web", conversationId: "h0" }, h0);
    const store = new TaskStore(openDb(":memory:"));
    const service = new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
    store.markOpenItems(["Login", "login v2", "logout", "deploy"].map((problem) => ({ op: "open" as const, problem, stage: "", runIds: [] })), 1, "h0", "main");
    const open = () => store.openItems("main").map((i) => i.problem);

    expect(service.closeItem("main", " LOGIN ", 2)).toBe("Login");
    expect(service.closeItem("main", "dep", 3)).toBe("deploy");
    expect(open()).toEqual(["login v2", "logout"]);
    expect(store.itemHistory("main", "deploy")?.closedAt).toBe(3);
    expect(workspace).toEqual(["open-items-changed", "open-items-changed"]);
    expect(h0.systemInputs).toEqual(["Login", "deploy"].map((key) => ({ text: `[Pier: the user closed ${key}]`, origin: { kind: "open-items" }, mode: "append" })));
    expect(h0.prompts).toEqual([]);

    expect(() => service.closeItem("main", "log", 4)).toThrow("/done log matches login v2, logout \u2014 say more");
    expect(() => service.closeItem("main", "o", 4)).toThrow("/done o matches login v2, logout \u2014 say more");
    expect(() => service.closeItem("main", "v2 out", 4)).toThrow('no open item "v2 out"');
    expect(() => service.closeItem("main", "deploy", 4)).toThrow(ItemNotFound);
    expect(() => service.closeItem("main", "deploy", 4)).toThrow('no open item "deploy"');
    // The panel's Close names one key exactly: never a prefix of another.
    expect(() => service.closeItem("main", "login", 4, true)).toThrow(ItemNotFound);
    expect(() => service.closeItem("other", "logout", 4)).toThrow(ItemNotFound);
    expect(open()).toEqual(["login v2", "logout"]);
    expect(workspace).toHaveLength(2);
    expect(h0.systemInputs).toHaveLength(2);

    // The panel's Close racing the head's own `<done>`: the key already closed is the answer, nothing told.
    expect(service.closeItem("main", "deploy", 4, true)).toBe("deploy");
    expect(workspace).toHaveLength(2);
    expect(h0.systemInputs).toHaveLength(2);
    // The head's `<done>` of what the user closed first agrees with them: no resend asked, nothing owed.
    h0.emit({ type: "turn-end", text: "Done.\n<done>Login</done><done>deploy</done>" });
    expect(h0.systemInputs).toHaveLength(2);
    expect(service.unmatchedDone("main")).toEqual([]);
    // A user's close settles what an ambiguous `<done>` of it owed.
    h0.emit({ type: "turn-end", text: "<open>dup: a</open><open>dup: b</open><done>dup</done>" });
    expect(service.unmatchedDone("main")).toEqual(["dup"]);
    service.closeItem("main", "dup: a", 5);
    expect(service.unmatchedDone("main")).toEqual([]);

    // A reply written while the user closed its item does not reopen it; one after the note may.
    h0.setState("streaming");
    service.closeItem("main", "logout", 6);
    h0.emit({ type: "turn-end", text: "<open>logout — still on it</open>" });
    expect(open()).toEqual(["login v2", "dup: b"]);
    h0.setState("idle");
    h0.emit({ type: "turn-end", text: "<open>logout — reopened</open>" });
    expect(open()).toEqual(["login v2", "dup: b", "logout"]);
  });

  it("asks no resend of a <done> already settled, a restart's head too, and tells one whose arrow from what the user closed names nothing", () => {
    const r = head();
    r.end("<open>a — x</open><open>b — y</open><open>K — z</open>");
    r.end("Done.\n<done>a</done>");
    r.end("Following up on a.\n<done>a</done>");
    expect(r.notes()).toEqual([]);
    expect(r.service.unmatchedDone("main")).toEqual([]);
    r.service.closeItem("main", "K", 2, true);
    r.end("<done>K</done>");
    expect(r.notes()).toEqual(["[Pier: the user closed K]"]);
    r.end("<done>K → K v2</done>");
    expect(r.notes()[1]).toContain("<done>K → K v2</done> (\"K v2\" is not open) closed no open item");
    expect(r.service.unmatchedDone("main")).toEqual(["K → K v2"]);
    const restarted = head(r.store);
    restarted.end("<done>K</done><done>a</done>");
    expect(restarted.notes()).toEqual([]);
    expect(restarted.service.unmatchedDone("main")).toEqual([]);
  });

  it("owes a miswritten key through a reply that closes nothing, and only that reply's misses after one that closes an item", () => {
    const r = head();
    r.end("<open>主会话上下文隔离 design — x</open><open>other — y</open>");
    r.end("<done>主会话上下文隔离设计</done>");
    r.end("Still on it.");
    expect(r.service.unmatchedDone("main")).toEqual(["主会话上下文隔离设计"]);
    r.end("<done>主会话上下文隔离 design</done>");
    expect(r.service.unmatchedDone("main")).toEqual([]);
    expect(openItemsStatus(r.service.openItems("main"), 1, r.service.unmatchedDone("main")).seed).not.toContain("unmatched");
    // A marker written before the answer, beside a tool call, is the turn's too.
    r.end("Answered.", "<open>notes — from a tool step</open>");
    expect(r.open()).toEqual(["other", "notes"]);
  });

  it("keeps closed what the user closed while the head wrote: under a new key holding its run or its old key, and not an item open before", () => {
    for (const reply of ["<open>logout, also SSO — still on it (run r1)</open>", "<open>logout, also SSO — still on it</open><done>logout → logout, also SSO</done>"]) {
      const r = head();
      r.end("<open>logout — x (run r1)</open><open>other — y</open>");
      r.h0.setState("streaming");
      r.service.closeItem("main", "logout", 2);
      r.end(reply);
      expect(r.open()).toEqual(["other"]);
    }
    const r = head();
    r.end("<open>logout — x (run r1)</open><open>other — y</open>");
    r.h0.setState("streaming");
    r.service.closeItem("main", "logout", 2);
    r.end("<open>other — took logout's run over (run r1)</open>");
    expect(r.store.openItems("main")).toMatchObject([{ problem: "other", runIds: ["r1"] }]);
  });

  it("closes by words anywhere in a key, in any order and case, and refuses several or none", () => {
    const hub = new EventHub();
    const h0 = fakeSession("h0");
    const router = new Router(hub, () => Promise.resolve(h0));
    const store = new TaskStore(openDb(":memory:"));
    const service = new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
    store.markOpenItems(["Lending: aave v3 on Base", "Lending: Aave v3 on Arbitrum", "Swap on base"].map((problem) => ({ op: "open" as const, problem, stage: "", runIds: [] })), 1, "h0", "main");

    expect(() => service.closeItem("main", "aave", 2)).toThrow("/done aave matches Lending: aave v3 on Base, Lending: Aave v3 on Arbitrum \u2014 say more");
    expect(() => service.closeItem("main", "aave polygon", 2)).toThrow('no open item "aave polygon"');
    expect(service.closeItem("main", "Base  AAVE", 2)).toBe("Lending: aave v3 on Base");
    expect(service.closeItem("main", "arb", 3)).toBe("Lending: Aave v3 on Arbitrum");
    expect(store.openItems("main").map((i) => i.problem)).toEqual(["Swap on base"]);
  });

  it("writes each chain's head into its own chain: a key matches only there, and the list names each item's chain", () => {
    const hub = new EventHub();
    const sessions = new Map(["h0", "d0"].map((id) => [id, fakeSession(id)]));
    const router = new Router(hub, (key) => Promise.resolve(sessions.get(key.conversationId)!));
    for (const s of sessions.values()) router.attach({ channelId: "web", conversationId: s.id }, s);
    const db = openDb(":memory:");
    db.exec("INSERT INTO chains VALUES ('design', 'design', 1, NULL)");
    const store = new TaskStore(db);
    const service = new TaskService(store, {} as AgentFactory, router, hub, {
      modelMenu: () => [],
      ...fakeChains({ main: ["h0"], design: ["d0"] }),
    });
    const end = (id: string, text: string) => sessions.get(id)!.emit({ type: "turn-end", text });
    const rows = () => db.prepare("SELECT chain_id, problem, closed_at IS NULL AS open FROM open_items ORDER BY chain_id").all();

    end("d0", "<open>login \u2014 drafting</open>");
    end("h0", "<open>login \u2014 testing</open>");
    expect(rows()).toEqual([{ chain_id: "design", problem: "login", open: 1 }, { chain_id: "main", problem: "login", open: 1 }]);
    end("h0", "<done>login</done>");
    expect(rows()).toEqual([{ chain_id: "design", problem: "login", open: 1 }, { chain_id: "main", problem: "login", open: 0 }]);
    // A link naming no chain: the one active chain holding the item, else the first active chain's.
    expect(store.itemHistoryByProblem("login")?.chain).toBe("design");
    db.exec("UPDATE chains SET archived_at = 2 WHERE id = 'design'");
    expect(store.itemHistoryByProblem("login")?.chain).toBe("main");
    db.exec("UPDATE chains SET archived_at = NULL WHERE id = 'design'");
    end("d0", "<open>signup</open>");
    expect(store.itemHistoryByProblem("signup")?.chain).toBe("design");
    expect(store.itemHistoryByProblem("nowhere")).toBeUndefined();

    end("d0", "<done>never open</done>");
    expect([service.unmatchedDone("design"), service.unmatchedDone("main")]).toEqual([["never open"], []]);
    end("h0", "<open>deploy</open>");
    const design = { id: "design", name: "design", archived: false };
    expect(service.openItems().items.map((i) => [i.problem, i.chain])).toEqual([["deploy", { id: "main", name: "Main", archived: false }], ["login", design], ["signup", design]]);
    expect(service.openItems("design").items.map((i) => [i.problem, i.chain])).toEqual([["login", design], ["signup", design]]);
  });

  it("tells the head when its turn answering a run's result, a steer's included, left that run's item at its old stage", () => {
    const hub = new EventHub();
    const h0 = fakeSession("h0", { scripted: true });
    const router = new Router(hub, () => Promise.resolve(h0));
    router.attach({ channelId: "web", conversationId: "h0" }, h0);
    const store = new TaskStore(openDb(":memory:"));
    new TaskService(store, {} as AgentFactory, router, hub, {
      modelMenu: () => [],
      ...fakeChains({ main: ["h0"] }),
    });
    const end = (text: string) => h0.emit({ type: "turn-end", text });
    const notes = () => h0.systemInputs.map((i) => i.text);
    // As agent/events.ts reports an input entering the context: a turn-start, then the input.
    const user = (text: string) => { h0.emit({ type: "turn-start" }); h0.emit({ type: "user-message", text }); };
    const result = (...runIds: string[]) => {
      h0.emit({ type: "turn-start" });
      h0.emit({ type: "system-input", text: "Task finished", origin: { kind: "task-callback", taskId: "t1", runId: runIds[0]!, sourceSessionId: null, runIds } });
    };
    const ended = (id: string, targetSessionId: string) => store.saveRun(saved(id, { targetSessionId, state: "succeeded", finishedAt: 1 }));
    ended("r1", "s1");
    store.saveRun(saved("live", { targetSessionId: "s2" }));
    end("<open>fix parser — worker running (run r1)</open><open>pair — two workers (run r3, run live)</open>");
    const note = (runId: string) => `[Pier: run ${runId} ended; open item "fix parser" still has its old stage. Close it with <done>, or <open> it again with a stage saying waiting on you.]`;

    // A newer run of the item's session stands for it; the reply's marker for another item does not count.
    ended("r2", "s1");
    result("r9", "r2");
    end("Merged.\n<open>other — x</open>");
    expect(notes()).toEqual([note("r2")]);
    // A user's turn answered no result: a result sent and never entered, a retry's, owes nothing.
    user("thanks");
    end("ok");
    expect(notes()).toHaveLength(1);

    // A steer sent into a user's turn is answered by the turn it opens on entering, not the one it was sent into.
    ended("r4", "s1");
    user("status?");
    end("checking");
    expect(notes()).toHaveLength(1);
    result("r4");
    end("Done.");
    expect(notes()).toEqual([note("r2"), note("r4")]);
    // An `append` shown mid-turn opens nothing.
    user("again?");
    h0.emit({ type: "system-input", text: "note", origin: { kind: "task-callback", taskId: "t1", runId: "r4", sourceSessionId: null } });
    end("yes");
    expect(notes()).toHaveLength(2);

    // An item updated or closed in the reply, or with a run still live, owes nothing.
    result("r4");
    end("<open>fix parser — waiting on you: merge?</open>");
    ended("r3", "s3");
    result("r3");
    end("Half done.");
    result("r4");
    end("<done>fix parser</done>");
    expect(notes()).toHaveLength(2);
  });

  it("gives a miss or a stale item a turn of its own, and appends the note to the turn a note opened or when it repeats", () => {
    const hub = new EventHub();
    const h0 = fakeSession("h0", { scripted: true });
    const router = new Router(hub, () => Promise.resolve(h0));
    router.attach({ channelId: "web", conversationId: "h0" }, h0);
    const store = new TaskStore(openDb(":memory:"));
    new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
    const end = (text: string) => h0.emit({ type: "turn-end", text });
    const user = (text: string) => { h0.emit({ type: "turn-start" }); h0.emit({ type: "user-message", text }); };
    const sent = () => h0.systemInputs.map((i) => [i.mode, i.origin.kind === "open-items" ? i.origin.turn : "?", i.text.split(" closed")[0]]);
    // Pi answers the follow-up in the run it was queued in: the note enters with its own turn-start, no agent_start's.
    const drained = () => {
      h0.emit({ type: "turn-start" });
      h0.emit({ type: "system-input", text: h0.systemInputs.at(-1)!.text, origin: h0.systemInputs.at(-1)!.origin });
    };
    store.saveRun(saved("r1", { targetSessionId: "s1", state: "succeeded", finishedAt: 1 }));
    end("<open>login — x (run r1)</open><open>deploy — y</open>");

    user("go");
    end("<done>logn</done>");
    expect(h0.systemInputs[0]).toMatchObject({ mode: "followUp", origin: { kind: "open-items", turn: true, statusSnapshot: { version: 1 } } });
    // The turn that note opened misses again: told, but no turn of its own.
    drained();
    end("<done>dploy</done>");
    // The same note on a later user's turn opens none either; a different one does.
    user("and?");
    end("<done>dploy</done>");
    user("again");
    end("<done>logn</done>");
    expect(sent()).toEqual([
      ["followUp", true, "[Pier: <done>logn</done>"],
      ["append", undefined, "[Pier: <done>dploy</done>"],
      ["append", undefined, "[Pier: <done>dploy</done>"],
      ["followUp", true, "[Pier: <done>logn</done>"],
    ]);

    // A result answered without touching its item: the stale note opens a turn too, and names no key.
    h0.emit({ type: "turn-start" });
    h0.emit({ type: "system-input", text: "Task finished", origin: { kind: "task-callback", taskId: "t1", runId: "r1", sourceSessionId: null } });
    end("Merged.");
    expect(h0.systemInputs.at(-1)).toEqual({ mode: "followUp", origin: { kind: "open-items", turn: true },
      text: `[Pier: run r1 ended; open item "login" still has its old stage. Close it with <done>, or <open> it again with a stage saying waiting on you.]` });
  });

  it("reads no marker and sends no note for a failed turn or once the router is stopping", () => {
    const hub = new EventHub();
    const h0 = fakeSession("h0", { scripted: true });
    const router = new Router(hub, () => Promise.resolve(h0));
    router.attach({ channelId: "web", conversationId: "h0" }, h0);
    const store = new TaskStore(openDb(":memory:"));
    new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
    h0.emit({ type: "turn-end", text: "<open>login — x</open>" });
    h0.emit({ type: "turn-end", text: "<done>logn</done><done>login</done>", error: "503" });
    router.stopping();
    h0.emit({ type: "turn-end", text: "<done>logn</done><done>login</done>" });
    expect(h0.systemInputs).toEqual([]);
    expect(store.openItems("main").map((i) => i.problem)).toEqual(["login"]);
  });

  it("reads no marker a cut answer stops inside, and the ones it finished", () => {
    const hub = new EventHub();
    const h0 = fakeSession("h0", { scripted: true });
    const router = new Router(hub, () => Promise.resolve(h0));
    router.attach({ channelId: "web", conversationId: "h0" }, h0);
    const store = new TaskStore(openDb(":memory:"));
    new TaskService(store, {} as AgentFactory, router, hub, { modelMenu: () => [], ...fakeChains({ main: ["h0"] }) });
    const keys = () => store.openItems("main").map((i) => i.problem);
    h0.emit({ type: "turn-end", text: "<open>fix parser — x</open><open>fix parser tests — y</open><open>login — z</open>" });
    // Stopped inside `<done>fix parser tests</done>`: the item its first words name stays open, and no item is opened by half a key.
    h0.emit({ type: "turn-end", text: "<done>login</done>\nMerged.\n<done>fix parser", partial: true });
    h0.emit({ type: "turn-end", text: "Next.\n<open>new it", partial: true });
    expect(keys()).toEqual(["fix parser", "fix parser tests"]);
    expect(h0.systemInputs).toEqual([]);
    // A finished answer's last line is still read without its closer.
    h0.emit({ type: "turn-end", text: "Merged.\n<done>fix parser" });
    expect(keys()).toEqual(["fix parser tests"]);
  });
});
