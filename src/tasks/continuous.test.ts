// Tasks under the continuous conversation: a result owed to any of its
// sessions reaches the current head, every member controls what any member
// launched, and `pier task runs` is the ledger.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import { fakeSession, type FakeSession } from "../core/session.testkit.js";
import type { AgentFactory } from "../core/types.js";
import { TaskService, type TaskChain } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskDefinition, TaskRun } from "./types.js";

/** h0 is yesterday's head, h1 today's; "child" is nobody's member. */
function rig(on = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pier-chain-tasks-"));
  const sessions = new Map<string, FakeSession>(["h0", "h1", "stranger"].map((id) => [id, fakeSession(id)]));
  const child = fakeSession("child");
  const factory: AgentFactory = {
    availableModels: async () => [],
    create: async () => child,
    resume: async (id) => sessions.get(id) ?? child,
    list: async () => [...sessions.keys(), "child"].map((id) => ({ id, cwd, createdAt: 1 })),
    find: async (id) => ({ id, cwd, createdAt: 1 }),
    search: async () => [],
    readHistory: async () => undefined,
  };
  const members = ["h1", "h0"];
  const chain: TaskChain = { enabled: () => on, chainOf: (id) => (members.includes(id) ? members : undefined) };
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, router, hub, { modelMenu: () => [], continuous: chain });
  const bash = () => service.create({ name: "command", trigger: { type: "manual" }, action: { type: "bash", cwd, script: "echo done" }, timeoutSeconds: 5 });
  return { cwd, sessions, child, service, store, bash };
}

const stored = (id: string, task: TaskDefinition, over: Partial<TaskRun>): TaskRun => ({
  id, taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null, resumedFromRunId: null,
  triggerSource: "agent", invokedBySessionId: null, sourceSessionId: null, targetSessionId: null,
  sessionMode: null, callbackSessionId: null, background: true, callbackState: null,
  callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null, state: "succeeded", input: null,
  context: { definition: task }, probe: null, matched: null, result: null, error: null, skipReason: null,
  queuedAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now(), ...over,
});

describe("tasks under the continuous conversation", () => {
  it("delivers a run launched by an earlier head to the current head", async () => {
    const { sessions, service, bash } = rig();
    const task = await bash();
    service.run(task.id, null, "agent", null, { invokedBySessionId: "h0", callbackSessionId: "h0", background: true });
    await vi.waitFor(() => expect(sessions.get("h1")!.systemInputs).toHaveLength(1));
    expect(sessions.get("h1")!.systemInputs[0]!.text).toContain("done");
    expect(sessions.get("h0")!.systemInputs).toEqual([]);
    service.stop();
  });

  it("delivers a group's callback to the current head too", async () => {
    const { sessions, service, bash } = rig();
    const task = await bash();
    service.runGroup([task, task], "all", "h0", "h0", "followUp");
    await vi.waitFor(() => expect(sessions.get("h1")!.systemInputs).toHaveLength(1));
    expect(sessions.get("h0")!.systemInputs).toEqual([]);
    service.stop();
  });

  it("lets every member control what another launched, and nobody else", async () => {
    const { service, store, bash } = rig();
    const task = await bash();
    store.saveRun(stored("r0", task, { invokedBySessionId: "h0" }));
    await expect(service.handle({ operation: "cancel", run_id: "r0" }, "h1")).resolves.toMatchObject({ runId: "r0" });
    await expect(service.handle({ operation: "cancel", run_id: "r0" }, "stranger")).rejects.toThrow(/does not own/);
  });

  it("lists the chain's runs — in flight, and finished in the last day — for a member only", async () => {
    const { service, store, bash, cwd } = rig();
    const task = await bash();
    const day = 24 * 60 * 60_000;
    store.saveRun(stored("live", task, { invokedBySessionId: "h0", state: "running", finishedAt: null, targetSessionId: "c1", context: { definition: task, cwd: "/wt" } }));
    store.saveRun(stored("done", task, { invokedBySessionId: "h1" }));
    store.saveRun(stored("stale", task, { invokedBySessionId: "h1", queuedAt: Date.now() - 2 * day, finishedAt: Date.now() - 2 * day }));
    // Queued before the window, finished inside it.
    store.saveRun(stored("long", task, { invokedBySessionId: "h0", queuedAt: Date.now() - 2 * day, finishedAt: Date.now() - 60_000 }));
    store.saveRun(stored("theirs", task, { invokedBySessionId: "stranger" }));
    const runs = await service.handle({ operation: "runs" }, "h1") as { runId: string }[];
    expect(runs.map((r) => r.runId).sort()).toEqual(["done", "live", "long"]);
    expect(runs.find((r) => r.runId === "live")).toEqual({
      runId: "live", name: "command", state: "running", targetSessionId: "c1", cwd: "/wt", queuedAt: expect.any(Number), finishedAt: null,
    });
    expect(runs.find((r) => r.runId === "done")).toMatchObject({ cwd, targetSessionId: null });
    await expect(service.handle({ operation: "runs" }, "child")).rejects.toThrow(/not one of its sessions/);
  });

  it("refuses runs while the switch is off", async () => {
    const { service } = rig(false);
    await expect(service.handle({ operation: "runs" }, "h1")).rejects.toThrow(/not one of its sessions/);
  });
});
