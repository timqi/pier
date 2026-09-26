// The continuous conversation's chain: which session a user message lands on,
// when a new one starts, and what the new one is told.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { MainChain, type LedgerRun } from "./chain.js";
import { CHAIN_IDLE_MS as IDLE_MS } from "./types.js";
import { EventHub } from "./hub.js";
import { Router } from "./router.js";
import { fakeSession, type FakeSession, type FakeSessionOptions } from "./session.testkit.js";
import type { AgentFactory, AgentLaunchOptions } from "./types.js";

const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rig({ runs = [] as LedgerRun[] | (() => LedgerRun[]), on = true } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "pier-chain-")), "home");
  const db = openDb(":memory:");
  const clock = { now: Date.now() };
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
  const router = new Router(new EventHub(), (key) => factory.resume(key.conversationId));
  const chain = new MainChain(db, {
    factory, router, home,
    enabled: () => on,
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs() : runs;
    },
    now: () => clock.now,
  });
  /** A head already in the chain, as a restart finds it: on disk, not live. */
  const existing = (id: string, startedAt: number, opts: FakeSessionOptions = {}): FakeSession => {
    const s = fakeSession(id, opts);
    sessions.set(id, s);
    onDisk.add(id);
    db.prepare("INSERT INTO main_chain VALUES (?, ?, 'first')").run(id, startedAt);
    return s;
  };
  const say = (text: string) => chain.send({ senderId: "web", sender: { id: "web", name: "operator" }, text, mode: "auto" });
  return { chain, db, home, clock, sessions, created, ledger, existing, say, router };
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
    const runs: LedgerRun[] = [{ runId: "r1", name: "fix", state: "running", targetSessionId: "c1", cwd: "/wt", queuedAt: 1, finishedAt: null }];
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
    expect(r.ledger).toEqual([{ ids: ["h1"], since: startedAt }]);
    const seed = r.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "idle", previousSessionId: "h1" });
    expect(seed.text).toContain(JSON.stringify(runs[0]));
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

  it("resolves the head ahead of a send, rotating when due and dispatching nothing", async () => {
    const r = rig();
    expect(await r.chain.resolve()).toEqual({ sessionId: "m1", rotated: "first" });
    expect(r.sessions.get("m1")!.prompts).toEqual([]);
    expect(await r.say("then this")).toEqual({ sessionId: "m1" });
    expect(r.created).toHaveLength(1);
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
