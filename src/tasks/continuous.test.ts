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
function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-chain-tasks-"));
  const sessions = new Map<string, FakeSession>(["h0", "h1", "h2", "stranger"].map((id) => [id, fakeSession(id)]));
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
  const switched = { on: true };
  const chain: TaskChain = {
    chainOf: (id) => (members.includes(id) ? members : undefined),
    enabled: () => switched.on,
    members: () => members.map((sessionId) => ({ sessionId, startedAt: 1, reason: "first" as const })),
  };
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, router, hub, { modelMenu: () => [], continuous: chain });
  const bash = () => service.create({ name: "command", trigger: { type: "manual" }, action: { type: "bash", cwd, script: "echo done" }, timeoutSeconds: 5 });
  return { cwd, sessions, child, service, store, bash, members, switched };
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

  it("delivers a saved definition's run to the head at the time it runs, by default", async () => {
    const { sessions, service, members, cwd } = rig();
    const nightly = await service.handle({ operation: "save", task: { name: "nightly", action: { type: "bash", cwd, script: "echo nightly" } } }, "h1") as TaskDefinition;
    expect(nightly.callback).toEqual({ type: "conversation" });
    members.unshift("h2");
    const run = service.run(nightly.id, null, "cron", null, {});
    expect(run.callbackSessionId).toBe("h2");
    await vi.waitFor(() => expect(sessions.get("h2")!.systemInputs).toHaveLength(1));
    expect(sessions.get("h2")!.systemInputs[0]!.text).toContain("nightly");
    expect(sessions.get("h1")!.systemInputs).toEqual([]);
    service.stop();
  });

  it("keeps a definition saved with callback none silent, and every definition silent with the switch off", async () => {
    const { service, switched, cwd } = rig();
    const silent = await service.handle({ operation: "save", task: { name: "quiet", callback: { type: "none" }, action: { type: "bash", cwd, script: "true" } } }, "h1") as TaskDefinition;
    expect(service.run(silent.id, null, "cron", null, {}).callbackSessionId).toBeNull();
    // A probe that did not match is the interval passing: nothing to deliver.
    const watch = await service.create({ name: "watch", trigger: { type: "watch", cwd, script: "exit 1", intervalSeconds: 60, mode: "repeat" }, action: { type: "bash", cwd, script: "true" } });
    const probe = await service.waitForRun(service.run(watch.id, null, "watch", null, {}).id);
    expect([probe.callbackSessionId, probe.callbackState]).toEqual(["h1", null]);
    const nightly = await service.handle({ operation: "save", task: { name: "nightly", action: { type: "bash", cwd, script: "true" } } }, "h1") as TaskDefinition;
    switched.on = false;
    expect(service.run(nightly.id, null, "cron", null, {}).callbackSessionId).toBeNull();
    service.stop();
  });

  it("lets every member control what another launched, and nobody else", async () => {
    const { service, store, bash } = rig();
    const task = await bash();
    store.saveRun(stored("r0", task, { invokedBySessionId: "h0" }));
    await expect(service.handle({ operation: "cancel", run_id: "r0" }, "h1")).resolves.toMatchObject({ runId: "r0" });
    await expect(service.handle({ operation: "cancel", run_id: "r0" }, "stranger")).rejects.toThrow(/does not own/);
  });

  it("lists the runs the caller launched — the whole chain's, for a member — in flight and finished in the last day", async () => {
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
    // Any session: its own runs, none refused.
    expect((await service.handle({ operation: "runs" }, "stranger") as { runId: string }[]).map((r) => r.runId)).toEqual(["theirs"]);
    await expect(service.handle({ operation: "runs" }, "child")).resolves.toEqual([]);
  });
});
