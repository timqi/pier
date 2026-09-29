// The `--until merged` loop (docs/plans/18-goal-runtime.md): every row of its
// table, driven through the real service with sessions whose replies are
// scripted per session id — the worker is the first fresh session, each
// review a later one, and a review's reply is its verdict.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import type { AgentFactory, ModelTier } from "../core/types.js";
import { fixPrompt, MERGE_PROMPT } from "./goals.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { GOAL_STEP, type Goal, type TaskRun } from "./types.js";

/** A turn's answer: its text, a provider failure, or a text the test releases later. */
type Reply = string | { error: string } | Promise<string>;

/** Pi's side played by hand: each turn answers the next scripted reply. */
function scripted(id: string, replies: Reply[]): FakeSession {
  const s = fakeSession(id, { scripted: true });
  const record = s.systemInput.bind(s);
  s.systemInput = async (text, origin, mode) => {
    await record(text, origin, mode);
    s.setState("streaming");
    const next = replies.shift() ?? `${id}: nothing scripted`;
    const reply = next instanceof Promise ? { text: await next } : typeof next === "string" ? { text: next } : next;
    s.emit({ type: "turn-end", text: "text" in reply ? reply.text : "", ...("error" in reply ? { error: reply.error } : {}) });
    s.setState("idle");
  };
  return s;
}

function rig(script: Record<string, Reply[]>, menu: { provider: string; id: string; tier?: ModelTier }[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "pier-goal-"));
  const sessions = new Map<string, FakeSession>([["main", fakeSession("main", { reply: "main heard" })]]);
  if (script.w) sessions.set("w", scripted("w", script.w));
  const created: string[] = [];
  let n = 0;
  const factory: AgentFactory = {
    availableModels: async () => [],
    create: async (opts) => {
      const id = `s${String(++n)}`;
      created.push(`${id}:${opts.model ? `${opts.model.provider}/${opts.model.id}` : "?"}`);
      const s = scripted(id, script[id] ?? []);
      sessions.set(id, s);
      return s;
    },
    resume: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`unknown session: ${id}`);
      return s;
    },
    list: async () => [...sessions.keys()].map((id) => ({ id, cwd, createdAt: 1 })),
    find: async (id) => (sessions.has(id) ? { id, cwd, createdAt: 1 } : undefined),
    search: async () => [],
    readHistory: async () => undefined,
    readSystemPrompt: async () => undefined,
  };
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const store = new TaskStore(openDb(":memory:"));
  // The goal's steps in order: runs queued in one millisecond have no other.
  const steps: string[] = [];
  const saveGoal = store.saveGoal.bind(store);
  store.saveGoal = (goal) => {
    if (steps.at(-1) !== goal.currentRunId) steps.push(goal.currentRunId);
    saveGoal(goal);
  };
  const service = new TaskService(store, factory, router, hub, {
    modelMenu: () => menu,
    continuous: { chainOf: () => undefined, members: () => [] },
  });
  const main = sessions.get("main")!;
  const callbacks = () => main.systemInputs.filter((i) => i.origin.kind === "task-callback").map((i) => i.text);
  const launch = async (launch: Record<string, unknown> = {}, input: Record<string, unknown> = {}): Promise<TaskRun> => {
    const { runId } = await service.handle({ operation: "run", prompt: "build it", cwd, ...input, launch: { model: "test/model", until: "merged", ...launch } }, "main") as { runId: string };
    return store.getRun(runId)!;
  };
  const goalOf = (root: TaskRun): Goal => store.getGoal(store.getRun(root.id)!.goalId!)!;
  /** The goal's end, once its one callback reached main. */
  const ended = async (root: TaskRun): Promise<{ goal: Goal; text: string; runs: TaskRun[] }> => {
    await vi.waitFor(() => expect(callbacks()).toHaveLength(1));
    const goal = goalOf(root);
    const runs = steps.map((id) => store.getRun(id)!);
    return { goal, text: callbacks()[0]!, runs };
  };
  return { cwd, sessions, created, service, store, launch, ended, goalOf, callbacks };
}

/** Every run but the end settled as a step; the end is the one delivered. */
function onlyTheEndCalledBack(runs: TaskRun[]): void {
  for (const r of runs.slice(0, -1)) expect(r).toMatchObject({ callbackState: null, callbackError: GOAL_STEP });
  expect(runs.at(-1)).toMatchObject({ callbackState: "delivered", callbackError: null });
}

describe("a --until merged goal", () => {
  it("reviews clean, merges, and calls back once: merged, review clean", async () => {
    const { launch, ended, sessions, service, cwd, created, store } = rig({
      s1: ["built on branch x", "merged: abc on main"],
      s2: ["nothing to fix\n\n**Verdict:** clean"],
    });
    const root = await launch({}, { timeoutSeconds: 120 });
    const { goal, text, runs } = await ended(root);
    expect(goal).toMatchObject({ outcome: "done", round: 0, step: "merge", cap: 3, supervisorSessionId: "main" });
    expect(text).toMatch(/^Goal: merged, review clean\nTask "build it" finished with state: succeeded/);
    expect(text).toContain("merged: abc on main");
    expect(runs.map((r) => r.triggerSource)).toEqual(["agent", "goal", "goal"]);
    onlyTheEndCalledBack(runs);
    // The review is a fresh run of the supervisor's, on the root's model, in its worktree.
    expect(runs[1]).toMatchObject({ invokedBySessionId: "main", sourceSessionId: "main", targetSessionId: "s2", callbackSessionId: "main" });
    expect(created).toEqual(["s1:test/model", "s2:test/model"]);
    const review = sessions.get("s2")!.systemInputs[0]!.text;
    expect(review).toContain(`The worktree is ${cwd}`);
    expect(review).toMatch(/review 1 \(up to 3 fix rounds\)/);
    // The reviewer reads the task the branch was built for: its base is the branch that task names.
    expect(review).toMatch(/The task the branch was built for:\n\nbuild it\n/);
    expect(review).toMatch(/`Verdict: clean`.*`Verdict: findings`\.$/);
    expect(store.getTask(runs[1]!.context.definition.id)?.timeoutSeconds).toBe(120);
    // The merge resumes the worker's own session.
    expect(runs[2]).toMatchObject({ targetSessionId: "s1", sessionMode: "reuse", resumedFromRunId: root.id });
    expect(sessions.get("s1")!.systemInputs.map((i) => i.text)[1]).toBe(MERGE_PROMPT);
    service.stop();
  });

  it("reads a verdict line case-insensitively, as VERDICT does", async () => {
    const { launch, ended, service } = rig({ s1: ["built", "merged"], s2: ["verdict: clean"] });
    const { goal } = await ended(await launch());
    expect(goal).toMatchObject({ outcome: "done", step: "merge" });
    service.stop();
  });

  it("fixes on findings, re-reviews clean, then merges: merged after 1 review round", async () => {
    const { launch, ended, sessions, service } = rig({
      s1: ["built", "fixed", "merged"],
      s2: ["a.ts:1 · off by one · use <=\nVerdict: findings"],
      s3: ["Verdict: findings is what I expected, but\nVerdict: clean"],
    });
    const root = await launch();
    const { goal, text, runs } = await ended(root);
    expect(goal).toMatchObject({ outcome: "done", round: 1 });
    expect(text.split("\n")[0]).toBe("Goal: merged after 1 review round");
    expect(runs.map((r) => r.targetSessionId)).toEqual(["s1", "s2", "s1", "s3", "s1"]);
    onlyTheEndCalledBack(runs);
    const worker = sessions.get("s1")!.systemInputs.map((i) => i.text);
    expect(worker[1]).toBe(fixPrompt(1, 3, "a.ts:1 · off by one · use <=\nVerdict: findings"));
    expect(worker[1]!.startsWith("[Pier: review round 1/3 found issues; fix them in this worktree and end your turn without merging.]")).toBe(true);
    expect(worker[2]).toBe(MERGE_PROMPT);
    service.stop();
  });

  it("stops at the cap with findings still open", async () => {
    const { launch, ended, service } = rig({
      s1: ["built", "fixed"],
      s2: ["Verdict: findings"],
      s3: ["b.ts:2 · still wrong · fix\nVerdict: findings"],
    });
    const root = await launch({ rounds: 1 });
    const { goal, text, runs } = await ended(root);
    expect(goal).toMatchObject({ outcome: "cap", round: 1, cap: 1 });
    expect(text).toMatch(/^Goal: 1 review round, still findings\n/);
    expect(text).toContain("b.ts:2 · still wrong");
    expect(runs).toHaveLength(4);
    onlyTheEndCalledBack(runs);
    service.stop();
  });

  it("ends on the user when the work or a review needs a decision", async () => {
    const work = rig({ s1: ["half done\n\nNeeds your decision\n- A or B?"] });
    const root = await work.launch();
    const first = await work.ended(root);
    expect(first.goal).toMatchObject({ outcome: "decision", round: 0, step: "work" });
    expect(first.text).toMatch(/^Goal: needs your decision \(round 0\)\n/);
    expect(work.created).toEqual(["s1:test/model"]);
    expect(first.runs).toHaveLength(1);
    work.service.stop();

    const review = rig({ s1: ["built"], s2: ["Needs your decision\n- the seam changed; keep it?\nVerdict: findings"] });
    const second = await review.ended(await review.launch());
    expect(second.goal).toMatchObject({ outcome: "decision", step: "review" });
    onlyTheEndCalledBack(second.runs);
    review.service.stop();
  });

  it("fails on a failed review, and on a review with no verdict line", async () => {
    const broken = rig({ s1: ["built"], s2: [{ error: "provider down" }] });
    const one = await broken.ended(await broken.launch());
    expect(one.goal).toMatchObject({ outcome: "failed", step: "review", reason: "Error: provider down" });
    expect(one.text).toMatch(/^Goal: failed at review — Error: provider down\nTask "review 1: build it" finished with state: failed/);
    onlyTheEndCalledBack(one.runs);
    broken.service.stop();

    const vague = rig({ s1: ["built"], s2: ["looks fine to me"] });
    const two = await vague.ended(await vague.launch());
    expect(two.goal).toMatchObject({ outcome: "failed", reason: "no verdict" });
    expect(two.text.split("\n")[0]).toBe("Goal: failed at review — no verdict");
    vague.service.stop();
  });

  it("fails, and still calls back, when its next step cannot be launched", async () => {
    const { launch, ended, service } = rig({ s1: ["built"] });
    const { goal, text, runs } = await ended(await launch({ reviewModel: "cheap" }));
    expect(goal).toMatchObject({ outcome: "failed", step: "work", reason: expect.stringMatching(/^model "cheap": tier cheap is unassigned/) });
    expect(text).toMatch(/^Goal: failed at work — model "cheap"/);
    expect(runs).toHaveLength(1);
    service.stop();
  });

  it("takes the named review model from the menu", async () => {
    const { launch, ended, created, service } = rig(
      { s1: ["built", "merged"], s2: ["Verdict: clean"] },
      [{ provider: "p", id: "strong", tier: "hardest" }],
    );
    await ended(await launch({ reviewModel: "hardest" }));
    expect(created).toEqual(["s1:test/model", "s2:p/strong"]);
    service.stop();
  });

  it("refuses --run while a review is in flight, and cancel --run <root> ends the goal and calls back", async () => {
    let release: (verdict: string) => void = () => {};
    const { launch, store, service, goalOf, callbacks } = rig({ s1: ["built"], s2: [new Promise<string>((done) => { release = done; })] });
    const root = await launch();
    await vi.waitFor(() => expect(goalOf(root).step).toBe("review"));
    const review = () => store.getRun(goalOf(root).currentRunId)!;
    await vi.waitFor(() => expect(review().state).toBe("running"));
    await expect(service.handle({ operation: "message", run_id: root.id, message: "and also" }, "main"))
      .rejects.toThrow(`run ${root.id} is in a goal (review 1); cancel it or wait for its end`);
    await service.handle({ operation: "cancel", run_id: root.id }, "main");
    await vi.waitFor(() => expect(callbacks()).toHaveLength(1));
    expect(goalOf(root)).toMatchObject({ outcome: "failed", reason: "cancelled by main", step: "review" });
    expect(review()).toMatchObject({ state: "cancelled", callbackState: "delivered" });
    expect(callbacks()[0]).toMatch(/^Goal: failed at review — cancelled by main\n/);
    release("Verdict: clean");
    // An ended goal's run resumes as any run does, out of the goal.
    const resumed = await service.handle({ operation: "message", run_id: root.id, message: "go on" }, "main") as { delivery: string; run: { runId: string } };
    expect(resumed.delivery).toBe("resume");
    expect(store.getRun(resumed.run.runId)!.goalId).toBeUndefined();
    service.stop();
  });

  it("cancel on a goal whose current run the ledger lost ends it failed instead of throwing", async () => {
    const { launch, service, store, goalOf } = rig({ s1: [], s2: [] });
    const root = await launch();
    const goal = goalOf(root);
    store.saveGoal({ ...goal, currentRunId: "gone" });
    expect(() => service.cancel(root.id, "main")).not.toThrow();
    expect(goalOf(root)).toMatchObject({ outcome: "failed", reason: "cancelled by main; its run gone was gone" });
    service.stop();
  });

  it("recovers a goal whose current run settled but never advanced", async () => {
    const { store, service, cwd, callbacks, sessions } = rig({ w: ["merged"], s1: ["Verdict: clean"] });
    const task = await service.create({
      name: "left over", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "build", launch: { model: { provider: "test", id: "model" }, until: "merged" } },
    });
    const goal: Goal = {
      id: "g1", rootRunId: "root", supervisorSessionId: "main", cap: 3, round: 0, step: "work", currentRunId: "root",
      outcome: null, reason: null, reviewModel: null, createdAt: 1, finishedAt: null,
    };
    store.saveGoal(goal);
    store.saveRun({
      id: "root", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null, goalId: "g1",
      triggerSource: "agent", invokedBySessionId: "main", sourceSessionId: "main", targetSessionId: "w",
      sessionMode: "fresh", callbackSessionId: "main", background: true, callbackState: null,
      callbackAttempts: 0, callbackError: GOAL_STEP, callbackNextAttemptAt: null, state: "succeeded", input: null,
      context: { definition: task, sessionId: "w", cwd, model: { provider: "test", id: "model" } }, probe: null, matched: null,
      result: { type: "agent", text: "built", sessionId: "w" }, error: null, skipReason: null, queuedAt: 1, startedAt: 1, finishedAt: 2,
    });
    service.start(60_000);
    await vi.waitFor(() => expect(callbacks()).toHaveLength(1));
    expect(store.getGoal("g1")).toMatchObject({ outcome: "done", round: 0 });
    expect(callbacks()[0]).toMatch(/^Goal: merged, review clean\n/);
    expect(sessions.get("w")!.systemInputs.map((i) => i.text)).toEqual([MERGE_PROMPT]);
    service.stop();
  });

  it("is refused where no one would hear its end or where it is not one fresh run", async () => {
    const { service, cwd } = rig({});
    const run = (extra: Record<string, unknown>) => service.handle({ operation: "run", prompt: "x", cwd, launch: { model: "test/model", until: "merged" }, ...extra }, "main");
    await expect(run({ launch: { model: "test/model", until: "merged", role: "lead" } })).rejects.toThrow(/until applies to a worker, not a lead/);
    await expect(run({ launch: { model: "test/model", until: "soon" } })).rejects.toThrow(/until must be merged/);
    for (const rounds of [0, 10, 1.5]) {
      await expect(run({ launch: { model: "test/model", until: "merged", rounds } })).rejects.toThrow(/rounds must be a whole number from 1 to 9/);
    }
    await expect(run({ launch: { model: "test/model", rounds: 2 } })).rejects.toThrow(/beside until/);
    await expect(run({ launch: { model: "test/model", reviewModel: "hardest" } })).rejects.toThrow(/beside until/);
    await expect(run({ callback: "none" })).rejects.toThrow(/callback none has nobody to tell/);
    await expect(service.handle({ operation: "run", tasks: [{ prompt: "a", launch: { model: "test/model", until: "merged" } }, { prompt: "b", launch: { model: "test/model" } }] }, "main"))
      .rejects.toThrow(/a --member cannot carry it/);
    service.stop();
  });
});
