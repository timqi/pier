import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../core/hub.js";
import { Router } from "../core/router.js";
import type {
  AgentFactory,
  AgentSession,
  ChatTurn,
  ModelRef,
  SessionEventPayload,
  SessionState,
  SystemInputOrigin,
  ThinkingLevel,
} from "../core/types.js";
import { registerTaskRoutes } from "./routes.js";
import { TaskService } from "./service.js";
import type { RunSummary } from "./tool.js";
import { TaskStore } from "./store.js";
import type { TaskDefinition, TaskRun } from "./types.js";

function fakeSession(id = "s1"): AgentSession & {
  prompts: string[];
  systemInputs: { text: string; origin: SystemInputOrigin; mode: "prompt" | "steer" | "followUp" }[];
  setState(state: SessionState): void;
} {
  let state: SessionState = "idle";
  const listeners = new Set<(event: SessionEventPayload) => void>();
  const prompts: string[] = [];
  const systemInputs: { text: string; origin: SystemInputOrigin; mode: "prompt" | "steer" | "followUp" }[] = [];
  const model: ModelRef = { provider: "test", id: "model" };
  const runPrompt = async (text: string): Promise<void> => {
    prompts.push(text);
    state = "streaming";
    listeners.forEach((fn) => fn({ type: "turn-start" }));
    await Promise.resolve();
    listeners.forEach((fn) => fn({ type: "turn-end", text: "agent result" }));
    state = "idle";
    listeners.forEach((fn) => fn({ type: "state", state: "idle" }));
  };
  return {
    id,
    prompts,
    systemInputs,
    get state() { return state; },
    // Real sessions emit a state event on every transition; the task runner
    // relies on that stream (not polling) to notice idle.
    setState(next) {
      state = next;
      listeners.forEach((fn) => fn({ type: "state", state: next }));
    },
    model,
    thinkingLevel: "off" as ThinkingLevel,
    contextUsage: undefined,
    history: async (): Promise<ChatTurn[]> => [
      ...systemInputs.map(({ text, origin }) => ({ role: "system" as const, text, origin })),
      { role: "assistant", text: "agent result" },
    ],
    setModel: async () => {},
    availableModels: async () => [model],
    availableThinkingLevels: () => ["off"],
    setThinkingLevel: () => {},
    image: async () => undefined,
    pendingQueue: async () => ({ steering: [], followUp: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    rewindToUserTurn: async () => {},
    prompt: runPrompt,
    steer: async () => {},
    followUp: async () => {},
    systemInput: async (text, origin, mode) => {
      systemInputs.push({ text, origin, mode });
      await runPrompt(text);
    },
    abort: async () => { state = "idle"; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: async () => {},
  };
}

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-task-"));
  const session = fakeSession();
  const factory: AgentFactory = {
    create: vi.fn(async () => session),
    fork: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: session.id, cwd, createdAt: 1 }]),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume(session.id));
  const store = new TaskStore(":memory:");
  const service = new TaskService(store, factory, router, hub);
  return { cwd, session, factory, hub, router, store, service };
}

const bashDraft = (cwd: string, script: string) => ({
  name: "command",
  trigger: { type: "manual" },
  action: { type: "bash", cwd, script },
  timeoutSeconds: 5,
});

describe("task service", () => {
  it("records Bash input, context, output and timestamps", async () => {
    const { cwd, service } = setup();
    const task = await service.create(bashDraft(cwd, `printf '%s' "$PIER_TASK_INPUT"`));
    const queued = service.run(task.id, { pr: 42 });
    const run = await service.waitForRun(queued.id);

    expect(run.state).toBe("succeeded");
    expect(run.input).toEqual({ pr: 42 });
    expect(run.context.definition.revision).toBe(1);
    expect(run.result).toMatchObject({ type: "bash", exitCode: 0, stdout: '{"pr":42}' });
    expect(run.startedAt).toEqual(expect.any(Number));
    expect(run.finishedAt).toEqual(expect.any(Number));
  });

  it("treats watch exit 1 as no match and exit 0 as a match", async () => {
    const { cwd, service } = setup();
    const noMatch = await service.create({
      ...bashDraft(cwd, "echo action"),
      name: "watch-no",
      trigger: { type: "watch", cwd, script: "exit 1", intervalSeconds: 60, mode: "repeat" },
    });
    const noRun = await service.waitForRun(service.run(noMatch.id).id);
    expect(noRun.state).toBe("succeeded");
    expect(noRun.matched).toBe(false);
    expect(noRun.result).toEqual({ type: "watch", matched: false });

    const once = await service.create({
      ...bashDraft(cwd, "echo fixed"),
      name: "watch-yes",
      trigger: { type: "watch", cwd, script: "echo review; exit 0", intervalSeconds: 60, mode: "once" },
    });
    const yesRun = await service.waitForRun(service.run(once.id).id);
    expect(yesRun.probe).toMatchObject({ exitCode: 0, stdout: "review\n" });
    expect(yesRun.result).toMatchObject({ type: "bash", stdout: "fixed\n" });
    expect(service.get(once.id).enabled).toBe(false);
  });

  it("links an Agent result to its session and exact rendered prompt", async () => {
    const { service, session } = setup();
    const task = await service.create({
      name: "review",
      trigger: { type: "manual" },
      action: { type: "agent", sessionId: session.id, prompt: "Review the PR" },
    });
    const run = await service.waitForRun(service.run(task.id, { pr: 7 }).id);
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual({ type: "agent", text: "agent result", sessionId: "s1" });
    expect(run.context.model).toEqual({ provider: "test", id: "model" });
    expect(run.context.renderedPrompt).toContain('"pr": 7');
    expect(session.prompts).toHaveLength(1);
    expect(session.systemInputs[0]).toMatchObject({
      origin: { kind: "task-delegation", taskId: task.id, runId: run.id, sourceSessionId: null },
      mode: "prompt",
    });
  });

  it("tracks the invoking session and durably calls back for background work", async () => {
    const { cwd, service, session, hub, store, factory, router } = setup();
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo delegated") }, "s1") as TaskDefinition;
    expect(task.createdBySessionId).toBe("s1");
    const statuses: string[] = [];
    hub.subscribe("s1", (event) => {
      if (event.type === "task-status") statuses.push(event.run.state);
    });

    const queued = await service.tool({ operation: "run", task_id: task.id, wait: false }, "s1") as RunSummary;
    const done = await service.waitForRun(queued.runId);
    await vi.waitFor(() => expect(service.getRun(done.id).callbackState).toBe("delivered"));
    const stored = service.getRun(done.id);
    expect(stored).toMatchObject({
      invokedBySessionId: "s1",
      callbackSessionId: "s1",
      background: true,
      callbackAttempts: 1,
    });
    expect(statuses).toContain("running");
    expect(statuses).toContain("succeeded");
    expect(session.systemInputs.at(-1)).toMatchObject({
      origin: { kind: "task-callback", runId: done.id },
      mode: "followUp",
    });

    // Simulate a crash after Pi persisted the custom message but before Pier
    // committed delivery: startup detects runId in transcript and does not resend.
    const callbackCount = session.systemInputs.length;
    stored.callbackState = "pending";
    stored.callbackNextAttemptAt = null;
    store.saveRun(stored);
    const restarted = new TaskService(store, factory, router, hub);
    restarted.start(60_000);
    await vi.waitFor(() => expect(restarted.getRun(done.id).callbackState).toBe("delivered"));
    expect(session.systemInputs).toHaveLength(callbackCount);
    restarted.stop();

    const foreground = await service.tool({ operation: "run", task_id: task.id, wait: true }, "s1") as RunSummary;
    expect(foreground).toMatchObject({ background: false, callbackSessionId: null, callbackState: null });
    expect(foreground).not.toHaveProperty("context");
    const silent = await service.tool({ operation: "run", task_id: task.id, wait: false, callback: "none" }, "s1") as RunSummary;
    expect((await service.waitForRun(silent.runId))).toMatchObject({
      background: true,
      callbackSessionId: null,
      callbackState: null,
    });
  });

  it("creates persisted fresh and forked child sessions with lineage", async () => {
    const { cwd, service, factory } = setup();
    const freshChild = fakeSession("fresh-child");
    const forkChild = fakeSession("fork-child");
    vi.mocked(factory.create).mockResolvedValueOnce(freshChild);
    vi.mocked(factory.fork).mockResolvedValueOnce(forkChild);

    const fresh = await service.create({
      name: "fresh reviewer",
      trigger: { type: "manual" },
      action: {
        type: "agent",
        session: { mode: "fresh", cwd },
        launch: { capabilities: "read", thinking: "low" },
        prompt: "Review independently",
      },
    });
    const freshRun = await service.waitForRun(service.run(fresh.id, { diff: true }, "agent", null, {
      invokedBySessionId: "s1",
      sourceSessionId: "s1",
    }).id);
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      capabilities: "read",
      thinking: "low",
    }));
    expect(freshRun).toMatchObject({
      state: "succeeded",
      rootRunId: freshRun.id,
      depth: 0,
      sourceSessionId: "s1",
      targetSessionId: "fresh-child",
      sessionMode: "fresh",
    });

    const forked = await service.create({
      name: "context worker",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fork" }, prompt: "Continue from context" },
    });
    const forkRun = await service.tool({ operation: "run", task_id: forked.id, wait: true }, "s1") as RunSummary;
    expect(factory.fork).toHaveBeenCalledWith("s1", expect.objectContaining({ cwd }));
    expect(forkRun).toMatchObject({
      state: "succeeded",
      targetSessionId: "fork-child",
      sessionMode: "fork",
    });
    expect(service.getRun(forkRun.runId).sourceSessionId).toBe("s1");
  });

  it("allows concurrent interactive fresh runs of one role", async () => {
    const { cwd, service, factory } = setup();
    vi.mocked(factory.create)
      .mockResolvedValueOnce(fakeSession("review-a"))
      .mockResolvedValueOnce(fakeSession("review-b"));
    const task = await service.create({
      name: "parallel reviewer",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review" },
    });
    const first = service.run(task.id, { angle: "correctness" }, "agent");
    const second = service.run(task.id, { angle: "tests" }, "agent");
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");
    const done = await service.waitForRuns([first.id, second.id]);
    expect(done.map((run) => run.state)).toEqual(["succeeded", "succeeded"]);
    expect(done.map((run) => run.targetSessionId)).toEqual(["review-a", "review-b"]);
  });

  it("persists steering and resumes a completed Agent run in the same session", async () => {
    const { service, session } = setup();
    const task = await service.create({
      name: "controlled agent",
      trigger: { type: "manual" },
      action: { type: "agent", sessionId: session.id, prompt: "Start" },
    });
    session.setState("streaming");
    const queued = service.run(task.id, null, "agent", null, { invokedBySessionId: "owner" });
    const message = await service.control(queued.id, "owner", "steer", "Change direction");
    expect(message).toMatchObject({ kind: "steer", state: "delivered", runId: queued.id });
    expect(session.systemInputs).toContainEqual(expect.objectContaining({
      origin: expect.objectContaining({ kind: "task-message", messageId: message.id }),
      mode: "steer",
    }));
    session.setState("idle");
    const done = await service.waitForRun(queued.id);
    const resumed = await service.waitForRun(service.resume(done.id, "Check one more edge case").id);
    expect(resumed).toMatchObject({
      state: "succeeded",
      resumedFromRunId: done.id,
      rootRunId: done.rootRunId,
      targetSessionId: session.id,
      sessionMode: "reuse",
    });
    expect(resumed.context.renderedPrompt).toBe("Check one more edge case");
  });

  it("supports detached supervisor decisions without overwriting answered state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-supervisor-"));
    const parent = fakeSession("parent");
    const child = fakeSession("child");
    child.setState("streaming");
    let releaseParent = (): void => {};
    const parentTurn = new Promise<void>((resolve) => { releaseParent = resolve; });
    parent.systemInput = async (text, origin, mode) => {
      parent.systemInputs.push({ text, origin, mode });
      await parentTurn;
    };
    const sessions = new Map([[parent.id, parent], [child.id, child]]);
    const factory: AgentFactory = {
      create: vi.fn(async () => child),
      fork: vi.fn(async () => child),
      resume: vi.fn(async (id: string) => sessions.get(id) ?? child),
      list: vi.fn(async () => [...sessions.values()].map((session) => ({ id: session.id, cwd, createdAt: 1 }))),
    };
    const hub = new EventHub();
    const router = new Router(hub, (key) => factory.resume(key.conversationId));
    const service = new TaskService(new TaskStore(":memory:"), factory, router, hub);
    const task = await service.create({
      name: "worker",
      trigger: { type: "manual" },
      action: { type: "agent", sessionId: child.id, prompt: "Work" },
    });
    const run = service.run(task.id, null, "agent", null, {
      invokedBySessionId: parent.id,
      sourceSessionId: parent.id,
      callbackSessionId: null,
      background: true,
    });
    const contact = service.tool({
      operation: "contact",
      reason: "decision",
      message: "Use API A or B?",
      wait: true,
    }, child.id);
    await vi.waitFor(() => expect(parent.systemInputs).toHaveLength(1));
    const question = service.listMessages(run.id)[0]!;
    await service.tool({ operation: "reply", message_id: question.id, message: "Use API A" }, parent.id);
    releaseParent();
    await expect(contact).resolves.toMatchObject({ reply: { content: "Use API A" } });
    expect(service.listMessages(run.id).find((message) => message.id === question.id)?.state).toBe("answered");

    const bash = await service.create(bashDraft(cwd, "true"));
    await expect(service.tool({ operation: "run", task_id: bash.id }, child.id)).rejects.toThrow("only invoke Agent tasks");
    await expect(service.tool({
      operation: "run",
      task: { name: "inline bash", action: { type: "bash", cwd, script: "true" } },
    }, child.id)).rejects.toThrow("only inline Agent tasks");
    await expect(service.tool({
      operation: "run",
      task: { name: "inline reuse", action: { type: "agent", session: { mode: "reuse", sessionId: parent.id }, prompt: "p" } },
    }, child.id)).rejects.toThrow("cannot reuse an existing session");
    child.setState("idle");
    await service.waitForRun(run.id);
  });

  it("runs inline subagent drafts atomically and filters them from lists", async () => {
    const { cwd, service } = setup();
    const run = await service.tool({
      operation: "run",
      wait: true,
      task: {
        name: "inline reviewer",
        action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review" },
      },
    }, "s1") as RunSummary;
    expect(run.state).toBe("succeeded");
    expect(service.getRun(run.runId).invokedBySessionId).toBe("s1");

    // Definition is persisted (auditable, taskId resolves) but kind-tagged.
    const task = service.get(run.taskId);
    expect(task).toMatchObject({ kind: "subagent", trigger: { type: "manual" }, createdBySessionId: "s1" });
    expect(service.listRuns(task.id).map((row) => row.id)).toContain(run.runId);

    // Hidden from the agent-facing list; visible in the unfiltered service list.
    expect(await service.tool({ operation: "list" }, "s1")).toEqual([]);
    expect(service.list().map((row) => row.id)).toContain(task.id);

    await expect(service.tool({
      operation: "run",
      task: {
        ...bashDraft(cwd, "true"),
        trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      },
    }, "s1")).rejects.toThrow("manual trigger");
  });

  it("inherits the caller's live model for fresh children", async () => {
    const { cwd, service, session, factory, router } = setup();
    router.attach({ channelId: "web", conversationId: session.id }, session);
    vi.mocked(factory.create).mockResolvedValueOnce(fakeSession("fresh-inherit"));
    const run = await service.tool({
      operation: "run",
      wait: true,
      task: { name: "inherit", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "go" } },
    }, session.id) as RunSummary;
    expect(run.state).toBe("succeeded");
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "test", id: "model" },
    }));
  });

  it("resumes a watch Agent without re-running its probe", async () => {
    const { cwd, service, session } = setup();
    const task = await service.create({
      name: "watch agent",
      trigger: { type: "watch", cwd, script: "exit 1", intervalSeconds: 60, mode: "repeat" },
      action: { type: "agent", sessionId: session.id, prompt: "Handle match" },
    });
    const first = await service.waitForRun(service.run(task.id).id);
    expect(first.result).toEqual({ type: "watch", matched: false });
    const resumed = await service.waitForRun(service.resume(first.id, "Continue manually").id);
    expect(resumed).toMatchObject({
      state: "succeeded",
      probe: null,
      matched: null,
      result: { type: "agent", text: "agent result" },
    });
  });

  it("stays queued until a busy Agent session becomes idle", async () => {
    const { service, session } = setup();
    const task = await service.create({
      name: "queued agent",
      trigger: { type: "manual" },
      action: { type: "agent", sessionId: session.id, prompt: "later" },
    });
    session.setState("streaming");
    const queued = service.run(task.id);
    await Promise.resolve();
    expect(service.getRun(queued.id)).toMatchObject({ state: "queued", startedAt: null });
    session.setState("idle");
    expect((await service.waitForRun(queued.id)).state).toBe("succeeded");
  });

  it("runs another task and records the parent-child relation", async () => {
    const { cwd, service } = setup();
    const child = await service.create(bashDraft(cwd, "echo child"));
    const parent = await service.create({
      name: "parent",
      trigger: { type: "manual" },
      action: { type: "task", taskId: child.id },
    });
    const parentRun = await service.waitForRun(service.run(parent.id, { issue: 1 }).id);
    expect(parentRun.state).toBe("succeeded");
    expect(parentRun.result).toMatchObject({ type: "task" });
    if (parentRun.result?.type !== "task") throw new Error("missing child result");
    expect(service.getRun(parentRun.result.runId).parentRunId).toBe(parentRun.id);
  });

  it("skips overlap, cancels active work, and rejects dependency cycles", async () => {
    const { cwd, service } = setup();
    const slow = await service.create(bashDraft(cwd, "sleep 5"));
    const first = service.run(slow.id);
    const overlap = service.run(slow.id);
    expect(overlap.state).toBe("skipped");
    expect(overlap.skipReason).toBe("overlap");
    service.cancel(first.id);
    expect((await service.waitForRun(first.id)).state).toBe("cancelled");

    const child = await service.create(bashDraft(cwd, "true"));
    const parent = await service.create({
      name: "parent",
      trigger: { type: "manual" },
      action: { type: "task", taskId: child.id },
    });
    await expect(service.update(child.id, {
      name: "cycle",
      trigger: { type: "manual" },
      action: { type: "task", taskId: parent.id },
    })).rejects.toThrow("cycle");
  });

  it("fires cron only at the next future occurrence", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:59.000Z"));
      const { service, session } = setup();
      const task = await service.create({
        name: "cron agent",
        trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
        action: { type: "agent", sessionId: session.id, prompt: "tick" },
      });
      service.start(1000);
      expect(service.get(task.id).nextRunAt).toBe(Date.parse("2026-01-01T00:01:00.000Z"));
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      const runs = service.listRuns(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ triggerSource: "cron", state: "succeeded" });
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks unfinished records interrupted on startup", async () => {
    const { cwd, store, factory, router, hub } = setup();
    const service = new TaskService(store, factory, router, hub);
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun({
      id: "stale", taskId: task.id, taskRevision: 1, parentRunId: null,
      rootRunId: "stale", depth: 0, resumedFromRunId: null,
      triggerSource: "cron", invokedBySessionId: null, sourceSessionId: null,
      targetSessionId: null, sessionMode: null,
      callbackSessionId: null, background: false, callbackState: null,
      callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null,
      state: "running", input: null,
      context: { definition: task }, probe: null, matched: null, result: null,
      error: null, skipReason: null, queuedAt: now, startedAt: now, finishedAt: null,
    });
    service.start(60_000);
    expect(service.getRun("stale")).toMatchObject({ state: "interrupted", finishedAt: expect.any(Number) });
    service.stop();
  });
});

describe("task HTTP routes", () => {
  it("creates, runs, lists and reads a task result", async () => {
    const { cwd, service } = setup();
    const app = new Hono();
    registerTaskRoutes(app, service);
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: bashDraft(cwd, "echo api"), runNow: true }),
    });
    expect(created.status).toBe(201);
    const { task, runId } = await created.json() as { task: { id: string }; runId: string };
    const done = await service.waitForRun(runId);
    const result = await app.request(`/api/task-runs/${done.id}`);
    expect(await result.json()).toMatchObject({ state: "succeeded", result: { stdout: "api\n" } });
    const list = await app.request("/api/tasks?state=active");
    expect(await list.json()).toEqual([expect.objectContaining({ id: task.id, lastRun: expect.objectContaining({ id: runId }) })]);
  });

  it("exposes steer, message history, wait, resume, and fork source over HTTP", async () => {
    const { cwd, service, session, factory } = setup();
    const app = new Hono();
    registerTaskRoutes(app, service);
    const task = await service.create({
      name: "http agent",
      trigger: { type: "manual" },
      action: { type: "agent", sessionId: session.id, prompt: "Work" },
    });
    session.setState("streaming");
    const run = service.run(task.id, null, "agent", null, { invokedBySessionId: "owner" });
    const steered = await app.request(`/api/task-runs/${run.id}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Focus on tests", sourceSessionId: "owner" }),
    });
    expect(steered.status).toBe(202);
    session.setState("idle");
    const done = await service.waitForRun(run.id);
    const ledger = await app.request(`/api/task-runs/${done.id}/messages`);
    expect(await ledger.json()).toEqual([expect.objectContaining({ kind: "steer", content: "Focus on tests" })]);

    const resumed = await app.request(`/api/task-runs/${done.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Check another case", wait: true, sourceSessionId: "owner" }),
    });
    expect(resumed.status).toBe(200);
    const resumedRun = await resumed.json() as TaskRun;
    expect(resumedRun).toMatchObject({ state: "succeeded", resumedFromRunId: done.id });
    const waited = await app.request("/api/task-runs/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runIds: [done.id, resumedRun.id], mode: "all" }),
    });
    expect((await waited.json()) as TaskRun[]).toHaveLength(2);

    const forkTask = await service.create({
      name: "http fork",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fork" }, prompt: "Use context" },
    });
    const invalidFork = await app.request(`/api/tasks/${forkTask.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: "missing" }),
    });
    expect(invalidFork.status).toBe(400);
    expect(service.listRuns(forkTask.id)).toHaveLength(0);

    const forked = await app.request(`/api/tasks/${forkTask.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: session.id }),
    });
    expect(forked.status).toBe(202);
    const { runId } = await forked.json() as { runId: string };
    await service.waitForRun(runId);
    expect(factory.fork).toHaveBeenCalledWith(session.id, expect.objectContaining({ cwd }));
  });
});
