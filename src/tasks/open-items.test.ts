// The open items: main's markers, written only from the head's turn ends, and
// joined to the run ledger into the one text `/status` and the seed show.

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { EventHub } from "../core/hub.js";
import { agoLabel } from "../core/reply.js";
import { Router } from "../core/router.js";
import { fakeSession } from "../core/session.testkit.js";
import { NOT_IN_LEDGER, type AgentFactory, type LedgerRun, type TaskRunState } from "../core/types.js";
import { openItems, openItemsStatus, type OpenItemReads } from "./open-items.js";
import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import type { TaskRun } from "./types.js";

const MIN = 60_000;
const run = (runId: string, over: Partial<LedgerRun> = {}): LedgerRun =>
  ({ runId, name: runId, state: "running", targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null, ...over });

function rig({
  runs = [] as LedgerRun[] | ((ids: string[], since: number) => LedgerRun[]),
  leads = [] as string[],
  workers = [] as { invokedBySessionId: string; state: TaskRunState }[],
  runSessions = {} as Record<string, string>,
} = {}) {
  const db = openDb(":memory:");
  const store = new TaskStore(db);
  const now = Date.now();
  const ledger: { ids: string[]; since: number }[] = [];
  const workerReads: string[][] = [];
  const reads: OpenItemReads = {
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs(ids, since) : runs;
    },
    store: {
      openItems: () => store.openItems(),
      getRun: (id) => (runSessions[id] ? { targetSessionId: runSessions[id] } as TaskRun : undefined),
      leads: () => new Map(leads.map((id) => [id, { phase: "build" as const, runId: `c-${id}`, runLive: false, designOpen: false }])),
      ledgerRuns: (ids) => {
        workerReads.push(ids);
        return workers.filter((w) => ids.includes(w.invokedBySessionId)) as TaskRun[];
      },
    },
  };
  const router = new Router(new EventHub(), () => Promise.reject(new Error("no session")));
  const item = (problem: string, stage: string, runIds: string[], updatedAt: number) =>
    db.prepare("INSERT INTO open_items VALUES (?, ?, ?, ?)").run(problem, stage, JSON.stringify(runIds), updatedAt);
  const list = (members = ["h1"], designs: LedgerRun[] = []) => openItems(reads, router, members, designs, now);
  return { now, ledger, workerReads, router, item, list };
}

describe("the open items", () => {
  it("joins each run token through the ledger: found, gone, and a lead with its workers", () => {
    let now = 0;
    const r = rig({
      leads: ["lead1"],
      workers: [{ invokedBySessionId: "lead1", state: "running" }, { invokedBySessionId: "lead1", state: "succeeded" }],
      runs: () => [run("1prwmabcdef", { name: "lead open items", targetSessionId: "lead1", queuedAt: now - 23 * MIN })],
    });
    now = r.now;
    r.item("open items 视图", "lead designing", ["1prwmabcdef"], 2);
    r.item("model menu 重选", "merged, restart pending", ["gone1"], 1);
    const open = r.list();
    expect(open.items.map((i) => i.problem)).toEqual(["model menu 重选", "open items 视图"]);
    expect(open.items[0]!.runs).toEqual([{ runId: "gone1", name: "gone1", state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }]);
    expect(open.items[1]!.runs[0]!.workers).toEqual({ queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 });
    expect(open.unlisted).toEqual([]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: now - 86_400_000 }]);
    expect(r.workerReads).toEqual([["lead1"]]);
    expect(openItemsStatus(open, now).text).toBe([
      "Waiting on you",
      "- model menu 重选 — merged, restart pending (waiting on you) · run gone1 — not in the ledger",
      "In progress",
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
      "Waiting on you",
      "- the problem (waiting on you) · run r-named failed just now",
      "In progress",
      "- Build it — not on the list (running) · run r-live running 5m",
      "- Next — not on the list (queued) · run r-queued queued 1m",
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
    expect(openItemsStatus(open, now).text).toBe("In progress\n- status 归并 — lead building (running) · run k4k3jz55 running 2m");
  });

  // The status is the runs' and sessions', whatever the stage text says.
  it("reads an item running while its session streams, though its run has finished, and pending release once idle", () => {
    let now = 0;
    const r = rig({ runs: () => [run("r1", { targetSessionId: "lead1", state: "succeeded", finishedAt: now - MIN })] });
    now = r.now;
    r.item("fix", "lead building (running)", ["r1"], 1);
    expect(r.list().items[0]!.status).toBe("pending release");
    const lead = fakeSession("lead1");
    r.router.attach({ channelId: "task", conversationId: "lead1" }, lead);
    lead.setState("streaming");
    expect(r.list().items[0]!.status).toBe("running");
  });

  // A design lead's turn ends on the user; until it reports `Design final:` it is theirs to decide.
  it("lists the designs no item holds after the items, waiting on the user, each linking its session from `/status`", () => {
    const design = run("d1abcdefgh", { name: "Rail redesign", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const r = rig();
    r.item("model menu", "merged", [], 1);
    const status = openItemsStatus(r.list(["h1"], [design]), r.now);
    expect(status.text).toBe([
      "Waiting on you",
      "- model menu — merged (waiting on you)",
      `- Rail redesign (waiting on you) · run d1abcdef… succeeded ${agoLabel(0, r.now)}`,
    ].join("\n"));
    expect(status.sessions).toEqual({ d1abcdefgh: "s-d1" });
  });

  // One session is one row: an item or an in-flight run holding a design's session stands for it.
  it("never lists a session twice: a design under its item, or under its live run", () => {
    let now = 0;
    const d1 = run("d1", { name: "多入口统一对话", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const d2 = run("d2", { name: "Rail", state: "succeeded", targetSessionId: "s-d2", finishedAt: 0 });
    const r = rig({ runs: () => [
      run("t1", { name: "子任务 thread", state: "succeeded", targetSessionId: "s-d1", finishedAt: now - 11 * MIN }),
      run("t2", { name: "Rail again", targetSessionId: "s-d2", queuedAt: now - MIN }),
    ] });
    now = r.now;
    r.item("子任务 thread", "design lead narrowing scope (running)", ["t1"], 1);
    const open = r.list(["h1"], [d1, d2]);
    expect(open.items.map((i) => [i.problem, i.status])).toEqual([["子任务 thread", "waiting on you"]]);
    expect(open.unlisted.map((u) => u.runId)).toEqual(["t2"]);
    expect(openItemsStatus(open, now).text).toBe([
      "Waiting on you",
      "- 子任务 thread — design lead narrowing scope (running) (waiting on you) · run t1 succeeded 11m ago",
      "In progress",
      "- Rail again — not on the list (running) · run t2 running 1m",
    ].join("\n"));
  });

  it("reads every shown lead's workers in one ledger read, three leads or one", () => {
    const r = rig({
      leads: ["l1", "l2", "l3"],
      workers: [
        { invokedBySessionId: "l1", state: "running" },
        { invokedBySessionId: "l2", state: "failed" },
        { invokedBySessionId: "l3", state: "queued" },
        { invokedBySessionId: "l3", state: "succeeded" },
      ],
      runs: () => [
        run("a", { targetSessionId: "l1" }),
        run("b", { targetSessionId: "l2" }),
        run("c", { targetSessionId: "l3", state: "queued" }),
        run("d", { targetSessionId: "not-a-lead" }),
      ],
    });
    r.item("first", "", ["a"], 2);
    r.item("second", "", ["b"], 1);
    const open = r.list();
    expect(r.workerReads).toEqual([["l2", "l1", "l3"]]);
    expect(open.items.map((i) => i.runs[0]!.workers)).toEqual([
      { queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0, interrupted: 0, skipped: 0 },
      { queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 },
    ]);
    expect(open.unlisted.map((u) => [u.runId, u.workers])).toEqual([
      ["c", { queued: 1, running: 0, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 }],
      ["d", undefined],
    ]);
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
