// The open items: main's markers, written only from the head's turn ends, and
// joined to stored runs for stable facts, compact status and the full continuation seed.

import { describe, expect, it, onTestFinished } from "vitest";
import { toChatTurns } from "../agent/events.js";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { agoLabel } from "../core/reply.js";
import { Router } from "../core/router.js";
import { fakeSession } from "../core/session.testkit.js";
import { NOT_IN_LEDGER, TASK_RUN_STATES, type AgentFactory, type LedgerRun, type TaskRunState } from "../core/types.js";
import { openItems, openItemsStatus, openStatus, type OpenItemReads } from "./open-items.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { Goal, OpenRun, TaskDefinition, TaskRun } from "./types.js";

const MIN = 60_000;
const DAY = 86_400_000;
const run = (runId: string, over: Partial<LedgerRun> = {}): LedgerRun =>
  ({ runId, name: runId, state: "running", targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null, ...over });

const definition = (name: string, lead: boolean): TaskDefinition => ({
  id: "t1", kind: "subagent", name, description: "", enabled: true, archived: false, revision: 1,
  trigger: { type: "manual" }, callback: { type: "origin" }, timeoutSeconds: 900, nextRunAt: null,
  action: { type: "agent", session: { mode: "reuse", sessionId: "h1" }, prompt: "go", ...(lead ? { launch: { role: "lead" as const } } : {}) },
  creator: "session:h1", createdBySessionId: "h1", createdAt: 0, updatedAt: 0,
});

/** A saved run launched by the head `h1` unless `over` says otherwise; `lead` makes it its session's creating lead run. */
const saved = (id: string, over: Partial<TaskRun> & { name?: string; lead?: boolean } = {}): TaskRun => {
  const { name = id, lead = false, ...rest } = over;
  return {
    id, taskId: "t1", taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null,
    triggerSource: "agent", invokedBySessionId: "h1", sourceSessionId: "h1", targetSessionId: null,
    sessionMode: lead ? "fresh" : "reuse", callbackSessionId: "h1", background: true,
    callbackState: null, callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null,
    state: "running", input: null, context: { definition: definition(name, lead) }, probe: null, matched: null,
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
    openItems: () => store.openItems(),
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
    db.prepare("INSERT INTO open_items VALUES (?, ?, ?, ?)").run(problem, stage, JSON.stringify(runIds), updatedAt);
  const list = (members = ["h1"], designs: LedgerRun[] = []) => openItems(reads, router, members, designs);
  const goal = (rootRunId: string, over: Partial<Goal> = {}) => store.saveGoal({
    id: `g-${rootRunId}`, rootRunId, supervisorSessionId: "h1", cap: 3, round: 0, step: "work", currentRunId: rootRunId,
    outcome: null, reason: null, reviewModel: null, createdAt: 0, finishedAt: null, ...over,
  });
  return { now, save, workers, workerReads, titleReads, router, item, list, goal };
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
    expect(open.items.map((i) => i.problem)).toEqual(["model menu 重选", "open items 视图"]);
    expect(open.items[0]!.runs).toEqual([{ runId: "gone1", name: "gone1", state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }]);
    expect(open.items[1]!.runs[0]!.workers).toEqual({ queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 });
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
      saved("k4k3jz55", { name: "lead again", targetSessionId: "lead1", queuedAt: now - 2 * MIN }),
    );
    r.item("status 归并", "lead building", ["vdmj112x"], 1);
    const open = r.list();
    expect(open.items[0]!.runs.map((x) => x.runId)).toEqual(["k4k3jz55"]);
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
    expect(item!.status).toBe("pending release");
  });

  // A listing's window is not the work's end: age alone never stops an item.
  it("reads an item whose run succeeded 3 days ago as pending release", () => {
    const r = rig();
    r.save(saved("old", { targetSessionId: "s-old", state: "succeeded", queuedAt: r.now - 3 * DAY, finishedAt: r.now - 3 * DAY }));
    r.item("shipped", "merged, restart pending", ["old"], 1);
    expect(r.list().items.map((i) => [i.runs[0]!.runId, i.status])).toEqual([["old", "pending release"]]);
  });

  it("reads a token that names no run as not in the ledger, and so stopped", () => {
    const r = rig();
    r.item("typo", "", ["nosuchrun"], 1);
    const [item] = r.list().items;
    expect(item!.runs.map((x) => x.state)).toEqual([NOT_IN_LEDGER]);
    expect(item!.status).toBe("stopped");
  });

  // The status is the runs' and sessions', whatever the stage text says.
  it("reads an item running while its session streams, though its run has finished, and pending release once idle", () => {
    const r = rig();
    r.save(saved("r1", { targetSessionId: "lead1", state: "succeeded", finishedAt: r.now - MIN }));
    r.item("fix", "lead building (running)", ["r1"], 1);
    expect(r.list().items[0]!.status).toBe("pending release");
    const lead = fakeSession("lead1");
    r.router.attach({ channelId: "task", conversationId: "lead1" }, lead);
    lead.setState("streaming");
    expect(r.list().items[0]!.status).toBe("running");
  });

  // A design lead's turn ends on the user; until it reports `Design final:` it is theirs to decide.
  it("lists the designs no item holds after the items, waiting on the user, each linking its session from `/status`", () => {
    const design = run("d1abcdefgh", { name: "Rail redesign", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const r = rig();
    r.item("model menu", "merged", [], 1);
    const status = openItemsStatus(r.list(["h1"], [design]), r.now);
    expect(status.text).toBe([
      "Waiting on you · 1", "", "Rail redesign", "Finalize design", `succeeded ${agoLabel(0, r.now)}`, "",
      "Other open · 1", "", "model menu · Pending release", "merged",
    ].join("\n"));
    expect(status.sessions).toEqual({ d1abcdefgh: "s-d1" });
  });

  it("keeps same-named designs distinct from each other and a marker through refresh and snapshot replay", () => {
    const r = rig();
    const name = "Same design name";
    const designs = ["held", "first", "second"].map((id) => {
      r.save(saved(`root-${id}`, { name, lead: true, targetSessionId: id, state: "succeeded", queuedAt: 1, finishedAt: 2 }));
      return run(`root-${id}`, { name, targetSessionId: id, state: "succeeded", queuedAt: 1, finishedAt: 2 });
    });
    r.item(name, "", ["root-held"], 1);
    const initial = openItemsStatus(r.list(["h1"], designs), r.now);
    const identities = (status: typeof initial) => status.snapshot.items.map((i) => [i.key, i.designSessionId]);
    expect(identities(initial)).toEqual([[`item:${name}`, "held"], ["design:first", "first"], ["design:second", "second"]]);
    expect(initial.text).toContain("Waiting on you · 3");
    const origin = { kind: "chat-command", command: "status", statusSnapshot: initial.snapshot, sessions: initial.sessions };
    const history = JSON.stringify([{ role: "custom", customType: "pier.system-input", content: initial.text, details: origin, timestamp: 1 }]);
    r.save(saved("followup", { name: "New steering title", targetSessionId: "first", state: "succeeded", queuedAt: 3, finishedAt: 4 }));
    const refreshed = openItemsStatus(r.list(["h1"], [...designs].reverse()), r.now + MIN);
    expect(identities(refreshed)).toEqual([[`item:${name}`, "held"], ["design:second", "second"], ["design:first", "first"]]);
    expect(refreshed.snapshot.items[2]).toMatchObject({ title: name, runs: [{ runId: "followup", targetSessionId: "first" }] });
    expect(toChatTurns(JSON.parse(history))).toEqual([{ role: "system", text: initial.text, at: 1, origin }]);
  });

  // One session is one row: an item or an in-flight run holding a design's session stands for it.
  it("never lists a session twice: a design under its item, or under its live run", () => {
    const r = rig();
    const now = r.now;
    const d1 = run("d1", { name: "多入口统一对话", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const d2 = run("d2", { name: "Rail", state: "succeeded", targetSessionId: "s-d2", finishedAt: 0 });
    r.save(
      saved("t1", { name: "子任务 thread", state: "succeeded", targetSessionId: "s-d1", finishedAt: now - 11 * MIN }),
      saved("t2", { name: "Rail again", targetSessionId: "s-d2", queuedAt: now - MIN }),
    );
    r.item("子任务 thread", "design lead narrowing scope (running)", ["t1"], 1);
    const open = r.list(["h1"], [d1, d2]);
    expect(open.items.map((i) => [i.problem, i.status])).toEqual([["子任务 thread", "waiting on you"]]);
    expect(open.unlisted.map((u) => u.runId)).toEqual(["t2"]);
    expect(openItemsStatus(open, now).text).toBe([
      "Waiting on you · 1", "", "子任务 thread", "design lead narrowing scope (running)", "succeeded 11m ago", "",
      "In progress · 1", "", "Rail again", "elapsed 1m",
    ].join("\n"));
  });

  // Every state a run can hold, through the one reading every surface groups by.
  it("reads an item's status from its whole run tree and its stage, for every run state", () => {
    const at = (state: string, over: Partial<OpenRun> = {}): OpenRun => ({ ...run("r", { state, targetSessionId: "s" }), ...over });
    const none = (id: string): boolean => id === "";
    const quiet = { streaming: none, designOpen: none };
    const status = (runs: OpenRun[], stage = "", session = quiet) => openStatus({ problem: "p", stage, runs }, session).status;
    expect(Object.fromEntries([...TASK_RUN_STATES, NOT_IN_LEDGER].map((s) => [s, status([at(s)])]))).toEqual({
      queued: "running", running: "running", succeeded: "pending release", failed: "stopped",
      cancelled: "stopped", interrupted: "stopped", skipped: "stopped", [NOT_IN_LEDGER]: "stopped",
    });
    expect(status([])).toBe("pending release");
    expect(status([at("succeeded"), at("failed")])).toBe("stopped");
    // The stage's marker, a design awaiting Finalize: the only two ways an item waits on the user.
    expect(status([at("succeeded")], "waiting on you: 手动重启还是派 worker")).toBe("waiting on you");
    expect(status([at("failed")], "Waiting on you: 60K or 80K?")).toBe("waiting on you");
    expect(status([at("succeeded")], "", { ...quiet, designOpen: (id) => id === "s" })).toBe("waiting on you");
    // Anything live below the item outranks the marker: a streaming session, a lead's workers in flight.
    expect(status([at("succeeded")], "waiting on you: x", { ...quiet, streaming: (id) => id === "s" })).toBe("running");
    const workers = (over: Partial<Record<TaskRunState, number>>) =>
      ({ ...Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])), ...over }) as Record<TaskRunState, number>;
    expect(status([at("succeeded", { workers: workers({ running: 3 }) })], "lead 实现中")).toBe("running");
    expect(status([at("succeeded", { workers: workers({ queued: 1 }) })])).toBe("running");
    // A finished worker's outcome is its lead's to read: the lead's run decides.
    expect(status([at("succeeded", { workers: workers({ succeeded: 2, failed: 1 }) })])).toBe("pending release");
  });

  // The goal, not the stage or the root run's state, says where a goal's item stands.
  it("reads a goal's item from its goal: live, a decision, the cap, clean, failed", () => {
    const r = rig();
    const now = r.now;
    const ends: [string, Partial<Goal>][] = [
      ["live", { step: "review", round: 2 }],
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
      ["goal done", "waiting on you", undefined],
      ["goal failed", "stopped", undefined],
      ["goal merged", "pending release", undefined],
      ["goal legacy", "pending release", undefined],
    ]);
    const status = openItemsStatus(open, now);
    expect(status.snapshot.items.map((i) => i.metadata)).toEqual([
      ["review 3/3"], ["succeeded 1m ago"],
      ["succeeded 1m ago", "review cap reached · findings remain"], ["succeeded 1m ago", "review clean"],
      ["succeeded 1m ago", "failed: no verdict"], ["succeeded 1m ago"], ["succeeded 1m ago", "merged"],
    ]);
    expect(status.text).toContain("Waiting on you · 3");
    expect(status.text).not.toContain("run ");
    expect(status.seed).toContain("run live");
    expect(status.seed).toContain("session s-live");
  });

  it("keeps multi-run review progress and failures consistent in compact text, details and replay", () => {
    const r = rig();
    r.save(
      saved("root", { name: "Reviewed work", targetSessionId: "root-session", state: "succeeded", finishedAt: r.now - MIN }),
      saved("failed", { name: "First line\nSecond line", state: "failed", finishedAt: r.now - MIN }),
      saved("queued", { name: "Next work", state: "queued", queuedAt: r.now - MIN }),
    );
    r.goal("root", { step: "review" });
    r.item("original multi-run question", "Authorized scope", ["root", "failed", "queued"], 1);
    const status = openItemsStatus(r.list(), r.now);
    expect(status.text).toContain("3 runs · review 1/3");
    expect(status.text).not.toContain("succeeded");
    expect(status.text).toContain("First line\nSecond line · failed 1m ago");
    expect(status.text).toContain("Next work · queued · elapsed 1m");
    expect(status.snapshot.items[0]!.details.find((d) => d.runId === "root")!.text).toContain("succeeded 1m ago");
    expect(status.seed).toContain("run root");
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
    const design = run("d1", { name: "Rail redesign", state: "succeeded", targetSessionId: "s-d1", finishedAt: now });
    r.save(
      saved("w-stage", { targetSessionId: "s-stage", state: "succeeded", finishedAt: now }),
      saved("w-goal", { targetSessionId: "s-goal", state: "succeeded", finishedAt: now }),
    );
    r.goal("w-goal", { outcome: "decision", finishedAt: now });
    r.item("stage wait", "waiting on you: 60K or 80K?", ["w-stage"], 1);
    r.item("goal wait", "worker building", ["w-goal"], 2);
    expect(r.list(["h1"], [design]).items.map((i) => [i.problem, i.status, i.waitsIn])).toEqual([
      ["stage wait", "waiting on you", undefined],
      ["goal wait", "waiting on you", undefined],
      ["Rail redesign", "waiting on you", "s-d1"],
    ]);
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
      ["已合并", "pending release"],
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
    expect(r.workerReads).toEqual([["l2", "l1", "l3"]]);
    expect(open.items.map((i) => i.runs[0]!.workers)).toEqual([
      { queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0, interrupted: 0, skipped: 0 },
      { queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 },
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
      saved(design.runId, { name: design.name, lead: true, targetSessionId: design.targetSessionId, queuedAt: 1, state: "succeeded" }),
      saved("created-worker-full", { name: "Worker title", sessionMode: "fresh", targetSessionId: "worker-session-full", queuedAt: 1, state: "succeeded" }),
      saved("steering-design-full", { name: "A very long new steering prompt", targetSessionId: design.targetSessionId, queuedAt: 2 }),
      saved("steering-worker-full", { name: "Another follow-up", targetSessionId: "worker-session-full", queuedAt: 2 }),
    );
    r.item(original, "waiting on you: 是否合并？授权只限当前分支。", [design.runId, "created-worker-full"], 1);
    const open = r.list(["h1"], [design]);
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
    new TaskService(new TaskStore(db), {} as AgentFactory, router, hub, {
      modelMenu: () => [],
      continuous: { chainOf: () => members, members: () => members.map((sessionId) => ({ sessionId, startedAt: 1, reason: "first" as const })) },
    });
    const end = (id: string, text: string) => sessions.get(id)!.emit({ type: "turn-end", text });
    const count = () => db.prepare("SELECT count(*) AS n FROM open_items").get();

    end("h0", "On it.\n<open>open items — worker running (run r1)</open>");
    expect(db.prepare("SELECT problem, stage, run_ids FROM open_items").all())
      .toEqual([{ problem: "open items", stage: "worker running", run_ids: '["r1"]' }]);
    expect(workspace).toEqual(["open-items-changed"]);

    // Nothing written, nothing said: no marker, a done for no item, a marker with no problem.
    end("h0", "plain <done>never open</done><open> — x</open>");
    end("h0", "");
    expect(workspace).toEqual(["open-items-changed"]);

    // A member no longer the head writes nothing.
    members.unshift("m1");
    end("h0", "<done>open items</done>");
    expect(count()).toEqual({ n: 1 });
    end("m1", "Merged.\n<open>open items — merged, restart pending</open>\n<done>open items</done>");
    expect(count()).toEqual({ n: 0 });
    expect(workspace).toEqual(["open-items-changed", "open-items-changed"]);
  });
});
