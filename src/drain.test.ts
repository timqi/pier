// The drain's promises: nothing new starts, everything running gets its
// window, and what the deadline cuts off reaches the chat at the next boot —
// never silently (§5).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "./db.js";
import { deliverLedger, drainForRestart, RestartLedger, type DrainDeps } from "./drain.js";
import type { AgentSession, ConversationKey } from "./core/types.js";

function busySession(id: string, queued: string[] = [], hang: "abort" | null = null) {
  const calls: string[] = [];
  const session = {
    id,
    state: "streaming" as const,
    pendingQueue: () => {
      calls.push("pendingQueue");
      return Promise.resolve({ steering: queued, followUp: [] });
    },
    abort: () => {
      calls.push("abort");
      return hang === "abort" ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
  return { session: session as unknown as AgentSession, calls };
}

function deps(
  busy: () => { session: AgentSession; key: ConversationKey; sending?: true }[],
  runs: () => number,
  attached: () => { session: AgentSession; key: ConversationKey }[] = () => busy().filter((b) => !b.sending),
): { deps: DrainDeps; ledger: RestartLedger; calls: string[] } {
  const ledger = new RestartLedger(openDb(":memory:"));
  const calls: string[] = [];
  return {
    ledger,
    calls,
    deps: {
      router: { beginDrain: () => calls.push("beginDrain"), busy, attachedSessions: attached },
      tasks: { pause: () => calls.push("pause"), activeRunCount: runs },
      ledger,
    },
  };
}

describe("drainForRestart", () => {
  it("returns after one poll when nothing is running, after gating new work", async () => {
    const rig = deps(() => [], () => 0);
    await drainForRestart(rig.deps, 1000, 1);
    expect(rig.calls).toEqual(["beginDrain", "pause"]);
    expect(rig.ledger.list()).toEqual([]);
  });

  it("ledgers an idle attached session's queue — the runtime is its only home", async () => {
    const idle = busySession("s1", ["first", "second"]);
    Object.assign(idle.session, { state: "idle" });
    const key = { channelId: "slack" as const, conversationId: "42" };
    const rig = deps(() => [], () => 0, () => [{ session: idle.session, key }]);
    await drainForRestart(rig.deps, 1000, 1);
    // Nothing was running: the queue is snapshotted, never aborted.
    expect(idle.calls).toEqual(["pendingQueue"]);
    expect(rig.ledger.list()).toEqual([
      expect.objectContaining({ conversationId: "42", note: expect.stringContaining("> first\n> second") }),
    ]);
  });

  it("waits for a running turn and a task run to settle", async () => {
    const turn = busySession("s1");
    let polls = 0;
    const rig = deps(
      () => (polls < 2 ? [{ session: turn.session, key: { channelId: "slack", conversationId: "C1:t1" } }] : []),
      () => (polls++ < 3 ? 1 : 0),
    );
    await drainForRestart(rig.deps, 5000, 1);
    // Settled on its own: nothing was aborted, nothing owed to the chat.
    expect(turn.calls).toEqual([]);
    expect(rig.ledger.list()).toEqual([]);
  });

  it("deadline aborts IM turns into the ledger, queue texts included", async () => {
    const turn = busySession("s1", ["queued question"]);
    const rig = deps(
      () => [{ session: turn.session, key: { channelId: "slack", conversationId: "42" } }],
      () => 0,
    );
    await drainForRestart(rig.deps, 0, 1);
    expect(turn.calls).toEqual(["pendingQueue", "abort"]);
    const entries = rig.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ channelId: "slack", conversationId: "42" });
    expect(entries[0]!.note).toContain("restarted before this turn finished");
    expect(entries[0]!.note).toContain("queued question");
  });

  it("waits for an answer still going out, and owns up to one the deadline cuts off", async () => {
    const idle = busySession("s1");
    Object.assign(idle.session, { state: "idle" });
    const sending = { session: idle.session, key: { channelId: "slack", conversationId: "C1:t1" }, sending: true as const };
    let polls = 0;
    const rig = deps(() => (polls++ < 2 ? [sending] : []), () => 0);
    await drainForRestart(rig.deps, 5000, 1);
    expect(polls).toBeGreaterThan(2); // not "nothing running" on the first poll
    expect(rig.ledger.list()).toEqual([]);
    const late = deps(() => [sending], () => 0);
    await drainForRestart(late.deps, 0, 1);
    // Nothing to abort: the turn is over, only its delivery is in doubt.
    expect(idle.calls).toEqual([]);
    expect(late.ledger.list()).toEqual([
      expect.objectContaining({ conversationId: "C1:t1", note: expect.stringContaining("may have arrived incomplete") }),
    ]);
  });

  it("deadline aborts a web turn without a ledger entry — its transcript shows it", async () => {
    const turn = busySession("s1");
    const rig = deps(
      () => [{ session: turn.session, key: { channelId: "web", conversationId: "s1" } }],
      () => 0,
    );
    await drainForRestart(rig.deps, 0, 1);
    expect(turn.calls).toContain("abort");
    expect(rig.ledger.list()).toEqual([]);
  });

  it("a hung abort cannot hold the deadline hostage — the note is already written", async () => {
    const turn = busySession("s1", [], "abort");
    const rig = deps(
      () => [{ session: turn.session, key: { channelId: "slack", conversationId: "42" } }],
      () => 0,
    );
    // Resolves despite abort() never settling, because the cleanup bound answers.
    await drainForRestart(rig.deps, 0, 1, 5);
    expect(rig.ledger.list()).toHaveLength(1);
  });

  it("all hung sessions share one cleanup window", async () => {
    vi.useFakeTimers();
    try {
      const first = busySession("s1", [], "abort");
      const second = busySession("s2", [], "abort");
      const rig = deps(
        () => [
          { session: first.session, key: { channelId: "lark", conversationId: "1" } },
          { session: second.session, key: { channelId: "slack", conversationId: "2" } },
        ],
        () => 0,
      );
      const draining = drainForRestart(rig.deps, 0, 1, 10);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.calls).toContain("abort");
      expect(second.calls).toContain("abort");
      await vi.advanceTimersByTimeAsync(10);
      await draining;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deliverLedger", () => {
  it("delivers an entry once and removes it", async () => {
    const ledger = new RestartLedger(openDb(":memory:"));
    ledger.record({ channelId: "slack", conversationId: "C1:t1", note: "cut off" });
    const notify = vi.fn().mockResolvedValue(true);
    await deliverLedger(ledger, notify);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "C1:t1" }));
    await deliverLedger(ledger, notify);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry of a platform that is not running for the next start", async () => {
    const ledger = new RestartLedger(openDb(":memory:"));
    ledger.record({ channelId: "slack", conversationId: "a", note: "n" });
    const notify = vi.fn().mockResolvedValue(false);
    await deliverLedger(ledger, notify);
    expect(ledger.list()).toHaveLength(1);
    // The adapter came up (a Console unlock, say): now it goes out and clears.
    notify.mockResolvedValue(true);
    await deliverLedger(ledger, notify);
    expect(ledger.list()).toEqual([]);
  });

  it("keeps a thrown notify for the next delivery attempt", async () => {
    const ledger = new RestartLedger(openDb(":memory:"));
    ledger.record({ channelId: "slack", conversationId: "b", note: "n" });
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(true);
    await deliverLedger(ledger, notify);
    expect(ledger.list()).toHaveLength(1);
    await deliverLedger(ledger, notify);
    expect(ledger.list()).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

// A real process boundary is essential here: the dying runner must not get a
// chance to settle its in-memory execution controllers after boot recovery.
// Only the AgentSession and outbound transport are fakes; no Pi is imported.
const processScript = `
  import assert from "node:assert/strict";
  import { once } from "node:events";
  import { join } from "node:path";
  import { openDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)};
  import { drainForRestart, deliverLedger, RestartLedger } from ${JSON.stringify(new URL("./drain.ts", import.meta.url).href)};
  import { EventHub } from ${JSON.stringify(new URL("./core/hub.ts", import.meta.url).href)};
  import { Router } from ${JSON.stringify(new URL("./core/router.ts", import.meta.url).href)};
  import { TaskService } from ${JSON.stringify(new URL("./tasks/service.ts", import.meta.url).href)};
  import { TaskStore } from ${JSON.stringify(new URL("./tasks/store.ts", import.meta.url).href)};
  const mode = process.argv[1];
  // Keep IPC alive like the real HTTP listener while unref cleanup timers run.
  process.on("message", () => {});
  const db = openDb(join(process.env.PIER_HOME, "db", "pier.db"));
  const ledger = new RestartLedger(db);
  const store = new TaskStore(db);
  const hub = new EventHub();
  const inputs = [];
  const notes = [];
  const sessions = [];
  const send = (message) => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  function session(id) {
    const started = deferred();
    const turn = deferred();
    const listeners = new Set();
    const emit = event => listeners.forEach(fn => fn(event));
    const s = {
      id, state: "idle", model: undefined, thinkingLevel: "off",
      setCacheRetention() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      history: async () => inputs,
      pendingQueue: async () => ({ steering: id === "source" ? ["queued question"] : [], followUp: [] }),
      abort: async () => {
        if (id === "source") {
          // The durable note must exist before a hung abort can prevent exit.
          assert.equal(ledger.list().length, 1);
          await send({ phase: "aborting", ledger: ledger.list() });
        }
        await new Promise(() => {});
      },
      systemInput: async (text, origin) => {
        if (origin.kind === "task-callback") {
          inputs.push({ role: "system", text, origin });
          emit({ type: "system-input", text, origin });
          return;
        }
        s.state = "streaming";
        started.resolve();
        await turn.promise;
        emit({ type: "turn-end", text: "finished naturally" });
        s.state = "idle";
        emit({ type: "state", state: "idle" });
      },
      started: started.promise, finish: () => turn.resolve(),
    };
    sessions.push(s);
    return s;
  }
  const parent = session("parent");
  const factory = {
    availableModels: async () => [], list: async () => [], find: async () => undefined,
    create: async () => session("worker-" + sessions.length),
    resume: async id => { assert.equal(id, "parent"); return parent; },
  };
  const router = new Router(hub, key => factory.resume(key.conversationId));
  router.registerChannel({ id: "slack", notify: async (id, note) => notes.push({ id, ...note }), send: async () => {} });
  router.attach({ channelId: "slack", conversationId: "parent-thread" }, parent);
  const tasks = new TaskService(store, factory, router, hub);
  if (mode.startsWith("recover")) {
    const recovered = deferred();
    const complete = () => {
      if (store.queryRuns({ showUnmatched: true }).runs.every(run => run.state === "interrupted" &&
          (!run.callbackSessionId || run.callbackState === "delivered")) && store.listOpenGroups().length === 0) recovered.resolve();
    };
    const unsubscribe = hub.subscribeWorkspace(complete);
    tasks.start(60_000);
    complete();
    await recovered.promise;
    unsubscribe();
    const attempted = [];
    await deliverLedger(ledger, async entry => {
      attempted.push(entry);
      if (mode === "recover-fail") throw new Error("fixture outbound unavailable");
      notes.push({ id: entry.conversationId, text: entry.note });
      return true;
    });
    await send({ phase: "recovered", runs: store.queryRuns({ showUnmatched: true }).runs, inputs, notes, attempted, ledger: ledger.list() });
  } else {
    tasks.start(60_000);
    const task = await tasks.create({ name: "worker", action: {
      type: "agent", session: { mode: "fresh", cwd: process.env.HOME }, prompt: "work",
    } });
    const root = tasks.run(task.id, null, "agent", null, { callbackSessionId: "parent" });
    // Factory creation is asynchronous, so the production workspace event is
    // the readiness signal, not a sleep or a guessed microtask count.
    const running = deferred();
    const unsubscribe = hub.subscribeWorkspace(() => {
      if (tasks.getRun(root.id).state === "running") running.resolve();
    });
    if (tasks.getRun(root.id).state === "running") running.resolve();
    await running.promise;
    unsubscribe();
    await sessions[1].started;
    if (mode === "deadline") {
      const source = session("source");
      source.state = "streaming";
      router.attach({ channelId: "slack", conversationId: "source-thread" }, source);
      // Six slots total: the root plus five members run, the sixth member
      // is durably queued. The unfinished join must be evaluated at next boot.
      tasks.runGroup([task, task, task, task, task, task], "all", "parent", "parent", "followUp");
    }
    const beginDrain = once(process, "message");
    await send({ phase: "ready", rootId: root.id });
    await beginDrain;
    let drained = false;
    const draining = drainForRestart({ router, tasks, ledger }, mode === "deadline" ? 0 : 10_000, 1, 20)
      .then(() => { drained = true; });
    assert.throws(() => tasks.run(task.id), /restarting/);
    await assert.rejects(router.dispatch({ key: { channelId: "slack", conversationId: "parent-thread" },
      senderId: "test", text: "new root input", mode: "auto" }), /restarting/);
    if (mode === "graceful") {
      const child = tasks.run(task.id, null, "task", root.id);
      const childRunning = deferred();
      const unsub = hub.subscribeWorkspace(() => {
        if (tasks.getRun(child.id).state === "running") childRunning.resolve();
      });
      if (tasks.getRun(child.id).state === "running") childRunning.resolve();
      await childRunning.promise;
      unsub();
      await sessions[2].started;
      sessions[1].finish();
      await tasks.waitForRun(root.id);
      const finishChild = once(process, "message");
      await send({ phase: "child-running", active: tasks.activeRunCount(), drained, notes });
      await finishChild;
      sessions[2].finish();
      await tasks.waitForRun(child.id);
    }
    await draining;
    await send({ phase: "drained", runs: store.queryRuns({ showUnmatched: true }).runs, ledger: ledger.list() });
  }
  // Like main shutdown(false), do not cancel task runs at a drain deadline.
  tasks.pause();
  db.close();
  process.disconnect();
`;

function restartProcess(home: string, mode: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", processScript, mode], {
    // Whitelist, not an inherited environment: no credentials or agent paths.
    env: { PATH: process.env.PATH, HOME: home, PIER_HOME: home, PIER_LOG: "warn" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("message", (message) => messages.push(message as Record<string, unknown>));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child, exited, stderr: () => stderr,
    async phase(name: string) {
      await vi.waitFor(() => {
        expect(child.exitCode, stderr).not.toBe(1);
        expect(messages.some(message => message.phase === name), stderr).toBe(true);
      }, { timeout: 5000, interval: 5 });
      return messages.find(message => message.phase === name)!;
    },
  };
}

describe("restart process boundaries", () => {
  function home() {
    const dir = mkdtempSync(join(tmpdir(), "pier-drain-process-"));
    // Vitest runs these hooks in reverse registration order: child exit first.
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("gates root work while an existing run creates and finishes its child", async () => {
    const process = restartProcess(home(), "graceful");
    await process.phase("ready");
    process.child.send("drain");
    const busy = await process.phase("child-running");
    expect(busy).toMatchObject({ active: 1, drained: false });
    expect(busy.notes).toContainEqual(expect.objectContaining({ text: expect.stringContaining("message was not taken") }));
    process.child.send("finish child");
    const drained = await process.phase("drained");
    expect(drained.ledger).toEqual([]);
    expect(drained.runs).toEqual([
      expect.objectContaining({ state: "succeeded", parentRunId: expect.any(String) }),
      expect.objectContaining({ state: "succeeded", parentRunId: null }),
    ]);
    expect(await process.exited).toEqual({ code: 0, signal: null });
  });

  it.each(["deadline", "crash"])("recovers interrupted runs and an unfinished join after %s", { timeout: 15_000 }, async (ending) => {
    const dir = home();
    const first = restartProcess(dir, "deadline");
    await first.phase("ready");
    if (ending === "crash") {
      first.child.kill("SIGKILL");
      expect(await first.exited).toEqual({ code: null, signal: "SIGKILL" });
    } else {
      first.child.send("drain");
      expect((await first.phase("aborting")).ledger).toEqual([
        expect.objectContaining({ conversationId: "source-thread", note: expect.stringContaining("queued question") }),
      ]);
      const drained = await first.phase("drained");
      expect(drained.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: "queued" }), expect.objectContaining({ state: "running" }),
      ]));
      expect(await first.exited).toEqual({ code: 0, signal: null });
    }
    const second = restartProcess(dir, "recover-fail");
    const recovered = await second.phase("recovered");
    expect(await second.exited).toEqual({ code: 0, signal: null });
    expect(recovered.runs).toEqual(Array.from({ length: 7 }, () => expect.objectContaining({ state: "interrupted" })));
    expect(recovered.inputs).toHaveLength(2); // root callback plus one group, never member callbacks
    expect(recovered.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "parent-thread", text: expect.stringContaining("state: interrupted") }),
      expect.objectContaining({ id: "parent-thread", text: expect.stringContaining("Task group finished") }),
    ]));
    expect(recovered.ledger).toHaveLength(ending === "deadline" ? 1 : 0);
    if (ending === "deadline") expect(second.stderr()).toContain("fixture outbound unavailable");
    const third = restartProcess(dir, "recover-ok");
    const retried = await third.phase("recovered");
    expect(await third.exited).toEqual({ code: 0, signal: null });
    expect(retried.inputs).toEqual([]); // delivered rows stay settled on another boot
    expect(retried.ledger).toEqual([]);
    expect(retried.attempted).toHaveLength(ending === "deadline" ? 1 : 0);
    if (ending === "deadline") expect(retried.notes).toContainEqual(expect.objectContaining({
      id: "source-thread", text: expect.stringContaining("queued question"),
    }));
  });
});
