// The stop's promises: every running turn is on disk before its abort, the
// exit delivers and deletes nothing, and the boot resumes each turn in its
// session or tells its chat why it could not — never silently (§5).

import { describe, expect, it, vi } from "vitest";
import { openDb } from "./db.js";
import { EventHub } from "./core/hub.js";
import { restartInput, restartQueued } from "./core/reply.js";
import { Router } from "./core/router.js";
import { fakeSession, type FakeSession } from "./core/session.testkit.js";
import type { AgentSession, Channel, ConversationKey } from "./core/types.js";
import {
  deliverLedger, RestartLedger, resumeTurns, stopForExit, trackTurns, TurnsInFlight,
  type ResumeDeps, type StopDeps,
} from "./stop.js";

const KEY = { channelId: "slack", conversationId: "C1/1.2" };

function rig() {
  const db = openDb(":memory:");
  const hub = new EventHub();
  const sessions = new Map<string, FakeSession>();
  const router = new Router(hub, (key) => {
    const session = sessions.get(key.conversationId);
    return session ? Promise.resolve(session) : Promise.reject(new Error("no such session"));
  });
  const sent: string[] = [];
  const channel: Channel = {
    id: "slack",
    start: () => Promise.resolve(),
    send: (conversationId) => { sent.push(conversationId); return Promise.resolve(); },
    notify: () => Promise.resolve(),
    openThread: () => Promise.resolve(""),
    editRoot: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  router.registerChannel(channel);
  const turns = new TurnsInFlight(db);
  const ledger = new RestartLedger(db);
  trackTurns(router, hub, turns);
  const stopDeps = (over: Partial<StopDeps> = {}): StopDeps => ({
    closeInbound: () => Promise.resolve(), router, turns, ledger, tasks: { activeRunCount: () => 0 }, ...over,
  });
  return { db, router, turns, ledger, sent, stopDeps };
}

/** Its pending-queue reads recorded beside its abort, so order is visible. */
function watched(id: string, queued: string[] = []): FakeSession {
  const session = fakeSession(id, { queue: { steering: queued } });
  const snapshot = session.pendingQueue;
  session.pendingQueue = () => {
    session.calls.push("pendingQueue");
    return snapshot();
  };
  return session;
}

describe("turns in flight", () => {
  it("records a turn as it starts and retires it once idle", () => {
    const { router, turns } = rig();
    const session = watched("s1");
    router.attach(KEY, session);
    session.setState("streaming");
    expect(turns.list()).toEqual([{ sessionId: "s1", key: KEY, queued: [], at: expect.any(Number) }]);
    session.setState("idle");
    expect(turns.list()).toEqual([]);
  });

  it("keeps the queue a stop wrote when the resumed turn starts", () => {
    const { turns } = rig();
    turns.record("s1", KEY, ["later"], 5);
    turns.record("s1", KEY, null, 9);
    expect(turns.list()).toEqual([{ sessionId: "s1", key: KEY, queued: ["later"], at: 9 }]);
    // A later stop's snapshot is the queue now, even an empty one.
    turns.record("s1", KEY, [], 12);
    expect(turns.list()).toEqual([{ sessionId: "s1", key: KEY, queued: [], at: 12 }]);
  });
});

describe("stopForExit", () => {
  it("writes a running turn's queue before aborting it, and keeps the row", async () => {
    const { router, turns, stopDeps } = rig();
    const session = watched("s1", ["queued question"]);
    router.attach(KEY, session);
    session.setState("streaming");
    await stopForExit(stopDeps(), "SIGTERM", 50);
    expect(session.calls).toEqual(["pendingQueue", "abort"]);
    expect(session.state).toBe("idle");
    // The abort's idle is not a turn end: the resume owns the row.
    expect(turns.list()).toEqual([{ sessionId: "s1", key: KEY, queued: ["queued question"], at: expect.any(Number) }]);
  });

  it("delivers no turn end once stopping", async () => {
    const { router, turns, sent, stopDeps } = rig();
    const session = watched("s1");
    router.attach(KEY, session);
    session.setState("streaming");
    await stopForExit(stopDeps(), "SIGTERM", 50);
    session.emit({ type: "turn-end", text: "late answer" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(turns.list()).toHaveLength(1);
  });

  it("records an idle session's queue without aborting it, and leaves an empty one alone", async () => {
    const { router, turns, stopDeps } = rig();
    const queued = watched("s1", ["first", "second"]);
    const empty = watched("s2");
    router.attach(KEY, queued);
    router.attach({ channelId: "web", conversationId: "s2" }, empty);
    await stopForExit(stopDeps(), "SIGTERM", 50);
    expect(queued.calls).toEqual(["pendingQueue"]);
    expect(empty.calls).toEqual(["pendingQueue"]);
    expect(turns.list()).toEqual([{ sessionId: "s1", key: KEY, queued: ["first", "second"], at: expect.any(Number) }]);
  });

  it("owns up to a send the budget cut off", async () => {
    const { ledger, stopDeps } = rig();
    const session = fakeSession("s1");
    const busy = () => [{ session, key: KEY, sending: true as const }];
    const router = { stopping: () => {}, attachedSessions: () => [], busy };
    await stopForExit(stopDeps({ router }), "SIGTERM", 20);
    expect(ledger.list()).toEqual([
      expect.objectContaining({ conversationId: KEY.conversationId, note: expect.stringContaining("may have arrived incomplete") }),
    ]);
  });

  it("writes no note for a send that finishes inside the budget", async () => {
    const { ledger, stopDeps } = rig();
    const session = fakeSession("s1");
    let polls = 0;
    const busy = () => (polls++ < 2 ? [{ session, key: KEY, sending: true as const }] : []);
    await stopForExit(stopDeps({ router: { stopping: () => {}, attachedSessions: () => [], busy } }), "SIGTERM", 1000);
    expect(ledger.list()).toEqual([]);
  });

  it("a hung seam cannot outlast the budget — the row is already written", async () => {
    vi.useFakeTimers();
    try {
      const { router, turns, stopDeps } = rig();
      const session = watched("s1");
      session.abort = () => new Promise<void>(() => {});
      const hung = watched("s2");
      hung.pendingQueue = () => new Promise(() => {});
      router.attach(KEY, session);
      router.attach({ channelId: "web", conversationId: "s2" }, hung);
      session.setState("streaming");
      hung.setState("streaming");
      let done = false;
      const stopped = stopForExit(stopDeps({ closeInbound: () => new Promise(() => {}) }), "SIGTERM", 100)
        .then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(100);
      await stopped;
      expect(done).toBe(true);
      expect(turns.list().map((row) => row.sessionId).sort()).toEqual(["s1", "s2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function resumeRig(sessions: AgentSession[], over: Partial<ResumeDeps> = {}) {
  const db = openDb(":memory:");
  const turns = new TurnsInFlight(db);
  const ledger = new RestartLedger(db);
  const opened: ConversationKey[] = [];
  const reports: string[] = [];
  const deps: ResumeDeps = {
    turns, ledger,
    router: {
      ensure: (key) => {
        opened.push(key);
        const session = sessions.find((s) => s.id === key.conversationId) ?? (key.channelId === "slack" ? sessions[0] : undefined);
        return session ? Promise.resolve(session) : Promise.reject(new Error("session gone"));
      },
      reportTo: (_id, message) => reports.push(message),
    },
    live: () => true,
    resumedByRun: () => false,
    ...over,
  };
  return { turns, ledger, opened, reports, deps };
}

describe("resumeTurns", () => {
  it("prompts an idle session with the restart text, its queue included", async () => {
    const session = fakeSession("s1", { scripted: true });
    const { turns, deps, opened } = resumeRig([session]);
    turns.record("s1", KEY, ["first", "second"], 1_000);
    await resumeTurns(deps, 61_000);
    expect(opened).toEqual([KEY]);
    expect(session.systemInputs).toEqual([{
      text: restartInput(61_000, 60_000, ["first", "second"]),
      origin: { kind: "restart", at: 61_000, downMs: 60_000 },
      mode: "prompt",
    }]);
    expect(session.systemInputs[0]!.text).toContain("Messages the user sent before the restart that you had not yet seen:\n> first\n> second");
    // The resumed turn's end retires the row, not the resume.
    expect(turns.list()).toHaveLength(1);
  });

  it("gives a session a user reached first only its queue, as a follow-up", async () => {
    const session = fakeSession("s1", { scripted: true });
    session.setState("streaming");
    const { turns, deps } = resumeRig([session]);
    turns.record("s1", KEY, ["later"], 1_000);
    await resumeTurns(deps, 2_000);
    expect(session.systemInputs).toEqual([{
      text: restartQueued(["later"]),
      origin: { kind: "restart", at: 2_000, downMs: 1_000 },
      mode: "followUp",
    }]);
  });

  it("says nothing to a streaming session with nothing queued, leaving its row to its turn", async () => {
    const session = fakeSession("s1", { scripted: true });
    session.setState("streaming");
    const { turns, deps } = resumeRig([session]);
    turns.record("s1", KEY, null, 1_000);
    await resumeTurns(deps, 2_000);
    expect(session.systemInputs).toEqual([]);
    expect(turns.list()).toHaveLength(1);
  });

  it("tells the chat a turn that could not resume, queue included, and drops the row", async () => {
    const { turns, ledger, deps } = resumeRig([]);
    turns.record("gone", KEY, ["lost"], 1_000);
    await resumeTurns(deps, 2_000);
    expect(turns.list()).toEqual([]);
    expect(ledger.list()).toEqual([expect.objectContaining({
      channelId: "slack", conversationId: KEY.conversationId,
      note: "Pier restarted while answering and could not pick the answer back up (session gone) — send the message again.\nQueued and not delivered:\n> lost",
    })]);
  });

  it("logs rather than ledgers a web turn that could not resume", async () => {
    const { turns, ledger, deps } = resumeRig([]);
    turns.record("gone", { channelId: "web", conversationId: "gone" }, null, 1_000);
    await resumeTurns(deps, 2_000);
    expect(turns.list()).toEqual([]);
    expect(ledger.list()).toEqual([]);
  });

  it("leaves a running agent run's target to the run", async () => {
    const session = fakeSession("s1", { scripted: true });
    const { turns, deps, opened } = resumeRig([session], { resumedByRun: (id) => id === "s1" });
    turns.record("s1", KEY, null, 1_000);
    await resumeTurns(deps, 2_000);
    expect(opened).toEqual([]);
    expect(session.systemInputs).toEqual([]);
    expect(turns.list()).toHaveLength(1);
  });

  it("resumes a turn whose adapter is down on the session's own stream", async () => {
    const session = fakeSession("s1", { scripted: true });
    const { turns, deps, opened } = resumeRig([session], { live: () => false });
    turns.record("s1", KEY, null, 1_000);
    await resumeTurns(deps, 2_000);
    expect(opened).toEqual([{ channelId: "web", conversationId: "s1" }]);
    expect(session.systemInputs).toHaveLength(1);
  });

  it("reports a resume the session refused", async () => {
    const session = fakeSession("s1", { scripted: true });
    session.systemInput = () => Promise.reject(new Error("no model"));
    const { turns, deps, reports } = resumeRig([session]);
    turns.record("s1", KEY, null, 1_000);
    await resumeTurns(deps, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual([expect.stringContaining("no model")]);
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

