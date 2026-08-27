import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db.js";
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
import { TaskCallbacks } from "./callbacks.js";
import { idSymbol, newId } from "./definitions.js";
import { TaskMessenger } from "./messages.js";
import { registerTaskRoutes } from "./routes.js";
import { TaskService } from "./service.js";
import type { GroupSummary, RunSummary } from "./tool.js";
import { TaskStore } from "./store.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  retryDelay,
  type TaskDefinition,
  type TaskMessage,
  type TaskRun,
} from "./types.js";

function fakeSession(id = "s1", reply = "agent result"): AgentSession & {
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
    listeners.forEach((fn) => fn({ type: "turn-end", text: reply }));
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
      { role: "assistant", text: reply },
    ],
    setModel: async () => {},
    availableModels: async () => [model],
    availableThinkingLevels: () => ["off"],
    setThinkingLevel: () => {},
    pendingQueue: async () => ({ steering: [], followUp: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    rewindToUserTurn: async () => {},
    compact: async () => {},
    rename: async () => {},
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

/** A session whose turn never ends until it is aborted — for cancel paths. */
function hangingSession(id: string): ReturnType<typeof fakeSession> {
  const session = fakeSession(id);
  let release = (): void => {};
  session.systemInput = async (text, origin, mode) => {
    session.systemInputs.push({ text, origin, mode });
    await new Promise<void>((resolve) => { release = resolve; });
  };
  const abort = session.abort.bind(session);
  session.abort = async () => { release(); await abort(); };
  return session;
}

function setup(session = fakeSession()) {
  const cwd = mkdtempSync(join(tmpdir(), "pier-task-"));
  const factory: AgentFactory = {
    availableModels: vi.fn(async () => []),
    create: vi.fn(async () => session),
    fork: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: session.id, cwd, createdAt: 1 }]),
    // Derived from the same list, like the real seam: a fake that answers the
    // two independently can agree with nothing.
    find: vi.fn(async (id: string) => (await factory.list()).find((s) => s.id === id)),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume(session.id));
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, router, hub);
  return { cwd, session, factory, hub, router, store, service };
}

/** A stored run row. The literal is long and four tests need one, differing
 *  only in the handful of fields each is about. */
function storedRun(id: string, task: TaskDefinition, now: number, over: Partial<TaskRun> = {}): TaskRun {
  return {
    id, taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null,
    rootRunId: id, depth: 0, resumedFromRunId: null,
    triggerSource: "agent", invokedBySessionId: null, sourceSessionId: null,
    targetSessionId: null, sessionMode: null,
    callbackSessionId: null, background: false, callbackState: null,
    callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null,
    state: "succeeded", input: null,
    context: { definition: task }, probe: null, matched: null,
    result: { type: "bash", exitCode: 0, stdout: "done", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    error: null, skipReason: null, queuedAt: now, startedAt: now, finishedAt: now,
    ...over,
  };
}

const bashDraft = (cwd: string, script: string) => ({
  name: "command",
  trigger: { type: "manual" },
  action: { type: "bash", cwd, script },
  timeoutSeconds: 5,
});

describe("newId", () => {
  // Spelled out rather than derived: a character that drifts out of the
  // alphabet has to fail against something written independently of it.
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

  it("maps all 256 byte values onto Crockford's 32 lowercase symbols, evenly", () => {
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte++) {
      const symbol = idSymbol(byte);
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    // Exact set, exact order, and no symbol reachable more often than another:
    // duplication, omission and modulo bias all show up here and nowhere else.
    expect([...Array(32).keys()].map(idSymbol).join("")).toBe(alphabet);
    expect([...counts.keys()].sort().join("")).toBe([...alphabet].sort().join(""));
    expect([...counts.values()]).toEqual(Array(32).fill(8));
    expect("ilou".split("").some((c) => counts.has(c))).toBe(false);
  });

  it("mints 16 characters from that alphabet, distinct across a large sample", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = newId();
      expect(id).toHaveLength(16);
      expect([...id].every((c) => alphabet.includes(c))).toBe(true);
      ids.add(id);
    }
    // Not a guarantee — 80 bits makes a repeat here a ~1e-13 event, so one
    // would mean the source stopped being random, not that luck ran out.
    expect(ids.size).toBe(10_000);
  });
});

describe("outbox backoff", () => {
  it("doubles from 1s and caps at 60s", () => {
    expect([0, 1, 2, 6, 7, 99].map(retryDelay)).toEqual([1000, 2000, 4000, 60000, 60000, 60000]);
  });
});

describe("drain pause", () => {
  it("refuses new root runs and resumes while paused; children stay allowed", async () => {
    const { cwd, service } = setup();
    const task = await service.create(bashDraft(cwd, "echo hi"));
    const before = await service.waitForRun(service.run(task.id).id);
    expect(before.state).toBe("succeeded");

    service.pause();
    expect(() => service.run(task.id)).toThrow(/restarting/);
    expect(() => service.resume(before.id, "go on")).toThrow(/restarting/);
    // A child of a run that is still finishing is the drain's own work.
    expect(() => service.run(task.id, null, "task", before.id)).not.toThrow();
  });
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
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Review the PR" },
    });
    const run = await service.waitForRun(service.run(task.id, { pr: 7 }).id);
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual({ type: "agent", text: "agent result", sessionId: "s1" });
    expect(run.context.model).toEqual({ provider: "test", id: "model" });
    expect(run.context.renderedPrompt).toContain('"pr":7');
    expect(session.prompts).toHaveLength(1);
    expect(session.systemInputs[0]).toMatchObject({
      origin: { kind: "task-delegation", taskId: task.id, runId: run.id, sourceSessionId: null },
      mode: "prompt",
    });
  });

  it("prefixes delegation with the run contract, naming contact only when supervised", async () => {
    const { cwd, service, session } = setup();
    const task = await service.create({
      name: "review",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Review the PR" },
    });
    const manual = await service.waitForRun(service.run(task.id).id);
    expect(manual.context.renderedPrompt).toContain(`[Pier task run ${manual.id} — "review"]`);
    expect(manual.context.renderedPrompt).toContain("read by the operator");
    expect(manual.context.renderedPrompt).not.toContain("contact");

    const delegated = await service.tool({
      operation: "run",
      task: { name: "child", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review the PR" } },
    }, "s9") as RunSummary;
    const done = await service.waitForRun(delegated.runId);
    expect(done.context.renderedPrompt).toContain("read by the agent that delegated this run");
    expect(done.context.renderedPrompt).toContain("contact");
  });

  it("strips chat-only markup from a child result", async () => {
    const { service, session } = setup(fakeSession("s1", "Done.\n\n---\n[Merge it] | [Show diff]"));
    const task = await service.create({
      name: "buttons",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Go" },
    });
    const run = await service.waitForRun(service.run(task.id).id);
    expect(run.result).toEqual({ type: "agent", text: "Done.", sessionId: "s1" });
  });

  it("models: the operator's menu when set, the catalog otherwise", async () => {
    const { factory } = setup();
    (factory.availableModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { provider: "test", id: "model" },
    ]);
    const menu: { provider: string; id: string; note?: string }[] = [];
    const service = new TaskService(new TaskStore(openDb(":memory:")), factory, new Router(new EventHub(), () => factory.resume("s1")), new EventHub(), { modelMenu: () => menu });
    expect(await service.tool({ operation: "models" }, "s1")).toEqual({
      source: "catalog",
      models: [{ provider: "test", id: "model" }],
    });
    menu.push({ provider: "test", id: "model", note: "the one we pay for" });
    expect(await service.tool({ operation: "models" }, "s1")).toEqual({ source: "menu", models: menu });
  });

  it("caps a chatty result in run lists, but not in a single-run get", async () => {
    const long = `start ${"x".repeat(3000)}`;
    const { service, session } = setup(fakeSession("s1", long));
    const task = await service.create({
      name: "chatty",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Go" },
    });
    const run = await service.waitForRun(service.run(task.id).id);
    const listed = await service.tool({ operation: "get", task_id: task.id }, "s1") as RunSummary[];
    expect(listed[0]!.result).toMatchObject({ type: "agent" });
    const listedText = (listed[0]!.result as { text: string }).text;
    expect(listedText.length).toBeLessThan(2200);
    expect(listedText).toContain(`get run_id ${run.id} for the full text`);
    const single = await service.tool({ operation: "get", run_id: run.id }, "s1") as RunSummary;
    expect((single.result as { text: string }).text).toBe(long);
  });

  it("names a silent child turn instead of storing an empty result", async () => {
    const { service, session } = setup(fakeSession("s1", "<silent>humans talking</silent>"));
    const task = await service.create({
      name: "quiet",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Watch" },
    });
    const run = await service.waitForRun(service.run(task.id).id);
    expect(run.result).toEqual({ type: "agent", text: "stayed silent — humans talking", sessionId: "s1" });
  });

  it("tracks the invoking session and durably calls back for background work", async () => {
    const { cwd, service, session, hub, store, factory, router } = setup();
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo delegated") }, "s1") as TaskDefinition;
    expect(task.createdBySessionId).toBe("s1");
    const statuses: string[] = [];
    hub.subscribe("s1", (event) => {
      if (event.type === "task-status") statuses.push(event.run.state);
    });

    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    expect(queued).not.toHaveProperty("context");
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

    const silent = await service.tool({ operation: "run", task_id: task.id, callback: "none" }, "s1") as RunSummary;
    expect((await service.waitForRun(silent.runId))).toMatchObject({
      background: true,
      callbackSessionId: null,
      callbackState: null,
    });
  });

  it("hands off a control message without awaiting the recipient, then sweeps a failed one", async () => {
    const { cwd, service, factory } = setup();
    const child = hangingSession("steer-child");
    const hangingInput = child.systemInput;
    child.systemInput = async (text, origin, mode) => {
      if (origin.kind === "task-message") throw new Error("session gone");
      await hangingInput(text, origin, mode);
    };
    vi.mocked(factory.create).mockResolvedValueOnce(child);
    const task = await service.create({
      name: "steerable",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Work" },
    });
    const run = service.run(task.id, null, "agent", null, {
      invokedBySessionId: "owner",
      sourceSessionId: "s1",
      background: true,
    });
    await vi.waitFor(() => expect(service.getRun(run.id).targetSessionId).toBe("steer-child"));

    // The sender never waits for the recipient's turn, so the receipt is a
    // hand-off, not a delivery: `delivered` needs the recipient's transcript to
    // show it, and this injection is rejected before anything is recorded.
    expect(await service.control(run.id, "owner", "steer", "Change direction")).toMatchObject({ state: "pending" });
    await vi.waitFor(() => expect(service.listMessages(run.id)[0]).toMatchObject({
      state: "failed",
      error: expect.stringContaining("session gone"),
    }));

    // A control message aimed at a finished run is dead: the sweep expires it.
    service.cancel(run.id);
    await service.waitForRun(run.id);
    service.start(20);
    await vi.waitFor(() => expect(service.listMessages(run.id)[0]).toMatchObject({
      state: "expired",
      error: expect.stringContaining("run finished"),
    }));
    service.stop();
  });

  it("records callback delivery from the transcript, without waiting out the recipient's turn", async () => {
    const { cwd, service, session } = setup();
    let release = (): void => {};
    // Pi resolves `systemInput` only when the turn it triggers settles; the
    // proof is in the transcript as the turn starts, so a recipient turn
    // running for minutes must not leave the run "pending".
    session.systemInput = async (text, origin, mode) => {
      session.systemInputs.push({ text, origin, mode });
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo accepted") }, "s1") as TaskDefinition;
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const done = await service.waitForRun(queued.runId);

    await vi.waitFor(() => expect(service.getRun(done.id)).toMatchObject({
      callbackState: "delivered",
      callbackAttempts: 1,
      callbackNextAttemptAt: null,
    }));
    expect(session.systemInputs.at(-1)).toMatchObject({
      origin: { kind: "task-callback", runId: done.id },
      mode: "followUp",
    });
    release();
  });

  it("will not call a callback delivered on a recipient that recorded nothing", async () => {
    // Pi's queues are memory: an input an abort or a restart throws away leaves
    // no transcript entry, and a resolved send proves nothing. This recipient
    // accepts everything and records none of it.
    const amnesiac = fakeSession();
    amnesiac.systemInput = async () => {};
    const { cwd, service } = setup(amnesiac);
    service.start(20);
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo lost") }, "s1") as TaskDefinition;
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const done = await service.waitForRun(queued.runId);

    await vi.waitFor(() => expect(service.getRun(done.id).callbackAttempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(service.getRun(done.id).callbackState).toBe("pending");
    // ...and it keeps trying, on the backoff curve rather than every tick.
    await vi.waitFor(() => expect(service.getRun(done.id).callbackAttempts).toBe(2), { timeout: 3000 });
    expect(service.getRun(done.id).callbackState).toBe("pending");
    service.stop();
  });

  it("counts a target that will not resolve, and gives up after the ceiling", async () => {
    // The original incident's worst case: the recipient's transcript is gone,
    // so every attempt fails before a send. Nothing counted those, and the
    // callback retried at attempt 0 forever.
    const { cwd, service, store, hub } = setup();
    const router = new Router(hub, () => Promise.reject(new Error("unknown session")));
    const told: string[] = [];
    const callbacks = new TaskCallbacks(store, router, () => {}, (id, what, why) => told.push(`${id}|${what}|${why}`));
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("lost", task, now, { callbackSessionId: "s1", callbackState: "pending" }));

    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      callbacks.recover(now + i * 600_000);
      await vi.waitFor(() => expect(store.getRun("lost")?.callbackAttempts).toBe(i));
    }
    callbacks.recover(now + 999 * 600_000);
    await vi.waitFor(() => expect(store.getRun("lost")).toMatchObject({
      callbackState: "abandoned",
      callbackError: expect.stringContaining("undeliverable"),
    }));
    expect(told).toHaveLength(1);
  });

  it("lets proof win over the ceiling: a callback that did land is not given up on", async () => {
    const { cwd, service, store, session, router, hub } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("landed", task, now, {
      callbackSessionId: session.id,
      callbackState: "failed",
      callbackAttempts: MAX_DELIVERY_ATTEMPTS,
    }));
    // Its last attempt did reach the transcript; the proof read happens before
    // the ceiling, or a delivered result would be reported as undeliverable.
    session.systemInputs.push({
      text: "result",
      origin: { kind: "task-callback", taskId: task.id, runId: "landed", sourceSessionId: null },
      mode: "followUp",
    });
    const told: string[] = [];
    const callbacks = new TaskCallbacks(store, router, () => {}, (...args) => told.push(args.join("|")));

    callbacks.recover(now + 600_000);
    await vi.waitFor(() => expect(store.getRun("landed")?.callbackState).toBe("delivered"));
    expect(told).toEqual([]);
    expect(hub.lastSeq(session.id)).toBeDefined();
  });

  it("does not send a steer twice while the first one waits in Pi's queue", async () => {
    // A steer is not deferred on a busy target — reaching the running turn is
    // the point — so it sits in Pi's in-memory queue, invisible in the
    // transcript until the turn drains it. Re-sending it there is a duplicate.
    const busy = fakeSession("busy");
    const queued: string[] = [];
    busy.systemInput = async (text) => { queued.push(text); };
    busy.pendingQueue = async () => ({ steering: [...queued], followUp: [] });
    busy.setState("streaming");
    const { cwd, service, store, router, hub } = setup(busy);
    const messenger = new TaskMessenger(store, router, hub, () => { throw new Error("no resume"); }, () => {});
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("steered", task, now, {
      state: "running", finishedAt: null, result: null,
      targetSessionId: busy.id, sessionMode: "reuse", invokedBySessionId: "owner",
    }));
    const message = await messenger.control(store.getRun("steered")!, "owner", "steer", "Change direction");

    await vi.waitFor(() => expect(queued).toHaveLength(1));
    for (let i = 1; i <= 3; i++) {
      messenger.retryUndelivered(now + i * 600_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queued).toHaveLength(1);
    expect(store.getMessage(message.id)).toMatchObject({ state: "pending", attempts: 1 });

    // The turn drains it: now it is in the transcript, and only now delivered.
    busy.systemInputs.push({
      text: queued[0]!,
      origin: {
        kind: "task-message", taskId: task.id, runId: "steered",
        sourceSessionId: "owner", messageId: message.id, messageKind: "steer",
      },
      mode: "steer",
    });
    queued.length = 0;
    messenger.retryUndelivered(now + 999 * 600_000);
    await vi.waitFor(() => expect(store.getMessage(message.id)?.state).toBe("delivered"));
    expect(queued).toHaveLength(0);
  });

  it("gives up on an unreachable callback target and reports it instead of retrying forever", async () => {
    const { cwd, service, store, hub } = setup();
    const errors: string[] = [];
    hub.subscribe("s1", (event) => { if (event.type === "error") errors.push(event.message); });
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun({
      id: "spent", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null,
      rootRunId: "spent", depth: 0, resumedFromRunId: null,
      triggerSource: "agent", invokedBySessionId: "s1", sourceSessionId: "s1",
      targetSessionId: null, sessionMode: null,
      callbackSessionId: "s1", background: true, callbackState: "failed",
      callbackAttempts: MAX_DELIVERY_ATTEMPTS, callbackError: "unknown session",
      callbackNextAttemptAt: now,
      state: "succeeded", input: null,
      context: { definition: task }, probe: null, matched: null,
      result: {
        type: "bash", exitCode: 0, stdout: "done", stderr: "",
        stdoutTruncated: false, stderrTruncated: false,
      },
      error: null, skipReason: null, queuedAt: now, startedAt: now, finishedAt: now,
    });
    service.start(20);

    await vi.waitFor(() => expect(service.getRun("spent")).toMatchObject({
      callbackState: "abandoned",
      callbackError: expect.stringContaining("undeliverable"),
      callbackNextAttemptAt: null,
    }));
    // The session that was owed the result hears about it — the whole point of
    // stopping is that stopping is visible.
    expect(errors.join(" ")).toContain("could not be delivered");
    service.stop();
  });

  it("counts a message pass that dies before the send, so its ceiling arrives too", async () => {
    const { cwd, service, store, hub } = setup();
    const messenger = new TaskMessenger(
      store,
      new Router(hub, () => Promise.reject(new Error("unknown session"))),
      hub,
      () => { throw new Error("no resume"); },
      () => {},
    );
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("gone", task, now, {
      state: "running", finishedAt: null, result: null,
      targetSessionId: "gone-session", sessionMode: "reuse", invokedBySessionId: "owner",
    }));
    const message = await messenger.control(store.getRun("gone")!, "owner", "steer", "Change direction");

    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      await vi.waitFor(() => expect(store.getMessage(message.id)?.attempts).toBe(i));
      messenger.retryUndelivered(now + i * 600_000);
    }
    await vi.waitFor(() => expect(store.getMessage(message.id)).toMatchObject({
      state: "expired",
      error: expect.stringContaining("undeliverable"),
    }));
  });

  it("gives up on an undeliverable message and tells the session it was aimed at", async () => {
    const amnesiac = fakeSession("target");
    amnesiac.systemInput = async () => {};
    const { cwd, service, store, router, hub } = setup(amnesiac);
    const told: string[] = [];
    const messenger = new TaskMessenger(
      store,
      router,
      hub,
      () => { throw new Error("no resume in this test"); },
      (sessionId, what, why) => told.push(`${sessionId}|${what}|${why}`),
    );
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun({
      id: "live", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null,
      rootRunId: "live", depth: 0, resumedFromRunId: null,
      triggerSource: "agent", invokedBySessionId: "owner", sourceSessionId: "owner",
      targetSessionId: "target", sessionMode: "reuse",
      callbackSessionId: null, background: true, callbackState: null,
      callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null,
      state: "running", input: null,
      context: { definition: task }, probe: null, matched: null, result: null,
      error: null, skipReason: null, queuedAt: now, startedAt: now, finishedAt: null,
    });
    const run = store.getRun("live")!;
    const message = await messenger.control(run, "owner", "steer", "Change direction");
    expect(message.state).toBe("pending");

    // The hand-off spent attempt 1; each sweep past the backoff spends the
    // next, and the one past the ceiling gives up.
    await vi.waitFor(() => expect(store.getMessage(message.id)?.attempts).toBe(1));
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      messenger.retryUndelivered(now + i * 600_000);
      await vi.waitFor(() => expect(store.getMessage(message.id)?.attempts).toBe(i + 1));
    }
    expect(store.getMessage(message.id)).toMatchObject({
      state: "expired",
      error: expect.stringContaining("undeliverable"),
    });
    // Both ends: the session that was owed it, and the sender waiting on it.
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("target|a steer from run live");
    expect(told[1]).toContain("owner|your steer on run live");
  });

  it("does not spend a delivery attempt while the callback target is busy", async () => {
    const { cwd, service, session } = setup();
    service.start(20);
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo busy") }, "s1") as TaskDefinition;
    session.setState("streaming");
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const done = await service.waitForRun(queued.runId);

    // Retries keep rescheduling while the target streams; waiting is not an
    // attempt, so the counter stays clean and the failure backoff stays short.
    await vi.waitFor(() => expect(service.getRun(done.id).callbackNextAttemptAt).toEqual(expect.any(Number)));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(service.getRun(done.id)).toMatchObject({ callbackState: "pending", callbackAttempts: 0 });

    session.setState("idle");
    await vi.waitFor(() => expect(service.getRun(done.id).callbackState).toBe("delivered"));
    expect(service.getRun(done.id).callbackAttempts).toBe(1);
    service.stop();
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
    const forkQueued = await service.tool({ operation: "run", task_id: forked.id }, "s1") as RunSummary;
    const forkRun = await service.waitForRun(forkQueued.runId);
    expect(factory.fork).toHaveBeenCalledWith("s1", expect.objectContaining({ cwd }));
    expect(forkRun).toMatchObject({
      state: "succeeded",
      targetSessionId: "fork-child",
      sessionMode: "fork",
    });
    expect(forkRun.sourceSessionId).toBe("s1");
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
    const done = await Promise.all([first, second].map((run) => service.waitForRun(run.id)));
    expect(done.map((run) => run.state)).toEqual(["succeeded", "succeeded"]);
    expect(done.map((run) => run.targetSessionId)).toEqual(["review-a", "review-b"]);
  });

  it("persists steering and resumes a completed Agent run in the same session", async () => {
    const { service, session } = setup();
    const task = await service.create({
      name: "controlled agent",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Start" },
    });
    session.setState("streaming");
    const queued = service.run(task.id, null, "agent", null, { invokedBySessionId: "owner" });
    const message = await service.control(queued.id, "owner", "steer", "Change direction");
    expect(message).toMatchObject({ kind: "steer", state: "pending", runId: queued.id });
    await vi.waitFor(() => expect(session.systemInputs).toContainEqual(expect.objectContaining({
      origin: expect.objectContaining({ kind: "task-message", messageId: message.id }),
      mode: "steer",
    })));
    // Delivered once the recipient's own transcript carries it, not before.
    await vi.waitFor(() => expect(service.listMessages(queued.id)[0]?.state).toBe("delivered"));
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

  it("routes supervisor decisions asynchronously: receipt, suppressed callback, reply auto-resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pier-supervisor-"));
    const parent = fakeSession("parent");
    const child = fakeSession("child");
    child.setState("streaming");
    const sessions = new Map([[parent.id, parent], [child.id, child]]);
    const factory: AgentFactory = {
      availableModels: vi.fn(async () => []),
    create: vi.fn(async () => child),
      fork: vi.fn(async () => child),
      resume: vi.fn(async (id: string) => sessions.get(id) ?? child),
      list: vi.fn(async () => [...sessions.values()].map((session) => ({ id: session.id, cwd, createdAt: 1 }))),
      find: vi.fn(async (id: string) => (await factory.list()).find((s) => s.id === id)),
    };
    const hub = new EventHub();
    const router = new Router(hub, (key) => factory.resume(key.conversationId));
    const service = new TaskService(new TaskStore(openDb(":memory:")), factory, router, hub);
    const task = await service.create({
      name: "worker",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: child.id }, prompt: "Work" },
    });
    const run = service.run(task.id, null, "agent", null, {
      invokedBySessionId: parent.id,
      sourceSessionId: parent.id,
      callbackSessionId: parent.id,
      background: true,
    });
    // contact never blocks: the receipt returns once the question lands on
    // the parent. A decision steers — a follow-up would make the blocked child
    // wait out the parent's whole turn; progress stays a follow-up.
    const receipt = await service.tool({
      operation: "contact",
      reason: "decision",
      message: "Use API A or B?",
    }, child.id) as TaskMessage;
    expect(receipt).toMatchObject({ kind: "decision", state: "pending" });
    await vi.waitFor(() => expect(service.listMessages(run.id)[0]?.state).toBe("delivered"));
    expect(parent.systemInputs.at(-1)).toMatchObject({ text: expect.stringContaining("Use API A or B?"), mode: "steer" });
    await expect(service.tool({ operation: "contact", reason: "decision", message: "again?" }, child.id))
      .rejects.toThrow("pending supervisor decision");
    await service.tool({ operation: "contact", reason: "progress", message: "Halfway done" }, child.id);
    await vi.waitFor(() => expect(parent.systemInputs.at(-1))
      .toMatchObject({ text: expect.stringContaining("Halfway done"), mode: "followUp" }));

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

    // Ending the turn with the question open finishes the run but suppresses
    // its completion callback: the pending question is the notification.
    child.setState("idle");
    const done = await service.waitForRun(run.id);
    expect(done.state).toBe("succeeded");
    expect(done.callbackState).toBeNull();
    expect((await service.tool({ operation: "get", run_id: run.id }, parent.id) as RunSummary).pendingDecisionId).toBe(receipt.id);

    // The reply resumes the terminal child with the answer as its prompt and
    // calls back to the replier.
    await service.tool({ operation: "reply", message_id: receipt.id, message: "Use API A" }, parent.id);
    expect(service.listMessages(run.id).find((message) => message.id === receipt.id)?.state).toBe("answered");
    const resumed = service.listRuns(task.id).find((row) => row.resumedFromRunId === run.id);
    expect(resumed).toBeDefined();
    expect((await service.waitForRun(resumed!.id)).context.renderedPrompt).toContain("Use API A");
    await vi.waitFor(() => expect(service.getRun(resumed!.id).callbackState).toBe("delivered"));
    expect(parent.systemInputs.at(-1)).toMatchObject({
      origin: { kind: "task-callback", runId: resumed!.id },
      mode: "followUp",
    });
  });

  it("expires an open decision when the run is manually resumed", async () => {
    const { service, session } = setup();
    const task = await service.create({
      name: "superseded",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Work" },
    });
    session.setState("streaming");
    const run = service.run(task.id, null, "agent", null, { invokedBySessionId: "owner", background: true });
    const receipt = await service.tool({ operation: "contact", reason: "decision", message: "A or B?" }, session.id) as TaskMessage;
    session.setState("idle");
    await service.waitForRun(run.id);
    await service.waitForRun(service.resume(run.id, "Just continue").id);
    expect(service.listMessages(run.id).find((message) => message.id === receipt.id)?.state).toBe("expired");
    await expect(service.tool({ operation: "reply", message_id: receipt.id, message: "A" }, "owner"))
      .rejects.toThrow("decision is expired");
  });

  it("runs inline subagent drafts atomically and filters them from lists", async () => {
    const { cwd, service } = setup();
    const queued = await service.tool({
      operation: "run",
      task: {
        name: "inline reviewer",
        action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review" },
      },
    }, "s1") as RunSummary;
    await service.waitForRun(queued.runId);
    const run = await service.tool({ operation: "get", run_id: queued.runId }, "s1") as RunSummary;
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

  it("defaults a trigger-less create to manual but keeps update strict", async () => {
    const { cwd, service } = setup();
    const { trigger: _trigger, ...noTrigger } = bashDraft(cwd, "echo untriggered");
    const task = await service.tool({ operation: "create", task: noTrigger }, "s1") as TaskDefinition;
    expect(task).toMatchObject({ kind: "task", trigger: { type: "manual" }, nextRunAt: null });

    await expect(service.tool({ operation: "update", task_id: task.id, task: noTrigger }, "s1"))
      .rejects.toThrow("trigger required");
  });

  it("inherits the caller's live model for fresh children", async () => {
    const { cwd, service, session, factory, router } = setup();
    router.attach({ channelId: "web", conversationId: session.id }, session);
    vi.mocked(factory.create).mockResolvedValueOnce(fakeSession("fresh-inherit"));
    const queued = await service.tool({
      operation: "run",
      task: { name: "inherit", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "go" } },
    }, session.id) as RunSummary;
    expect((await service.waitForRun(queued.runId)).state).toBe("succeeded");
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "test", id: "model" },
    }));
  });

  it("resumes a watch Agent without re-running its probe", async () => {
    const { cwd, service, session } = setup();
    const task = await service.create({
      name: "watch agent",
      trigger: { type: "watch", cwd, script: "exit 1", intervalSeconds: 60, mode: "repeat" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Handle match" },
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
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "later" },
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

  it("reports the reason a run stopped: exit code, cancellation or timeout", async () => {
    const { cwd, service } = setup();
    const failing = await service.create({ ...bashDraft(cwd, "echo out; exit 3"), name: "failing" });
    const failed = await service.waitForRun(service.run(failing.id).id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("bash exited 3");
    expect(failed.result).toMatchObject({ type: "bash", exitCode: 3, stdout: "out\n" });

    // A killed child reports `exited null`; the run must still say why.
    const slow = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "cancel-me" });
    const running = service.run(slow.id);
    service.cancel(running.id);
    const cancelled = await service.waitForRun(running.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("cancelled");

    const timing = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "timeout", timeoutSeconds: 1 });
    const timedOut = await service.waitForRun(service.run(timing.id).id);
    expect(timedOut.state).toBe("failed");
    expect(timedOut.error).toBe("task timed out");

    // Only exit 0/1 are watch verdicts; anything else is a broken probe.
    const broken = await service.create({
      ...bashDraft(cwd, "echo action"),
      name: "watch-broken",
      trigger: { type: "watch", cwd, script: "exit 2", intervalSeconds: 60, mode: "repeat" },
    });
    const probeRun = await service.waitForRun(service.run(broken.id).id);
    expect(probeRun.state).toBe("failed");
    expect(probeRun.error).toContain("watch probe exited 2");
  });

  it("runs paused tasks on demand and lists a task's run history", async () => {
    const { cwd, service } = setup();
    const task = await service.create(bashDraft(cwd, "echo paused"));
    // enabled:false pauses scheduling only — manual and agent triggers still fire.
    service.setEnabled(task.id, false);
    const run = await service.waitForRun(service.run(task.id).id);
    expect(run.state).toBe("succeeded");

    const history = await service.tool({ operation: "get", task_id: task.id }, "s1") as RunSummary[];
    expect(history.map((row) => row.runId)).toEqual([run.id]);
    expect(history[0]).toMatchObject({ state: "succeeded", triggerSource: "manual" });

    service.archive(task.id);
    expect(() => service.run(task.id)).toThrow("archived tasks cannot run");
  });

  it("a run whose final save throws still settles its waiters", async () => {
    const { cwd, store, service } = setup();
    const original = store.saveRun.bind(store);
    vi.spyOn(store, "saveRun").mockImplementation((run) => {
      if (run.finishedAt) throw new Error("disk full");
      original(run);
    });
    const task = await service.create(bashDraft(cwd, "echo ok"));
    const queued = service.run(task.id);
    // A regression hangs waitForRun forever (and group joins with it): fail
    // fast instead of at the suite timeout.
    const run = await Promise.race([
      service.waitForRun(queued.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waiter never settled")), 2_000)),
    ]);
    expect(run.state).toBe("succeeded");
    // The throw really fired: the stored row is one save behind.
    expect(store.getRun(queued.id)?.finishedAt).toBeNull();
  });

  it("cancelling a turn Pi never settles still releases the agent slot", async () => {
    const { cwd, service, factory } = setup();
    // A session that ignores its abort: systemInput never settles.
    const deaf = fakeSession("deaf");
    deaf.systemInput = async (text, origin, mode) => {
      deaf.systemInputs.push({ text, origin, mode });
      await new Promise<void>(() => {});
    };
    deaf.abort = async () => {};
    vi.mocked(factory.create)
      .mockResolvedValueOnce(deaf)
      .mockResolvedValueOnce(fakeSession("second"));
    const task = await service.create({
      name: "deaf child",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Work" },
    });
    const first = service.run(task.id);
    await vi.waitFor(() => expect(deaf.systemInputs.length).toBe(1));
    service.cancel(first.id);
    // The abortedTurn race, not the (never-settling) turn, settles the run…
    expect((await service.waitForRun(first.id)).state).toBe("cancelled");
    // …and the slot is free again: a second run on the same task succeeds.
    const second = await service.waitForRun(service.run(task.id).id);
    expect(second.state).toBe("succeeded");
  });

  it("refuses nested delegation from a read-only subagent", async () => {
    const { cwd, service, factory } = setup();
    vi.mocked(factory.create).mockResolvedValueOnce(hangingSession("read-only-child"));
    // Read-only is a Console/HTTP definition field, not a tool parameter: the
    // reachable path is a stored task the model runs by id.
    const task = await service.create({
      name: "reviewer",
      trigger: { type: "manual" },
      action: {
        type: "agent",
        session: { mode: "fresh", cwd },
        prompt: "Review",
        launch: { capabilities: "read" },
      },
    });
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    await vi.waitFor(() => expect(service.getRun(queued.runId).targetSessionId).toBe("read-only-child"));

    await expect(service.tool({
      operation: "run",
      task: bashDraft(cwd, "echo nested"),
    }, "read-only-child")).rejects.toThrow("read-only subagents cannot delegate");

    // The tool refuses the field outright instead of honouring it silently.
    await expect(service.tool({
      operation: "run",
      task: {
        name: "tool read-only",
        action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review", launch: { capabilities: "read" } },
      },
    }, "s1")).rejects.toThrow("configured in Console or HTTP");
    service.cancel(queued.runId);
  });

  it("joins an all-group in core and delivers one aggregated callback", async () => {
    const { cwd, service, session, factory } = setup();
    vi.mocked(factory.create)
      .mockResolvedValueOnce(fakeSession("member-a"))
      .mockResolvedValueOnce(fakeSession("member-b"));
    const draft = (name: string) => ({ name, action: { type: "agent", session: { mode: "fresh", cwd }, prompt: name } });
    const group = await service.tool({ operation: "run", tasks: [draft("angle-a"), draft("angle-b")] }, "s1") as GroupSummary;
    expect(group).toMatchObject({ join: "all", state: "running" });
    // No per-member callback — the group delivers one. Absent rather than
    // null: the model-facing summary drops its empty fields.
    expect(group.members.every((member) => member.callbackSessionId === undefined)).toBe(true);
    await Promise.all(group.members.map((member) => service.waitForRun(member.runId)));
    await vi.waitFor(() => expect(service.getGroup(group.groupId).group.callbackState).toBe("delivered"));
    const callback = session.systemInputs.at(-1)!;
    expect(callback).toMatchObject({
      origin: { kind: "task-callback", runId: group.groupId },
      mode: "followUp",
    });
    expect(callback.text).toContain("angle-a");
    expect(callback.text).toContain("angle-b");
    const fetched = await service.tool({ operation: "get", group_id: group.groupId }, "s1") as GroupSummary;
    expect(fetched.state).toBe("finished");
    expect(fetched.members.map((member) => member.state)).toEqual(["succeeded", "succeeded"]);
  });

  it("first-join delivers the winner and cancels losers as resumable", async () => {
    const { cwd, service, session, factory } = setup();
    vi.mocked(factory.create)
      .mockResolvedValueOnce(fakeSession("fast-member"))
      .mockResolvedValueOnce(hangingSession("slow-member"));
    const draft = (name: string) => ({ name, action: { type: "agent", session: { mode: "fresh", cwd }, prompt: name } });
    const group = await service.tool({ operation: "run", tasks: [draft("fast"), draft("slow")], join: "first" }, "s1") as GroupSummary;
    await vi.waitFor(() => expect(service.getGroup(group.groupId).group.callbackState).toBe("delivered"));
    const { group: finished, members } = service.getGroup(group.groupId);
    const winner = members.find((run) => run.id === finished.winnerRunId)!;
    expect(winner.state).toBe("succeeded");
    const loser = members.find((run) => run.id !== finished.winnerRunId)!;
    await vi.waitFor(() => expect(service.getRun(loser.id).state).toBe("cancelled"));
    expect(session.systemInputs.at(-1)!.text).toContain("resume its session");
  });

  it("cancel cascades to descendants and cancels whole groups", async () => {
    const { cwd, service, factory } = setup();
    const slowA = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "slow-a" });
    const slowB = await service.create({ ...bashDraft(cwd, "sleep 5"), name: "slow-b" });
    const parent = service.run(slowA.id);
    const child = service.run(slowB.id, null, "task", parent.id);
    expect(child.rootRunId).toBe(parent.id);
    service.cancel(parent.id);
    expect((await service.waitForRun(parent.id)).state).toBe("cancelled");
    expect((await service.waitForRun(child.id)).state).toBe("cancelled");

    vi.mocked(factory.create)
      .mockResolvedValueOnce(hangingSession("hang-a"))
      .mockResolvedValueOnce(hangingSession("hang-b"));
    const draft = (name: string) => ({ name, action: { type: "agent", session: { mode: "fresh", cwd }, prompt: name } });
    const group = await service.tool({ operation: "run", tasks: [draft("one"), draft("two")] }, "s1") as GroupSummary;
    await service.tool({ operation: "cancel", group_id: group.groupId }, "s1");
    for (const member of group.members) {
      await vi.waitFor(() => expect(service.getRun(member.runId).state).toBe("cancelled"));
    }
  });

  it("names the worker's session in a single run's callback, not only a group's", async () => {
    const { cwd, service, session, factory } = setup();
    vi.mocked(factory.create).mockResolvedValueOnce(fakeSession("worker-1"));
    const task = await service.tool({
      operation: "run",
      task: { name: "review", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Review" } },
    }, "s1") as RunSummary;
    const run = await service.waitForRun(task.runId);
    await vi.waitFor(() => expect(service.getRun(run.id).callbackState).toBe("delivered"));
    // The relay's next move is a deep link to the session that did the work;
    // without this line finding it costs the reader another tool call.
    expect(session.systemInputs.at(-1)!.text).toContain(`Run: ${run.id} / Session: worker-1`);
  });

  it("batches pending callbacks for one session into a single input", async () => {
    const { cwd, service, session } = setup();
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo done") }, "s1") as TaskDefinition;
    session.setState("streaming");
    const first = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    await service.waitForRun(first.runId);
    const second = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    await service.waitForRun(second.runId);
    session.setState("idle");
    const before = session.systemInputs.length;
    service.start(50);
    await vi.waitFor(() => expect(service.getRun(first.runId).callbackState).toBe("delivered"), { timeout: 3000 });
    expect(service.getRun(second.runId).callbackState).toBe("delivered");
    expect(session.systemInputs).toHaveLength(before + 1);
    expect(session.systemInputs.at(-1)!.origin).toMatchObject({
      kind: "task-callback",
      runIds: expect.arrayContaining([first.runId, second.runId]) as unknown,
    });
    service.stop();
  });

  it("fires cron only at the next future occurrence", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:59.000Z"));
      const { service, session } = setup();
      const task = await service.create({
        name: "cron agent",
        trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
        action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "tick" },
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
      id: "stale", taskId: task.id, taskRevision: 1, parentRunId: null, groupId: null,
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
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Work" },
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
