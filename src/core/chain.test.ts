// The continuous conversation's chain: which session a user message lands on,
// when a new one starts, and what the new one is told.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefaults } from "../agent/types.js";
import { openDb } from "../db.js";
import { MainChain } from "./chain.js";
import { CHAIN_FULL_TOKENS as FULL, CHAIN_IDLE_MS as IDLE_MS } from "./types.js";
import { EventHub } from "./hub.js";
import { Router } from "./router.js";
import { fakeSession, type FakeSession, type FakeSessionOptions } from "./session.testkit.js";
import type { AgentFactory, AgentLaunchOptions, Channel, LedgerRun, NoteOrigin } from "./types.js";

const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function rig({
  runs = [] as LedgerRun[] | ((ids: string[], since: number) => LedgerRun[]),
  head = undefined as string | undefined,
} = {}) {
  // Settings' default model and reasoning, as the operator last saved them; a function may throw.
  const defaults: { value: AgentDefaults | (() => AgentDefaults) } = { value: { defaultModel: null, defaultThinkingLevel: null } };
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
    readSystemPrompt: async () => undefined,
  } satisfies AgentFactory;
  const ledger: { ids: string[]; since: number }[] = [];
  const hub = new EventHub();
  const router = new Router(hub, (key) => factory.resume(key.conversationId));
  // The open items' text is tasks/open-items.ts's; the chain only places it.
  const status = { text: "Nothing open.", seed: undefined as string | undefined, sessions: {} as Record<string, string>, asked: [] as number[] };
  const chain = new MainChain(db, {
    factory, router, home,
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs(ids, since) : runs;
    },
    status: (now) => {
      status.asked.push(now);
      return { text: status.text, seed: status.seed ?? status.text, snapshot: { version: 1, items: [] }, sessions: status.sessions };
    },
    defaults: async () => (typeof defaults.value === "function" ? defaults.value() : defaults.value),
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
  return { chain, db, home, clock, sessions, created, ledger, existing, say, router, status, defaults };
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
    expect(seed?.text).toContain("## Runs — in flight, or ended short of success since the previous session started (succeeded and skipped: `pier task runs`)\n\nnone");
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
      { runId: "r3", name: "shipped", state: "succeeded", targetSessionId: "c3", cwd: "/wt3", queuedAt: 3, finishedAt: 4 },
      { runId: "r4", name: "broke", state: "failed", targetSessionId: "c4", cwd: "/wt4", queuedAt: 5, finishedAt: 6 },
      { runId: "r5", name: "cut off", state: "interrupted", targetSessionId: "c5", cwd: null, queuedAt: 7, finishedAt: 8 },
      { runId: "r6", name: "overlapped", state: "skipped", targetSessionId: null, cwd: null, queuedAt: 9, finishedAt: 9 },
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
    expect(r.ledger).toEqual([{ ids: ["h1"], since: startedAt }]);
    const seed = r.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "idle", previousSessionId: "h1" });
    // In flight and failed runs only: a succeeded or skipped one is `pier task runs`' to show.
    expect(seed.text).toContain("`pier task runs`)\n\nr1 · fix · running · session c1 · /wt\nr2 · look · queued · session — · —\nr4 · broke · failed · session c4 · /wt4\nr5 · cut off · interrupted · session c5 · —\n\n");
    expect(seed.text).not.toContain("r3 ·");
    expect(seed.text).not.toContain("r6 ·");
    expect(seed.text).toContain("user: question 2\n\nassistant: answer 2");
    expect(seed.text).toContain("assistant: answer 4");
    expect(seed.text).not.toContain("question 1");
    expect(seed.text).not.toContain("callback");
    expect(r.chain.members().map((m) => [m.sessionId, m.reason])).toEqual([["m1", "idle"], ["h1", "first"]]);
    // The message went to the new head, not the one it was typed against.
    expect(r.sessions.get("m1")!.prompts[0]).toContain("new day");
    expect(r.sessions.get("h1")!.prompts).toEqual([]);
  });

  it("starts every new head — first, rotated, /new — on the Settings default model and reasoning, read each time", async () => {
    const r = rig();
    r.defaults.value = { defaultModel: { provider: "p", id: "default" }, defaultThinkingLevel: "medium" };
    await r.say("hello");
    expect(r.created).toEqual([{ cwd: r.home, model: { provider: "p", id: "default" }, thinking: "medium" }]);

    // The head was switched by hand; the next head still starts from Settings, as saved now.
    r.sessions.get("m1")!.setThinkingLevel("high");
    r.defaults.value = { defaultModel: { provider: "p", id: "newer" }, defaultThinkingLevel: "xhigh" };
    r.clock.now += 2 * IDLE_MS;
    expect(await r.say("later")).toEqual({ sessionId: "m2", rotated: "idle" });
    expect(r.created.at(-1)).toEqual({ cwd: r.home, model: { provider: "p", id: "newer" }, thinking: "xhigh" });

    // Only the reasoning set: the model is the previous head's.
    r.defaults.value = { defaultModel: null, defaultThinkingLevel: "minimal" };
    expect(await r.say("/new")).toMatchObject({ sessionId: "m3", command: "new" });
    expect(r.created.at(-1)).toEqual({ cwd: r.home, model: { provider: "p", id: "newer" }, thinking: "minimal" });
  });

  it("stamps the seed with the language the previous head's user wrote in", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - 3 * IDLE_MS, { history: [{ role: "user", text: "[Ada<U1> 12:00 lang=zh]\n帮我看看这个问题" }, { role: "assistant", text: "Looking at it now" }] });
    expect(await r.say("new day")).toEqual({ sessionId: "m1", rotated: "idle" });
    expect(r.sessions.get("m1")!.systemInputs[0]!.text).toMatch(/^\[lang=zh\]\n\[Pier: a new session/);
    // Nothing to carry from a head that was never spoken to.
    const r2 = rig();
    await r2.say("hello");
    expect(r2.sessions.get("m1")!.systemInputs[0]!.text).toMatch(/^\[Pier: a new session/);
  });

  it("keeps the previous head's model and effort when Settings cannot be read", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - 3 * IDLE_MS, { model: { provider: "p", id: "strong" }, thinkingLevel: "high" });
    r.defaults.value = () => { throw new Error("settings.json is not JSON"); };
    expect(await r.say("new day")).toEqual({ sessionId: "m1", rotated: "idle" });
    expect(r.created).toEqual([{ cwd: r.home, model: { provider: "p", id: "strong" }, thinking: "high" }]);
  });

  it("starts a new head, named lost, when the head is gone from Pi, and drops the gone one from the chain", async () => {
    const r = rig();
    r.existing("h0", r.clock.now - 2);
    r.db.prepare("INSERT INTO main_chain VALUES ('gone', ?, 'first')").run(r.clock.now - 1);
    expect(await r.say("hi")).toEqual({ sessionId: "m1", rotated: "lost" });
    expect(r.created).toEqual([{ cwd: r.home, thinking: "low" }]);
    expect(r.sessions.get("m1")!.systemInputs[0]!.origin).toEqual({ kind: "session-seed", reason: "lost", previousSessionId: "gone" });
    // Nothing on disk to page back to: a member left behind would be an unknown session forever.
    expect(r.chain.members().map((m) => [m.sessionId, m.reason])).toEqual([["m1", "lost"], ["h0", "first"]]);
    expect(r.chain.chainOf("gone")).toBeUndefined();
  });

  it("appends the head's <note> lines to today's daily note, on its own line, and nobody else's", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    const older = r.existing("h0", r.clock.now - 120_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    await r.router.ensure({ channelId: "web", conversationId: "h0" });
    const file = join(r.home, "memory", `${day(new Date(r.clock.now))}.md`);
    head.emit({ type: "turn-end", text: "Merged.\n<note>决定：审查默认 balanced</note>" });
    expect(readFileSync(file, "utf8")).toBe("- 决定：审查默认 balanced\n");
    writeFileSync(file, "- edited by hand");
    older.emit({ type: "turn-end", text: "<note>not the head</note>" });
    head.emit({ type: "turn-end", text: "<note>one</note>\n<note>two</note>" });
    expect(readFileSync(file, "utf8")).toBe("- edited by hand\n- one\n- two\n");
  });

  it("tells the head's conversation when a note could not be written", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    mkdirSync(r.home, { recursive: true });
    writeFileSync(join(r.home, "memory"), "a file, not the directory");
    const told = vi.spyOn(r.router, "reportTo");
    head.emit({ type: "turn-end", text: "<note>kept anyway</note>" });
    expect(told).toHaveBeenCalledWith("h1", expect.stringMatching(/^notes: could not append to memory\/.*: kept anyway$/));
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

  it("cuts each seed part to its budget, the ledger's oldest lines first", async () => {
    const runs: LedgerRun[] = Array.from({ length: 300 }, (_, i) => (
      { runId: `r${String(300 - i)}`, name: "n", state: "failed", targetSessionId: null, cwd: null, queuedAt: 300 - i, finishedAt: 1 }
    ));
    const r = rig({ runs });
    mkdirSync(r.home, { recursive: true });
    writeFileSync(join(r.home, "MEMORY.md"), "m".repeat(100_000));
    await r.say("hi");
    const text = r.sessions.get("m1")!.systemInputs[0]!.text;
    const memory = text.slice(0, text.indexOf("\n\n## Open"));
    expect(memory.length).toBeLessThan(13_000);
    expect(memory.endsWith("…")).toBe(true);
    expect(text).toContain("`pier task runs`)\n\nr300 · n · failed");
    expect(text).not.toContain("r1 · n");
  });

  it("keeps the end of a day's notes, where the newest entries are", async () => {
    const r = rig();
    mkdirSync(join(r.home, "memory"), { recursive: true });
    const lines = Array.from({ length: 400 }, (_, i) => `- entry ${String(i + 1)} ${"x".repeat(20)}`);
    writeFileSync(join(r.home, "memory", `${day(new Date(r.clock.now))}.md`), lines.join("\n"));
    await r.say("hi");
    const text = r.sessions.get("m1")!.systemInputs[0]!.text;
    const notes = text.slice(text.indexOf("## memory/"));
    expect(notes.length).toBeLessThan(6_100);
    expect(notes).toMatch(/^## memory\/(\d{4}-\d{2}-\d{2})\.md\n\n… 219 lines omitted, the rest in memory\/\1\.md\n- entry 220 x/);
    expect(notes).toContain("- entry 400 ");
    expect(notes).not.toContain("- entry 1 ");
  });
});

describe("the chat commands", () => {
  it("puts the open items in a new head's seed, after MEMORY.md", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - 3 * IDLE_MS);
    r.status.text = "Compact status";
    r.status.seed = "Open\n- 60K rotation — waiting on you: keep 60K or raise to 80K?\nrun full-run-identity";
    await r.say("morning");
    expect(r.sessions.get("m1")!.systemInputs[0]!.text).toContain("## Open\n\nOpen\n- 60K rotation — waiting on you: keep 60K or raise to 80K?\nrun full-run-identity\n\n## Runs");
    expect(r.status.asked).toEqual([r.clock.now]);
  });

  it("answers exactly `/status` with the list, appended to the head without a turn", async () => {
    const r = rig();
    r.status.text = "Open\n- model menu — merged";
    expect(await r.say("  /STATUS \n")).toEqual({ sessionId: "m1", rotated: "first", command: "status" });
    const m1 = r.sessions.get("m1")!;
    expect(m1.systemInputs.at(-1)).toMatchObject({ text: "Open\n- model menu — merged", origin: { kind: "chat-command", command: "status" }, mode: "append" });
    expect(m1.prompts).toEqual([]);
    for (const text of ["/tmp is full", "/status please", "status", "/stat", "%", "%unknown"]) await r.say(text);
    expect(m1.prompts).toHaveLength(6);
    expect(m1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(1);
    expect(await r.say(" %Status ")).toEqual({ sessionId: "m1", command: "status" });
    expect(m1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(2);
  });

  it("carries each named run's session with `/status`, for the card to link", async () => {
    const r = rig();
    r.status.sessions = { "r-sess": "s-r" };
    await r.say("/status");
    expect(r.sessions.get("m1")!.systemInputs.at(-1)!.origin).toEqual({ kind: "chat-command", command: "status", sessions: { "r-sess": "s-r" }, statusSnapshot: { version: 1, items: [] } });
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

  it("lists the head's skills on `/skills`, one line each, or says there are none", async () => {
    const r = rig({ head: "h1" });
    const h1 = r.existing("h1", r.clock.now, {
      skills: [{ name: "pier-tasks", description: "run a task" }, { name: "pier-web", description: "search the web" }],
    });
    expect(await r.say("%skills")).toEqual({ sessionId: "h1", command: "skills" });
    expect(h1.systemInputs.at(-1)).toEqual({
      text: "pier-tasks — run a task\npier-web — search the web", origin: { kind: "chat-command", command: "skills" }, mode: "append",
    });
    expect(h1.prompts).toEqual([]);

    const r2 = rig();
    await r2.say("/skills");
    expect(r2.sessions.get("m1")!.systemInputs.at(-1)!.text).toBe("no skills");
  });
});

describe("a send under a chat's key", () => {
  const KEY = { channelId: "lark", conversationId: "oc_home" };
  const lark = () => {
    const notes: [string, NoteOrigin][] = [];
    const channel: Channel = {
      id: "lark",
      start: async () => {},
      send: async () => {},
      notify: async (id, note) => void notes.push([id, note.origin]),
      openThread: async () => "",
      editRoot: async () => {},
      status: async () => {},
      stop: async () => {},
    };
    return { channel, notes };
  };
  const send = (r: ReturnType<typeof rig>, text: string) =>
    r.chain.send({ senderId: "u1", sender: { id: "u1", name: "qiqi" }, text, mode: "steer" }, KEY);

  it("dispatches under that key, the head attached under it, and so is a rotation's next head", async () => {
    const r = rig();
    const im = lark();
    r.router.registerChannel(im.channel);
    expect(await send(r, "hello")).toEqual({ sessionId: "m1", rotated: "first" });
    expect(r.router.conversationOf("m1")).toEqual(KEY);
    expect(r.router.sessionOf(KEY)?.id).toBe("m1");
    expect(r.sessions.get("m1")!.prompts[0]).toContain("lark:oc_home");
    // The seed reached the chat: attached before it was appended.
    expect(im.notes.map(([id, o]) => [id, o.kind])).toEqual([["oc_home", "session-seed"]]);

    r.clock.now += 2 * IDLE_MS;
    expect(await send(r, "back")).toEqual({ sessionId: "m2", rotated: "idle" });
    expect(r.router.sessionOf(KEY)?.id).toBe("m2");
    expect(r.router.conversationOf("m2")).toEqual(KEY);
    // The previous head keeps no delivery: its next turn would otherwise answer in the chat too.
    expect(r.router.conversationOf("m1")).toEqual({ channelId: "web", conversationId: "m1" });
    expect(im.notes.at(-1)).toEqual(["oc_home", expect.objectContaining({ kind: "session-seed", reason: "idle" })]);
    expect(r.sessions.get("m2")!.prompts[0]).toContain("back");
  });
});
