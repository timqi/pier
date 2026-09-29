// A goal's loop (docs/plans/18-goal-runtime.md): every row of its
// table, driven through the real service with sessions whose replies are
// scripted per session id — the worker is the first fresh session, each
// review a later one, and a review's reply is its verdict. The worktree is a
// real git repository in a scratch directory, the one the service pins.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import type { AgentFactory, ModelTier } from "../core/types.js";
import { fixPrompt, statusLine } from "./goals.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { GOAL_STEP, type Goal, type TaskRun } from "./types.js";

// No operator config reaches the service's git: hooks, fsmonitor or a pager would.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** A repository on `feature`, one commit past `main`; its HEAD. */
function repo(cwd: string): string {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(cwd, "a.ts"), "export {};\n");
  git("add", "a.ts");
  git("commit", "-q", "-m", "feature");
  return git("rev-parse", "HEAD");
}

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

function rig(script: Record<string, Reply[]>, menu: { provider: string; id: string; tier?: ModelTier }[] = [], git = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pier-goal-"));
  const head = git ? repo(cwd) : "";
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
    const { runId } = await service.handle({ operation: "run", prompt: "build it", cwd, ...input, name: "build it", launch: { model: "test/model", rounds: 3, ...launch } }, "main") as { runId: string };
    return store.getRun(runId)!;
  };
  const goalOf = (root: TaskRun): Goal => store.getGoal(store.getRun(root.id)!.goalId!)!;
  /** The goal's end, once its one callback reached main. */
  const ended = async (root: TaskRun, nth = 1): Promise<{ goal: Goal; text: string; runs: TaskRun[] }> => {
    await vi.waitFor(() => expect(callbacks()).toHaveLength(nth));
    const goal = goalOf(root);
    const runs = steps.map((id) => store.getRun(id)!);
    return { goal, text: callbacks()[nth - 1]!, runs };
  };
  return { cwd, head, sessions, created, service, store, launch, ended, goalOf, callbacks };
}

/** Every run but the end settled as a step; the end is the one delivered. */
function onlyTheEndCalledBack(runs: TaskRun[]): void {
  for (const r of runs.slice(0, -1)) expect(r).toMatchObject({ callbackState: null, callbackError: GOAL_STEP });
  expect(runs.at(-1)).toMatchObject({ callbackState: "delivered", callbackError: null });
}

describe("statusLine", () => {
  it("reads the last plain line outside fences, and only that shape", () => {
    expect(statusLine("done\n\nVerdict: clean\n\n")).toEqual({ kind: "clean" });
    expect(statusLine("a.ts:1 · x · y\nVerdict: findings")).toEqual({ kind: "findings" });
    expect(statusLine("Verdict: blocked — HEAD is abc, not def")).toEqual({ kind: "blocked", detail: "HEAD is abc, not def" });
    expect(statusLine("Verdict: blocked - dirty")).toEqual({ kind: "blocked", detail: "dirty" });
    expect(statusLine("Verdict: blocked")).toEqual({ kind: "blocked", detail: null });
    expect(statusLine("half done\nNeeds your decision — A or B?")).toEqual({ kind: "decision", detail: "A or B?" });
    expect(statusLine("Needs your decision")).toEqual({ kind: "decision", detail: null });
    for (const text of ["**Verdict:** clean", "- Verdict: clean", "## Verdict: clean", "verdict: clean", "Verdict: clean-ish", "Verdict: clean — but", "Verdict: clean\nthat is all", ""]) {
      expect(statusLine(text), text).toBeNull();
    }
  });

  it("ignores a status line inside a code block, an unclosed one to the end", () => {
    expect(statusLine("Verdict: findings\n```\nVerdict: clean\n```")).toEqual({ kind: "findings" });
    expect(statusLine("```text\nVerdict: findings\n```\nVerdict: clean")).toEqual({ kind: "clean" });
    expect(statusLine("Verdict: clean\n```\nVerdict: findings")).toEqual({ kind: "clean" });
  });

  it("rejects a second status line anywhere outside fences", () => {
    expect(statusLine("Needs your decision — keep it?\nVerdict: findings")).toEqual({ kind: "several" });
    expect(statusLine("Verdict: clean\n\nVerdict: findings")).toEqual({ kind: "several" });
  });
});

describe("a goal", () => {
  it("reviews clean and calls back once, the merge left to the user", async () => {
    const { launch, ended, sessions, service, cwd, head, created, store, callbacks } = rig({
      s1: ["built on branch x", "merged anyway"],
      s2: ["nothing to fix\n\nVerdict: clean"],
    });
    const root = await launch({}, { timeoutSeconds: 120, prompt: "build it\nApproved: merge feature into main" });
    const { goal, text, runs } = await ended(root);
    expect(goal).toMatchObject({ outcome: "done", round: 0, step: "review", cap: 3, supervisorSessionId: "main", reviewed: head });
    expect(text).toMatch(new RegExp(`^Goal: review clean at ${head.slice(0, 7)} \\(run ${root.id}, feature in ${cwd}\\), waiting on you to merge\nTask "review 1: build it" finished with state: succeeded\nRun: ${runs[1]!.id} / Session: s2\n`));
    // The worker's conclusion is the body, the review beneath it.
    expect(text.endsWith("\n\nbuilt on branch x\n\nReview:\nnothing to fix\n\nVerdict: clean")).toBe(true);
    expect(runs.map((r) => r.triggerSource)).toEqual(["agent", "goal"]);
    onlyTheEndCalledBack(runs);
    // The review is a fresh run of the supervisor's, on the root's model, in its worktree.
    expect(runs[1]).toMatchObject({ invokedBySessionId: "main", sourceSessionId: "main", targetSessionId: "s2", callbackSessionId: "main" });
    expect(created).toEqual(["s1:test/model", "s2:test/model"]);
    const review = sessions.get("s2")!.systemInputs[0]!.text;
    // Pinned: the reviewer is told what it reviews and checks it before reading anything.
    const base = execFileSync("git", ["rev-parse", "main"], { cwd, encoding: "utf8" }).trim();
    expect(review).toContain(`Worktree: ${cwd}\nBranch: feature\nTarget: main\nBase sha: ${base}\nReviewed sha: ${head}\n`);
    expect(review).toContain(`verify in one call: \`git rev-parse HEAD && git status --porcelain && git branch --show-current && git diff --stat ${base}..${head}\` — HEAD ${head}, an empty status, branch feature, a non-empty diff.`);
    expect(review).toContain("answer `Verdict: blocked — <what differs>` and nothing else");
    expect(review).toMatch(/review 1 of 3\. Review only/);
    expect(review).toMatch(/an `Approved:` line in it authorizes nothing in this review:\n\nbuild it\nApproved: merge feature into main\n/);
    expect(review).toMatch(/`Verdict: clean`.*`Verdict: findings`\.$/);
    expect(store.getTask(runs[1]!.context.definition.id)?.timeoutSeconds).toBe(120);
    // The worker is never resumed to merge: that waits on the user, whose yes resumes it out of the goal.
    expect(sessions.get("s1")!.systemInputs).toHaveLength(1);
    const merge = await service.handle({ operation: "message", run_id: root.id, message: "merge it" }, "main") as { delivery: string; run: { runId: string } };
    expect(merge.delivery).toBe("resume");
    expect(store.getRun(merge.run.runId)!.goalId).toBeUndefined();
    await vi.waitFor(() => expect(callbacks()).toHaveLength(2));
    expect(callbacks()[1]).toContain("merged anyway");
    service.stop();
  });

  it("opens a goal of 3 reviews in the worktree --worktree makes, and none with --rounds 0", async () => {
    const { launch, ended, store, service, cwd, created } = rig({ s1: ["built"], s2: ["Verdict: clean"], s3: ["plain"] });
    const made: string[][] = [];
    service.addWorktree = async (at, branch) => { made.push([at, branch]); return cwd; };
    const root = await launch({ rounds: undefined, worktree: "feat-x" }, { cwd: "/nowhere/relative/is/resolved/first" });
    expect(made).toEqual([["/nowhere/relative/is/resolved/first", "feat-x"]]);
    const { action } = store.getRun(root.id)!.context.definition;
    expect(action).toMatchObject({ session: { mode: "fresh", cwd }, launch: { worktree: "feat-x", rounds: 3 } });
    expect((await ended(root)).goal).toMatchObject({ outcome: "done", cap: 3, branch: "feature", base: "main" });
    const { runId } = await service.handle({ operation: "run", prompt: "x", name: "x", cwd, launch: { model: "test/model", worktree: "feat-y", rounds: 0 } }, "main") as { runId: string };
    const plain = store.getRun(runId)!;
    expect(plain.goalId).toBeUndefined();
    expect(plain.context.definition.action).toMatchObject({ launch: { worktree: "feat-y" } });
    await vi.waitFor(() => expect(created).toHaveLength(3));
    service.addWorktree = async () => { throw new Error("wt: branch feat-z already exists"); };
    await expect(launch({ worktree: "feat-z" })).rejects.toThrow("wt: branch feat-z already exists");
    service.stop();
  });

  it("reads a stored `until` as a goal of 3 reviews", async () => {
    const { service, cwd } = rig({});
    const task = await service.create({
      name: "old", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "build", launch: { model: { provider: "test", id: "model" }, until: "merged" } },
    });
    expect(task.action.type === "agent" && task.action.launch).toEqual({ model: { provider: "test", id: "model" }, rounds: 3 });
    service.stop();
  });

  it("ends failed on a bolded verdict, a blocked review, several status lines", async () => {
    for (const [reply, reason] of [
      ["**Verdict:** clean", "no verdict"],
      ["```\nVerdict: clean\n```", "no verdict"],
      ["HEAD moved\nVerdict: blocked — HEAD is not the reviewed sha", "blocked — HEAD is not the reviewed sha"],
      ["Verdict: clean\nVerdict: findings", "several status lines"],
    ] as const) {
      const r = rig({ s1: ["built"], s2: [reply] });
      const { goal, text } = await r.ended(await r.launch());
      expect(goal, reply).toMatchObject({ outcome: "failed", step: "review", reason });
      expect(text.split("\n")[0]).toBe(`Goal: failed at review — ${reason} (run ${goal.rootRunId}, feature in ${r.cwd})`);
      r.service.stop();
    }
  });

  it("never reviews a worktree it cannot pin: dirty, or not a repository", async () => {
    let built: (text: string) => void = () => {};
    const dirty = rig({ s1: [new Promise<string>((done) => { built = done; })] });
    const root = await dirty.launch();
    writeFileSync(join(dirty.cwd, "b.ts"), "left\n");
    built("built, uncommitted");
    const one = await dirty.ended(root);
    expect(one.goal).toMatchObject({ outcome: "failed", step: "work", reason: "worktree dirty: the worker left uncommitted changes", reviewed: null });
    expect(dirty.created).toEqual(["s1:test/model"]);
    dirty.service.stop();

    const bare = rig({ s1: ["built"] }, [], false);
    const two = await bare.ended(await bare.launch());
    expect(two.goal).toMatchObject({ outcome: "failed", step: "work", reason: expect.stringMatching(/^git rev-parse HEAD: fatal: not a git repository/) });
    expect(two.text.split("\n")[0]).toMatch(/^Goal: failed at work — git rev-parse HEAD: fatal/);
    bare.service.stop();
  });

  it("fixes on findings, re-reviews clean, then waits on the user: clean after 1 review round", async () => {
    const { launch, ended, sessions, service, head, cwd } = rig({
      s1: ["built", "fixed", "merged anyway"],
      s2: ["a.ts:1 · off by one · use <=\nVerdict: findings"],
      s3: ["Verdict: findings is what I expected, but\nVerdict: clean"],
    });
    const root = await launch();
    const { goal, text, runs } = await ended(root);
    expect(goal).toMatchObject({ outcome: "done", round: 1 });
    expect(text.split("\n")[0]).toBe(`Goal: review clean at ${head.slice(0, 7)} after 2 reviews (run ${root.id}, feature in ${cwd}), waiting on you to merge`);
    expect(runs.map((r) => r.targetSessionId)).toEqual(["s1", "s2", "s1", "s3"]);
    onlyTheEndCalledBack(runs);
    const worker = sessions.get("s1")!.systemInputs.map((i) => i.text);
    expect(worker[1]).toBe(fixPrompt(1, 3, "a.ts:1 · off by one · use <=\nVerdict: findings"));
    expect(worker[1]!.startsWith("[Pier: review 1/3 found issues; fix them in this worktree and commit before you end your turn")).toBe(true);
    expect(worker).toHaveLength(2);
    service.stop();
  });

  it("stops at the cap with findings still open: --rounds counts reviews", async () => {
    const one = rig({ s1: ["built"], s2: ["b.ts:2 · still wrong · fix\nVerdict: findings"] });
    const root = await one.launch({ rounds: 1 });
    const first = await one.ended(root);
    expect(first.goal).toMatchObject({ outcome: "cap", round: 0, cap: 1 });
    expect(first.text).toMatch(new RegExp(`^Goal: 1 review, still findings \\(run ${root.id}, feature in ${one.cwd}\\)\n`));
    expect(first.text).toContain("Review:\nb.ts:2 · still wrong");
    expect(first.runs).toHaveLength(2);
    onlyTheEndCalledBack(first.runs);
    one.service.stop();

    const two = rig({ s1: ["built", "fixed"], s2: ["Verdict: findings"], s3: ["Verdict: findings"] });
    const second = await two.ended(await two.launch({ rounds: 2 }));
    expect(second.goal).toMatchObject({ outcome: "cap", round: 1, cap: 2 });
    expect(second.text).toMatch(/^Goal: 2 reviews, still findings \(run /);
    expect(second.text).toContain("fixed\n\nReview:\nVerdict: findings");
    expect(second.runs).toHaveLength(4);
    two.service.stop();
  });

  it("ends on the user when the work or a review needs a decision", async () => {
    const work = rig({ s1: ["half done\n\nNeeds your decision — A or B?"] });
    const root = await work.launch();
    const first = await work.ended(root);
    expect(first.goal).toMatchObject({ outcome: "decision", round: 0, step: "work" });
    expect(first.text).toMatch(new RegExp(`^Goal: needs your decision \\(run ${root.id}\\)\n`));
    // The worker's own run ended it: its text is the body as it is.
    expect(first.text.endsWith("\n\nhalf done\n\nNeeds your decision — A or B?")).toBe(true);
    expect(work.created).toEqual(["s1:test/model"]);
    expect(first.runs).toHaveLength(1);
    work.service.stop();

    const review = rig({ s1: ["built"], s2: ["the seam changed\nNeeds your decision — keep it?"] });
    const second = await review.ended(await review.launch());
    expect(second.goal).toMatchObject({ outcome: "decision", step: "review" });
    onlyTheEndCalledBack(second.runs);
    review.service.stop();

    const fix = rig({ s1: ["built", "Needs your decision — rename it?"], s2: ["a.ts:1 · off by one · use <=\nVerdict: findings"] });
    const third = await fix.ended(await fix.launch());
    expect(third.goal).toMatchObject({ outcome: "decision", round: 1, step: "work" });
    expect(third.text).toMatch(/^Goal: needs your decision after 1 review \(run \w+, feature in [^)]+\)\n/);
    fix.service.stop();
  });

  it("fails on a failed review, and on a review with no verdict line", async () => {
    const broken = rig({ s1: ["built"], s2: [{ error: "provider down" }] });
    const one = await broken.ended(await broken.launch());
    expect(one.goal).toMatchObject({ outcome: "failed", step: "review", reason: "Error: provider down" });
    expect(one.text).toMatch(/^Goal: failed at review — Error: provider down \(run \w+, feature in [^)]+\)\nTask "review 1: build it" finished with state: failed/);
    onlyTheEndCalledBack(one.runs);
    broken.service.stop();

    const vague = rig({ s1: ["built"], s2: ["looks fine to me"] });
    const two = await vague.ended(await vague.launch());
    expect(two.goal).toMatchObject({ outcome: "failed", reason: "no verdict" });
    expect(two.text.split("\n")[0]).toMatch(/^Goal: failed at review — no verdict \(run \w+, feature in /);
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
      { s1: ["built"], s2: ["Verdict: clean"] },
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
    expect(callbacks()[0]).toMatch(new RegExp(`^Goal: failed at review — cancelled by main \\(run ${root.id}, feature in `));
    release("Verdict: clean");
    // An ended goal's run resumes as any run does, out of the goal.
    const resumed = await service.handle({ operation: "message", run_id: root.id, message: "go on" }, "main") as { delivery: string; run: { runId: string } };
    expect(resumed.delivery).toBe("resume");
    expect(store.getRun(resumed.run.runId)!.goalId).toBeUndefined();
    service.stop();
  });

  it("takes the user's answer back through the loop: --rounds beside --run on an ended goal's root", async () => {
    const { launch, ended, service, store, sessions, head, goalOf, cwd } = rig({
      s1: ["built", "kept the seam"],
      s2: ["the seam changed\nNeeds your decision — keep it?"],
      s3: ["Verdict: clean"],
    });
    const root = await launch({ rounds: 2, reviewModel: "test/model" });
    const first = await ended(root);
    expect(first.goal).toMatchObject({ outcome: "decision", step: "review" });
    const answer = (runId: string, extra: Record<string, unknown> = {}) =>
      service.handle({ operation: "message", run_id: runId, message: "keep it", rounds: 2, ...extra }, "main");
    const again = await answer(root.id) as { delivery: string; run: { runId: string } };
    expect(again.delivery).toBe("resume");
    const resumed = store.getRun(again.run.runId)!;
    expect(resumed).toMatchObject({ targetSessionId: "s1", resumedFromRunId: root.id });
    const second = await ended(resumed, 2);
    // A new goal rooted at the resumed run, of the reviews it named, on the ended goal's review model.
    expect(second.goal).toMatchObject({ rootRunId: resumed.id, outcome: "done", round: 0, cap: 2, reviewModel: "test/model", reviewed: head });
    expect(second.goal.id).not.toBe(first.goal.id);
    expect(second.text).toMatch(new RegExp(`^Goal: review clean at ${head.slice(0, 7)} \\(run ${resumed.id}, feature in ${cwd}\\), waiting on you to merge\n`));
    expect(sessions.get("s1")!.systemInputs.map((i) => i.text)).toHaveLength(2);
    // The review quotes the task and the answer the root resumed with.
    expect(sessions.get("s3")!.systemInputs[0]!.text).toMatch(/\n\nbuild it\n\nThen, resuming it:\n\nkeep it\n/);
    expect(goalOf(root)).toMatchObject({ id: first.goal.id, outcome: "decision" });
    // The earlier root is no longer the session's goal; a run no goal roots, none at all.
    await expect(answer(root.id)).rejects.toThrow(`run ${root.id}'s session is in a later goal, rooted at run ${resumed.id}; --run that one`);
    const review = first.runs[1]!;
    await expect(answer(review.id)).rejects.toThrow(`--rounds beside --run resumes a goal's root run; run ${review.id} is not one; its root is run ${root.id}`);
    await expect(answer(resumed.id, { rounds: 0 })).rejects.toThrow("rounds must be a whole number from 1 to 9");
    service.stop();
  });

  it("refuses --rounds beside --run on a run no goal ever rooted, and on one still running", async () => {
    let release: (text: string) => void = () => {};
    const { service, store, cwd } = rig({ s1: ["plain"], s2: [new Promise<string>((done) => { release = done; })] });
    const { runId } = await service.handle({ operation: "run", prompt: "no goal", name: "no goal", cwd, launch: { model: "test/model" } }, "main") as { runId: string };
    await vi.waitFor(() => expect(store.getRun(runId)!.state).toBe("succeeded"));
    await expect(service.handle({ operation: "message", run_id: runId, message: "go", rounds: 1 }, "main"))
      .rejects.toThrow(`--rounds beside --run resumes a goal's root run; run ${runId} is not one`);
    const { runId: busy } = await service.handle({ operation: "run", prompt: "slow", name: "slow", cwd, launch: { model: "test/model" } }, "main") as { runId: string };
    await vi.waitFor(() => expect(store.getRun(busy)!.state).toBe("running"));
    await expect(service.handle({ operation: "message", run_id: busy, message: "go", rounds: 1 }, "main"))
      .rejects.toThrow(`run ${busy} is running: --rounds resumes an ended goal's root; steer it without --rounds`);
    release("done");
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
    const { store, service, cwd, head, callbacks, sessions } = rig({ w: ["merged anyway"], s1: ["Verdict: clean"] });
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
    // A goal stored before reviews were pinned carries no `reviewed`; its review pins one.
    expect(store.getGoal("g1")!.reviewed).toBe(head);
    expect(callbacks()[0]).toMatch(new RegExp(`^Goal: review clean at ${head.slice(0, 7)} \\(run root, feature in ${cwd}\\), waiting on you to merge\n`));
    expect(sessions.get("w")!.systemInputs).toEqual([]);
    service.stop();
  });

  it("ends a goal stored mid-merge, before the loop left the merge to the user, done and merged", async () => {
    const { store, service, cwd, callbacks, sessions } = rig({ w: [] });
    const task = await service.create({
      name: "legacy", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "build", launch: { model: { provider: "test", id: "model" }, until: "merged" } },
    });
    store.saveGoal({
      id: "g1", rootRunId: "root", supervisorSessionId: "main", cap: 3, round: 1, step: "merge", currentRunId: "root",
      outcome: null, reason: null, reviewModel: null, createdAt: 1, finishedAt: null,
    });
    store.saveRun({
      id: "root", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null, goalId: "g1",
      triggerSource: "agent", invokedBySessionId: "main", sourceSessionId: "main", targetSessionId: "w",
      sessionMode: "fresh", callbackSessionId: "main", background: true, callbackState: null,
      callbackAttempts: 0, callbackError: GOAL_STEP, callbackNextAttemptAt: null, state: "succeeded", input: null,
      context: { definition: task, sessionId: "w", cwd, model: { provider: "test", id: "model" } }, probe: null, matched: null,
      result: { type: "agent", text: "merged: abc on main", sessionId: "w" }, error: null, skipReason: null, queuedAt: 1, startedAt: 1, finishedAt: 2,
    });
    service.start(60_000);
    await vi.waitFor(() => expect(callbacks()).toHaveLength(1));
    expect(store.getGoal("g1")).toMatchObject({ outcome: "done", step: "merge" });
    expect(callbacks()[0]).toMatch(/^Goal: merged after 1 review round\n/);
    expect(sessions.get("w")!.systemInputs).toEqual([]);
    service.stop();
  });

  it("is refused where no one would hear its end or where it is not one fresh run", async () => {
    const { service, cwd } = rig({});
    const run = (extra: Record<string, unknown>) => service.handle({ operation: "run", prompt: "x", name: "x", cwd, launch: { model: "test/model", rounds: 3 }, ...extra }, "main");
    await expect(run({ launch: { model: "test/model", rounds: 3, role: "lead" } })).rejects.toThrow(/rounds and worktree apply to a worker, not a lead/);
    await expect(run({ launch: { model: "test/model", worktree: "b", role: "lead" } })).rejects.toThrow(/rounds and worktree apply to a worker, not a lead/);
    for (const rounds of [-1, 10, 1.5]) {
      await expect(run({ launch: { model: "test/model", rounds } })).rejects.toThrow(/rounds must be a whole number from 0 to 9/);
    }
    await expect(run({ launch: { model: "test/model", reviewModel: "hardest" } })).rejects.toThrow(/beside rounds or worktree/);
    await expect(run({ launch: { model: "test/model", rounds: 0, reviewModel: "hardest" } })).rejects.toThrow(/beside rounds or worktree/);
    await expect(run({ callback: "none" })).rejects.toThrow(/callback none has nobody to tell/);
    await expect(service.handle({ operation: "run", tasks: [{ prompt: "a", launch: { model: "test/model", worktree: "b" } }, { prompt: "b", launch: { model: "test/model" } }] }, "main"))
      .rejects.toThrow(/a --member cannot carry it/);
    await expect(service.handle({ operation: "save", task: { name: "n", prompt: "x", cwd, launch: { model: "test/model", worktree: "b" } } }, "main"))
      .rejects.toThrow("--worktree and --rounds are one run's; save files a definition that runs again");
    service.stop();
  });
});

describe("pier task finish", () => {
  const cheap = [{ provider: "p", id: "small", tier: "cheap" as const }];
  const finish = (r: ReturnType<typeof rig>, runId: string, extra: Record<string, unknown> = {}) =>
    r.service.handle({ operation: "finish", run_id: runId, ...extra }, "main") as Promise<{ runId: string; next: string }>;

  it("merges a reviewed goal's branch as a cheap worker's run in the main repo, at the reviewed sha only", async () => {
    const r = rig({ s1: ["built"], s2: ["Verdict: clean"], s3: ["merged"] }, cheap);
    const root = await r.launch();
    await r.ended(root);
    const receipt = await finish(r, root.id, { remove_worktree: true });
    expect(receipt.next).toBe("the result arrives as a callback message once your turn ends; nothing to query");
    const run = r.store.getRun(receipt.runId)!;
    const main = realpathSync(r.cwd);
    expect(run).toMatchObject({ invokedBySessionId: "main", callbackSessionId: "main" });
    expect(run.goalId).toBeUndefined();
    expect(run.context.definition).toMatchObject({
      kind: "subagent", name: "finish: build it",
      action: { session: { mode: "fresh", cwd: main }, launch: { model: { provider: "p", id: "small" }, tier: "cheap" } },
    });
    await r.ended(root, 2);
    expect(r.created.at(-1)).toBe("s3:p/small");
    const prompt = r.sessions.get("s3")!.systemInputs[0]!.text;
    expect(prompt).toContain(`Approved: merge feature into main at ${r.head}\nApproved: remove worktree ${r.cwd}\n\nWorktree: ${r.cwd}\nMain repo: ${main}\n`);
    expect(prompt).toContain(`\`wt -C ${r.cwd} merge main\``);
    const plain = r.store.getRun((await finish(r, root.id)).runId)!;
    expect(plain.context.definition.action.type === "agent" && plain.context.definition.action.prompt).not.toContain("Approved: remove worktree");

    writeFileSync(join(r.cwd, "b.ts"), "left\n");
    await expect(finish(r, root.id)).rejects.toThrow(`${r.cwd} has uncommitted changes; commit them, then re-review with pier task run --run ${root.id} --prompt "<what changed>" --rounds 1`);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "b.ts"], { cwd: r.cwd });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b"], { cwd: r.cwd });
    const moved = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.cwd, encoding: "utf8" }).trim();
    await expect(finish(r, root.id)).rejects.toThrow(`feature moved past the reviewed sha ${r.head.slice(0, 7)} (HEAD ${moved.slice(0, 7)}); re-review with`);
    const review = r.goalOf(root).currentRunId;
    await expect(finish(r, review)).rejects.toThrow(`run ${review} is neither a reviewed goal's root nor a build lead's run`);
    r.service.stop();
  });

  it("refuses a goal that did not end clean", async () => {
    const r = rig({ s1: ["built"], s2: ["Verdict: findings"] }, cheap);
    const root = await r.launch({ rounds: 1 });
    await r.ended(root);
    await expect(finish(r, root.id)).rejects.toThrow(`run ${root.id}'s goal ended cap, nothing to merge`);
    r.service.stop();
  });

  it("merges a build lead's branch at its HEAD once the lead is idle and its tree clean", async () => {
    let release: (text: string) => void = () => {};
    const r = rig({ s1: ["integrated and reviewed", new Promise<string>((done) => { release = done; })] }, cheap);
    const { runId } = await r.service.handle({ operation: "run", prompt: "lead it", name: "lead it", cwd: r.cwd, launch: { model: "test/model", role: "lead" } }, "main") as { runId: string };
    await vi.waitFor(() => expect(r.store.getRun(runId)!.state).toBe("succeeded"));
    const run = r.store.getRun((await finish(r, runId)).runId)!;
    const { action } = run.context.definition;
    expect(action.type === "agent" && action.prompt).toContain(`Approved: merge feature into main at ${r.head}\n\nWorktree: ${r.cwd}\n`);
    await r.service.handle({ operation: "message", run_id: runId, message: "one more thing" }, "main");
    await vi.waitFor(() => expect(r.store.findActiveRunForTarget("s1")?.state).toBe("running"));
    await expect(finish(r, runId)).rejects.toThrow(`run ${runId}'s lead session s1 is still at work; wait for its milestone`);
    release("done");
    await vi.waitFor(() => expect(r.store.findActiveRunForTarget("s1")).toBeUndefined());
    writeFileSync(join(r.cwd, "b.ts"), "left\n");
    await expect(finish(r, runId)).rejects.toThrow(`${r.cwd} has uncommitted changes; commit them`);
    r.service.stop();
  });
});
