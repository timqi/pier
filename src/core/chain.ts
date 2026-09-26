// The continuous conversation: an ordered chain of main sessions in
// `$PIER_HOME/home`, whose newest — the head — takes every user message,
// rotated lazily once idle past an hour or full (docs/design/10-continuous-session.md).

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { transact } from "../db.js";
import { logger } from "../log.js";
import type { EventHub } from "./hub.js";
import { agoLabel, openItemMarkers, relTime } from "./reply.js";
import type { Router } from "./router.js";
import { CHAIN_FULL_TOKENS, CHAIN_IDLE_MS, isChatCommand, LEDGER_WINDOW_MS, NOT_IN_LEDGER, TASK_RUN_STATES } from "./types.js";
import type {
  AgentFactory, AgentRole, AgentSession, ChainMember, ChainReason, ChatCommand, ChatTurn, ConversationKey, InboundMessage, LedgerRun, OpenItems,
  OpenRun, TaskRunState,
} from "./types.js";

const log = logger("core");

const EXCHANGES = 3;

export interface ChainDeps {
  factory: AgentFactory;
  router: Router;
  home: string;
  enabled: () => boolean;
  /** Runs launched by any of `sessionIds`: in flight, or finished at or after `since`. */
  ledger: (sessionIds: string[], since: number) => LedgerRun[];
  /** `TaskStore.roleOf`: a lead run's item line counts the lead's own workers. */
  roleOf: (sessionId: string) => AgentRole | undefined;
  /** `TaskService.openDesigns`, less closed sessions: the designs waiting on the user. */
  designs: () => LedgerRun[];
  /** The head's turn ends carry the open-item markers. */
  hub: EventHub;
  now?: () => number;
}

const WHY: Record<ChainReason, string> = {
  first: "the first one",
  idle: "the previous one was idle for an hour",
  lost: "the previous one is gone from Pi",
  full: `the previous one reached ${String(CHAIN_FULL_TOKENS / 1000)}K tokens`,
  new: "you asked for one with /new",
};

/** A `/new` sent to a head mid-reply: a 409 to the composer, never a card the
 *  head's queue would only deliver after the turn it refuses for. */
export class ChatCommandRefused extends Error {}

type Head = { session: AgentSession; rotated?: ChainReason };

const webKey = (sessionId: string): ConversationKey => ({ channelId: "web", conversationId: sessionId });

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The last `n` user turns and the replies after them, text only. */
function lastExchanges(turns: ChatTurn[], n: number): string {
  const users = turns.flatMap((t, i) => (t.role === "user" ? [i] : []));
  const from = users[Math.max(0, users.length - n)];
  if (from === undefined) return "";
  return turns.slice(from).filter((t) => t.role !== "system" && t.text)
    .map((t) => `${t.role}: ${t.text}`).join("\n\n");
}

const ledgerLine = (r: LedgerRun): string =>
  `${r.runId} · ${r.name} · ${r.state} · session ${r.targetSessionId ?? "—"} · ${r.cwd ?? "—"}`;

/** Only the exact word is a command: the composer is not a shell. */
function chatCommand(text: string): ChatCommand | undefined {
  const draft = text.trim().toLowerCase();
  const word = draft.slice(1);
  return draft.startsWith("/") && isChatCommand(word) ? word : undefined;
}

const runStatus = (r: LedgerRun, now: number): string =>
  r.finishedAt === null ? `${r.state} ${relTime(r.queuedAt, now)}` : `${r.state} ${agoLabel(r.finishedAt, now)}`;

function workersText(workers: Record<TaskRunState, number> | undefined): string {
  if (!workers) return "";
  const counts = TASK_RUN_STATES.filter((s) => workers[s] > 0).map((s) => `${String(workers[s])} ${s}`);
  return ` · workers: ${counts.join(", ") || "none"}`;
}

const runText = (r: OpenRun, now: number): string =>
  r.state === NOT_IN_LEDGER
    ? `run ${r.runId} — ${NOT_IN_LEDGER}`
    : `run ${r.runId.length > 8 ? `${r.runId.slice(0, 8)}…` : r.runId} ${runStatus(r, now)}${workersText(r.workers)}`;

/** The one string every surface shows for the open items: `/status`, the seed, the rail. */
export function renderOpenItems({ items, unlisted, designs }: OpenItems, now: number): string {
  if (!items.length && !unlisted.length && !designs.length) return "Nothing open.";
  const open = items.map((i) => `- ${i.problem}${i.stage ? ` — ${i.stage}` : ""}${i.runs.map((r) => ` · ${runText(r, now)}`).join("")}`);
  const rest = unlisted.map((r) => `- ${r.name} — ${runStatus(r, now)}${workersText(r.workers)}`);
  const decide = designs.map((r) => `- ${r.name} · ${runText(r, now)}`);
  return [
    ...(open.length ? ["Open", ...open] : []),
    ...(rest.length ? ["Not on the list", ...rest] : []),
    ...(decide.length ? ["Designs for you to finalize", ...decide] : []),
  ].join("\n");
}

export class MainChain {
  /** Sends pass one at a time, so two cannot both find the head idle and rotate twice. */
  private queue: Promise<unknown> = Promise.resolve();
  private unwatch?: () => void;

  constructor(private readonly db: DatabaseSync, private readonly deps: ChainDeps) {
    const head = this.members()[0];
    if (head) this.watch(head.sessionId);
  }

  enabled(): boolean {
    return this.deps.enabled();
  }

  /** Newest first. */
  members(): ChainMember[] {
    const rows = this.db.prepare("SELECT session_id, started_at, reason FROM main_chain ORDER BY started_at DESC, rowid DESC")
      .all() as { session_id: string; started_at: number; reason: ChainReason }[];
    return rows.map((r) => ({ sessionId: r.session_id, startedAt: r.started_at, reason: r.reason }));
  }

  /** Every member's id, newest first, when `sessionId` is one: a member's
   *  launches are the whole chain's, and a result owed to it goes to the head. */
  chainOf(sessionId: string): string[] | undefined {
    const ids = this.members().map((m) => m.sessionId);
    return ids.includes(sessionId) ? ids : undefined;
  }

  /** The alias send: resolve the head, rotating it first when due, then dispatch
   *  to its own key; `command` names a chat command, answered without a turn. */
  send(message: Omit<InboundMessage, "key">): Promise<{ sessionId: string; rotated?: ChainReason; command?: ChatCommand }> {
    const command = chatCommand(message.text);
    if (command) return this.serial((session, rotated) => this.command(command, session, rotated)).then((head) => ({ ...head, command }));
    return this.serial(async (session) => {
      await this.deps.router.dispatch({ ...message, key: webKey(session.id) });
    });
  }

  /** `status` and `stop` answer with a card on the head; `new` answers with the
   *  next head's seed card — a head just rotated for its own reason is that answer. */
  private async command(command: ChatCommand, session: AgentSession, rotated?: ChainReason): Promise<Head | undefined> {
    const origin = { kind: "chat-command" as const, command };
    if (command === "new") {
      if (session.state === "streaming") throw new ChatCommandRefused("the conversation is replying — /stop first");
      if (rotated) return undefined;
      return { session: await this.rotate("new", this.members()[0], session), rotated: "new" };
    }
    if (command === "stop") {
      const running = session.state === "streaming";
      if (running) await session.abort();
      await session.systemInput(running ? "stopped" : "nothing running", origin, "append");
      return undefined;
    }
    const open = this.openItems();
    const sessions = Object.fromEntries([...open.items.flatMap((i) => i.runs), ...open.designs]
      .flatMap((r) => (r.targetSessionId ? [[r.runId, r.targetSessionId]] : [])));
    await session.systemInput(renderOpenItems(open, this.now()), { ...origin, sessions }, "append");
    return undefined;
  }

  openItems(): OpenItems {
    const since = this.now() - LEDGER_WINDOW_MS;
    const ids = this.members().map((m) => m.sessionId);
    const runs = ids.length ? this.deps.ledger(ids, since) : [];
    const byId = new Map(runs.map((r) => [r.runId, r]));
    const named = new Set<string>();
    const withWorkers = (r: LedgerRun): OpenRun => {
      if (!r.targetSessionId || this.deps.roleOf(r.targetSessionId) !== "lead") return r;
      const workers = Object.fromEntries(TASK_RUN_STATES.map((s) => [s, 0])) as Record<TaskRunState, number>;
      for (const w of this.deps.ledger([r.targetSessionId], since)) {
        if (w.state in workers) workers[w.state as TaskRunState] += 1;
      }
      return { ...r, workers };
    };
    const rows = this.db.prepare("SELECT problem, stage, run_ids FROM open_items ORDER BY updated_at, rowid")
      .all() as { problem: string; stage: string; run_ids: string }[];
    const items = rows.map((row) => ({
      problem: row.problem,
      stage: row.stage,
      runs: (JSON.parse(row.run_ids) as string[]).map((id): OpenRun => {
        named.add(id);
        const run = byId.get(id);
        return run
          ? withWorkers(run)
          : { runId: id, name: id, state: NOT_IN_LEDGER, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null };
      }),
    }));
    const unlisted = runs.filter((r) => !named.has(r.runId) && r.state !== "succeeded").map(withWorkers);
    return { items, unlisted, designs: this.deps.designs() };
  }

  /** Only the head's turns write the list: a new head takes the subscription over. */
  private watch(sessionId: string): void {
    this.unwatch?.();
    this.unwatch = this.deps.hub.subscribe(sessionId, (e) => {
      if (e.type !== "turn-end" || !e.text) return;
      try {
        this.record(e.text);
      } catch (err) {
        log.warn(`open items: the markers in ${sessionId}'s reply could not be written`, err);
      }
    });
  }

  private record(text: string): void {
    const { markers, dropped } = openItemMarkers(text);
    for (const marker of dropped) log.warn(`open items: dropped a marker with no problem text: ${marker}`);
    if (!markers.length) return;
    const now = this.now();
    const changes = transact(this.db, () => markers.reduce((n, m) => n + Number(m.op === "open"
      ? this.db.prepare(`INSERT INTO open_items(problem, stage, run_ids, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(problem) DO UPDATE SET stage = excluded.stage, run_ids = excluded.run_ids, updated_at = excluded.updated_at`)
        .run(m.problem, m.stage, JSON.stringify(m.runIds), now).changes
      : this.db.prepare("DELETE FROM open_items WHERE problem = ?").run(m.problem).changes), 0));
    if (changes > 0) this.deps.hub.emitWorkspace({ type: "open-items-changed" });
  }

  /** `then` may rotate again and return the head it made; the caller's answer is that one. */
  private serial(then: (head: AgentSession, rotated?: ChainReason) => Promise<Head | undefined | void>): Promise<{ sessionId: string; rotated?: ChainReason }> {
    const done = this.queue.then(async () => {
      const found = await this.current();
      const { session, rotated } = (await then(found.session, found.rotated)) ?? found;
      return { sessionId: session.id, ...(rotated ? { rotated } : {}) };
    });
    this.queue = done.catch(() => undefined);
    return done;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async current(): Promise<Head> {
    const head = this.members()[0];
    if (!head) return { session: await this.rotate("first"), rotated: "first" };
    const live = this.deps.router.stateOf(head.sessionId) !== undefined;
    if (!live && !(await this.deps.factory.find(head.sessionId))) {
      log.warn(`main session ${head.sessionId} is gone from Pi — starting the next one`);
      return { session: await this.rotate("lost", head), rotated: "lost" };
    }
    const session = await this.deps.router.ensure(webKey(head.sessionId));
    // A head with no user message yet counts from its start: its seed is not the user speaking.
    const spoke = (await session.history()).reduce((at, t) => (t.role === "user" && t.at ? t.at : at), head.startedAt);
    if (session.state === "streaming") return { session };
    if (this.now() - spoke >= CHAIN_IDLE_MS) return { session: await this.rotate("idle", head, session), rotated: "idle" };
    // Unknown right after a compaction: that head is small again, not full.
    if ((session.contextUsage?.tokens ?? 0) <= CHAIN_FULL_TOKENS) return { session };
    return { session: await this.rotate("full", head, session), rotated: "full" };
  }

  private async rotate(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<AgentSession> {
    // Built before anything is created: a seed that fails leaves no orphan session.
    const seed = await this.seed(reason, previous, open).catch((err: unknown) => {
      log.warn("the continuous conversation's next session could not be seeded", err);
      throw new Error(`a new session could not start — its seed failed: ${String(err)}`);
    });
    mkdirSync(this.deps.home, { recursive: true });
    const session = await this.deps.factory.create({
      cwd: this.deps.home,
      ...(open?.model ? { model: open.model } : {}),
      thinking: open?.thinkingLevel ?? "low",
    });
    this.db.prepare("INSERT INTO main_chain(session_id, started_at, reason) VALUES (?, ?, ?)").run(session.id, this.now(), reason);
    this.deps.router.attach(webKey(session.id), session);
    this.watch(session.id);
    await session.systemInput(seed, { kind: "session-seed", reason, previousSessionId: previous?.sessionId ?? null }, "append");
    log.info(`main session ${session.id} started (${reason})`);
    return session;
  }

  /** Read fresh at every rotation; a part that cannot be read says so in the seed. */
  private async seed(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<string> {
    const today = new Date(this.now());
    const days = [new Date(today.getTime() - 86_400_000), today].map(localDate);
    const runs = this.deps.ledger(this.members().map((m) => m.sessionId), previous?.startedAt ?? this.now());
    const section = (title: string, text: string): string => (text ? `## ${title}\n\n${text}` : "");
    return [
      `[Pier: a new session of the continuous conversation — ${WHY[reason]}. The rest of this note is context, not a message.]`,
      section("MEMORY.md", await this.read("MEMORY.md")),
      section("Open", renderOpenItems(this.openItems(), this.now())),
      section("Runs — in flight, and finished since the previous session started", runs.map(ledgerLine).join("\n") || "none"),
      ...(await Promise.all(days.map(async (day) => section(`memory/${day}.md`, await this.read(join("memory", `${day}.md`)))))),
      section("The previous session's last exchanges", open ? lastExchanges(await open.history(), EXCHANGES) : ""),
    ].filter(Boolean).join("\n\n");
  }

  private async read(name: string): Promise<string> {
    try {
      return (await readFile(join(this.deps.home, name), "utf8")).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      log.warn(`seed: could not read ${name}`, err);
      return `(could not be read: ${String(err)})`;
    }
  }
}
