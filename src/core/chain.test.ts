// The continuous conversation's chain: which session a user message lands on,
// when a new one starts, and what the new one is told.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefaults } from "../agent/types.js";
import { openDb } from "../db.js";
import { ChatCommandRefused, MainChain } from "./chain.js";
import { ChainArchived, ChainHasOpen, Chains } from "./chains.js";
import { CHAIN_FULL_TOKENS as FULL, CHAIN_IDLE_MS as IDLE_MS } from "./types.js";
import { EventHub } from "./hub.js";
import { Router } from "./router.js";
import { fakeSession, type FakeSession, type FakeSessionOptions } from "./session.testkit.js";
import type { AgentFactory, AgentLaunchOptions, Channel, ConversationKey, LedgerRun, NoteOrigin, OpenItemTarget } from "./types.js";

const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const meta = (completedAt: number) => ({ completedAt, durationMs: 1000, tokens: 1 });

function rig({
  runs = [] as LedgerRun[] | ((ids: string[], since: number) => LedgerRun[]),
  head = undefined as string | undefined,
  chat = undefined as ConversationKey | undefined,
  // Run id → the session that launched it; a cron or watch run has none.
  launchers = {} as Record<string, string>,
} = {}) {
  // Settings' default model and reasoning, as the operator last saved them; a function may throw.
  const defaults: { value: AgentDefaults | (() => AgentDefaults) } = { value: { defaultModel: null, defaultThinkingLevel: null } };
  const home = join(mkdtempSync(join(tmpdir(), "pier-chain-")), "home");
  const db = openDb(":memory:");
  const clock = { now: Date.now() };
  // A head already in the chain when the process starts.
  if (head) db.prepare("INSERT INTO main_chain(session_id, chain_id, started_at, reason) VALUES (?, 'main', ?, 'first')").run(head, clock.now);
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
    readHistory: async (id: string) => sessions.get(id)?.history(),
    readSystemPrompt: async () => undefined,
  } satisfies AgentFactory;
  const ledger: { ids: string[]; since: number }[] = [];
  const launcherAsked: string[] = [];
  const hub = new EventHub();
  // The home chat answers for the head only, as main.ts wires it.
  const router = new Router(hub, (key) => factory.resume(key.conversationId), undefined,
    (id) => (chat && chain.isHead(id) ? chat : undefined));
  // The open items' text is tasks/open-items.ts's; the chain only places it.
  const status = { text: "Nothing open.", seed: undefined as string | undefined, sessions: {} as Record<string, string>, asked: [] as number[],
    // Per chain, the items `/chain` and `## Chains` count.
    items: {} as Record<string, OpenItemTarget["status"][]> };
  const chains = new Chains(db, (id) => status.items[id]?.length ?? 0);
  const mode = { on: false, set: vi.fn(async (on: boolean) => { mode.on = on; }) };
  const deps: ConstructorParameters<typeof MainChain>[1] = {
    factory, router, home, chains,
    mode: { get: () => mode.on, set: mode.set },
    changed: vi.fn(),
    ledger: (ids, since) => {
      ledger.push({ ids, since });
      return typeof runs === "function" ? runs(ids, since) : runs;
    },
    launcher: (runId) => {
      launcherAsked.push(runId);
      return launchers[runId] ?? null;
    },
    status: (now, chainId) => {
      status.asked.push(now);
      const items = (status.items[chainId] ?? []).map((s, n) => ({ problem: `p${String(n)}`, status: s, runs: [], key: "", title: "", statusLabel: "", stage: "", metadata: [] }));
      return { text: status.text, seed: status.seed ?? status.text, snapshot: { version: 1 as const, items }, sessions: status.sessions };
    },
    defaults: async () => (typeof defaults.value === "function" ? defaults.value() : defaults.value),
    // The resolution is TaskService.closeItem's; the chain only answers with its key.
    close: vi.fn((_chainId: string, query: string): string => {
      if (query === "log") throw new ChatCommandRefused("/done log matches login, logout \u2014 say more");
      return `${query} fix`;
    }),
    now: () => clock.now,
  };
  const chain = new MainChain(db, deps);
  /** The same database and sessions read by a new process. */
  const restart = (): MainChain => new MainChain(db, deps);
  /** A head already in the chain, as a restart finds it: on disk, not live. */
  const existing = (id: string, startedAt: number, opts: FakeSessionOptions = {}): FakeSession => {
    const s = fakeSession(id, opts);
    sessions.set(id, s);
    onDisk.add(id);
    db.prepare("INSERT OR IGNORE INTO main_chain(session_id, chain_id, started_at, reason) VALUES (?, 'main', ?, 'first')").run(id, startedAt);
    return s;
  };
  const say = (text: string, chainId = "main") => chain.send({ senderId: "web", sender: { id: "web", name: "operator" }, text, mode: "auto" }, chainId);
  return { chain, chains, mode, changed: deps.changed as ReturnType<typeof vi.fn>, close: deps.close as ReturnType<typeof vi.fn>, db, home, clock, sessions, created, ledger, launcherAsked, existing, say, router, status, defaults, factory, restart };
}

describe("the continuous conversation's chain", () => {
  it("starts its first session on the first message, in the home at low effort, seeded before the message", async () => {
    const r = rig({ runs: [] });
    mkdirSync(join(r.home, "memory"), { recursive: true });
    writeFileSync(join(r.home, "MEMORY.md"), "pier lives in ~/code/pier\n");
    const today = new Date(r.clock.now);
    writeFileSync(join(r.home, "memory", `${day(today)}.md`), "shipped the doc");
    writeFileSync(join(r.home, "memory", `${day(new Date(r.clock.now - 86_400_000))}.md`), "wrote the contract");

    expect(await r.say("hello")).toEqual({ sessionId: "m1", chainId: "main", rotated: "first" });
    expect(r.created).toEqual([{ cwd: r.home, thinking: "low" }]);
    expect(r.chain.members("main")).toEqual([{ sessionId: "m1", startedAt: r.clock.now, reason: "first" }]);
    const m1 = r.sessions.get("m1")!;
    const [seed] = m1.systemInputs;
    expect(seed?.mode).toBe("append");
    expect(seed?.origin).toEqual({ kind: "session-seed", reason: "first", previousSessionId: null });
    expect(seed?.text).toContain("pier lives in ~/code/pier");
    expect(seed?.text.indexOf("wrote the contract")).toBeLessThan(seed!.text.indexOf("shipped the doc"));
    expect(seed?.text).toContain("## Runs — in flight, or ended short of success since the previous session started (succeeded and skipped: `pier task runs`)\n\nnone");
    expect(seed?.text).toContain("pier lives in ~/code/pier\n\n## Open\n\nNothing open.\n\n## Runs");
    expect(seed?.text).not.toContain("## Previous session");
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
    expect(await r.say("still here")).toEqual({ sessionId: "h1", chainId: "main" });

    const r2 = rig();
    r2.existing("h1", r2.clock.now - 5 * IDLE_MS, { history: history(r2.clock.now - IDLE_MS) });
    expect(await r2.say("back")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
  });

  it("counts idle from the later of the user's last message and the last reply that reached them", async () => {
    // Asked two hours ago, answered half an hour ago: the answer is the exchange.
    const r = rig();
    r.existing("h1", r.clock.now - 5 * IDLE_MS, { history: [
      { role: "user", text: "ship it", at: r.clock.now - 2 * IDLE_MS },
      { role: "assistant", text: "merge?\n---\n[Yes] | [No]", meta: meta(r.clock.now - IDLE_MS / 2) },
    ] });
    expect(await r.say("\u25b8 Yes")).toEqual({ sessionId: "h1", chainId: "main" });
    expect(r.launcherAsked).toEqual([]);

    // A silent turn reached no one: it does not keep the head.
    const r2 = rig();
    r2.existing("h1", r2.clock.now - 5 * IDLE_MS, { history: [
      { role: "user", text: "ship it", at: r2.clock.now - 2 * IDLE_MS },
      { role: "assistant", text: "<silent>stage moved</silent>", meta: meta(r2.clock.now - IDLE_MS / 2) },
    ] });
    expect(await r2.say("back")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
  });

  it("counts a reply to a run the chain dispatched as an exchange, never one to a scheduled report", async () => {
    const callback = (runId: string, runIds?: string[]) => ({
      role: "system" as const, text: `result of ${runId}`,
      origin: { kind: "task-callback" as const, taskId: "t", runId, sourceSessionId: null, ...(runIds ? { runIds } : {}) },
    });
    const history = (now: number, ...callbacks: ReturnType<typeof callback>[]) => [
      { role: "user" as const, text: "ship it", at: now - 2 * IDLE_MS },
      { role: "assistant" as const, text: "dispatched", meta: meta(now - 2 * IDLE_MS) },
      ...callbacks,
      { role: "assistant" as const, text: "built \u2014 merge?\n---\n[Yes] | [No]", meta: meta(now - IDLE_MS / 2) },
      // A command's note lands without a turn and answers nothing.
      { role: "system" as const, text: "Nothing open.", origin: { kind: "chat-command" as const, command: "status" as const } },
    ];
    const launchers = { r1: "h1" };
    // The head's own dispatch: a button pressed on its result's answer stays in the session.
    const r = rig({ launchers });
    r.existing("h1", r.clock.now - 5 * IDLE_MS, { history: history(r.clock.now, callback("r1")) });
    expect(await r.say("\u25b8 Yes")).toEqual({ sessionId: "h1", chainId: "main" });
    // Only the runs a reply answered are looked up, never the ledger.
    expect(r.launcherAsked).toEqual(["r1"]);
    expect(r.ledger).toEqual([]);

    // One of a batch is enough, and so is one of two results the reply answered together.
    const r2 = rig({ launchers });
    r2.existing("h1", r2.clock.now - 5 * IDLE_MS, { history: history(r2.clock.now, callback("cron", ["cron", "r1"])) });
    expect(await r2.say("\u25b8 Yes")).toEqual({ sessionId: "h1", chainId: "main" });
    const r2b = rig({ launchers });
    r2b.existing("h1", r2b.clock.now - 5 * IDLE_MS, { history: history(r2b.clock.now, callback("r1"), callback("cron")) });
    expect(await r2b.say("\u25b8 Yes")).toEqual({ sessionId: "h1", chainId: "main" });

    // A cron or watch run has no launcher: its report keeps nothing.
    const r3 = rig({ launchers });
    r3.existing("h1", r3.clock.now - 5 * IDLE_MS, { history: history(r3.clock.now, callback("cron")) });
    expect(await r3.say("back")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
    // Nor does a run another chain launched.
    const r3b = rig({ launchers: { r1: "elsewhere" } });
    r3b.existing("h1", r3b.clock.now - 5 * IDLE_MS, { history: history(r3b.clock.now, callback("r1")) });
    expect(await r3b.say("back")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });

    // A user message steered in while a report was being answered: the reply answers the user too.
    const r4 = rig({ launchers });
    r4.existing("h1", r4.clock.now - 5 * IDLE_MS, { history: [
      callback("cron"),
      { role: "user", text: "and the docs?", at: r4.clock.now - 2 * IDLE_MS },
      { role: "assistant", text: "report read; docs next", meta: meta(r4.clock.now - IDLE_MS / 2) },
    ] });
    expect(await r4.say("\u25b8 Yes")).toEqual({ sessionId: "h1", chainId: "main" });

    // Nor does any other system input the head answered: a run's message, a restart.
    const r5 = rig({ launchers });
    r5.existing("h1", r5.clock.now - 5 * IDLE_MS, { history: [
      { role: "user", text: "ship it", at: r5.clock.now - 2 * IDLE_MS },
      { role: "assistant", text: "on it", meta: meta(r5.clock.now - 2 * IDLE_MS) },
      { role: "system", text: "progress", origin: { kind: "task-message", taskId: "t", runId: "r1", sourceSessionId: "w1", messageId: "x", messageKind: "follow_up" } },
      { role: "assistant", text: "noted", meta: meta(r5.clock.now - IDLE_MS / 2) },
    ] });
    expect(await r5.say("back")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
  });

  it("carries the head's model and effort into the next session with the ledger since its start, not its subject", async () => {
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

    expect(await r.say("new day")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
    expect(r.created).toEqual([{ cwd: r.home, model: { provider: "p", id: "strong" }, thinking: "high" }]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: startedAt }]);
    const seed = r.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "idle", previousSessionId: "h1" });
    // In flight and failed runs only: a succeeded or skipped one is `pier task runs`' to show.
    expect(seed.text).toContain("`pier task runs`)\n\nr1 · fix · running · session c1 · /wt\nr2 · look · queued · session — · —\nr4 · broke · failed · session c4 · /wt4\nr5 · cut off · interrupted · session c5 · —");
    expect(seed.text).not.toContain("r3 ·");
    expect(seed.text).not.toContain("r6 ·");
    // An idle head starts on a new subject: nothing of where the previous one left off.
    expect(seed.text).not.toContain("## Previous session");
    expect(seed.text).not.toContain("answer 4");
    expect(r.chain.members("main").map((m) => [m.sessionId, m.reason])).toEqual([["m1", "idle"], ["h1", "first"]]);
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
    expect(await r.say("later")).toEqual({ sessionId: "m2", chainId: "main", rotated: "idle" });
    expect(r.created.at(-1)).toEqual({ cwd: r.home, model: { provider: "p", id: "newer" }, thinking: "xhigh" });

    // Only the reasoning set: the model is the previous head's.
    r.defaults.value = { defaultModel: null, defaultThinkingLevel: "minimal" };
    expect(await r.say("/new")).toMatchObject({ sessionId: "m3" });
    expect(r.created.at(-1)).toEqual({ cwd: r.home, model: { provider: "p", id: "newer" }, thinking: "minimal" });
  });

  it("stamps the seed with the language the previous head's user wrote in", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - 3 * IDLE_MS, { history: [{ role: "user", text: "[Ada<U1> 12:00 lang=zh]\n帮我看看这个问题" }, { role: "assistant", text: "Looking at it now" }] });
    expect(await r.say("new day")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
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
    expect(await r.say("new day")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
    expect(r.created).toEqual([{ cwd: r.home, model: { provider: "p", id: "strong" }, thinking: "high" }]);
  });

  it("starts a new head, named lost, when the head is gone from Pi, and drops the gone one from the chain", async () => {
    const r = rig();
    r.existing("h0", r.clock.now - 2);
    r.db.prepare("INSERT INTO main_chain(session_id, chain_id, started_at, reason) VALUES ('gone', 'main', ?, 'first')").run(r.clock.now - 1);
    expect(await r.say("hi")).toEqual({ sessionId: "m1", chainId: "main", rotated: "lost" });
    expect(r.created).toEqual([{ cwd: r.home, thinking: "low" }]);
    expect(r.sessions.get("m1")!.systemInputs[0]!.origin).toEqual({ kind: "session-seed", reason: "lost", previousSessionId: "gone" });
    // Nothing on disk to page back to: a member left behind would be an unknown session forever.
    expect(r.chain.members("main").map((m) => [m.sessionId, m.reason])).toEqual([["m1", "lost"], ["h0", "first"]]);
    expect(r.chain.chainOf("gone")).toBeUndefined();
  });

  it("replaces a head a read found gone, and nothing else", async () => {
    const r = rig();
    r.existing("h0", r.clock.now - 2);
    // Present, or not the head: a failed read of it is that read's error.
    expect(await r.chain.replaceLost("h0")).toBeUndefined();
    r.db.prepare("INSERT INTO main_chain(session_id, chain_id, started_at, reason) VALUES ('gone', 'main', ?, 'first')").run(r.clock.now - 1);
    expect(await r.chain.replaceLost("h0")).toBeUndefined();
    expect(await r.chain.replaceLost("gone")).toBe("m1");
    expect(r.sessions.get("m1")!.systemInputs[0]!.origin).toEqual({ kind: "session-seed", reason: "lost", previousSessionId: "gone" });
    expect(r.chain.members("main").map((m) => [m.sessionId, m.reason])).toEqual([["m1", "lost"], ["h0", "first"]]);
    // Already moved on: a second read of the gone id starts nothing more.
    expect(await r.chain.replaceLost("gone")).toBeUndefined();
    expect(r.created).toHaveLength(1);
  });

  it("keeps a head whose successor's seed did not land", async () => {
    const r = rig();
    r.existing("h0", r.clock.now - IDLE_MS - 1);
    const create = r.factory.create;
    r.factory.create = async (opts) => {
      const s = await create(opts);
      s.systemInput = () => Promise.reject(new Error("disk full"));
      return s;
    };
    await expect(r.say("back")).rejects.toThrow("disk full");
    expect(r.chain.members("main").map((m) => m.sessionId)).toEqual(["h0"]);
  });

  it("appends the head's <note> lines to its chain's daily note, on its own line, and nobody else's", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    const older = r.existing("h0", r.clock.now - 120_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    await r.router.ensure({ channelId: "web", conversationId: "h0" });
    const file = join(r.home, "chains", "main", "memory", `${day(new Date(r.clock.now))}.md`);
    head.emit({ type: "turn-end", text: "Merged.\n<note>决定：审查默认 balanced</note>" });
    expect(readFileSync(file, "utf8")).toBe("- 决定：审查默认 balanced\n");
    writeFileSync(file, "- edited by hand");
    older.emit({ type: "turn-end", text: "<note>not the head</note>" });
    head.emit({ type: "turn-end", text: "<note>one</note>\n<note>two</note>" });
    expect(readFileSync(file, "utf8")).toBe("- edited by hand\n- one\n- two\n");
  });

  it("appends a <note> the head wrote beside a tool call, before its answer's", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    head.emit({ type: "turn-end", text: "Merged.\n<note>after</note>", earlier: "Checking.\n<note>before</note>" });
    expect(readFileSync(join(r.home, "chains", "main", "memory", `${day(new Date(r.clock.now))}.md`), "utf8")).toBe("- before\n- after\n");
  });

  it("hands a compacted head its open items again, and no one else", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    const older = r.existing("h0", r.clock.now - 120_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    await r.router.ensure({ channelId: "web", conversationId: "h0" });
    head.emit({ type: "context-compacted", before: 100, after: 10 });
    expect(head.systemInputs).toEqual([]);
    r.status.seed = "Open\n- p0 — merged";
    r.status.items.main = ["running"];
    older.emit({ type: "context-compacted", before: 100, after: 10 });
    expect(older.systemInputs).toEqual([]);
    head.emit({ type: "context-compacted", before: 100, after: 10 });
    expect(head.systemInputs).toEqual([{
      text: "[Pier: the context was compacted. The open items as they stand, keys exact:]\nOpen\n- p0 — merged",
      origin: { kind: "open-items", statusSnapshot: { version: 1, items: [expect.objectContaining({ problem: "p0" })], chain: "Main" } },
      mode: "append",
    }]);
  });

  it("tells the head's conversation when its compaction note could not land", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    r.status.seed = "Open\n- p0 — merged";
    head.systemInput = () => Promise.reject(new Error("disk full"));
    const told = vi.spyOn(r.router, "reportTo");
    head.emit({ type: "context-compacted", before: 100, after: 10 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told).toHaveBeenCalledWith("h1", "open items: the note to the compacted head could not reach it: Error: disk full");
  });

  it("appends a head's <note global> to the instance's daily note, whichever chain it heads", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    const head = r.existing("d1", r.clock.now - 60_000);
    r.db.prepare("UPDATE main_chain SET chain_id = ? WHERE session_id = 'd1'").run(design.id);
    await r.router.ensure({ channelId: "web", conversationId: "d1" });
    head.emit({ type: "turn-end", text: "<note global>qiqi prefers zh</note>\n<note>sidebar first</note>" });
    const today = `${day(new Date(r.clock.now))}.md`;
    expect(readFileSync(join(r.home, "memory", today), "utf8")).toBe("- qiqi prefers zh\n");
    expect(readFileSync(join(r.home, "chains", design.id, "memory", today), "utf8")).toBe("- sidebar first\n");
  });

  it("tells the head's conversation when a note could not be written", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 60_000);
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    mkdirSync(r.home, { recursive: true });
    writeFileSync(join(r.home, "memory"), "a file, not the directory");
    const told = vi.spyOn(r.router, "reportTo");
    head.emit({ type: "turn-end", text: "<note global>kept anyway</note>" });
    expect(told).toHaveBeenCalledWith("h1", expect.stringMatching(/^notes: could not append to memory\/.*: kept anyway$/));
  });

  it("never rotates a head mid-turn", async () => {
    const r = rig();
    const head = r.existing("h1", r.clock.now - 5 * IDLE_MS, { hold: true, history: [{ role: "user", text: "old", at: r.clock.now - 5 * IDLE_MS }] });
    await r.router.ensure({ channelId: "web", conversationId: "h1" });
    void head.prompt("long job");
    await Promise.resolve();
    expect(await r.say("and another thing")).toEqual({ sessionId: "h1", chainId: "main" });
    expect(r.created).toEqual([]);
    await head.abort();
  });

  it("rotates a head past the size ceiling, named full, pointing at where the previous one left off", async () => {
    const r = rig();
    const done = new Date(2024, 5, 1, 12, 5).getTime();
    const history = [1, 2, 3, 4].flatMap((i) => [
      { role: "user" as const, text: i === 4 ? "the plan" : `question ${String(i)}`, at: r.clock.now - 60_000 },
      { role: "system" as const, text: `callback ${String(i)}`, origin: { kind: "task-callback" as const, taskId: "t", runId: "r", sourceSessionId: null } },
      { role: "assistant" as const, text: i === 4 ? "agreed\n<topic>menu</topic>" : `answer ${String(i)}`, meta: { completedAt: done, durationMs: 1, tokens: 1 } },
    ]);
    r.existing("h1", r.clock.now - IDLE_MS / 2, { history, contextUsage: { tokens: FULL, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r.say("at the ceiling")).toEqual({ sessionId: "h1", chainId: "main" });

    const r2 = rig();
    r2.existing("h1", r2.clock.now - IDLE_MS / 2, { history, contextUsage: { tokens: FULL + 1, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r2.say("past it")).toEqual({ sessionId: "m1", chainId: "main", rotated: "full" });
    const seed = r2.sessions.get("m1")!.systemInputs[0]!;
    expect(seed.origin).toEqual({ kind: "session-seed", reason: "full", previousSessionId: "h1" });
    expect(seed.text).toContain("the previous one reached 60K tokens");
    expect(seed.text).toContain("## Previous session\n\nsession h1, last on menu at 2024-06-01 12:05\nreplay: `pier search --in h1 --around \"2024-06-01 12:05\"`");
    // No transcript: the replay is one fetch away.
    for (const said of ["question", "the plan", "agreed", "answer", "callback"]) expect(seed.text).not.toContain(said);
    expect(r2.sessions.get("m1")!.prompts[0]).toContain("past it");

    const r3 = rig();
    r3.existing("h1", r3.clock.now - IDLE_MS / 2, { history: history.slice(0, 3), contextUsage: { tokens: FULL + 1, contextWindow: 400_000, compactAt: 100_000 } });
    await r3.say("past it");
    expect(r3.sessions.get("m1")!.systemInputs[0]!.text).toContain("session h1, last on none at 2024-06-01 12:05");
  });

  it("never rotates on size when the size is unknown after a compaction, or mid-turn", async () => {
    const r = rig();
    r.existing("h1", r.clock.now, { contextUsage: { tokens: null, contextWindow: 400_000, compactAt: 100_000 } });
    expect(await r.say("hi")).toEqual({ sessionId: "h1", chainId: "main" });

    const r2 = rig();
    const head = r2.existing("h1", r2.clock.now, { hold: true, contextUsage: { tokens: 2 * FULL, contextWindow: 400_000, compactAt: 100_000 } });
    await r2.router.ensure({ channelId: "web", conversationId: "h1" });
    void head.prompt("long job");
    await Promise.resolve();
    expect(await r2.say("and another thing")).toEqual({ sessionId: "h1", chainId: "main" });
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
    expect(r.chain.chainOf("h0")).toEqual({ chainId: "main", members: ["h1", "h0"] });
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
    expect(r.chain.members("main")).toEqual([]);
    broken = false;
    expect(await r.say("again")).toEqual({ sessionId: "m1", chainId: "main", rotated: "first" });
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
    expect(memory.length).toBeLessThan(4_200);
    expect(memory.endsWith("…")).toBe(true);
    expect(text).toContain("`pier task runs`)\n\nr300 · n · failed");
    expect(text).not.toContain("r1 · n");
  });

  it("keeps the end of a day's notes, where the newest entries are: 1K of the instance's, 2K of the chain's", async () => {
    const r = rig();
    const today = `${day(new Date(r.clock.now))}.md`;
    const lines = Array.from({ length: 400 }, (_, i) => `- entry ${String(i + 1)} ${"x".repeat(20)}`).join("\n");
    mkdirSync(join(r.home, "memory"), { recursive: true });
    mkdirSync(join(r.home, "chains", "main", "memory"), { recursive: true });
    writeFileSync(join(r.home, "memory", today), lines);
    writeFileSync(join(r.home, "chains", "main", "memory", today), lines);
    await r.say("hi");
    const text = r.sessions.get("m1")!.systemInputs[0]!.text;
    const global = text.slice(text.indexOf("## memory/"), text.indexOf("\n\n## chains/main/memory/"));
    expect(global.length).toBeLessThan(1_100);
    expect(global).toMatch(/^## memory\/(\d{4}-\d{2}-\d{2})\.md\n\n… 370 lines omitted, the rest in memory\/\1\.md\n- entry 371 x/);
    const notes = text.slice(text.indexOf("## chains/main/memory/"));
    expect(notes.length).toBeLessThan(2_150);
    expect(notes).toMatch(/^## chains\/main\/memory\/(\d{4}-\d{2}-\d{2})\.md\n\n… 340 lines omitted, the rest in chains\/main\/memory\/\1\.md\n- entry 341 x/);
    expect(notes).toContain("- entry 400 ");
    expect(notes).not.toContain("- entry 1 ");
  });

  it("seeds the newest notes across days until the budget is full, oldest first, each under its own day", async () => {
    const r = rig();
    mkdirSync(join(r.home, "memory"), { recursive: true });
    const at = (daysAgo: number) => day(new Date(r.clock.now - daysAgo * 86_400_000));
    const line = (n: number) => `- ${String(n)} ${"x".repeat(96)}`;
    // A week's silence: the newest day is 7 days back; 8 days back is cut; 9 is never read.
    writeFileSync(join(r.home, "memory", `${at(7)}.md`), [line(1), line(2)].join("\n"));
    writeFileSync(join(r.home, "memory", `${at(8)}.md`), Array.from({ length: 40 }, (_, i) => line(100 + i)).join("\n"));
    writeFileSync(join(r.home, "memory", `${at(9)}.md`), line(900));
    writeFileSync(join(r.home, "memory", "notes.txt"), line(999));
    await r.say("hi");
    const text = r.sessions.get("m1")!.systemInputs[0]!.text;
    const notes = text.slice(text.indexOf("## memory/"), text.indexOf("\n\n## The previous") > 0 ? text.indexOf("\n\n## The previous") : undefined);
    expect(notes.startsWith(`## memory/${at(8)}.md\n\n… `)).toBe(true);
    expect(notes).toContain(`, the rest in memory/${at(8)}.md\n`);
    expect(notes).toContain(`\n\n## memory/${at(7)}.md\n\n${line(1)}\n${line(2)}`);
    expect(notes).toContain(line(139));
    expect(notes).not.toContain(line(100));
    expect(notes).not.toContain("900");
    expect(notes).not.toContain("999");
    expect(notes.length).toBeLessThan(2_200);
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
    expect(await r.say("  /STATUS \n")).toEqual({ sessionId: "m1", chainId: "main", rotated: "first" });
    const m1 = r.sessions.get("m1")!;
    expect(m1.systemInputs.at(-1)).toMatchObject({ text: "Open\n- model menu — merged", origin: { kind: "chat-command", command: "status" }, mode: "append" });
    expect(m1.prompts).toEqual([]);
    for (const text of ["/tmp is full", "/status please", "status", "/stat", "%", "%unknown"]) await r.say(text);
    expect(m1.prompts).toHaveLength(6);
    expect(m1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(1);
    r.clock.now += 1000;
    expect(await r.say(" %Status ")).toEqual({ sessionId: "m1", chainId: "main" });
    expect(m1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(2);
    // A command is the user writing here: the home chat's card gate and the chain list's order read it.
    expect(r.chain.lastUserAt("main")).toBe(r.clock.now);
  });

  it("carries each named run's session with `/status`, for the card to link", async () => {
    const r = rig();
    r.status.sessions = { "r-sess": "s-r" };
    await r.say("/status");
    expect(r.sessions.get("m1")!.systemInputs.at(-1)!.origin).toEqual({ kind: "chat-command", command: "status", sessions: { "r-sess": "s-r" }, statusSnapshot: { version: 1, items: [], chain: "Main" } });
  });

  it("names the chain `/status` answers for in its snapshot, not its text", async () => {
    const r = rig();
    const { chainId } = await r.say("/chain new Design");
    await r.say("/status", chainId);
    const answer = [...r.sessions.values()].flatMap((s) => s.systemInputs).find((i) => i.origin.kind === "chat-command")!;
    expect(answer.text).toBe("Nothing open.");
    expect(answer.origin).toMatchObject({ statusSnapshot: { chain: "Design" } });
  });

  it("rotates on `/new` with the seed as the answer, once when the head was due anyway, and refuses a replying head", async () => {
    const r = rig();
    r.existing("h1", r.clock.now, { history: [{ role: "user", text: "earlier", at: r.clock.now }] });
    expect(await r.say("/new")).toEqual({ sessionId: "m1", chainId: "main", rotated: "new" });
    expect(r.chain.members("main").map((m) => [m.sessionId, m.reason])).toEqual([["m1", "new"], ["h1", "first"]]);
    const m1 = r.sessions.get("m1")!;
    expect(m1.systemInputs).toHaveLength(1);
    expect(m1.systemInputs[0]).toMatchObject({ origin: { kind: "session-seed", reason: "new", previousSessionId: "h1" } });
    expect(m1.systemInputs[0]!.text).toContain("you asked for one with /new");
    expect(m1.prompts).toEqual([]);

    // Due for its own reason: one rotation, not two.
    r.clock.now += 2 * IDLE_MS;
    expect(await r.say("/NEW")).toEqual({ sessionId: "m2", chainId: "main", rotated: "idle" });
    expect(r.chain.members("main")).toHaveLength(3);

    // A replying head is stopped, then rotated: the reply was the old subject's.
    const m2 = r.sessions.get("m2")!;
    m2.setState("streaming");
    expect(await r.say("/new")).toEqual({ sessionId: "m3", chainId: "main", rotated: "new" });
    expect(m2.calls).toContain("abort");
    expect(r.chain.members("main")).toHaveLength(4);
    expect(m2.systemInputs.filter((i) => i.origin.kind === "chat-command")).toEqual([]);
  });

  it("rotates on `/new <text>` and sends the text to the next head as its first message", async () => {
    const r = rig();
    r.existing("h1", r.clock.now, { history: [{ role: "user", text: "earlier", at: r.clock.now }] });
    r.clock.now += 1;
    expect(await r.say("/new  what about caching?")).toEqual({ sessionId: "m1", chainId: "main", rotated: "new" });
    const m1 = r.sessions.get("m1")!;
    expect(m1.calls.map((c) => c.split(":").slice(0, 2).join(":"))).toEqual(["systemInput:session-seed", expect.stringMatching(/^prompt:/)]);
    expect(m1.prompts[0]).toContain("what about caching?");
    expect(m1.prompts[0]).not.toContain("/new");
    expect(r.sessions.get("h1")!.prompts).toEqual([]);
    // A message, not a note: it orders the chain list as the user's newest.
    expect(r.chain.lastUserAt("main")).toBe(r.clock.now);
  });

  it("aborts the head's turn on `/stop` and says so, or says nothing was running", async () => {
    const r = rig({ head: "h1" });
    const h1 = r.existing("h1", r.clock.now, { hold: true });
    await r.say("go");
    expect(h1.state).toBe("streaming");
    expect(await r.say("/stop")).toEqual({ sessionId: "h1", chainId: "main" });
    expect(h1.state).toBe("idle");
    expect(h1.calls.slice(-2)).toEqual(["abort", "systemInput:chat-command:append:stopped"]);
    expect(h1.systemInputs.at(-1)).toEqual({ text: "stopped", origin: { kind: "chat-command", command: "stop" }, mode: "append" });
    await r.say("/stop");
    expect(h1.calls.at(-1)).toBe("systemInput:chat-command:append:nothing running");
    expect(h1.calls.filter((c) => c === "abort")).toHaveLength(1);
  });

  it("`/stop` counts the chain's runs still in flight: the head's turn stopped, not its work", async () => {
    const run = (runId: string, finishedAt: number | null): LedgerRun => ({ runId, name: runId, state: finishedAt === null ? "running" : "succeeded", targetSessionId: null, cwd: null, queuedAt: 1, finishedAt });
    const r = rig({ head: "h1", runs: [run("a", null), run("b", null), run("c", 5)] });
    const h1 = r.existing("h1", r.clock.now, { hold: true });
    await r.say("go");
    await r.say("/stop");
    expect(h1.systemInputs.at(-1)?.text).toBe("stopped \u00b7 2 runs still running");
    expect(r.ledger.at(-1)).toEqual({ ids: ["h1"], since: r.clock.now });
    await r.say("/stop");
    expect(h1.systemInputs.at(-1)?.text).toBe("nothing running \u00b7 2 runs still running");

    const r1 = rig({ head: "h1", runs: [run("a", null)] });
    const one = r1.existing("h1", r1.clock.now, { hold: true });
    await r1.say("go");
    await r1.say("/stop");
    expect(one.systemInputs.at(-1)?.text).toBe("stopped \u00b7 1 run still running");
  });

  it("names the runs a head launched in a turn, by the turn's start", async () => {
    const runs: LedgerRun[] = [
      { runId: "r1", name: "fix", state: "running", targetSessionId: null, cwd: null, queuedAt: 50, finishedAt: null, tier: "balanced" },
      { runId: "r0", name: "older", state: "running", targetSessionId: null, cwd: null, queuedAt: 10, finishedAt: null },
    ];
    const r = rig({ runs });
    expect(r.chain.launched("h1", 40)).toEqual([runs[0]]);
    expect(r.ledger).toEqual([{ ids: ["h1"], since: 40 }]);
  });

  it("closes an item on `/done <item>`, answers its key, and refuses a bare or ambiguous one without a note", async () => {
    const r = rig({ head: "h1" });
    const h1 = r.existing("h1", r.clock.now);
    expect(await r.say("/done auth")).toEqual({ sessionId: "h1", chainId: "main" });
    expect(r.close).toHaveBeenCalledWith("main", "auth");
    expect(h1.systemInputs.at(-1)).toEqual({ text: "\u2713 closed \u00b7 auth fix", origin: { kind: "chat-command", command: "done" }, mode: "append" });
    await expect(r.say("/done log")).rejects.toThrow(ChatCommandRefused);
    await expect(r.say("%done")).rejects.toThrow("/done <item> \u2014 which one?");
    expect(r.close).toHaveBeenCalledTimes(2);
    expect(h1.systemInputs.filter((i) => i.origin.kind === "chat-command")).toHaveLength(1);
    expect(h1.prompts).toEqual([]);
  });

  it("lists the head's skills on `/skills`, one line each, or says there are none", async () => {
    const r = rig({ head: "h1" });
    const h1 = r.existing("h1", r.clock.now, {
      skills: [{ name: "pier-tasks", description: "run a task" }, { name: "pier-web", description: "search the web" }],
    });
    expect(await r.say("%skills")).toEqual({ sessionId: "h1", chainId: "main" });
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
    r.chain.send({ senderId: "u1", sender: { id: "u1", name: "qiqi" }, text, mode: "steer" }, "main", KEY);

  it("dispatches under that key, the head attached under it, and so is a rotation's next head", async () => {
    const r = rig();
    const im = lark();
    r.router.registerChannel(im.channel);
    expect(await send(r, "hello")).toEqual({ sessionId: "m1", chainId: "main", rotated: "first" });
    expect(r.router.conversationOf("m1")).toEqual(KEY);
    expect(r.router.sessionOf(KEY)?.id).toBe("m1");
    expect(r.sessions.get("m1")!.prompts[0]).toContain("lark:oc_home");
    // The seed reached the chat: attached before it was appended.
    expect(im.notes.map(([id, o]) => [id, o.kind])).toEqual([["oc_home", "session-seed"]]);

    r.clock.now += 2 * IDLE_MS;
    expect(await send(r, "back")).toEqual({ sessionId: "m2", chainId: "main", rotated: "idle" });
    expect(r.router.sessionOf(KEY)?.id).toBe("m2");
    expect(r.router.conversationOf("m2")).toEqual(KEY);
    // The previous head keeps no delivery: its next turn would otherwise answer in the chat too.
    expect(r.router.conversationOf("m1")).toEqual({ channelId: "web", conversationId: "m1" });
    expect(im.notes.at(-1)).toEqual(["oc_home", expect.objectContaining({ kind: "session-seed", reason: "idle" })]);
    expect(r.sessions.get("m2")!.prompts[0]).toContain("back");
  });

  it("keys the head, a rotation's next head and a /new to the web a user typed on, the chat's next word taking it back", async () => {
    const r = rig({ chat: KEY });
    const im = lark();
    r.router.registerChannel(im.channel);
    await send(r, "hello");
    expect(im.notes).toHaveLength(1);

    r.clock.now += 2 * IDLE_MS;
    expect(await r.say("from the browser")).toEqual({ sessionId: "m2", chainId: "main", rotated: "idle" });
    expect(r.router.conversationOf("m2")).toEqual({ channelId: "web", conversationId: "m2" });
    expect((await r.say("/new")).sessionId).toBe("m3");
    expect(r.router.conversationOf("m3")).toEqual({ channelId: "web", conversationId: "m3" });
    // Neither seed reached the chat: the user is on the web.
    expect(im.notes).toHaveLength(1);

    await send(r, "/status");
    expect(r.router.conversationOf("m3")).toEqual(KEY);
    expect(im.notes.at(-1)).toEqual(["oc_home", expect.objectContaining({ kind: "chat-command", command: "status" })]);
  });

  it("answers `/status` in the chat while the head is still replying", async () => {
    const r = rig({ head: "h1" });
    const im = lark();
    r.router.registerChannel(im.channel);
    const h1 = r.existing("h1", r.clock.now, { hold: true });
    await send(r, "go");
    expect(h1.state).toBe("streaming");
    expect(await send(r, "/status")).toEqual({ sessionId: "h1", chainId: "main" });
    expect(h1.state).toBe("streaming");
    expect(im.notes.at(-1)).toEqual(["oc_home", expect.objectContaining({ kind: "chat-command", command: "status" })]);
  });
});

describe("one chain per topic", () => {
  it("keeps a head per chain, each rotating on its own, and answers which chain a session is in", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    expect(await r.say("hi")).toEqual({ sessionId: "m1", chainId: "main", rotated: "first" });
    expect(await r.say("sidebar?", design.id)).toEqual({ sessionId: "m2", chainId: design.id, rotated: "first" });
    expect(await r.say("again")).toEqual({ sessionId: "m1", chainId: "main" });
    expect(r.chain.members(design.id).map((m) => m.sessionId)).toEqual(["m2"]);
    expect(r.chain.chainOf("m2")).toEqual({ chainId: design.id, members: ["m2"] });
    expect(r.chain.headOf("m2")).toBe("m2");
    expect(r.chain.headOf("child")).toBe("child");
    expect(r.chain.isHead("m1")).toBe(true);
    expect(r.chain.firstHead()).toBe("m1");
    expect(r.chain.heads()).toEqual([{ chainId: "main", sessionId: "m1" }, { chainId: design.id, sessionId: "m2" }]);
    expect(r.chain.lastUserAt(design.id)).toBe(r.clock.now);
    expect(r.chain.lastUserAt("other")).toBeUndefined();
  });

  it("knows each chain's last user message after a restart, from its head's transcript", async () => {
    const r = rig();
    r.existing("h1", r.clock.now - IDLE_MS, { history: [{ role: "user", text: "earlier", at: r.clock.now - 5_000 }, { role: "assistant", text: "ok" }] });
    const restarted = r.restart();
    await vi.waitFor(() => expect(restarted.lastUserAt("main")).toBe(r.clock.now - 5_000));
  });

  it("counts idle from each chain's own last user message", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    const history = (at: number) => [{ role: "user" as const, text: "earlier", at }];
    r.existing("h1", r.clock.now - 5 * IDLE_MS, { history: history(r.clock.now - IDLE_MS) });
    r.existing("d1", r.clock.now - 5 * IDLE_MS, { history: history(r.clock.now - IDLE_MS / 2) });
    r.db.prepare("UPDATE main_chain SET chain_id = ? WHERE session_id = 'd1'").run(design.id);
    expect(await r.say("sidebar again", design.id)).toEqual({ sessionId: "d1", chainId: design.id });
    expect(await r.say("main again")).toEqual({ sessionId: "m1", chainId: "main", rotated: "idle" });
    expect(r.chain.chainOf("h1")).toEqual({ chainId: "main", members: ["m1", "h1"] });
    expect(r.chain.headOf("h1")).toBe("m1");
  });

  it("has no first head before the first chain's first message", () => {
    expect(rig().chain.firstHead()).toBeNull();
  });

  it("does not hold one chain's send behind another's", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    let release = (): void => undefined;
    r.defaults.value = { defaultModel: null, defaultThinkingLevel: null };
    const slow = vi.spyOn(r.factory, "create").mockImplementationOnce(async (opts) => {
      await new Promise<void>((resolve) => { release = resolve; });
      slow.mockRestore();
      return r.factory.create(opts);
    });
    const main = r.say("hi");
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    expect(await r.say("sidebar?", design.id)).toMatchObject({ chainId: design.id, rotated: "first" });
    release();
    expect(await main).toMatchObject({ chainId: "main", rotated: "first" });
  });

  it("seeds a head with its chain's name, memory and the other chains in chain mode, and only its own runs", async () => {
    const r = rig({ runs: (ids) => ids.map((id) => ({ runId: `r-${id}`, name: "n", state: "failed" as const, targetSessionId: null, cwd: null, queuedAt: 1, finishedAt: 2 })) });
    await r.say("hi");
    const plain = r.sessions.get("m1")!.systemInputs[0]!.text;
    expect(plain).toMatch(/^\[Pier: a new session of chain "Main" — the first one\. Your chain's memory: chains\/main\/MEMORY\.md, notes chains\/main\/memory\/\./);
    // Session mode: the one chain's items are `## Open`.
    expect(plain).not.toContain("## Chains");

    r.mode.on = true;
    const design = r.chains.create("Design");
    mkdirSync(join(r.home, "chains", design.id), { recursive: true });
    writeFileSync(join(r.home, "chains", design.id, "MEMORY.md"), "the sidebar is a list");
    r.status.items = { main: ["waiting on you", "running"], [design.id]: ["running"] };
    const archived = r.chains.create("Old");
    r.chains.archive(archived.id);
    await r.say("sidebar?", design.id);
    const seed = r.sessions.get("m2")!.systemInputs[0]!.text;
    expect(seed).toContain(`## chains/${design.id}/MEMORY.md\n\nthe sidebar is a list\n\n## Open`);
    expect(seed).toContain(`## Chains\n\nMain · 2 open · 1 waiting on you\nDesign · 1 open · 0 waiting on you (this one)\n\n## Runs`);
    expect(seed).not.toContain("Old ·");
    expect(r.ledger.at(-1)!.ids).toEqual([]);
    expect(seed).not.toContain("r-m1");
  });

  it("refuses a message to an archived chain, its head still answering for what it launched", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    await r.say("hi", design.id);
    r.chains.archive(design.id);
    await expect(r.say("more", design.id)).rejects.toThrow(ChainArchived);
    await expect(r.say("/status", design.id)).rejects.toThrow("chain: Design is archived — unarchive first");
    expect(r.chain.headOf("m1")).toBe("m1");
    expect(r.chain.heads()).toContainEqual({ chainId: design.id, sessionId: "m1" });
  });
});

describe("/chain", () => {
  it("lists the chains on the head, the current one ticked and archived ones last", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    const old = r.chains.create("Old");
    r.chains.archive(old.id);
    r.status.items = { [design.id]: ["waiting on you", "running"] };
    const text = "Main · 0 open · 0 waiting on you\n✓ Design · 2 open · 1 waiting on you\nOld · 0 open · 0 waiting on you (archived)";
    // Before the chain's first message there is no head to say it on: the surface shows it, and no head starts for it.
    expect(await r.say("/chain", design.id)).toEqual({ chainId: design.id, answer: text });
    expect(r.created).toHaveLength(0);
    await r.say("hi", design.id);
    expect(await r.say("/chain", design.id)).toEqual({ sessionId: "m1", chainId: design.id });
    expect(r.sessions.get("m1")!.systemInputs.at(-1)).toMatchObject({ text, origin: { kind: "chat-command", command: "chain" } });
    expect(r.sessions.get("m1")!.prompts).toHaveLength(1);
    // A list changes nothing: no surface re-reads for it.
    expect(r.changed).not.toHaveBeenCalled();
    // An archived chain lists too, its head untouched.
    expect(await r.say("/chain", old.id)).toEqual({ chainId: old.id, answer: text.replace("✓ Design", "Design").replace("Old", "✓ Old") });
    expect(r.created).toHaveLength(1);
  });

  it("switches by unique prefix without touching either head, and refuses an archived or ambiguous one", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    r.chains.create("Desktop");
    const old = r.chains.create("Old");
    r.chains.archive(old.id);
    await r.say("hi");
    expect(await r.say("/chain desi")).toEqual({ chainId: design.id, switched: expect.objectContaining({ id: design.id, name: "Design" }) });
    expect(r.created).toHaveLength(1);
    // Every surface's list and the home chat's card follow a switch from any surface.
    expect(r.changed).toHaveBeenCalledTimes(1);
    await r.say("sidebar?", design.id);
    expect(await r.say("%chain MAIN", design.id)).toEqual({ sessionId: "m1", chainId: "main", switched: expect.objectContaining({ id: "main" }) });
    await expect(r.say("/chain des")).rejects.toThrow("/chain des matches Design, Desktop — say more");
    await expect(r.say("/chain old")).rejects.toThrow("chain: Old is archived — unarchive first");
    // Out of an archived chain is the one thing it takes.
    expect(await r.say("/chain main", old.id)).toMatchObject({ chainId: "main" });
    expect(r.sessions.get("m1")!.prompts).toHaveLength(1);
  });

  it("creates and switches on `/chain new`, turning chain mode on first", async () => {
    const r = rig();
    // A refused name in Session mode leaves Session mode.
    await expect(r.say("/chain new")).rejects.toThrow("chain: name must be 1–40 characters");
    expect(r.mode.on).toBe(false);
    expect(r.changed).not.toHaveBeenCalled();
    r.mode.set.mockClear();
    const sent = await r.say("/chain new  Design ");
    expect(sent).toEqual({ chainId: expect.any(String), switched: expect.objectContaining({ name: "Design" }) });
    expect(r.chains.get(sent.chainId)?.name).toBe("Design");
    expect(r.mode.set).toHaveBeenCalledWith(true);
    expect(r.chain.lastUserAt(sent.chainId)).toBe(r.clock.now);
    await r.say("/chain new Other", sent.chainId);
    expect(r.mode.set).toHaveBeenCalledTimes(1);
    await expect(r.say("/chain new design")).rejects.toThrow('chain: "design" exists');
    await expect(r.say("/chain new")).rejects.toThrow("chain: name must be 1–40 characters");
  });

  it("renames the current chain and answers with the list, on the head when it has one", async () => {
    const r = rig();
    expect(await r.say("/chain rename  Home ")).toEqual({ chainId: "main", answer: "✓ Home · 0 open · 0 waiting on you" });
    expect(r.chains.get("main")?.name).toBe("Home");
    expect(r.changed).toHaveBeenCalledTimes(1);
    expect(r.created).toHaveLength(0);
    await r.say("hi");
    expect(await r.say("/chain rename Main")).toMatchObject({ sessionId: "m1", chainId: "main" });
    expect(r.sessions.get("m1")!.systemInputs.at(-1)!.text).toBe("✓ Main · 0 open · 0 waiting on you");
    await expect(r.say("/chain rename archive")).rejects.toThrow('chain: "archive" is a /chain verb — pick another name');
  });

  it("archives the current chain onto the first, refusing one with open items and the last active one", async () => {
    const r = rig();
    const design = r.chains.create("Design");
    r.status.items = { [design.id]: ["running"] };
    await expect(r.say("/chain archive", design.id)).rejects.toThrow(ChainHasOpen);
    r.status.items = {};
    expect(await r.say("/chain archive", design.id)).toEqual({ chainId: "main", switched: expect.objectContaining({ id: "main" }) });
    expect(r.chains.get(design.id)?.archivedAt).not.toBeNull();
    await expect(r.say("/chain archive")).rejects.toThrow("chain: Main is the only active chain");
  });
});
