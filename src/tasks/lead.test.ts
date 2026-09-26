// Session roles (docs/design/10-continuous-session.md §Feature lead): a worker
// never delegates; a lead delegates, never to a lead; its workers' results wake
// it, and only the last of a wave reaches its supervisor, as one resumed run.
// No rig here turns the continuous switch on: the role does not need it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import type { AgentFactory, AgentLaunchOptions } from "../core/types.js";
import { LEAD_TURN, MILESTONE } from "./callbacks.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskDefinition, TaskRun } from "./types.js";

function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-lead-"));
  const sessions = new Map<string, FakeSession>(["main", "lead", "worker"].map((id) => [id, fakeSession(id, { reply: `${id} says done` })]));
  const created: AgentLaunchOptions[] = [];
  let n = 0;
  const factory: AgentFactory = {
    availableModels: async () => [],
    create: async (opts) => {
      created.push(opts);
      const s = fakeSession(`fresh${String(++n)}`);
      sessions.set(s.id, s);
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
  };
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, router, hub, { modelMenu: () => [] });
  const agent = (name: string, role?: "lead") => service.create({
    name, trigger: { type: "manual" },
    action: { type: "agent", session: { mode: "fresh", cwd }, prompt: `be ${name}`, ...(role ? { launch: { role } } : {}) },
  });
  /** The lead as main left it: one finished run on the lead session, owed to main. */
  const leadRan = async (state: TaskRun["state"] = "succeeded"): Promise<TaskDefinition> => {
    const task = await agent("feature", "lead");
    store.saveRun({
      id: "lead-run", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null,
      triggerSource: "agent", invokedBySessionId: "main", sourceSessionId: "main", targetSessionId: "lead",
      sessionMode: "fresh", callbackSessionId: "main", background: true, callbackState: "delivered",
      callbackAttempts: 1, callbackError: null, callbackNextAttemptAt: null, state, input: null,
      context: { definition: task, sessionId: "lead", cwd, model: { provider: "p", id: "strong" } }, probe: null, matched: null,
      result: null, error: null, skipReason: null, queuedAt: 1, startedAt: 1, finishedAt: state === "running" ? null : 2,
    });
    return task;
  };
  const bash = (script: string) => service.create({ name: script, trigger: { type: "manual" }, action: { type: "bash", cwd, script }, timeoutSeconds: 5 });
  return { cwd, sessions, created, service, store, leadRan, bash, agent };
}

/** The wall clock `ms` ahead, past a waiting result's backoff; timers stay real. */
async function laterBy(ms: number, then: () => Promise<unknown>): Promise<void> {
  const at = Date.now() + ms;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    await then();
  } finally {
    vi.useRealTimers();
  }
}

describe("a feature lead", () => {
  it("is launched with --role lead, opened with its role, and told it may delegate", async () => {
    const { service, created, store } = rig();
    const receipt = await service.handle({ operation: "run", prompt: "design the thing", launch: { role: "lead" } }, "main") as { runId: string };
    const run = await service.waitForRun(receipt.runId);
    expect(created.at(-1)).toMatchObject({ role: "lead" });
    expect(run.context.renderedPrompt).toContain("You are a feature lead: you may delegate to workers");
    expect(store.roleOf(run.targetSessionId!)).toBe("lead");
    expect(store.roleOf("main")).toBeUndefined();
    await expect(service.handle({ operation: "run", prompt: "x", launch: { role: "boss" } }, "main")).rejects.toThrow(/role must be lead/);
  });

  it("may delegate from its running run, never to a lead; a worker still may not delegate", async () => {
    const { service, store, leadRan, agent } = rig();
    await leadRan("running");
    await expect(service.handle({ operation: "run", bash: undefined, prompt: "a worker" }, "lead")).resolves.toMatchObject({ runId: expect.any(String) });
    await expect(service.handle({ operation: "run", prompt: "another lead", launch: { role: "lead" } }, "lead")).rejects.toThrow(/cannot launch a lead/);
    const saved = await agent("sub-lead", "lead");
    await expect(service.handle({ operation: "run", task_id: saved.id }, "lead")).rejects.toThrow(/cannot launch a lead/);
    await expect(service.handle({ operation: "run", tasks: [{ prompt: "w" }, { prompt: "l", launch: { role: "lead" } }] }, "lead")).rejects.toThrow(/cannot launch a lead/);

    const worker = await agent("worker");
    store.saveRun({ ...store.getRun("lead-run")!, id: "worker-run", taskId: worker.id, targetSessionId: "worker", invokedBySessionId: "lead", callbackSessionId: "lead", context: { definition: worker } });
    await expect(service.handle({ operation: "run", prompt: "deeper" }, "worker")).rejects.toThrow(/delegated run cannot delegate/);
    service.stop();
  });

  it("lists only the runs it launched, with the continuous switch off", async () => {
    const { service, bash, leadRan } = rig();
    await leadRan();
    const task = await bash("echo w");
    const mine = service.run(task.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: null, background: true });
    service.run(task.id, null, "agent", null, { invokedBySessionId: "main", callbackSessionId: null, background: true });
    await service.waitForRun(mine.id);
    const runs = await service.handle({ operation: "runs" }, "lead") as { runId: string }[];
    expect(runs.map((r) => r.runId)).toEqual([mine.id]);
    service.stop();
  });

  it("wakes on each worker result, and only the last of a wave resumes its run, which reports to main once", async () => {
    const { service, sessions, store, bash, leadRan } = rig();
    await leadRan();
    const fast = await bash("echo first");
    const slow = await bash("sleep 0.3; echo second");
    const a = service.run(fast.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    const b = service.run(slow.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    const lead = sessions.get("lead")!;
    const main = sessions.get("main")!;
    const callbacks = () => lead.systemInputs.filter((i) => i.origin.kind === "task-callback");
    // The first result, with the second still running: a lead turn outside any run.
    await vi.waitFor(() => expect(callbacks().map((i) => i.text)).toEqual([expect.stringContaining("first")]));
    expect(main.systemInputs).toEqual([]);
    // The last: a resume of the lead's run, not another system input.
    await vi.waitFor(() => expect(store.getRun(b.id)!.callbackState).toBe("delivered"));
    await vi.waitFor(() => expect(main.systemInputs).toHaveLength(1));
    expect(callbacks()).toHaveLength(1);
    const resumed = store.latestRunForTarget("lead")!;
    expect(resumed).toMatchObject({ resumedFromRunId: "lead-run", callbackSessionId: "main", invokedBySessionId: "main" });
    expect(lead.systemInputs.at(-1)).toMatchObject({
      origin: { kind: "task-delegation", runId: resumed.id },
      text: expect.stringMatching(/^\[Pier: the last result you were waiting on follows[\s\S]*second/),
    });
    expect(main.systemInputs[0]!.text).toContain("lead says done");
    expect(store.getRun(a.id)!.callbackState).toBe("delivered");
    service.stop();
  });

  it("takes a batch's callback as the wave's last result too", async () => {
    const { service, sessions, bash, leadRan } = rig();
    await leadRan();
    const task = await bash("echo member");
    service.runGroup([task, task], "all", "lead", "lead", "followUp");
    await vi.waitFor(() => expect(sessions.get("main")!.systemInputs).toHaveLength(1));
    // The lead sees the milestone as its resumed run's delegation, never as a bare callback.
    expect(sessions.get("lead")!.systemInputs.map((i) => i.origin.kind)).toEqual(["task-delegation"]);
    service.stop();
  });

  it("leaves a result as a plain callback when nobody waits on the lead", async () => {
    const { service, sessions, store, bash, leadRan } = rig();
    await leadRan();
    store.saveRun({ ...store.getRun("lead-run")!, callbackSessionId: null });
    const task = await bash("echo solo");
    service.run(task.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    await vi.waitFor(() => expect(sessions.get("lead")!.systemInputs).toHaveLength(1));
    expect(store.latestRunForTarget("lead")!.id).toBe("lead-run");
    service.stop();
  });

  it("waits for its own running turn to end before the wave's last result resumes it, asking again on a backoff", async () => {
    const { service, sessions, store, bash, leadRan } = rig();
    service.start(20);
    await leadRan("running");
    const task = await bash("echo late");
    const worker = service.run(task.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    const asked = vi.spyOn(store, "latestRunForTarget");
    await service.waitForRun(worker.id);
    // Five ticks go by: the waiting result is asked once, not once a tick.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(sessions.get("lead")!.systemInputs).toEqual([]);
    expect(store.getRun(worker.id)).toMatchObject({ callbackState: "pending", callbackAttempts: 0 });
    expect(store.getRun(worker.id)!.callbackNextAttemptAt).toBeGreaterThan(Date.now() + 9_000);
    store.saveRun({ ...store.getRun("lead-run")!, state: "succeeded", finishedAt: 3 });
    await laterBy(11_000, async () => {
      await vi.waitFor(() => expect(sessions.get("main")!.systemInputs).toHaveLength(1));
      expect(sessions.get("lead")!.systemInputs.map((i) => i.origin.kind)).toEqual(["task-delegation"]);
    });
    service.stop();
  });

  it("leaves a drain's last result pending for the next start, not as a plain callback", async () => {
    const { service, sessions, store, bash, leadRan } = rig();
    await leadRan();
    const task = await bash("sleep 0.2; echo drained");
    const worker = service.run(task.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    service.pause();
    await service.waitForRun(worker.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessions.get("lead")!.systemInputs).toEqual([]);
    expect(store.getRun(worker.id)!.callbackState).toBe("pending");
    service.unpause(20);
    await laterBy(11_000, () => vi.waitFor(() => expect(sessions.get("main")!.systemInputs).toHaveLength(1)));
    service.stop();
  });

  it("counts only results owed to it: a --callback none run and a finished race's losers hold no wave open", async () => {
    const { service, sessions, bash, leadRan } = rig();
    await leadRan();
    const slow = await bash("sleep 5");
    service.run(slow.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: null, background: true });
    const fast = await bash("echo fast");
    service.runGroup([fast, slow], "first", "lead", "lead", "followUp");
    await vi.waitFor(() => expect(sessions.get("main")!.systemInputs).toHaveLength(1));
    expect(sessions.get("lead")!.systemInputs.map((i) => i.origin.kind)).toEqual(["task-delegation"]);
    service.stop();
  });

  it("commits the resume with the delivered marks: a failed mark takes the resume back and the result arrives plain", async () => {
    const { service, sessions, store, bash, leadRan } = rig();
    await leadRan();
    const save = store.saveRun.bind(store);
    let failed = false;
    vi.spyOn(store, "saveRun").mockImplementation((run) => {
      if (!failed && run.callbackState === "delivered") {
        failed = true;
        throw new Error("disk full");
      }
      save(run);
    });
    const task = await bash("echo once");
    service.run(task.id, null, "agent", null, { invokedBySessionId: "lead", callbackSessionId: "lead", background: true });
    await vi.waitFor(() => expect(sessions.get("lead")!.systemInputs.map((i) => i.origin.kind)).toEqual(["task-callback"]));
    expect(failed).toBe(true);
    expect(store.latestRunForTarget("lead")!.id).toBe("lead-run");
    expect(sessions.get("main")!.systemInputs).toEqual([]);
    service.stop();
  });

  // docs/design/continuous-token-workflow.md §8: the user reads every other turn in the lead's session.
  it("reports to main only a milestone: a plain turn owes nothing and says why, a milestone or a Design final: delivers", async () => {
    const { service, sessions, store, leadRan } = rig();
    await leadRan();
    const main = sessions.get("main")!;
    const owed = { invokedBySessionId: "main", callbackSessionId: "main", background: true };
    const plain = await service.waitForRun(service.resume("lead-run", "what do you propose?", owed).id);
    expect(store.getRun(plain.id)).toMatchObject({ state: "succeeded", callbackState: null, callbackError: LEAD_TURN, callbackSessionId: "main" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(main.systemInputs).toEqual([]);

    const milestone = service.resume(plain.id, `${MILESTONE}\n\nworker says done`, owed);
    await vi.waitFor(() => expect(store.getRun(milestone.id)!.callbackState).toBe("delivered"));
    expect(main.systemInputs.map((i) => i.text)).toEqual([expect.stringContaining("lead says done")]);
    service.stop();

    const other = rig();
    await other.leadRan();
    other.sessions.set("lead", fakeSession("lead", { reply: "Plan agreed.\nDesign final: /repo/docs/design.md" }));
    const final = other.service.resume("lead-run", "go", owed);
    await vi.waitFor(() => expect(other.store.getRun(final.id)!.callbackState).toBe("delivered"));
    expect(other.sessions.get("main")!.systemInputs.map((i) => i.text)).toEqual([expect.stringContaining("Design final: /repo/docs/design.md")]);
    other.service.stop();
  });

  it("is a session of the user's, not one of the runs' own the rail hides", async () => {
    const { service, store, leadRan } = rig();
    await leadRan();
    store.saveRun({ ...store.getRun("lead-run")!, id: "worker-run", targetSessionId: "worker", context: { definition: (await service.create({
      name: "w", trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd: store.getRun("lead-run")!.context.cwd! }, prompt: "w" },
    })), sessionId: "worker" } });
    expect([...service.taskSessions()]).toEqual(["worker"]);
  });
});

describe("a session's role, kept for its life", () => {
  it("makes a session a delegated run created a worker: refused in its run and reopened after it, told so, opened as one", async () => {
    const { service, store, created } = rig();
    const receipt = await service.handle({ operation: "run", prompt: "fix it" }, "main") as { runId: string };
    const run = await service.waitForRun(receipt.runId);
    const worker = run.targetSessionId!;
    expect(created.at(-1)).toMatchObject({ role: "worker" });
    expect(run.context.renderedPrompt).toContain("`pier task` is refused");
    expect(store.roleOf(worker)).toBe("worker");
    await expect(service.handle({ operation: "run", prompt: "deeper" }, worker)).rejects.toThrow(/worker's session never delegates, in a run or after it/);
    await expect(service.handle({ operation: "list" }, worker)).rejects.toThrow(/worker's session never delegates/);
    service.stop();
  });

  it("leaves a cron run's session and a lead's able to delegate once their runs are over", async () => {
    const { service, store, cwd, leadRan } = rig();
    const nightly = await service.create({ name: "nightly", trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "sweep" } });
    const cron = await service.waitForRun(service.run(nightly.id, null, "cron").id);
    expect(store.roleOf(cron.targetSessionId!)).toBeUndefined();
    expect(cron.context.renderedPrompt).not.toContain("`pier task` is refused");
    await expect(service.handle({ operation: "run", prompt: "follow up" }, cron.targetSessionId!)).resolves.toMatchObject({ runId: expect.any(String) });
    await leadRan();
    await expect(service.handle({ operation: "run", prompt: "a worker" }, "lead")).resolves.toMatchObject({ runId: expect.any(String) });
    service.stop();
  });
});
