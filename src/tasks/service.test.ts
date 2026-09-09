import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
import { runResultText, TaskCallbacks } from "./callbacks.js";
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
  emit(event: SessionEventPayload): void;
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
    /** For the turns this fake does not run itself — the ones that end on
     *  something other than an answer. */
    emit(event) {
      listeners.forEach((fn) => fn(event));
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
    setCacheRetention: () => {},
    pendingQueue: async () => ({ steering: [], followUp: [] }),
    pendingSystemInputs: async () => [],
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

/** A session whose turn ends the way a provider outage ends one: no text, and
 *  the reason on the turn (what agent/events.ts emits for an assistant message
 *  that stopped with `stopReason: "error"`). */
function outageSession(id: string, error: string): ReturnType<typeof fakeSession> {
  const session = fakeSession(id);
  session.systemInput = async (text, origin, mode) => {
    session.systemInputs.push({ text, origin, mode });
    session.setState("streaming");
    await Promise.resolve();
    session.emit({ type: "turn-end", text: "", error });
    session.setState("idle");
  };
  return session;
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

function setup(session = fakeSession(), instance?: ConstructorParameters<typeof TaskService>[4]) {
  const cwd = mkdtempSync(join(tmpdir(), "pier-task-"));
  const factory: AgentFactory = {
    availableModels: vi.fn(async () => []),
    create: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    list: vi.fn(async () => [{ id: session.id, cwd, createdAt: 1 }]),
    // Derived from the same list, like the real seam: a fake that answers the
    // two independently can agree with nothing.
    find: vi.fn(async (id: string) => (await factory.list()).find((s) => s.id === id)),
    search: vi.fn(async () => []),
  };
  const hub = new EventHub();
  const router = new Router(hub, () => factory.resume(session.id));
  const store = new TaskStore(openDb(":memory:"));
  const service = new TaskService(store, factory, router, hub, instance);
  return { cwd, session, factory, hub, router, store, service };
}

/** A stored run row. The literal is long and a dozen tests need one, differing
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

/** A supervisor session and the child it delegates to on one service: the rig
 *  every decision/reply path needs, and the only one where `resume` has to
 *  answer with a different session than `create`. */
function supervised() {
  const cwd = mkdtempSync(join(tmpdir(), "pier-supervisor-"));
  const parent = fakeSession("parent");
  const child = fakeSession("child");
  const sessions = new Map([[parent.id, parent], [child.id, child]]);
  const factory: AgentFactory = {
    availableModels: vi.fn(async () => []),
    create: vi.fn(async () => child),
    resume: vi.fn(async (id: string) => sessions.get(id) ?? child),
    list: vi.fn(async () => [...sessions.values()].map((session) => ({ id: session.id, cwd, createdAt: 1 }))),
    find: vi.fn(async (id: string) => (await factory.list()).find((s) => s.id === id)),
    search: vi.fn(async () => []),
  };
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const store = new TaskStore(openDb(":memory:"));
  return { cwd, parent, child, hub, router, store, service: new TaskService(store, factory, router, hub) };
}

/** Where every reply path starts: a background run on the child that asked its
 *  supervisor a question and then ended its turn with the question open. */
async function askedAndFinished(rig: ReturnType<typeof supervised>) {
  const { service, child, parent } = rig;
  child.setState("streaming");
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
  const question = await service.tool({
    operation: "contact",
    reason: "decision",
    message: "Use API A or B?",
  }, child.id) as TaskMessage;
  child.setState("idle");
  await service.waitForRun(run.id);
  return { task, run, question };
}

/** Moves the sweep's clock past a backoff instead of sleeping it out. */
function skewClock(): (ms: number) => void {
  const real = Date.now;
  let skew = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
  onTestFinished(() => spy.mockRestore());
  return (ms) => { skew += ms; };
}

const bashDraft = (cwd: string, script: string) => ({
  name: "command",
  trigger: { type: "manual" },
  action: { type: "bash", cwd, script },
  timeoutSeconds: 5,
});

describe("global run queries", () => {
  it("filters before limiting and keyset-pages timestamp ties without hiding child failures", async () => {
    const { cwd, service, store } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    for (let i = 0; i < 620; i++) store.saveRun(storedRun(`noise-${i}`, task, 1000 + i));
    for (const id of ["a", "b", "c"]) store.saveRun(storedRun(id, task, 10, {
      state: "failed", triggerSource: "watch", parentRunId: "parent", groupId: "group",
    }));
    const query = { state: "failed" as const, source: "watch" as const, taskId: task.id, since: 10, until: 10, limit: 2 };
    const first = service.queryRuns(query);
    expect(first.runs.map((r) => r.id)).toEqual(["c", "b"]);
    expect(first.nextCursor).toEqual({ queuedAt: 10, id: "b" });
    store.saveRun(storedRun("newer", task, 20, { state: "failed", triggerSource: "watch" }));
    const second = service.queryRuns({ ...query, cursor: first.nextCursor! });
    expect(second.runs.map((r) => r.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
    // Children are rows like any other: a failed child is never folded away.
    expect(service.queryRuns({ state: "failed" }).runs.map((r) => r.parentRunId)).toContain("parent");
    expect(service.queryRuns({ taskId: "' OR 1=1 --" }).runs).toHaveLength(0);
  });

  it("hides only successful unmatched probes without returning a hidden count", async () => {
    const { cwd, service, store } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    store.saveRun(storedRun("no-match", task, 5, { matched: false, result: { type: "watch", matched: false }, triggerSource: "watch" }));
    store.saveRun(storedRun("failed-probe", task, 4, { state: "failed", matched: false, triggerSource: "watch" }));
    store.saveRun(storedRun("skipped", task, 3, { state: "skipped", matched: false, triggerSource: "watch" }));
    store.saveRun(storedRun("action", task, 2, { matched: true }));
    store.saveRun(storedRun("ordinary", task, 1));
    const page = service.queryRuns({ limit: 1 });
    expect(page.runs.map((r) => r.id)).toEqual(["failed-probe"]);
    expect(Object.keys(page).sort()).toEqual(["nextCursor", "runs"]);
    expect(service.queryRuns({ cursor: page.nextCursor! }).runs.map((r) => r.id)).toEqual(["skipped", "action", "ordinary"]);
    expect(service.queryRuns().runs.map((r) => r.id)).toEqual(["failed-probe", "skipped", "action", "ordinary"]);
    expect(service.queryRuns({ showUnmatched: true }).runs).toHaveLength(5);
    expect(service.queryRuns({ source: "agent" }).runs.map((r) => r.id)).toEqual(["action", "ordinary"]);
    expect(service.queryRuns({ state: "failed" }).runs).toHaveLength(1);
  });

  it("joins the unresolved decision, not an arbitrary recent message, beside the group's callback state", async () => {
    const { cwd, service, store } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    store.saveRun(storedRun("run", task, 1, { callbackState: "failed", callbackError: "unreachable" }));
    store.saveRun(storedRun("other", task, 2, { callbackState: "abandoned" }));
    store.saveRun(storedRun("member", task, 3, { groupId: "group" }));
    store.saveGroup({ id: "group", join: "all", invokedBySessionId: "supervisor", callbackSessionId: "supervisor",
      memberRunIds: ["member"], winnerRunId: null, createdAt: 1, finishedAt: 2,
      callbackState: "failed", callbackAttempts: 1, callbackError: "unreachable", callbackNextAttemptAt: 3 });
    const message = (id: string, state: TaskMessage["state"], kind: TaskMessage["kind"], runId = "run"): TaskMessage => ({
      id, runId, kind, state, fromSessionId: "child", toSessionId: "supervisor", replyTo: null,
      content: id, createdAt: 1, deliveredAt: null, answeredAt: null, error: null, attempts: 0, nextAttemptAt: null,
    });
    store.saveMessage(message("answered", "answered", "decision"));
    store.saveMessage(message("progress", "pending", "progress"));
    store.saveMessage(message("question", "delivered", "decision"));
    store.saveMessage(message("expired", "expired", "decision", "other"));
    const page = service.queryRuns();
    expect(page.runs.find((r) => r.id === "run")).toMatchObject({ pendingDecisionId: "question", callbackState: "failed" });
    expect(page.runs.find((r) => r.id === "other")!.pendingDecisionId).toBeNull();
    expect(page.runs.find((r) => r.id === "member")!.groupCallbackState).toBe("failed");
    expect(service.getRunView("member").groupCallbackState).toBe("failed");
    const app = new Hono(); registerTaskRoutes(app, service);
    const detail = await (await app.request("/api/task-runs/run")).json();
    expect(detail.pendingDecisionId).toBe("question");
    store.saveMessage(message("question", "answered", "decision"));
    expect(service.queryRuns().runs.find((r) => r.id === "run")!.pendingDecisionId).toBeNull();
  });

  it("validates HTTP filters and leaves the Activity snapshot as it was", async () => {
    const { cwd, service, store, factory, router } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    store.saveRun(storedRun("active", task, 1, { state: "running" }));
    store.saveRun(storedRun("old", task, 2));
    store.saveRun(storedRun("new", task, Date.now()));
    const app = new Hono(); registerTaskRoutes(app, service, { factory, router });
    for (const query of ["state=unknown", "source=console", "limit=NaN", "limit=0", "limit=201", "since=x", "since=9&until=1", "cursor={}", "cursor=garbage", "showUnmatched=yes"]) {
      expect((await app.request(`/api/task-runs?${query}`)).status, query).toBe(400);
    }
    const activity = await (await app.request("/api/activity")).json();
    expect(activity.runs.map((r: TaskRun) => r.id)).toEqual(["active"]);
    const recent = await (await app.request("/api/activity?scope=recent")).json();
    expect(recent.runs.map((r: TaskRun) => r.id)).toEqual(["new", "active"]);
    const list = await (await app.request("/api/task-runs?state=running&limit=1")).json();
    expect(list.runs[0].id).toBe("active");
    expect(list.runs[0].triggerSource).toBe("agent");
    expect(Object.keys(list).sort()).toEqual(["nextCursor", "runs"]);
  });
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
    const ids = Array.from({ length: 10_000 }, newId);
    expect(ids.filter((id) => id.length !== 16 || [...id].some((c) => !alphabet.includes(c)))).toEqual([]);
    // Not a guarantee — 80 bits makes a repeat here a ~1e-13 event, so one
    // would mean the source stopped being random, not that luck ran out.
    expect(new Set(ids).size).toBe(10_000);
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

describe("callback recovery across database connections", () => {
  function diskRig() {
    const home = mkdtempSync(join(tmpdir(), "pier-callback-restart-"));
    const proof = join(home, "recipient.json");
    writeFileSync(proof, "[]");
    vi.stubEnv("HOME", home);
    vi.stubEnv("PIER_HOME", home);
    const boots: { close(): void }[] = [];
    onTestFinished(() => {
      for (const boot of boots) boot.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });
    const history = (): ChatTurn[] => JSON.parse(readFileSync(proof, "utf8")) as ChatTurn[];
    const boot = (mode: "record" | "accept" | "reject" = "record") => {
      const db = openDb(join(home, "db", "pier.db"));
      const store = new TaskStore(db);
      const parent = fakeSession("parent");
      // Fixture-owned proof, deliberately independent of process-local inputs.
      // This tests the AgentSession contract, not Pi on-disk semantics.
      parent.history = async () => history();
      parent.systemInput = vi.fn(async (text, origin, delivery) => {
        parent.systemInputs.push({ text, origin, mode: delivery });
        if (mode === "record") {
          writeFileSync(proof, JSON.stringify([...history(), { role: "system", text, origin }]));
        }
      });
      const factory: AgentFactory = {
        availableModels: async () => [],
        create: async () => fakeSession(newId()),
        resume: async (id) => {
          if (mode === "reject") throw new Error("fixture recipient unavailable");
          if (id !== parent.id) throw new Error(`unexpected recipient ${id}`);
          return parent;
        },
        list: async () => [{ id: parent.id, cwd: home, createdAt: 1 }],
        find: async (id) => id === parent.id ? { id, cwd: home, createdAt: 1 } : undefined,
        search: async () => [],
      };
      const hub = new EventHub();
      const router = new Router(hub, (key) => factory.resume(key.conversationId));
      const service = new TaskService(store, factory, router, hub);
      let closed = false;
      const rig = { store, service, parent, hub, close() {
        if (closed) return;
        service.pause();
        db.close();
        closed = true;
      } };
      boots.push(rig);
      return rig;
    };
    return { home, boot, history };
  }

  it("writes off queued and running rows after reopen and tells their parent once", async () => {
    const disk = diskRig();
    const first = disk.boot();
    const task = await first.service.create(bashDraft(disk.home, "true"));
    for (const state of ["queued", "running"] as const) {
      first.store.saveRun(storedRun(state, task, Date.now(), {
        state, startedAt: state === "queued" ? null : Date.now(), finishedAt: null, result: null,
        invokedBySessionId: "parent", callbackSessionId: "parent", background: true,
      }));
    }
    first.close();
    const second = disk.boot();
    const statuses: { runId: string; state: string }[] = [];
    second.hub.subscribe("parent", (event) => {
      if (event.type === "task-status") statuses.push({ runId: event.run.runId, state: event.run.state });
    });
    second.service.start(60_000);
    await vi.waitFor(() => {
      for (const id of ["queued", "running"]) expect(second.service.getRun(id)).toMatchObject({
        state: "interrupted", callbackState: "delivered", finishedAt: expect.any(Number),
        error: "Pier restarted while the run was active",
      });
    });
    expect(statuses).toEqual(expect.arrayContaining([
      { runId: "queued", state: "interrupted" }, { runId: "running", state: "interrupted" },
    ]));
    expect(second.parent.systemInputs).toHaveLength(1);
    expect(second.parent.systemInputs[0]!.origin).toMatchObject({ runIds: ["queued", "running"] });
    expect(second.parent.systemInputs[0]!.text).toContain("state: interrupted");
    expect(second.parent.systemInputs[0]!.text).toContain("Pier restarted while the run was active");
    second.close();
    const third = disk.boot();
    third.service.start(60_000);
    expect(third.store.listPendingCallbacks()).toEqual([]);
    expect(third.parent.systemInputs).toEqual([]);
    expect(disk.history()).toHaveLength(1);
  });

  it.each(["accept", "reject"] as const)("recovers pending callbacks after a boot that can only %s input", async (mode) => {
    const disk = diskRig();
    const seed = disk.boot();
    const task = await seed.service.create(bashDraft(disk.home, "true"));
    seed.store.saveRun(storedRun("pending", task, Date.now(), {
      callbackSessionId: "parent", callbackState: "pending",
    }));
    seed.close();
    const first = disk.boot(mode);
    const errors: string[] = [];
    first.hub.subscribe("parent", (event) => { if (event.type === "error") errors.push(event.message); });
    first.service.start(60_000);
    await vi.waitFor(() => expect(first.service.getRun("pending")).toMatchObject({
      callbackState: mode === "accept" ? "pending" : "failed", callbackAttempts: 1,
    }));
    expect(disk.history()).toEqual([]);
    if (mode === "reject") {
      expect(errors.join(" ")).toContain("fixture recipient unavailable");
      expect(first.service.getRun("pending").callbackError).toContain("fixture recipient unavailable");
    } else expect(first.parent.systemInputs).toHaveLength(1);
    first.close();
    const second = disk.boot();
    const pending = second.service.getRun("pending");
    expect(pending.callbackNextAttemptAt).toEqual(expect.any(Number));
    // Move the clock to the persisted due time, without sleeping out backoff.
    const clock = vi.spyOn(Date, "now").mockReturnValue(pending.callbackNextAttemptAt!);
    try {
      second.service.start(60_000);
      await vi.waitFor(() => expect(second.service.getRun("pending")).toMatchObject({
        callbackState: "delivered", callbackAttempts: 2, callbackError: null, callbackNextAttemptAt: null,
      }));
    } finally { clock.mockRestore(); }
    expect(second.parent.systemInputs).toHaveLength(1);
    expect(disk.history()).toHaveLength(1);
  });

  it.each(["run", "group"] as const)("settles a pending %s from persisted recipient proof without reinjection", async (kind) => {
    const disk = diskRig();
    const first = disk.boot();
    const task = await first.service.create({
      name: "worker", action: { type: "agent", session: { mode: "fresh", cwd: disk.home }, prompt: "work" },
    });
    const id = kind === "run"
      ? first.service.run(task.id, null, "agent", null, { callbackSessionId: "parent" }).id
      : first.service.runGroup([task, task], "all", "parent", null, "parent", "followUp").group.id;
    const record = () => kind === "run" ? first.store.getRun(id)! : first.store.getGroup(id)!;
    await vi.waitFor(() => expect(record().callbackState).toBe("delivered"));
    expect(disk.history()).toHaveLength(1);
    // Crash window: the recipient committed its proof, but Pier retained the
    // pre-confirmation row. Both new connections and a fresh router are used.
    if (kind === "run") {
      first.store.saveRun({ ...first.store.getRun(id)!, callbackState: "pending" });
    } else first.store.saveGroup({ ...first.store.getGroup(id)!, callbackState: "pending" });
    first.close();
    const second = disk.boot();
    second.service.start(60_000);
    await vi.waitFor(() => expect((kind === "run" ? second.store.getRun(id) : second.store.getGroup(id)))
      .toMatchObject({ callbackState: "delivered", callbackAttempts: 1 }));
    expect(second.parent.systemInputs).toEqual([]);
    expect(disk.history()).toHaveLength(1);
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
      // The card rendering this input names what produced it without fetching
      // the run: the task, and the model and effort the session settled on.
      origin: {
        kind: "task-delegation",
        taskId: task.id,
        runId: run.id,
        sourceSessionId: null,
        source: { taskName: "review", model: { provider: "test", id: "model" }, thinking: "off" },
      },
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

  it("caps a chatty callback but recovers the full result", async () => {
    const long = `start ${"x".repeat(9000)}`;
    const { service, session } = setup(fakeSession("s1", long));
    const task = await service.create({
      name: "chatty",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Go" },
    });
    const run = await service.waitForRun(service.run(task.id).id);
    const callback = runResultText(run);
    expect(callback.length).toBeLessThan(8200);
    expect(callback).toContain(`recover run_id ${run.id}`);
    const single = await service.tool({ operation: "recover", run_id: run.id, reason: "callback text was truncated" }, "s1") as RunSummary;
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
      origin: { kind: "task-callback", runId: done.id, source: { taskName: "command" } },
      mode: "followUp",
    });
    // A bash run has no model and no effort, and the card must not invent one.
    expect(session.systemInputs.at(-1)?.origin.source).toEqual({ taskName: "command" });

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
    const advance = skewClock();
    service.start(20);
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo lost") }, "s1") as TaskDefinition;
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const done = await service.waitForRun(queued.runId);

    await vi.waitFor(() => expect(service.getRun(done.id).callbackAttempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(service.getRun(done.id).callbackState).toBe("pending");
    // ...and it keeps trying, on the backoff curve rather than every tick.
    advance(retryDelay(1) + 100);
    await vi.waitFor(() => expect(service.getRun(done.id).callbackAttempts).toBe(2));
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

  /** A recipient that is mid-turn, queueing what it is handed the way Pi does:
   *  the input goes into the agent's queue — not the transcript, and not the
   *  text queue `pendingQueue` reads — until the turn drains it. */
  function streamingRecipient(id: string) {
    const session = fakeSession(id);
    const queued: { text: string; origin: SystemInputOrigin }[] = [];
    session.systemInput = async (text, origin) => { queued.push({ text, origin }); };
    session.pendingSystemInputs = async () => queued.map((entry) => entry.origin);
    session.setState("streaming");
    /** The turn ends and takes the queue with it, into the transcript. */
    const drain = (): void => {
      for (const entry of queued) session.systemInputs.push({ ...entry, mode: "steer" });
      queued.length = 0;
    };
    return { session, queued, drain };
  }

  it("does not send a steer twice while the first one waits in Pi's queue", async () => {
    // A steer is not deferred on a busy target — reaching the running turn is
    // the point — so it sits in Pi's in-memory queue, invisible in the
    // transcript until the turn drains it. Re-sending it there is a duplicate.
    const busy = streamingRecipient("busy");
    const { cwd, service, store, router, hub } = setup(busy.session);
    const messenger = new TaskMessenger(store, router, hub, () => { throw new Error("no resume"); }, () => {}, () => {});
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("steered", task, now, {
      state: "running", finishedAt: null, result: null,
      targetSessionId: busy.session.id, sessionMode: "reuse", invokedBySessionId: "owner",
    }));
    const message = await messenger.control(store.getRun("steered")!, "owner", "steer", "Change direction");

    await vi.waitFor(() => expect(busy.queued).toHaveLength(1));
    for (let i = 1; i <= 3; i++) {
      messenger.retryUndelivered(now + i * 600_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(busy.queued).toHaveLength(1);
    expect(store.getMessage(message.id)).toMatchObject({ state: "pending", attempts: 1 });

    // The turn drains it: now it is in the transcript, and only now delivered.
    busy.drain();
    messenger.retryUndelivered(now + 999 * 600_000);
    await vi.waitFor(() => expect(store.getMessage(message.id)?.state).toBe("delivered"));
    expect(busy.queued).toHaveLength(0);
  });

  it("waits out a long turn instead of spending a follow-up's attempts on it", async () => {
    // A follow-up is drained when the turn ends, so a recipient that streams
    // for an hour holds it that long. Every sweep in between is a wait, not an
    // attempt: counting them expires a message that was never undeliverable —
    // and queues a copy of it per sweep, all of which land at once.
    const busy = streamingRecipient("long-turn");
    const { cwd, service, store, router, hub } = setup(busy.session);
    const told: string[] = [];
    const messenger = new TaskMessenger(
      store, router, hub,
      () => { throw new Error("no resume"); },
      (...args) => told.push(args.join("|")),
      () => {},
    );
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("guided", task, now, {
      state: "running", finishedAt: null, result: null,
      targetSessionId: busy.session.id, sessionMode: "reuse", invokedBySessionId: "owner",
    }));
    const message = await messenger.control(store.getRun("guided")!, "owner", "follow_up", "Also check the tests");

    await vi.waitFor(() => expect(busy.queued).toHaveLength(1));
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS + 2; i++) {
      messenger.retryUndelivered(now + i * 600_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(busy.queued).toHaveLength(1);
    expect(store.getMessage(message.id)).toMatchObject({ state: "pending", attempts: 1 });
    expect(told).toEqual([]);

    busy.drain();
    messenger.retryUndelivered(now + 999 * 600_000);
    await vi.waitFor(() => expect(store.getMessage(message.id)?.state).toBe("delivered"));
  });

  it("gives up on an unreachable callback target and reports it instead of retrying forever", async () => {
    const { cwd, service, store, hub } = setup();
    const errors: string[] = [];
    hub.subscribe("s1", (event) => { if (event.type === "error") errors.push(event.message); });
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("spent", task, now, {
      invokedBySessionId: "s1", sourceSessionId: "s1", callbackSessionId: "s1", background: true,
      callbackState: "failed", callbackAttempts: MAX_DELIVERY_ATTEMPTS,
      callbackError: "unknown session", callbackNextAttemptAt: now,
    }));
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
      () => {},
    );
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    store.saveRun(storedRun("live", task, now, {
      state: "running", finishedAt: null, result: null,
      targetSessionId: "target", sessionMode: "reuse", invokedBySessionId: "owner", sourceSessionId: "owner", background: true,
    }));
    const run = store.getRun("live")!;
    const message = await messenger.control(run, "owner", "steer", "Change direction");
    expect(message.state).toBe("pending");

    // The hand-off spent attempt 1; each sweep past the backoff spends the
    // next, and the one past the ceiling gives up without sending.
    await vi.waitFor(() => expect(store.getMessage(message.id)?.attempts).toBe(1));
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      messenger.retryUndelivered(now + i * 600_000);
      await vi.waitFor(() => expect(store.getMessage(message.id)?.attempts).toBe(i + 1));
    }
    messenger.retryUndelivered(now + MAX_DELIVERY_ATTEMPTS * 600_000);
    await vi.waitFor(() => expect(store.getMessage(message.id)).toMatchObject({
      state: "expired",
      attempts: MAX_DELIVERY_ATTEMPTS,
      error: expect.stringContaining("undeliverable"),
    }));
    // Both ends: the session that was owed it, and the sender waiting on it.
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("target|a steer from run live");
    expect(told[1]).toContain("owner|your steer on run live");
  });

  it("does not spend a delivery attempt while the callback target is busy", async () => {
    const { cwd, service, session } = setup();
    const advance = skewClock();
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
    advance(1100);
    await vi.waitFor(() => expect(service.getRun(done.id).callbackState).toBe("delivered"));
    expect(service.getRun(done.id).callbackAttempts).toBe(1);
    service.stop();
  });

  it("steers a callback into the running turn only when the delegation asked for it", async () => {
    // A busy recipient that records what it is handed without ending its turn:
    // the steer has to land mid-stream, and the follow-up beside it must not.
    const session = fakeSession();
    session.systemInput = async (text, origin, mode) => { session.systemInputs.push({ text, origin, mode }); };
    const { cwd, service } = setup(session);
    const advance = skewClock();
    service.start(20);
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo busy") }, "s1") as TaskDefinition;
    session.setState("streaming");
    const waiting = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const urgent = await service.tool({ operation: "run", task_id: task.id, callback: "steer" }, "s1") as RunSummary;
    expect(urgent.callbackMode).toBe("steer");
    expect(waiting.callbackMode).toBeUndefined();
    await service.waitForRun(waiting.runId);
    await service.waitForRun(urgent.runId);

    // The steer rides the running turn; the default callback keeps waiting for
    // it to end, and is not batched into the delivery that overtook it.
    await vi.waitFor(() => expect(service.getRun(urgent.runId).callbackState).toBe("delivered"));
    expect(session.systemInputs).toHaveLength(1);
    expect(session.systemInputs[0]).toMatchObject({ mode: "steer" });
    expect(session.systemInputs[0]!.text).toContain(urgent.runId);
    expect(session.systemInputs[0]!.text).not.toContain(waiting.runId);
    expect(service.getRun(waiting.runId)).toMatchObject({ callbackState: "pending", callbackAttempts: 0 });

    session.setState("idle");
    // The deferred sweep is a second away, not a tick away — and a deferral
    // written mid-flight as the turn ended is another second out.
    await vi.waitFor(() => {
      advance(1100);
      expect(service.getRun(waiting.runId).callbackState).toBe("delivered");
    });
    expect(session.systemInputs.at(-1)).toMatchObject({ mode: "followUp" });
    service.stop();
  });

  it("does not send a steered callback twice while the first one waits in Pi's queue", async () => {
    // A steer is handed to a running turn, so until that turn drains it the
    // result is in Pi's memory queue and nowhere in the transcript. Proof by
    // transcript alone would read that as "never arrived" and send it again.
    const busy = streamingRecipient("s1");
    const { cwd, service, store } = setup(busy.session);
    const advance = skewClock();
    service.start(20);
    const task = await service.tool({ operation: "create", task: bashDraft(cwd, "echo busy") }, "s1") as TaskDefinition;
    const urgent = await service.tool({ operation: "run", task_id: task.id, callback: "steer" }, "s1") as RunSummary;
    await service.waitForRun(urgent.runId);

    await vi.waitFor(() => expect(busy.queued).toHaveLength(1));
    // Past the first retry's backoff, which is when the re-send would happen.
    advance(retryDelay(1) + 100);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(busy.queued).toHaveLength(1);
    // Waiting on the queue is not an attempt either: one send, one count.
    expect(store.getRun(urgent.runId)).toMatchObject({ callbackState: "pending", callbackAttempts: 1 });

    busy.drain();
    advance(1100);
    await vi.waitFor(() => expect(store.getRun(urgent.runId)?.callbackState).toBe("delivered"));
    expect(busy.queued).toHaveLength(0);
    service.stop();
  });

  it("creates a persisted fresh child session with lineage", async () => {
    const { cwd, service, factory } = setup();
    const freshChild = fakeSession("fresh-child");
    vi.mocked(factory.create).mockResolvedValueOnce(freshChild);

    const fresh = await service.create({
      name: "fresh reviewer",
      trigger: { type: "manual" },
      action: {
        type: "agent",
        session: { mode: "fresh", cwd },
        launch: { thinking: "low" },
        prompt: "Review independently",
      },
    });
    const freshRun = await service.waitForRun(service.run(fresh.id, { diff: true }, "agent", null, {
      invokedBySessionId: "s1",
      sourceSessionId: "s1",
    }).id);
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
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
  });

  it("refuses a definition stored with the removed fork mode instead of guessing a directory", async () => {
    const { cwd, service, store, factory } = setup();
    // Written past validation, the way the 23 definitions on disk were: created
    // when `fork` was still a mode, and runnable by id ever since.
    const legacy = await service.create({
      name: "legacy forker",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Continue from context" },
    });
    store.saveTask({
      ...legacy,
      action: { type: "agent", session: { mode: "fork" } as never, prompt: "Continue from context" },
    });

    const queued = await service.tool({ operation: "run", task_id: legacy.id }, "s1") as RunSummary;
    const run = await service.waitForRun(queued.runId);
    expect(run.state).toBe("failed");
    expect(run.error).toContain("removed fork session mode");
    expect(factory.create).not.toHaveBeenCalled();

    // Naming the mode as an override is answered too: dropping it would run
    // the definition's own policy under the caller's word for something else.
    await expect(service.tool({ operation: "run", task_id: legacy.id, session_mode: "fork" }, "s1"))
      .rejects.toThrow("unsupported session_mode");
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

  it.each([
    { sameRoot: true, cancelQueued: false },
    { sameRoot: false, cancelQueued: false },
    { sameRoot: true, cancelQueued: true },
    { sameRoot: false, cancelQueued: true },
  ])("keeps six agent slots across roots: $sameRoot, queued cancellation: $cancelQueued", async ({ sameRoot, cancelQueued }) => {
    const { cwd, service, factory } = setup();
    onTestFinished(() => service.stop());
    const sessions: ReturnType<typeof hangingSession>[] = [];
    vi.mocked(factory.create).mockImplementation(async () => {
      const session = hangingSession(`worker-${sessions.length}`);
      sessions.push(session);
      return session;
    });
    const task = await service.create({
      name: "slot worker",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Work" },
    });
    const runs = Array.from({ length: 7 }, () => service.run(task.id, null, "agent", null,
      sameRoot ? { rootRunId: "shared-root" } : {}));
    expect(new Set(runs.map((run) => run.rootRunId)).size).toBe(sameRoot ? 1 : 7);
    await vi.waitFor(() => expect(runs.slice(0, 6).map((run) => service.getRun(run.id).state))
      .toEqual(Array.from({ length: 6 }, () => "running")));
    expect(factory.create).toHaveBeenCalledTimes(6);
    expect(service.getRun(runs[6]!.id)).toMatchObject({ state: "queued", startedAt: null, targetSessionId: null });

    let waiting = runs[6]!;
    if (cancelQueued) {
      service.cancel(waiting.id);
      expect(await service.waitForRun(waiting.id)).toMatchObject({ state: "cancelled", startedAt: null, targetSessionId: null });
      waiting = service.run(task.id, null, "agent", null, sameRoot ? { rootRunId: "shared-root" } : {});
      runs.push(waiting);
      expect(factory.create).toHaveBeenCalledTimes(6);
      expect(service.getRun(waiting.id)).toMatchObject({ state: "queued", startedAt: null, targetSessionId: null });
    }

    // Complete the fake turn without cancelling its run, freeing exactly one slot.
    await sessions[0]!.abort();
    expect((await service.waitForRun(runs[0]!.id)).state).toBe("succeeded");
    await vi.waitFor(() => expect(service.getRun(waiting.id).state).toBe("running"));
    expect(factory.create).toHaveBeenCalledTimes(7);
    expect(runs.filter((run) => service.getRun(run.id).state === "running")).toHaveLength(6);
    await Promise.all(sessions.slice(1).map((session) => session.abort()));
    const done = await Promise.all(runs.map((run) => service.waitForRun(run.id)));
    expect(done.map((run) => run.state)).toEqual(cancelQueued
      ? [...Array.from({ length: 6 }, () => "succeeded"), "cancelled", "succeeded"]
      : Array.from({ length: 7 }, () => "succeeded"));
  });

  it("leaves slots available to a fresh run behind six runs reusing one session", async () => {
    const { cwd, service, session, factory } = setup(hangingSession("shared"));
    onTestFinished(() => service.stop());
    const reuse = await service.create({
      name: "reuse", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Work" },
    });
    const runs = Array.from({ length: 6 }, () => service.run(reuse.id, null, "agent"));
    await vi.waitFor(() => expect(session.systemInputs).toHaveLength(1));
    vi.mocked(factory.create).mockResolvedValueOnce(fakeSession("independent"));
    const fresh = await service.create({
      name: "fresh", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Independent" },
    });
    const independent = service.run(fresh.id);
    await vi.waitFor(() => expect(service.getRun(independent.id).state).toBe("succeeded"));
    expect(runs.map((run) => service.getRun(run.id).state))
      .toEqual(["running", ...Array.from({ length: 5 }, () => "queued")]);
    for (const run of runs) {
      await vi.waitFor(() => expect(service.getRun(run.id).state).toBe("running"));
      await session.abort();
      expect((await service.waitForRun(run.id)).state).toBe("succeeded");
    }
    expect(session.systemInputs.map((input) => input.origin)).toEqual(runs.map((run) =>
      expect.objectContaining({ runId: run.id })));
  });

  it("cancels a session waiter promptly without letting later arrivals pass its predecessor", async () => {
    const { service, session } = setup(hangingSession("shared"));
    onTestFinished(() => service.stop());
    const task = await service.create({
      name: "serial", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Work" },
    });
    const first = service.run(task.id, null, "agent");
    await vi.waitFor(() => expect(session.systemInputs).toHaveLength(1));
    const middle = service.run(task.id, null, "agent");
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.cancel(middle.id);
    await vi.waitFor(() => expect(service.getRun(middle.id)).toMatchObject({ state: "cancelled", startedAt: null }));
    const third = service.run(task.id, null, "agent");
    const fourth = service.run(task.id, null, "agent");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.systemInputs).toHaveLength(1);
    expect(service.getRun(third.id).state).toBe("queued");
    for (const run of [first, third, fourth]) {
      await vi.waitFor(() => expect(service.getRun(run.id).state).toBe("running"));
      expect(session.systemInputs.at(-1)?.origin).toMatchObject({ runId: run.id });
      await session.abort();
      expect((await service.waitForRun(run.id)).state).toBe("succeeded");
    }
  });

  it("leaves a session wait outside the timeout, which the waiter's own turn arms", async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const { service, session } = setup(hangingSession("shared"));
    onTestFinished(() => service.stop());
    const task = await service.create({
      name: "serial timeout", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: session.id }, prompt: "Work" },
      timeoutSeconds: 3600,
    });
    const first = service.run(task.id, null, "agent");
    await vi.waitFor(() => expect(session.systemInputs).toHaveLength(1));
    // The waiter's own revision carries the short budget; the run holding the
    // session keeps the long one.
    await service.update(task.id, { ...task, timeoutSeconds: 1 });
    const waiter = service.run(task.id, null, "agent");
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.getRun(waiter.id)).toMatchObject({ state: "queued", startedAt: null, error: null });
    expect(service.getRun(first.id).state).toBe("running");
    expect(session.systemInputs).toHaveLength(1);
    await session.abort();
    expect((await service.waitForRun(first.id)).state).toBe("succeeded");
    await vi.waitFor(() => expect(session.systemInputs).toHaveLength(2));
    await session.abort();
    expect(await service.waitForRun(waiter.id)).toMatchObject({ state: "succeeded", error: null });
  });

  it("starts a run held behind a full slot table long past its timeout", async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const { cwd, service, factory } = setup();
    onTestFinished(() => service.stop());
    const sessions: ReturnType<typeof hangingSession>[] = [];
    vi.mocked(factory.create).mockImplementation(async () => {
      const session = hangingSession(`worker-${sessions.length}`);
      sessions.push(session);
      return session;
    });
    const agentAction = { type: "agent" as const, session: { mode: "fresh" as const, cwd }, prompt: "Work" };
    const blocker = await service.create({
      name: "slot filler", trigger: { type: "manual" }, action: agentAction, timeoutSeconds: 3600,
    });
    const impatient = await service.create({
      name: "queued behind", trigger: { type: "manual" }, action: agentAction, timeoutSeconds: 1,
    });
    const filling = Array.from({ length: 6 }, () => service.run(blocker.id, null, "agent"));
    await vi.waitFor(() => expect(filling.map((run) => service.getRun(run.id).state))
      .toEqual(Array.from({ length: 6 }, () => "running")));
    const waiter = service.run(impatient.id, null, "agent");
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.getRun(waiter.id)).toMatchObject({ state: "queued", startedAt: null, error: null });
    await sessions[0]!.abort();
    expect((await service.waitForRun(filling[0]!.id)).state).toBe("succeeded");
    await vi.waitFor(() => expect(service.getRun(waiter.id).state).toBe("running"));
    await sessions.at(-1)!.abort();
    expect(await service.waitForRun(waiter.id)).toMatchObject({ state: "succeeded", error: null });
  });

  it("never resolves or starts an agent cancelled immediately after enqueue", async () => {
    const { cwd, service, factory, session } = setup();
    const task = await service.create({
      name: "pre-cancelled", trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Work" },
    });
    const run = service.run(task.id);
    service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({ state: "cancelled", startedAt: null });
    expect(factory.create).not.toHaveBeenCalled();
    expect(factory.resume).not.toHaveBeenCalled();
    expect(session.systemInputs).toHaveLength(0);
  });

  it.each([
    { mode: "fresh", resolveBeforeCancel: false },
    { mode: "reuse", resolveBeforeCancel: false },
    { mode: "fresh", resolveBeforeCancel: true },
  ] as const)("cancels slow $mode resolution, resolve before cancel: $resolveBeforeCancel", async ({ mode, resolveBeforeCancel }) => {
    const { cwd, service, session, factory, store } = setup();
    onTestFinished(() => service.stop());
    const dispose = vi.spyOn(session, "dispose");
    let resolve = (_session: AgentSession): void => {};
    const slow = new Promise<AgentSession>((done) => { resolve = done; });
    const resolveSession = vi.mocked(mode === "fresh" ? factory.create : factory.resume);
    resolveSession.mockReturnValueOnce(slow);
    const task = await service.create({
      name: "slow resolve", trigger: { type: "manual" },
      action: { type: "agent", session: mode === "fresh" ? { mode, cwd } : { mode, sessionId: session.id }, prompt: "Work" },
    });
    const run = service.run(task.id);
    await vi.waitFor(() => expect(resolveSession).toHaveBeenCalledTimes(1));
    if (resolveBeforeCancel) resolve(session);
    service.cancel(run.id);
    await vi.waitFor(() => expect(service.getRun(run.id)).toMatchObject({ state: "cancelled", startedAt: null }));
    if (mode === "fresh") store.saveRun({ ...service.getRun(run.id), callbackState: "abandoned", callbackAttempts: 8 });
    resolve(session);
    await new Promise<void>((done) => setImmediate(done));
    expect(session.systemInputs).toHaveLength(0);
    expect(service.getRun(run.id)).toMatchObject({ state: "cancelled", startedAt: null });
    if (mode === "fresh") {
      expect(service.getRun(run.id)).toMatchObject({ targetSessionId: session.id, callbackState: "abandoned", callbackAttempts: 8 });
      expect(store.taskOwnedSessionIds().has(session.id)).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
    } else expect(dispose).not.toHaveBeenCalled();
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
    const { cwd, parent, child, service } = supervised();
    child.setState("streaming");
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
    expect(service.getRunView(run.id).pendingDecisionId).toBe(receipt.id);
    await expect(service.tool({ operation: "recover", run_id: run.id, reason: "lost the result" }, parent.id))
      .rejects.toThrow(/decision/);

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

  it("holds a reply undelivered until the continuation that carries it starts", async () => {
    const rig = supervised();
    rig.service.start(20);
    onTestFinished(() => rig.service.stop());
    const { run, question } = await askedAndFinished(rig);

    const reply = await rig.service.tool({
      operation: "reply",
      message_id: question.id,
      message: "Use API A",
    }, rig.parent.id) as TaskMessage;
    // Creating the continuation is not delivering: its prompt is the only copy
    // of the text, and a restart or a cancel before it starts loses it.
    expect(reply).toMatchObject({ kind: "reply", state: "pending", deliveredAt: null });
    expect(reply.resumeRunId).toBeDefined();
    expect(rig.service.getRun(reply.resumeRunId!).resumedFromRunId).toBe(run.id);

    // `startedAt` is written one statement before the prompt reaches the
    // session, so it is the proof: handed to the run that reports for it.
    await vi.waitFor(() => expect(rig.service.listMessages(run.id)
      .find((m) => m.id === reply.id)).toMatchObject({ state: "delivered" }));
    expect(rig.service.getRun(reply.resumeRunId!).startedAt).toBeTruthy();
    expect(rig.child.systemInputs.at(-1)?.text).toContain("Use API A");
    // ...and the sweep never *also* injects it: that would be a second copy of
    // the same text, starting a turn no run owns.
    expect(rig.child.systemInputs.filter((input) => input.origin.kind === "task-message")).toEqual([]);
  });

  it("reports a reply whose continuation was cancelled before it started, to both ends", async () => {
    const rig = supervised();
    const errors = new Map<string, string[]>([[rig.parent.id, []], [rig.child.id, []]]);
    for (const [id, sink] of errors) {
      rig.hub.subscribe(id, (event) => { if (event.type === "error") sink.push(event.message); });
    }
    rig.service.start(20);
    onTestFinished(() => rig.service.stop());
    const { run, question } = await askedAndFinished(rig);

    // The child is busy with something else, so the continuation sits queued.
    rig.child.setState("streaming");
    const reply = await rig.service.tool({
      operation: "reply",
      message_id: question.id,
      message: "Use API A",
    }, rig.parent.id) as TaskMessage;
    expect(rig.service.getRun(reply.resumeRunId!).startedAt).toBeNull();
    // Sweeps while it waits must leave it alone: re-injecting it would put a
    // second copy of the resume prompt's text into the child and start a turn
    // no run owns.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(rig.service.listMessages(run.id).find((m) => m.id === reply.id)?.state).toBe("pending");
    expect(rig.child.systemInputs.filter((input) => input.origin.kind === "task-message")).toEqual([]);

    rig.service.cancel(reply.resumeRunId!);

    // Nothing will ever carry the text now, so the sweep says so rather than
    // retrying to a ceiling four minutes away — on both ends (§5).
    await vi.waitFor(() => expect(rig.service.listMessages(run.id).find((m) => m.id === reply.id))
      .toMatchObject({ state: "expired", error: expect.stringContaining(reply.resumeRunId!) }));
    for (const [, sink] of errors) {
      expect(sink.some((message) => message.includes("cancelled before it started"))).toBe(true);
    }
    expect(rig.child.systemInputs.filter((input) => input.origin.kind === "task-message")).toEqual([]);
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
    await vi.waitFor(() => expect(service.getRun(queued.runId).callbackState).toBe("delivered"));
    const run = await service.tool({ operation: "recover", run_id: queued.runId, reason: "result was lost from context" }, "s1") as RunSummary;
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

  it("runs a prompt shorthand in the caller's directory with a name from the prompt", async () => {
    const { cwd, service } = setup();
    mkdirSync(join(cwd, "sub"));
    const summary = await service.tool({
      operation: "run",
      prompt: "## Review the **auth** module\nLook at src/auth for injection risks.",
    }, "s1") as RunSummary;
    expect(summary.taskName).toBe("Review the auth module");
    expect(service.get(summary.taskId)).toMatchObject({
      kind: "subagent",
      action: { type: "agent", session: { mode: "fresh", cwd }, prompt: expect.stringContaining("injection") },
    });

    // Relative cwd resolves against the caller; a long first line is cut, not dropped.
    const long = `${"word ".repeat(20).trim()}`;
    const nested = await service.tool({ operation: "run", prompt: long, cwd: "sub" }, "s1") as RunSummary;
    expect(service.get(nested.taskId).action).toMatchObject({ session: { cwd: join(cwd, "sub") } });
    expect(nested.taskName.length).toBe(60);
    expect(nested.taskName.endsWith("…")).toBe(true);

    // The same defaults inside a full draft: no cwd means the caller's.
    const full = await service.tool({
      operation: "run",
      task: { action: { type: "agent", session: { mode: "fresh" }, prompt: "Plain" } },
    }, "s1") as RunSummary;
    expect(service.get(full.taskId)).toMatchObject({ name: "Plain", action: { session: { cwd } } });

    // Fan-out members may be bare prompts.
    const group = await service.tool({ operation: "run", tasks: ["angle a", { prompt: "angle b", cwd: "./sub" }] }, "s1") as GroupSummary;
    expect(group.members.map((m) => m.taskName)).toEqual(["angle a", "angle b"]);

    await expect(service.tool({ operation: "run", prompt: "x", task: { name: "y", action: { type: "bash", cwd, script: "true" } } }, "s1"))
      .rejects.toThrow("either prompt or task");
    await expect(service.tool({ operation: "run", prompt: "x", cwd: "missing" }, "s1"))
      .rejects.toThrow("working directory does not exist");
    // A caller Pier cannot place has no directory to resolve against.
    await expect(service.tool({ operation: "run", prompt: "x" }, "nobody"))
      .rejects.toThrow("no working directory");
  });

  it("takes timeoutSeconds from the prompt shorthand, defaulting to an hour", async () => {
    const { service } = setup();
    const long = await service.tool({ operation: "run", prompt: "Slow work", timeoutSeconds: 7200 }, "s1") as RunSummary;
    expect(service.get(long.taskId).timeoutSeconds).toBe(7200);
    const plain = await service.tool({ operation: "run", prompt: "Ordinary work" }, "s1") as RunSummary;
    expect(service.get(plain.taskId).timeoutSeconds).toBe(3600);
    // Same boundary as the draft form, not a second range.
    await expect(service.tool({ operation: "run", prompt: "x", timeoutSeconds: 86_401 }, "s1"))
      .rejects.toThrow("timeoutSeconds must be between 1 and 86400");
  });

  it("takes timeoutSeconds from a tasks[] entry", async () => {
    const { service } = setup();
    const group = await service.tool({
      operation: "run",
      tasks: [{ prompt: "patient member", timeoutSeconds: 7200 }, "default member"],
    }, "s1") as GroupSummary;
    expect(group.members.map((m) => service.get(m.taskId).timeoutSeconds)).toEqual([7200, 3600]);
    await expect(service.tool({
      operation: "run",
      tasks: [{ prompt: "x", timeoutSeconds: 0 }, "y"],
    }, "s1")).rejects.toThrow("timeoutSeconds must be between 1 and 86400");
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

  it.each(["cancel", "timeout"] as const)("keeps %s terminal when a bash TERM trap cleans up and exits zero", async (operation) => {
    const { cwd, service } = setup();
    const task = await service.create({
      ...bashDraft(cwd, "trap 'echo cleaned; exit 0' TERM; echo ready > ready; sleep 3"),
      timeoutSeconds: 1,
    });
    const run = service.run(task.id);
    onTestFinished(async () => {
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    if (operation === "cancel") service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({
      state: operation === "timeout" ? "failed" : "cancelled",
      error: operation === "timeout" ? "task timed out" : "cancelled",
      result: { type: "bash", exitCode: 0, stdout: "cleaned\n" },
    });
  });

  it("keeps a requested cancellation when TERM grace crosses the task timeout", async () => {
    const { cwd, service } = setup();
    const task = await service.create({
      // No children, and bounded even if SIGKILL regresses.
      ...bashDraft(cwd, "trap '' TERM; echo ready > ready; while (( SECONDS < 4 )); do :; done"),
      timeoutSeconds: 1,
    });
    const run = service.run(task.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    onTestFinished(async () => {
      clearTimeout(timer);
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    timer = setTimeout(() => service.cancel(run.id), Math.max(0, run.queuedAt + 900 - Date.now()));
    expect(await service.waitForRun(run.id)).toMatchObject({ state: "cancelled", error: "cancelled" });
  });

  it("does not succeed when cancellation leaves a watch probe unmatched", async () => {
    const { cwd, service } = setup();
    const task = await service.create({
      ...bashDraft(cwd, "echo unexpected > action"),
      trigger: {
        type: "watch", cwd, intervalSeconds: 60, mode: "repeat",
        script: "trap 'exit 1' TERM; echo ready > ready; sleep 3",
      },
    });
    const run = service.run(task.id);
    onTestFinished(async () => {
      service.stop();
      await service.waitForRun(run.id);
      rmSync(cwd, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
    service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({
      state: "cancelled", error: "cancelled", matched: false, probe: { exitCode: 1 },
    });
    expect(existsSync(join(cwd, "action"))).toBe(false);
  });

  it("fails a run whose turn died on the provider, instead of reporting 'no reply'", async () => {
    const outage = '503 {"error":{"message":"Upstream service overloaded"},"type":"error"}';
    const { service, session } = setup(outageSession("s1", outage));
    const task = await service.create({
      name: "review",
      trigger: { type: "manual" },
      action: { type: "agent", session: { mode: "reuse", sessionId: "s1" }, prompt: "Review the PR" },
    });
    const queued = await service.tool({ operation: "run", task_id: task.id }, "s1") as RunSummary;
    const run = await service.waitForRun(queued.runId);
    // "succeeded" with "no reply" is the same answer as an agent that chose to
    // stay silent — the caller cannot tell an outage from a decision (§5).
    expect(run.state).toBe("failed");
    expect(run.error).toContain("Upstream service overloaded");
    expect(run.result).toBeNull();

    // And the agent that delegated it is told, in the words the provider used.
    await vi.waitFor(() => expect(service.getRun(run.id).callbackState).toBe("delivered"));
    expect(session.systemInputs.at(-1)?.text).toContain("state: failed");
    expect(session.systemInputs.at(-1)?.text).toContain("Upstream service overloaded");
  });

  it("runs paused tasks on demand and lists a task's run history", async () => {
    const { cwd, service } = setup();
    const task = await service.create(bashDraft(cwd, "echo paused"));
    // enabled:false pauses scheduling only — manual and agent triggers still fire.
    service.setEnabled(task.id, false);
    const run = await service.waitForRun(service.run(task.id).id);
    expect(run.state).toBe("succeeded");

    const history = service.listRuns(task.id);
    expect(history.map((row) => row.id)).toEqual([run.id]);
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

  it("observes cancellation reentered from a child's queued event", async () => {
    const { cwd, service, hub } = setup();
    const childTask = await service.create(bashDraft(cwd, "sleep 1"));
    const parentTask = await service.create({ name: "parent", action: { type: "task", taskId: childTask.id } });
    const unsubscribe = hub.subscribeWorkspace((event) => {
      if (event.type !== "task-run-changed") return;
      const run = service.getRun(event.runId);
      if (run.parentRunId && run.state === "queued") service.cancel(run.parentRunId);
    });
    onTestFinished(() => { unsubscribe(); service.stop(); });
    const parent = service.run(parentTask.id);
    expect(await service.waitForRun(parent.id)).toMatchObject({ state: "cancelled" });
    const child = service.listRuns(childTask.id)[0]!;
    expect(await service.waitForRun(child.id)).toMatchObject({ state: "cancelled" });
  });

  it("cancels a run while its final history read is stalled", async () => {
    const { cwd, service, session } = setup(fakeSession("history", ""));
    session.history = vi.fn(() => new Promise<ChatTurn[]>(() => {}));
    const task = await service.create({ name: "history", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "Work" } });
    const run = service.run(task.id);
    await vi.waitFor(() => expect(session.history).toHaveBeenCalled());
    service.cancel(run.id);
    expect(await service.waitForRun(run.id)).toMatchObject({ state: "cancelled", error: "cancelled" });
  });

  it.each(["ignore", "reject", "throw"] as const)("releases the slot when a hung session's abort will %s", async (abortMode) => {
    const { cwd, service, factory } = setup();
    // A session that ignores its abort: systemInput never settles.
    const deaf = fakeSession("deaf");
    deaf.systemInput = async (text, origin, mode) => {
      deaf.systemInputs.push({ text, origin, mode });
      await new Promise<void>(() => {});
    };
    deaf.abort = () => {
      if (abortMode === "throw") throw new Error("fixture abort threw");
      return abortMode === "reject" ? Promise.reject(new Error("fixture abort rejected")) : Promise.resolve();
    };
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
    // Our cancellable wait settles even though the SDK turn never does.
    expect((await service.waitForRun(first.id)).state).toBe("cancelled");
    // …and the slot is free again: a second run on the same task succeeds.
    const second = await service.waitForRun(service.run(task.id).id);
    expect(second.state).toBe("succeeded");
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
    const fetched = await service.tool({ operation: "recover", group_id: group.groupId, reason: "group results were lost from context" }, "s1") as GroupSummary;
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
    skewClock()(1100);
    service.start(50);
    await vi.waitFor(() => expect(service.getRun(first.runId).callbackState).toBe("delivered"));
    expect(service.getRun(second.runId).callbackState).toBe("delivered");
    expect(session.systemInputs).toHaveLength(before + 1);
    expect(session.systemInputs.at(-1)!.origin).toMatchObject({
      kind: "task-callback",
      runIds: expect.arrayContaining([first.runId, second.runId]) as unknown,
    });
    // Several runs in one input: the first one's name and model as the card's
    // caption would attribute the others' results to it, so the batch carries
    // no provenance at all — the text names every run it contains.
    expect(session.systemInputs.at(-1)!.origin.source).toBeUndefined();
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

});

describe("task admission and delivery regressions", () => {
  it("keeps all live Activity runs when newer history exceeds the page limit", async () => {
    const { cwd, service, store, factory, router } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    const now = Date.now();
    for (let i = 0; i < 240; i++) store.saveRun(storedRun(`live-${i}`, task, now - 2 * 86_400_000 + i, {
      state: i % 2 ? "queued" : "running", finishedAt: null, result: null,
      invokedBySessionId: "supervisor", targetSessionId: "worker",
    }));
    for (let i = 0; i < 210; i++) store.saveRun(storedRun(`done-${i}`, task, now - 2000 + i));
    for (let i = 0; i < 260; i++) store.saveRun(storedRun(`probe-${i}`, task, now - 1000 + i, { matched: false }));
    const app = new Hono(); registerTaskRoutes(app, service, { factory, router });
    const active = await (await app.request("/api/activity")).json();
    expect(active.runs).toHaveLength(240);
    expect(new Set(active.sessions.map((s: { id: string }) => s.id))).toEqual(new Set(["supervisor", "worker"]));
    const recent = await (await app.request("/api/activity?scope=recent")).json();
    expect(recent.runs).toHaveLength(440);
    const ids = new Set(recent.runs.map((run: TaskRun) => run.id));
    expect(ids.size).toBe(440);
    for (let i = 0; i < 240; i++) expect(ids.has(`live-${i}`)).toBe(true);
    expect(ids.has("done-209")).toBe(true);
    expect(ids.has("done-0")).toBe(false);
    expect(recent.runs.some((run: TaskRun) => run.matched === false)).toBe(false);
  });

  it.each(["all", "first"] as const)("rejects an entire %s group before creating sessions or starting scripts", async (joinMode) => {
    const { cwd, service, store, factory, hub, session } = setup();
    onTestFinished(() => { service.stop(); rmSync(cwd, { recursive: true, force: true }); });
    const good = await service.create(bashDraft(cwd, "echo ran > marker"));
    const archived = await service.create(bashDraft(cwd, "true"));
    service.archive(archived.id);
    const changed: string[] = [];
    hub.subscribeWorkspace((event) => {
      if (event.type === "task-run-changed" || event.type === "task-group-changed") changed.push(event.type);
    });
    const saves = vi.spyOn(store, "saveGroup");
    await expect(service.tool({ operation: "run", join: joinMode, tasks: [
      { prompt: "work", cwd }, { task_id: good.id }, { task_id: archived.id },
    ] }, "s1")).rejects.toThrow("archived tasks cannot run");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(factory.create).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "marker"))).toBe(false);
    expect(store.queryRuns({ showUnmatched: true }).runs).toEqual([]);
    expect(store.listOpenGroups()).toEqual([]);
    expect(saves).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
    service.start(60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.systemInputs).toEqual([]);
  });

  it("rolls back admitted siblings when a group exceeds the root's child limit", async () => {
    const { cwd, service, store, factory } = setup();
    const task = await service.create({ name: "member", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "work" } });
    store.saveRun(storedRun("root", task, 1, { rootRunId: "root", state: "running", targetSessionId: "s1" }));
    for (let i = 0; i < 15; i++) store.saveRun(storedRun(`child-${i}`, task, i + 2, {
      parentRunId: "root", rootRunId: "root", depth: 1,
    }));
    await expect(service.tool({ operation: "run", tasks: [{ task_id: task.id }, { task_id: task.id }] }, "s1"))
      .rejects.toThrow("child limit");
    expect(store.listRunsByRoot("root", 100)).toHaveLength(16);
    expect(store.listOpenGroups()).toEqual([]);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("does not execute a group when persisting a later member fails", async () => {
    const { cwd, service, store, factory } = setup();
    const task = await service.create({ name: "member", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "work" } });
    const save = store.saveRun.bind(store);
    let attempts = 0;
    vi.spyOn(store, "saveRun").mockImplementation((run) => {
      save(run);
      if (++attempts === 2) throw new Error("fixture disk failure");
    });
    expect(() => service.runGroup([task, task], "all", "s1", null, "s1", "followUp"))
      .toThrow("fixture disk failure");
    expect(store.queryRuns({ showUnmatched: true }).runs).toEqual([]);
    expect(store.listOpenGroups()).toEqual([]);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("settles a group consisting entirely of overlap skips", async () => {
    const { cwd, service, store } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    store.saveRun(storedRun("already-going", task, 1, { state: "running" }));
    const { group, runs } = service.runGroup([task, task], "all", "s1", null, null, "followUp");
    expect(runs.map((run) => run.state)).toEqual(["skipped", "skipped"]);
    expect(group.finishedAt).not.toBeNull();
    expect(group.memberRunIds).toEqual(runs.map((run) => run.id));
    expect(store.listOpenGroups()).toEqual([]);
  });

  it("keeps first-join's any-terminal rule when a member is skipped for overlap", async () => {
    const { cwd, service, store, factory } = setup();
    const busy = await service.create(bashDraft(cwd, "true"));
    store.saveRun(storedRun("already-going", busy, 1, { state: "running" }));
    const worker = await service.create({ name: "worker", action: { type: "agent", session: { mode: "fresh", cwd }, prompt: "work" } });
    const { group, runs } = service.runGroup([worker, busy], "first", "s1", null, null, "followUp");
    expect(group.winnerRunId).toBe(runs[1]!.id);
    expect(runs[1]!.state).toBe("skipped");
    expect(await service.waitForRun(runs[0]!.id)).toMatchObject({ state: "cancelled" });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it.each(["all", "first"] as const)("retires a legacy empty %s group with an error instead of a fake completion", async (joinMode) => {
    const { service, store, hub, session } = setup();
    const errors: string[] = [];
    hub.subscribe("s1", (event) => { if (event.type === "error") errors.push(event.message); });
    store.saveGroup({ id: "empty", join: joinMode, invokedBySessionId: "s1", callbackSessionId: "s1",
      memberRunIds: [], winnerRunId: null, createdAt: 1, finishedAt: null,
      callbackState: null, callbackAttempts: 0, callbackError: null, callbackNextAttemptAt: null });
    service.start(60_000);
    onTestFinished(() => service.stop());
    expect(store.getGroup("empty")).toMatchObject({ callbackState: "abandoned", finishedAt: expect.any(Number) });
    expect(store.listOpenGroups()).toEqual([]);
    expect(errors.join(" ")).toContain("admission failed");
    expect(session.systemInputs).toEqual([]);
  });

  it.each(["paused", "save"] as const)("keeps a decision answerable when continuation admission fails: %s", async (failure) => {
    const rig = supervised();
    const { service, store, hub, parent, child } = rig;
    const { run, question, task } = await askedAndFinished(rig);
    await vi.waitFor(() => expect(store.getMessage(question.id)?.state).toBe("delivered"));
    const before = child.systemInputs.length;
    const changes: string[] = [];
    hub.subscribeWorkspace((event) => changes.push(event.type));
    const save = store.saveMessage.bind(store);
    const injected = vi.spyOn(store, "saveMessage").mockImplementation((message) => {
      save(message);
      if (failure === "save" && message.resumeRunId) throw new Error("fixture reply save failed");
    });
    if (failure === "paused") service.pause();
    await expect(service.tool({ operation: "reply", message_id: question.id, message: "Use A" }, parent.id))
      .rejects.toThrow(failure === "paused" ? "restarting" : "fixture reply save failed");
    expect(store.getMessage(question.id)).toMatchObject({ state: "delivered", answeredAt: null });
    expect(service.openDecisionId(run.id)).toBe(question.id);
    expect(service.listMessages(run.id).filter((m) => m.kind === "reply")).toEqual([]);
    expect(service.listRuns(task.id)).toHaveLength(1);
    expect(child.systemInputs).toHaveLength(before);
    expect(changes).toEqual([]);
    injected.mockRestore();
    service.unpause(60_000);
    onTestFinished(() => service.stop());
    const reply = await service.tool({ operation: "reply", message_id: question.id, message: "Use A" }, parent.id) as TaskMessage;
    expect(reply.resumeRunId).toBeDefined();
    expect(await service.waitForRun(reply.resumeRunId!)).toMatchObject({ state: "succeeded", resumedFromRunId: run.id });
    await vi.waitFor(() => expect(service.getRun(reply.resumeRunId!).callbackState).toBe("delivered"));
    const repeated = await service.tool({ operation: "reply", message_id: question.id, message: "Use A" }, parent.id) as TaskMessage;
    expect(repeated.id).toBe(reply.id);
    expect(service.listRuns(task.id)).toHaveLength(2);
    expect(child.systemInputs).toHaveLength(before + 1);
  });

  it("rolls back a manual continuation when superseding its decision cannot be saved", async () => {
    const rig = supervised();
    const { service, store, child } = rig;
    const { run, question, task } = await askedAndFinished(rig);
    await vi.waitFor(() => expect(store.getMessage(question.id)?.state).toBe("delivered"));
    const before = child.systemInputs.length;
    const save = store.saveMessage.bind(store);
    const injected = vi.spyOn(store, "saveMessage").mockImplementation((message) => {
      save(message);
      if (message.state === "expired") throw new Error("fixture decision save failed");
    });
    expect(() => service.resume(run.id, "continue without the question")).toThrow("fixture decision save failed");
    expect(store.getMessage(question.id)?.state).toBe("delivered");
    expect(service.listRuns(task.id)).toHaveLength(1);
    expect(child.systemInputs).toHaveLength(before);
    injected.mockRestore();
    const resumed = service.resume(run.id, "continue without the question");
    expect(await service.waitForRun(resumed.id)).toMatchObject({ state: "succeeded" });
    expect(store.getMessage(question.id)?.state).toBe("expired");
  });

  it("refuses an edit archived while its draft was still being validated", async () => {
    const { cwd, service } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    // Parked on the draft's directory check; archiving lands before it returns.
    const edit = service.update(task.id, bashDraft(cwd, "echo edited"));
    service.archive(task.id);
    await expect(edit).rejects.toThrow("archived tasks cannot be edited");
    expect(service.get(task.id)).toMatchObject({ archived: true, enabled: false, nextRunAt: null, revision: 1 });
  });

  it.each(["reject", "throw", "proof"] as const)("charges one callback attempt when delivery fails after send: %s", async (failure) => {
    const { cwd, service, store, router, session } = setup();
    const task = await service.create(bashDraft(cwd, "true"));
    const run = storedRun("result", task, 1, { callbackSessionId: "s1", callbackState: "pending" });
    store.saveRun(run);
    const send = vi.spyOn(session, "systemInput").mockImplementation(() => {
      if (failure === "throw") throw new Error("fixture synchronous refusal");
      return failure === "reject" ? Promise.reject(new Error("fixture refused")) : Promise.resolve();
    });
    let reads = 0;
    session.history = async () => {
      if (failure === "proof" && ++reads % 2 === 0) throw new Error("fixture proof read failed");
      return [];
    };
    const unreachable = vi.fn();
    const callbacks = new TaskCallbacks(store, router, () => {}, unreachable);
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      await callbacks.deliver(run);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(attempt);
      expect(store.getRun(run.id)).toMatchObject({
        callbackAttempts: attempt, callbackState: attempt === MAX_DELIVERY_ATTEMPTS ? "abandoned" : "failed",
      });
    }
    expect(unreachable).toHaveBeenCalledTimes(1);
    await callbacks.deliver(run);
    expect(send).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
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

  it("exposes steer, message history, wait, and resume over HTTP", async () => {
    const { service, session } = setup();
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
    // A session policy that is not a mode at all is refused by the parser, not
    // stored and run into the runner.
    const invalid = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "http fork",
        trigger: { type: "manual" },
        action: { type: "agent", session: { mode: "fork" }, prompt: "Use context" },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("agent session policy required");

    // Nor as a run-time override: silently ignoring it would run the stored
    // policy — on a reuse definition, into a live session.
    const overridden = await app.request(`/api/tasks/${task.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionMode: "fork", sourceSessionId: "owner" }),
    });
    expect(overridden.status).toBe(400);
    expect(await overridden.text()).toContain("unsupported sessionMode");
  });
});

describe("owned system actions", () => {
  const draft = (name = "config-sync") => ({
    name: "Configuration sync",
    trigger: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" },
    action: { type: "system", name },
  });
  const instance = (handler: (signal: AbortSignal) => Promise<string>) => ({
    modelMenu: () => [], systemActions: { "config-sync": handler },
  });

  it("reconciles by owner, preserves scheduling policy, and runs in process", async () => {
    const handler = vi.fn(async () => "Applied revision 2");
    const { service, factory } = setup(fakeSession(), instance(handler));
    const task = await service.create(draft(), "config-sync");
    expect(task).toMatchObject({ creator: "config-sync", revision: 1, enabled: true });
    expect(task.nextRunAt).not.toBeNull();
    const updated = await service.update(task.id, { ...draft(), enabled: false }, "config-sync");
    expect(updated).toMatchObject({ id: task.id, revision: 2, enabled: false, nextRunAt: null });
    service.start(60_000);
    onTestFinished(() => service.stop());
    expect(service.get(task.id)).toMatchObject({ enabled: false, nextRunAt: null });
    // Disabled only suspends scheduling; the owning Settings action still runs it.
    const done = await service.waitForRun(service.run(task.id).id);
    expect(done).toMatchObject({ state: "succeeded", result: { type: "system", text: "Applied revision 2" }, error: null });
    expect(done.startedAt).not.toBeNull();
    expect(handler).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(factory.create).not.toHaveBeenCalled();
    expect(factory.resume).not.toHaveBeenCalled();
    expect(service.get(task.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(service.setEnabled(task.id, true, "config-sync").nextRunAt).not.toBeNull();
    expect(service.archive(task.id, "config-sync")).toMatchObject({ enabled: false, archived: true, nextRunAt: null });
  });

  it("rejects HTTP, tool and inline spoofing while preserving owner guards", async () => {
    const handler = vi.fn(async () => "applied");
    const { cwd, service } = setup(fakeSession(), instance(handler));
    const app = new Hono();
    registerTaskRoutes(app, service);
    const task = await service.create(draft(), "config-sync");
    const publicTask = await service.create(bashDraft(cwd, "echo public"));
    const spoofed = { ...draft(), creator: "config-sync", by: "config-sync", id: task.id };
    for (const creator of ["http", "session:s1", "other"]) {
      await expect(service.create(draft(), creator)).rejects.toThrow(/trusted owner/);
    }
    for (const name of ["unknown", "toString", "__proto__"]) {
      await expect(service.create(draft(name), name)).rejects.toThrow(/unregistered/);
    }
    for (const name of ["http", "session:s1"]) {
      const rig = setup(fakeSession(), { modelMenu: () => [], systemActions: { [name]: handler } });
      await expect(rig.service.create(draft(name), name)).rejects.toThrow(/trusted owner/);
    }
    for (const [method, url] of [["POST", "/api/tasks"], ["PATCH", `/api/tasks/${task.id}`], ["PATCH", `/api/tasks/${publicTask.id}`]]) {
      const response = await app.request(url!, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(spoofed),
      });
      expect(response.status).toBe(400);
    }
    for (const operation of ["create", "run"]) {
      await expect(service.tool({ operation, task: { ...spoofed, trigger: { type: "manual" } }, creator: "config-sync" }, "s1")).rejects.toThrow(/trusted owner/);
      await expect(service.tool({ operation, task: { ...draft("unknown"), trigger: { type: "manual" } } }, "s1")).rejects.toThrow(/trusted owner/);
    }
    await expect(service.tool({ operation: "update", task_id: task.id, task: bashDraft(cwd, "echo spoof"), by: "config-sync" }, "s1")).rejects.toThrow(/reconciled by Pier/);
    await expect(service.tool({ operation: "update", task_id: publicTask.id, task: spoofed }, "s1")).rejects.toThrow(/trusted owner/);
    await expect(service.update(publicTask.id, draft(), "config-sync")).rejects.toThrow(/trusted owner/);
    await expect(service.update(task.id, draft(), "other")).rejects.toThrow(/reconciled by Pier/);
    await expect(service.update(task.id, draft("unknown"), "config-sync")).rejects.toThrow(/trusted owner/);
    for (const route of ["pause", "resume", "archive"]) {
      expect((await app.request(`/api/tasks/${task.id}/${route}`, { method: "POST" })).status).toBe(400);
    }
    expect(service.get(task.id)).toEqual(task);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports handler errors through the persisted run and HTTP", async () => {
    const { service } = setup(fakeSession(), instance(async () => { throw new Error("apply failed"); }));
    const task = await service.create(draft(), "config-sync");
    const done = await service.waitForRun(service.run(task.id).id);
    expect(done).toMatchObject({ state: "failed", error: "Error: apply failed", result: null });
    const app = new Hono();
    registerTaskRoutes(app, service);
    expect(await (await app.request(`/api/task-runs/${done.id}`)).json()).toMatchObject({ state: "failed", error: "Error: apply failed" });
  });

  it.each(["cancel", "timeout", "stop"] as const)("observes %s even when the cooperative handler resolves after abort", async (operation) => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const handler = vi.fn((signal: AbortSignal) => new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted work"), { once: true });
    }));
    const { service } = setup(fakeSession(), instance(handler));
    onTestFinished(() => service.stop());
    const task = await service.create({ ...draft(), timeoutSeconds: 1 }, "config-sync");
    const run = service.run(task.id);
    expect(service.getRun(run.id).state).toBe("running");
    expect(service.activeRunCount()).toBe(1);
    expect(service.run(task.id)).toMatchObject({ state: "skipped", skipReason: "overlap" });
    if (operation === "cancel") service.cancel(run.id);
    else if (operation === "stop") service.stop();
    else await vi.advanceTimersByTimeAsync(1000);
    const done = await service.waitForRun(run.id);
    expect(handler.mock.calls[0]![0].aborted).toBe(true);
    expect(done).toMatchObject({
      state: operation === "timeout" ? "failed" : "cancelled",
      error: operation === "timeout" ? "task timed out" : "cancelled",
      result: null,
    });
    expect(service.activeRunCount()).toBe(0);
  });

  it("recovers interrupted runs without replay and fails observably when registration is missing", async () => {
    const handler = vi.fn(async () => "applied");
    const { store, factory, router, hub, service } = setup(fakeSession(), instance(handler));
    const task = await service.create(draft(), "config-sync");
    const now = Date.now();
    store.saveRun(storedRun("interrupted-system", task, now, { state: "running", result: null, finishedAt: null }));
    const restarted = new TaskService(store, factory, router, hub);
    restarted.start(60_000);
    onTestFinished(() => restarted.stop());
    expect(restarted.getRun("interrupted-system")).toMatchObject({ state: "interrupted", error: "Pier restarted while the run was active" });
    expect(restarted.get(task.id)).toMatchObject({ enabled: true, creator: "config-sync" });
    expect(restarted.get(task.id).nextRunAt).toBeGreaterThan(now);
    const app = new Hono();
    registerTaskRoutes(app, restarted);
    const response = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });
    const { runId } = await response.json() as { runId: string };
    expect(await restarted.waitForRun(runId)).toMatchObject({ state: "failed", error: "Error: unregistered system action: config-sync" });
    const toolRun = await restarted.tool({ operation: "run", task_id: task.id, callback: "none" }, "s1") as RunSummary;
    expect(await restarted.waitForRun(toolRun.runId)).toMatchObject({ state: "failed", error: "Error: unregistered system action: config-sync" });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["http", "session:s1", "other"])("does not invoke a registered handler for a persisted definition owned by %s", async (creator) => {
    const handler = vi.fn(async () => "applied");
    const { service, store } = setup(fakeSession(), instance(handler));
    const task = await service.create(draft(), "config-sync");
    store.saveTask({ ...task, creator });
    const app = new Hono();
    registerTaskRoutes(app, service);
    const response = await app.request(`/api/tasks/${task.id}/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: "config-sync", action: draft().action }),
    });
    const { runId } = await response.json() as { runId: string };
    expect(await service.waitForRun(runId)).toMatchObject({ state: "failed", error: expect.stringContaining("trusted owner") });
    const toolRun = await service.tool({ operation: "run", task_id: task.id, callback: "none", creator: "config-sync" }, "s1") as RunSummary;
    expect(await service.waitForRun(toolRun.runId)).toMatchObject({ state: "failed", error: expect.stringContaining("trusted owner") });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a definition Pier's own code created", () => {
  // The bug this test exists for: the tools update task was reconciled at boot
  // and before every switch-triggered run, and an HTTP or task-tool edit in
  // between still changed what the CRON run executed — while the switch went
  // on saying Pier keeps the tools current.
  it("is reconciled by its owner and edited, paused or archived by neither surface", async () => {
    const { cwd, service } = setup();
    const app = new Hono();
    registerTaskRoutes(app, service);
    // Created the way main.ts creates the tools update task.
    const owned = await service.create(bashDraft(cwd, "echo tools sync"), "tools");
    const mine = await service.create(bashDraft(cwd, "echo hi"));
    const json = (body: unknown) => ({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const patched = await app.request(`/api/tasks/${owned.id}`, json(bashDraft(cwd, "echo something else")));
    expect(patched.status).toBe(400);
    expect(await patched.json()).toMatchObject({ error: expect.stringContaining("reconciled by Pier") });
    for (const route of ["pause", "resume", "archive"]) {
      expect((await app.request(`/api/tasks/${owned.id}/${route}`, { method: "POST" })).status).toBe(400);
    }
    // The other way in: the task tool, which has no owner to name either.
    await expect(service.tool({
      operation: "update",
      task_id: owned.id,
      task: bashDraft(cwd, "echo something else"),
    }, "s1")).rejects.toThrow(/reconciled by Pier/);

    // Nothing moved: same script, still enabled, still not archived.
    expect(service.get(owned.id)).toMatchObject({
      enabled: true,
      archived: false,
      action: { script: "echo tools sync" },
    });
    // Running it is not editing it — that is what a flipped switch does.
    expect((await service.waitForRun(service.run(owned.id).id)).state).toBe("succeeded");
    // A task a person wrote is nobody's but theirs.
    expect((await app.request(`/api/tasks/${mine.id}/pause`, { method: "POST" })).status).toBe(200);

    // And the owner reconciles it, which is the whole point of the exception.
    const repaired = await service.update(owned.id, bashDraft(cwd, "echo repaired"), "tools");
    expect(repaired.action).toMatchObject({ script: "echo repaired" });
    expect(service.archive(owned.id, "tools").archived).toBe(true);
  });

  // The bug this test exists for: the guard is reachable from *inside* the
  // task layer too. A one-shot watch retires itself after a successful run,
  // and with no owner named that mutation was refused — so an owned task
  // failed immediately after succeeding.
  it("still retires itself when it is a one-shot watch, however it was created", async () => {
    const { cwd, service } = setup();
    const once = await service.create({
      ...bashDraft(cwd, "echo fixed"),
      name: "owned one-shot",
      trigger: { type: "watch", cwd, script: "exit 0", intervalSeconds: 60, mode: "once" },
    }, "tools");
    const run = await service.waitForRun(service.run(once.id).id);
    expect(run.state).toBe("succeeded");
    expect(run.error).toBeNull();
    expect(service.get(once.id).enabled).toBe(false);
  });
});
