// The feature lead (docs/design/10-continuous-session.md §Feature lead): the one
// delegated run that may delegate, never to a lead.
// No rig here turns the continuous switch on: the role does not need it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import type { AgentFactory, AgentLaunchOptions } from "../core/types.js";
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

  it("is a session of the user's, not one of the runs' own the rail hides", async () => {
    const { service, store, leadRan } = rig();
    await leadRan();
    store.saveRun({ ...store.getRun("lead-run")!, id: "worker-run", targetSessionId: "worker", context: { definition: (await service.create({
      name: "w", trigger: { type: "manual" }, action: { type: "agent", session: { mode: "fresh", cwd: store.getRun("lead-run")!.context.cwd! }, prompt: "w" },
    })), sessionId: "worker" } });
    expect([...service.taskSessions()]).toEqual(["worker"]);
  });
});
