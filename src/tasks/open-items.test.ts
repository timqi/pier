// The open items: main's markers, written only from the head's turn ends, and
// joined to the run ledger into the one text `/status` and the seed show.

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { agoLabel } from "../core/reply.js";
import { Router } from "../core/router.js";
import { fakeSession } from "../core/session.testkit.js";
import type { AgentFactory, AgentRole, LedgerRun } from "../core/types.js";
import { openItems, openItemsStatus, type OpenItemReads } from "./open-items.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { NOT_IN_LEDGER, type TaskRun } from "./types.js";

const MIN = 60_000;
const run = (runId: string, over: Partial<LedgerRun> = {}): LedgerRun =>
  ({ runId, name: runId, state: "running", targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null, ...over });

function rig({
  runs = [] as LedgerRun[] | ((ids: string[], since: number) => LedgerRun[]),
  roles = {} as Record<string, AgentRole>,
  runSessions = {} as Record<string, string>,
} = {}) {
  const db = openDb(":memory:");
  const store = new TaskStore(db);
  const now = Date.now();
  const ledger: { ids: string[]; since: number }[] = [];
  const reads: OpenItemReads = {
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs(ids, since) : runs;
    },
    store: {
      openItems: () => store.openItems(),
      getRun: (id) => (runSessions[id] ? { targetSessionId: runSessions[id] } as TaskRun : undefined),
      roleOf: (id) => roles[id],
    },
  };
  const router = new Router(new EventHub(), () => Promise.reject(new Error("no session")));
  const item = (problem: string, stage: string, runIds: string[], updatedAt: number) =>
    db.prepare("INSERT INTO open_items VALUES (?, ?, ?, ?)").run(problem, stage, JSON.stringify(runIds), updatedAt);
  const list = (members = ["h1"], designs: LedgerRun[] = []) => openItems(reads, router, members, designs, now);
  return { now, ledger, router, item, list };
}

describe("the open items", () => {
  it("joins each run token through the ledger: found, gone, and a lead with its workers", () => {
    let now = 0;
    const r = rig({
      roles: { lead1: "lead" },
      runs: (ids) => ids[0] === "lead1"
        ? [run("w1"), run("w2", { state: "succeeded", finishedAt: now })]
        : [run("1prwmabcdef", { name: "lead open items", targetSessionId: "lead1", queuedAt: now - 23 * MIN })],
    });
    now = r.now;
    r.item("open items 视图", "lead designing", ["1prwmabcdef"], 2);
    r.item("model menu 重选", "merged, restart pending", ["gone1"], 1);
    const open = r.list();
    expect(open.items.map((i) => i.problem)).toEqual(["model menu 重选", "open items 视图"]);
    expect(open.items[0]!.runs).toEqual([{ runId: "gone1", name: "gone1", state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }]);
    expect(open.items[1]!.runs[0]!.workers).toEqual({ queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 });
    expect(open.unlisted).toEqual([]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: now - 86_400_000 }, { ids: ["lead1"], since: now - 86_400_000 }]);
    expect(openItemsStatus(open, now).text).toBe([
      "Open",
      "- model menu 重选 — merged, restart pending (idle) · run gone1 — not in the ledger",
      "- open items 视图 — lead designing (running) · run 1prwmabc… running 23m · workers: 1 running, 1 succeeded",
    ].join("\n"));
  });

  it("lists only the in-flight chain runs no item's session holds, never a finished one", () => {
    let now = 0;
    const r = rig({ runs: () => [
      run("r-live", { name: "Build it", queuedAt: now - 5 * MIN }),
      run("r-queued", { name: "Next", state: "queued", queuedAt: now - MIN }),
      run("r-failed", { name: "Review src/auth", state: "failed", finishedAt: now - 2 * 60 * MIN }),
      run("r-cancelled", { name: "Dropped", state: "cancelled", finishedAt: now - MIN }),
      run("r-ok", { name: "Done thing", state: "succeeded", finishedAt: now - MIN }),
      run("r-named", { name: "Named", state: "failed", finishedAt: now }),
    ] });
    now = r.now;
    r.item("the problem", "", ["r-named"], 1);
    const open = r.list();
    expect(open.unlisted.map((u) => u.runId)).toEqual(["r-live", "r-queued"]);
    // The window is the ledger's: `pier task runs`' last 24h.
    expect(r.ledger[0]!.since).toBe(now - 86_400_000);
    expect(openItemsStatus(open, now).text).toBe([
      "Open",
      "- the problem (idle) · run r-named failed just now",
      "Not on the list",
      "- Build it — running 5m",
      "- Next — queued 1m",
    ].join("\n"));
  });

  // A lead woken again (a callback turn, a follow-up run) is the same item: the item follows its session.
  it("follows an item's session to its newest run, even when the named run has left the ledger", () => {
    let now = 0;
    const r = rig({
      runSessions: { vdmj112x: "lead1" },
      runs: () => [run("k4k3jz55", { name: "lead again", targetSessionId: "lead1", queuedAt: now - 2 * MIN })],
    });
    now = r.now;
    r.item("status 归并", "lead building", ["vdmj112x"], 1);
    const open = r.list();
    expect(open.items[0]!.runs.map((x) => x.runId)).toEqual(["k4k3jz55"]);
    expect(open.unlisted).toEqual([]);
    expect(openItemsStatus(open, now).text).toBe("Open\n- status 归并 — lead building (running) · run k4k3jz55 running 2m");
  });

  it("reads an item running while its session streams, though its run has finished", () => {
    let now = 0;
    const r = rig({ runs: () => [run("r1", { targetSessionId: "lead1", state: "succeeded", finishedAt: now - MIN })] });
    now = r.now;
    r.item("fix", "lead building", ["r1"], 1);
    expect(r.list().items[0]!.live).toBe("idle");
    const lead = fakeSession("lead1");
    r.router.attach({ channelId: "task", conversationId: "lead1" }, lead);
    lead.setState("streaming");
    expect(r.list().items[0]!.live).toBe("running");
  });

  // A design lead's turn ends on the user; until it reports `Design final:` it is theirs to decide.
  it("lists the designs waiting on the user last, each linking its session from `/status`", () => {
    const design = run("d1abcdefgh", { name: "Rail redesign", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const r = rig();
    r.item("model menu", "merged", [], 1);
    const status = openItemsStatus(r.list(["h1"], [design]), r.now);
    expect(status.text).toBe([
      "Open",
      "- model menu — merged",
      "Designs for you to finalize",
      `- Rail redesign · run d1abcdef… succeeded ${agoLabel(0, r.now)}`,
    ].join("\n"));
    expect(status.sessions).toEqual({ d1abcdefgh: "s-d1" });
  });

  it("says nothing is open when nothing is, and asks no ledger before the first head", () => {
    const r = rig();
    expect(openItemsStatus(r.list([]), r.now).text).toBe("Nothing open.");
    expect(r.ledger).toEqual([]);
  });

  it("carries each named run's session with `/status`, for the card to link", () => {
    const r = rig({ runs: () => [run("r-sess", { targetSessionId: "s-r" }), run("r-none")] });
    r.item("with a session", "running", ["r-sess", "r-none", "r-gone"], 1);
    expect(openItemsStatus(r.list(), r.now).sessions).toEqual({ "r-sess": "s-r" });
  });

  it("writes the head's markers on its turn end and says so once, a restart's head and a new head alike", () => {
    const hub = new EventHub();
    const workspace: string[] = [];
    hub.subscribeWorkspace((e) => {
      if (e.type === "open-items-changed") workspace.push(e.type);
    });
    const sessions = new Map(["h0", "m1"].map((id) => [id, fakeSession(id)]));
    const router = new Router(hub, (key) => Promise.resolve(sessions.get(key.conversationId)!));
    for (const s of sessions.values()) router.attach({ channelId: "web", conversationId: s.id }, s);
    const members = ["h0"];
    const db = openDb(":memory:");
    new TaskService(new TaskStore(db), {} as AgentFactory, router, hub, {
      modelMenu: () => [],
      continuous: { chainOf: () => members, members: () => members.map((sessionId) => ({ sessionId, startedAt: 1, reason: "first" as const })) },
    });
    const end = (id: string, text: string) => sessions.get(id)!.emit({ type: "turn-end", text });
    const count = () => db.prepare("SELECT count(*) AS n FROM open_items").get();

    end("h0", "On it.\n<open>open items — worker running (run r1)</open>");
    expect(db.prepare("SELECT problem, stage, run_ids FROM open_items").all())
      .toEqual([{ problem: "open items", stage: "worker running", run_ids: '["r1"]' }]);
    expect(workspace).toEqual(["open-items-changed"]);

    // Nothing written, nothing said: no marker, a done for no item, a marker with no problem.
    end("h0", "plain <done>never open</done><open> — x</open>");
    end("h0", "");
    expect(workspace).toEqual(["open-items-changed"]);

    // A member no longer the head writes nothing.
    members.unshift("m1");
    end("h0", "<done>open items</done>");
    expect(count()).toEqual({ n: 1 });
    end("m1", "Merged.\n<open>open items — merged, restart pending</open>\n<done>open items</done>");
    expect(count()).toEqual({ n: 0 });
    expect(workspace).toEqual(["open-items-changed", "open-items-changed"]);
  });
});
