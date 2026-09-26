// The continuous conversation's chain: which session a user message lands on,
// when a new one starts, and what the new one is told.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { MainChain, renderOpenItems } from "./chain.js";
import { agoLabel } from "./reply.js";
import { CHAIN_FULL_TOKENS as FULL, CHAIN_IDLE_MS as IDLE_MS, NOT_IN_LEDGER } from "./types.js";
import { EventHub } from "./hub.js";
import { Router } from "./router.js";
import { fakeSession, type FakeSession, type FakeSessionOptions } from "./session.testkit.js";
import type { AgentFactory, AgentLaunchOptions, AgentRole, LedgerRun } from "./types.js";

const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rig({
  runs = [] as LedgerRun[] | ((ids: string[], since: number) => LedgerRun[]),
  on = true,
  roles = {} as Record<string, AgentRole>,
  head = undefined as string | undefined,
  designs = [] as LedgerRun[],
  runSessions = {} as Record<string, string>,
} = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "pier-chain-")), "home");
  const db = openDb(":memory:");
  const clock = { now: Date.now() };
  // A head already in the chain when the process starts.
  if (head) db.prepare("INSERT INTO main_chain VALUES (?, ?, 'first')").run(head, clock.now);
  const sessions = new Map<string, FakeSession>();
  const created: AgentLaunchOptions[] = [];
  const onDisk = new Set<string>();
  let n = 0;
  const factory = {
    availableModels: async () => [],
    create: async (opts: AgentLaunchOptions) => {
      created.push(opts);
      const s = fakeSession(`m${String(++n)}`, { model: opts.model, thinkingLevel: opts.thinking });
      sessions.set(s.id, s);
      onDisk.add(s.id);
      return s;
    },
    resume: async (id: string) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`unknown session: ${id}`);
      return s;
    },
    list: async () => [],
    find: async (id: string) => (onDisk.has(id) ? { id, cwd: home, createdAt: 0 } : undefined),
    search: async () => [],
    readHistory: async () => undefined,
  } satisfies AgentFactory;
  const ledger: { ids: string[]; since: number }[] = [];
  const hub = new EventHub();
  const workspace: string[] = [];
  hub.subscribeWorkspace((e) => {
    if (e.type === "open-items-changed") workspace.push(e.type);
  });
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  const chain = new MainChain(db, {
    factory, router, home, hub,
    enabled: () => on,
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs(ids, since) : runs;
    },
    sessionOf: (id) => runSessions[id] ?? null,
    roleOf: (id) => roles[id],
    designs: () => designs,
    now: () => clock.now,
  });
  /** A head already in the chain, as a restart finds it: on disk, not live. */
  const existing = (id: string, startedAt: number, opts: FakeSessionOptions = {}): FakeSession => {
    const s = fakeSession(id, opts);
    sessions.set(id, s);
    onDisk.add(id);
    db.prepare("INSERT OR IGNORE INTO main_chain VALUES (?, ?, 'first')").run(id, startedAt);
    return s;
  };
  const say = (text: string) => chain.send({ senderId: "web", sender: { id: "web", name: "operator" }, text, mode: "auto" });
  const item = (problem: string, stage: string, runIds: string[], updatedAt: number) =>
    db.prepare("INSERT INTO open_items VALUES (?, ?, ?, ?)").run(problem, stage, JSON.stringify(runIds), updatedAt);
  return { chain, db, home, clock, sessions, created, ledger, existing, say, router, hub, workspace, item };
}

describe("the continuous conversation's chain", () => {
  it("starts its first session on the first message, in the home at low effort, seeded before the message", async () => {
    const r = rig({ runs: [] });
    mkdirSync(join(r.home, "memory"), { recursive: true });
    writeFileSync(join(r.home, "MEMORY.md"), "pier lives in ~/code/pier\n");
    const today = new Date(r.clock.now);
    writeFileSync(join(r.home, "memory", `${day(today)}.md`), "shipped the doc");
    writeFileSync(join(r.home, "memory", `${day(new Date(r.clock.now - 86_400_000))}.md`), "wrote the contract");

    expect(await r.say("hello")).toEqual({ sessionId: "m1", rotated: "first" });
    expect(r.created).toEqual([{ cwd: r.home, thinking: "low" }]);
    expect(r.chain.members()).toEqual([{ sessionId: "m1", startedAt: r.clock.now, reason: "first" }]);
    const m1 = r.sessions.get("m1")!;
    const [seed] = m1.systemInputs;
    expect(seed?.mode).toBe("append");
    expect(seed?.origin).toEqual({ kind: "session-seed", reason: "first", previousSessionId: null });
    expect(seed?.text).toContain("pier lives in ~/code/pier");
    expect(seed?.text.indexOf("wrote the contract")).toBeLessThan(seed!.text.indexOf("shipped the doc"));
    expect(seed?.text).toContain("## Runs — in flight, and finished since the previous session started\n\nnone");
    expect(seed?.text).toContain("pier lives in ~/code/pier\n\n## Open\n\nNothing open.\n\n## Runs");
    expect(seed?.text).not.toContain("last exchanges");
    // The seed before the message.
    expect(m1.calls.map((c) => c.split(":").slice(0, 2).join(":"))).toEqual([
      "systemInput:session-seed", expect.stringMatching(/^prompt:/),
    ]);
    expect(m1.prompts[0]).toContain("hello");
  });

  it("counts idle from the head's last user message, and rotates at the hour", async () => {
    const r = rig();
    const history = (at: number) => [{ role: "user" as const, text: "earlier", at }, { role: "assistant" as const, text: "ok" }];
    // Started five hours ago, spoken to half an hour ago: still the head.
    r.existing("h1", r.clock.now - 5 * IDLE_MS, { history: history(r.clock.now - IDLE_MS / 2) });
    expect(await r.say("still here")).toEqual({ sessionId: "h1" });

    const r2 = rig();
    r2.existing("h1", r2.clock.now - 5 * IDLE_MS, { history: history(r2.clock.now - IDLE_MS) });
    expect(await r2.say("back")).toEqual({ sessionId: "m1", rotated: "idle" });
  });

  it("carries the head's model, effort and last three exchanges into the next session, with the ledger since its start", async () => {
    const runs: LedgerRun[] = [
      { runId: "r1", name: "fix", state: "running", targetSessionId: "c1", cwd: "/wt", queuedAt: 1, finishedAt: null },
      { runId: "r2", name: "look", state: "queued", targetSessionId: null, cwd: null, queuedAt: 2, finishedAt: null },
    ];
    const r = rig({ runs });
    const turns = [1, 2, 3, 4].flatMap((i) => [
      { role: "user" as const, text: `question ${String(i)}`, at: r.clock.now - 2 * IDLE_MS },
      { role: "system" as const, text: `callback ${String(i)}`, origin: { kind: "task-callback" as const, taskId: "t", runId: "r", sourceSessionId: null } },
      { role: "assistant" as const, text: `answer ${String(i)}` },
    ]);
    const startedAt = r.clock.now - 3 * IDLE_MS;
    r.existing("h1", startedAt, { history: turns, model: { provider: "p", id: "strong" }, thinkingLevel: "high" });

    expect(await r.say("new day")).toEqual({ sessionId: "m1", rotated: "idle" });
    expect(r.created).toEqual([{ cwd: r.home, model: { provider: "p", id: "strong" }, thinking: "high" }]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: startedAt }, { ids: ["h1"], since: r.clock.now - 86_400_000 }]);
    const seed = r.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "idle", previousSessionId: "h1" });
    expect(seed.text).toContain("started\n\nr1 · fix · running · session c1 · /wt\nr2 · look · queued · session — · —\n\n");
    expect(seed.text).toContain("## Open\n\nNot on the list\n- fix — running ");
    expect(seed.text).toContain("user: question 2\n\nassistant: answer 2");
    expect(seed.text).toContain("assistant: answer 4");
    expect(seed.text).not.toContain("question 1");
    expect(seed.text).not.toContain("callback");
    expect(r.chain.members().map((m) => [m.sessionId, m.reason])).toEqual([["m1", "idle"], ["h1", "first"]]);
    // The message went to the new head, not the one it was typed against.
    expect(r.sessions.get("m1")!.prompts[0]).toContain("new day");
    expect(r.sessions.get("h1")!.prompts).toEqual([]);
  });

  it("starts a new head, named lost, when the head is gone from Pi", async () => {
    const r = rig();
    r.db.prepare("INSERT INTO main_chain VALUES ('gone', ?, 'first')").run(r.clock.now);
    expect(await r.say("hi")).toEqual({ sessionId: "m1", rotated: "lost" });
    expect(r.created).toEqual([{ cwd: r.home, thinking: "low" }]);
    expect(r.sessions.get("m1")!.systemInputs[0]!.origin).toEqual({ kind: "session-seed", reason: "lost", previousSessionId: "gone" });
  });

  it("never rotates a head mid-turn", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 5 * IDLE_MS, { hold: true, history: [{ role: "user", text: "old", at: r.clock.now - 5 * IDLE_MS }] });
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    void head.prompt("long job");
    await Promise.resolve();
    expect(await r.say("and another thing")).toEqual({ sessionId: "h1" });
    expect(r.created).toEqual([]);
    await head.abort();
  });

  it("rotates a head past the size ceiling, named full, carrying its last exchanges", async () => {
    const r = rig();
    const history = [{ role: "user" as const, text: "the plan", at: r.clock.now - 60_000 }, { role: "assistant" as const, text: "agreed" }];
    r.existing("h1", r.clock.now - IDLE_MS / 2, { history, contextUsage: { tokens: FULL, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r.say("at the ceiling")).toEqual({ sessionId: "h1" });

    const r2 = rig();
    r2.existing("h1", r2.clock.now - IDLE_MS / 2, { history, contextUsage: { tokens: FULL + 1, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r2.say("past it")).toEqual({ sessionId: "m1", rotated: "full" });
    const seed = r2.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "full", previousSessionId: "h1" });
    expect(seed.text).toContain("the previous one reached 60K tokens");
    expect(seed.text).toContain("## The previous session's last exchanges\n\nuser: the plan\n\nassistant: agreed");
    expect(r2.sessions.get("m1")!.prompts[0]).toContain("past it");
  });

  it("never rotates on size when the size is unknown after a compaction, or mid-turn", async () => {
    const r = rig();
    r.existing("h1", r.clock.now, { contextUsage: { tokens: null, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r.say("hi")).toEqual({ sessionId: "h1" });

    const r2 = rig();
    const head = r2.existing("h1", r2.clock.now, { hold: true, contextUsage: { tokens: 2 * FULL, contextWindow: 400_000, compactAt: 100_000 } });
    await r2.router.ensure({ channelId: "web", conversationId: "h1" });
    void head.prompt("long job");
    await Promise.resolve();
    expect(await r2.say("and another thing")).toEqual({ sessionId: "h1" });
    expect(r2.created).toEqual([]);
    await head.abort();
  });

  it("rotates once when two messages race an idle head", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.say("one"), r.say("two")]);
    expect([a.sessionId, b.sessionId]).toEqual(["m1", "m1"]);
    expect(r.created).toHaveLength(1);
  });

  it("answers for every member with the whole chain, newest first", () => {
    const r = rig();
    r.existing("h0", r.clock.now - 10);
    r.existing("h1", r.clock.now);
    expect(r.chain.chainOf("h0")).toEqual(["h1", "h0"]);
    expect(r.chain.chainOf("child")).toBeUndefined();
  });

  it("creates nothing when the seed cannot be built, says why, and starts cleanly on the next message", async () => {
    let broken = true;
    const r = rig({ runs: () => {
      if (broken) throw new Error("database is locked");
      return [];
    } });
    await expect(r.say("hello")).rejects.toThrow("a new session could not start — its seed failed: Error: database is locked");
    expect(r.created).toEqual([]);
    expect(r.chain.members()).toEqual([]);
    broken = false;
    expect(await r.say("again")).toEqual({ sessionId: "m1", rotated: "first" });
    expect(r.created).toHaveLength(1);
  });

  it("says in the seed when a memory file cannot be read", async () => {
    const r = rig();
    mkdirSync(join(r.home, "MEMORY.md"), { recursive: true });
    await r.say("hi");
    expect(r.sessions.get("m1")!.systemInputs[0]!.text).toMatch(/## MEMORY\.md\n\n\(could not be read: .*EISDIR/);
  });
});

const MIN = 60_000;
const run = (runId: string, over: Partial<LedgerRun> = {}): LedgerRun =>
  ({ runId, name: runId, state: "running", targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null, ...over });

describe("the open items", () => {
  it("joins each run token through the ledger: found, gone, and a lead with its workers", () => {
    let now = 0;
    const r = rig({
      roles: { lead1: "lead" },
      runs: (ids) => ids[0] === "lead1"
        ? [run("w1"), run("w2", { state: "succeeded", finishedAt: now })]
        : [run("1prwmabcdef", { name: "lead open items", targetSessionId: "lead1", queuedAt: now - 23 * MIN })],
    });
    now = r.clock.now;
    r.existing("h1", now);
    r.item("open items 视图", "lead designing", ["1prwmabcdef"], 2);
    r.item("model menu 重选", "merged, restart pending", ["gone1"], 1);
    const open = r.chain.openItems();
    expect(open.items.map((i) => i.problem)).toEqual(["model menu 重选", "open items 视图"]);
    expect(open.items[0]!.runs).toEqual([{ runId: "gone1", name: "gone1", state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }]);
    expect(open.items[1]!.runs[0]!.workers).toEqual({ queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 });
    expect(open.unlisted).toEqual([]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: now - 86_400_000 }, { ids: ["lead1"], since: now - 86_400_000 }]);
    expect(renderOpenItems(open, now)).toBe([
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
    now = r.clock.now;
    r.existing("h1", now);
    r.item("the problem", "", ["r-named"], 1);
    const open = r.chain.openItems();
    expect(open.unlisted.map((u) => u.runId)).toEqual(["r-live", "r-queued"]);
    // The window is the ledger's: `pier task runs`' last 24h.
    expect(r.ledger[0]!.since).toBe(now - 86_400_000);
    expect(renderOpenItems(open, now)).toBe([
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
    now = r.clock.now;
    r.existing("h1", now);
    r.item("status 归并", "lead building", ["vdmj112x"], 1);
    const open = r.chain.openItems();
    expect(open.items[0]!.runs.map((x) => x.runId)).toEqual(["k4k3jz55"]);
    expect(open.unlisted).toEqual([]);
    expect(renderOpenItems(open, now)).toBe("Open\n- status 归并 — lead building (running) · run k4k3jz55 running 2m");
  });

  it("reads an item running while its session streams, though its run has finished", () => {
    let now = 0;
    const r = rig({ runs: () => [run("r1", { targetSessionId: "lead1", state: "succeeded", finishedAt: now - MIN })] });
    now = r.clock.now;
    r.existing("h1", now);
    r.item("fix", "lead building", ["r1"], 1);
    expect(r.chain.openItems().items[0]!.live).toBe("idle");
    const lead = fakeSession("lead1");
    r.router.attach({ channelId: "task", conversationId: "lead1" }, lead);
    lead.setState("streaming");
    expect(r.chain.openItems().items[0]!.live).toBe("running");
  });

  // A design lead's turn ends on the user; until it reports `Design final:` it is theirs to decide.
  it("lists the designs waiting on the user last, each linking its session from `/status`", async () => {
    const design = run("d1abcdefgh", { name: "Rail redesign", state: "succeeded", targetSessionId: "s-d1", finishedAt: 0 });
    const r = rig({ designs: [design] });
    const now = r.clock.now;
    r.item("model menu", "merged", [], 1);
    expect(renderOpenItems(r.chain.openItems(), now)).toBe([
      "Open",
      "- model menu — merged",
      "Designs for you to finalize",
      `- Rail redesign · run d1abcdef… succeeded ${agoLabel(0, now)}`,
    ].join("\n"));
    await r.say("/status");
    expect(r.sessions.get("m1")!.systemInputs.at(-1)!.origin).toEqual({ kind: "chat-command", command: "status", sessions: { d1abcdefgh: "s-d1" } });
  });

  it("says nothing is open when nothing is, and asks no ledger before the first head", () => {
    const r = rig();
    expect(renderOpenItems(r.chain.openItems(), r.clock.now)).toBe("Nothing open.");
    expect(r.ledger).toEqual([]);
  });

  it("puts the open items in a new head's seed, after MEMORY.md", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - 3 * IDLE_MS);
    r.item("60K rotation", "waiting on you: keep 60K or raise to 80K?", [], 1);
    await r.say("morning");
    expect(r.sessions.get("m1")!.systemInputs[0]!.text).toContain("## Open\n\nOpen\n- 60K rotation — waiting on you: keep 60K or raise to 80K?\n\n## Runs");
  });

  it("answers exactly `/status` with the list, appended to the head without a turn", async () => {
    const r = rig();
    r.item("model menu", "merged", [], 1);
    expect(await r.say("  /STATUS \n")).toEqual({ sessionId: "m1", rotated: "first", command: "status" });
    const m1 = r.sessions.get("m1")!;
    expect(m1.systemInputs.at(-1)).toMatchObject({ text: "Open\n- model menu — merged", origin: { kind: "chat-command", command: "status" }, mode: "append" });
    expect(m1.prompts).toEqual([]);
    for (const text of ["/tmp is full", "/status please", "status", "/stat"]) await r.say(text);
    expect(m1.prompts).toHaveLength(4);
    expect(m1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(1);
  });

  it("carries each named run's session with `/status`, for the card to link", async () => {
    const r = rig({ runs: () => [run("r-sess", { targetSessionId: "s-r" }), run("r-none")] });
    r.item("with a session", "running", ["r-sess", "r-none", "r-gone"], 1);
    await r.say("/status");
    expect(r.sessions.get("m1")!.systemInputs.at(-1)!.origin).toEqual({ kind: "chat-command", command: "status", sessions: { "r-sess": "s-r" } });
  });

  it("rotates on `/new` with the seed as the answer, once when the head was due anyway, and refuses a replying head", async () => {
    const r = rig();
    r.existing("h1", r.clock.now, { history: [{ role: "user", text: "earlier", at: r.clock.now }] });
    expect(await r.say("/new")).toEqual({ sessionId: "m1", rotated: "new", command: "new" });
    expect(r.chain.members().map((m) => [m.sessionId, m.reason])).toEqual([["m1", "new"], ["h1", "first"]]);
    const m1 = r.sessions.get("m1")!;
    expect(m1.systemInputs).toHaveLength(1);
    expect(m1.systemInputs[0]).toMatchObject({ origin: { kind: "session-seed", reason: "new", previousSessionId: "h1" } });
    expect(m1.systemInputs[0]!.text).toContain("you asked for one with /new");
    expect(m1.prompts).toEqual([]);

    // Due for its own reason: one rotation, not two.
    r.clock.now += 2 * IDLE_MS;
    expect(await r.say("/NEW")).toEqual({ sessionId: "m2", rotated: "idle", command: "new" });
    expect(r.chain.members()).toHaveLength(3);

    r.sessions.get("m2")!.setState("streaming");
    await expect(r.say("/new")).rejects.toThrow("the conversation is replying — /stop first");
    expect(r.chain.members()).toHaveLength(3);
    expect(r.sessions.get("m2")!.systemInputs.filter((i) => i.origin.kind === "chat-command")).toEqual([]);
  });

  it("aborts the head's turn on `/stop` and says so, or says nothing was running", async () => {
    const r = rig({ head: "h1" });
    const h1 = r.existing("h1", r.clock.now, { hold: true });
    await r.say("go");
    expect(h1.state).toBe("streaming");
    expect(await r.say("/stop")).toEqual({ sessionId: "h1", command: "stop" });
    expect(h1.state).toBe("idle");
    expect(h1.calls.slice(-2)).toEqual(["abort", "systemInput:chat-command:append:stopped"]);
    expect(h1.systemInputs.at(-1)).toEqual({ text: "stopped", origin: { kind: "chat-command", command: "stop" }, mode: "append" });
    await r.say("/stop");
    expect(h1.calls.at(-1)).toBe("systemInput:chat-command:append:nothing running");
    expect(h1.calls.filter((c) => c === "abort")).toHaveLength(1);
  });

  it("writes the head's markers on its turn end and says so once, a restart's head and a new head alike", async () => {
    const r = rig({ head: "h0" });
    r.existing("h0", r.clock.now);
    r.hub.emit("h0", { type: "turn-end", text: "On it.\n<open>open items — worker running (run r1)</open>" });
    expect(r.db.prepare("SELECT problem, stage, run_ids FROM open_items").all())
      .toEqual([{ problem: "open items", stage: "worker running", run_ids: '["r1"]' }]);
    expect(r.workspace).toEqual(["open-items-changed"]);

    // Nothing written, nothing said: no marker, a done for no item, a marker with no problem.
    r.hub.emit("h0", { type: "turn-end", text: "plain <done>never open</done><open> — x</open>" });
    r.hub.emit("h0", { type: "turn-end", text: "" });
    expect(r.workspace).toEqual(["open-items-changed"]);

    r.clock.now += 2 * IDLE_MS;
    await r.say("later");
    r.hub.emit("h0", { type: "turn-end", text: "<done>open items</done>" });
    expect(r.db.prepare("SELECT count(*) AS n FROM open_items").get()).toEqual({ n: 1 });
    r.hub.emit("m1", { type: "turn-end", text: "Merged.\n<open>open items — merged, restart pending</open>\n<done>open items</done>" });
    expect(r.db.prepare("SELECT count(*) AS n FROM open_items").get()).toEqual({ n: 0 });
    expect(r.workspace).toEqual(["open-items-changed", "open-items-changed"]);
  });
});
