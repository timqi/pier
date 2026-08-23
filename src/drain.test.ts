// The drain's promises: nothing new starts, everything running gets its
// window, and what the deadline cuts off reaches the chat at the next boot —
// never silently (§5b).

import { describe, expect, it, vi } from "vitest";
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
  busy: () => { session: AgentSession; key: ConversationKey }[],
  runs: () => number,
): { deps: DrainDeps; ledger: RestartLedger; calls: string[] } {
  const ledger = new RestartLedger(openDb(":memory:"));
  const calls: string[] = [];
  return {
    ledger,
    calls,
    deps: {
      router: { beginDrain: () => calls.push("beginDrain"), busy },
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
      () => [{ session: turn.session, key: { channelId: "telegram", conversationId: "42" } }],
      () => 0,
    );
    await drainForRestart(rig.deps, 0, 1);
    expect(turn.calls).toEqual(["pendingQueue", "abort"]);
    const entries = rig.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ channelId: "telegram", conversationId: "42" });
    expect(entries[0]!.note).toContain("restarted before this turn finished");
    expect(entries[0]!.note).toContain("queued question");
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
      () => [{ session: turn.session, key: { channelId: "telegram", conversationId: "42" } }],
      () => 0,
    );
    // Resolves despite abort() never settling, because the seam bound answers.
    await drainForRestart(rig.deps, 0, 1, 5);
    expect(rig.ledger.list()).toHaveLength(1);
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

  it("a thrown notify is terminal — logged once, never a stale apology later", async () => {
    const ledger = new RestartLedger(openDb(":memory:"));
    ledger.record({ channelId: "telegram", conversationId: "b", note: "n" });
    const notify = vi.fn().mockRejectedValue(new Error("boom"));
    await deliverLedger(ledger, notify);
    expect(ledger.list()).toEqual([]);
  });
});
