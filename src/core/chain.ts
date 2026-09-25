// The continuous conversation: an ordered chain of main sessions in
// `$PIER_HOME/home`, whose newest — the head — takes every user message,
// rotated lazily once idle past an hour (docs/design/10-continuous-session.md).

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../log.js";
import type { Router } from "./router.js";
import { CHAIN_IDLE_MS } from "./types.js";
import type { AgentFactory, AgentSession, ChainMember, ChainReason, ChatTurn, ConversationKey, InboundMessage } from "./types.js";

const log = logger("core");

/** Where a main session compacts; above 200K input, 1M-context models price higher. */
export const MAIN_COMPACTION_CAP = 100_000;
const EXCHANGES = 3;

/** One run of the ledger, as `pier task runs` prints it. */
export interface LedgerRun {
  runId: string;
  name: string;
  state: string;
  targetSessionId: string | null;
  cwd: string | null;
  queuedAt: number;
  finishedAt: number | null;
}

export interface ChainDeps {
  factory: AgentFactory;
  router: Router;
  home: string;
  enabled: () => boolean;
  /** Runs launched by any of `sessionIds`: in flight, or finished at or after `since`. */
  ledger: (sessionIds: string[], since: number) => LedgerRun[];
  now?: () => number;
}

const WHY: Record<ChainReason, string> = {
  first: "the first one",
  idle: "the previous one was idle for an hour",
  lost: "the previous one is gone from Pi",
};

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

export class MainChain {
  /** Sends pass one at a time, so two cannot both find the head idle and rotate twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: DatabaseSync, private readonly deps: ChainDeps) {}

  enabled(): boolean {
    return this.deps.enabled();
  }

  /** Newest first. */
  members(): ChainMember[] {
    const rows = this.db.prepare("SELECT session_id, started_at, reason FROM main_chain ORDER BY started_at DESC, rowid DESC")
      .all() as { session_id: string; started_at: number; reason: ChainReason }[];
    return rows.map((r) => ({ sessionId: r.session_id, startedAt: r.started_at, reason: r.reason }));
  }

  isMember(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM main_chain WHERE session_id = ?").get(sessionId) !== undefined;
  }

  /** Who counts as `sessionId` for a run it launched: every member, for a member. */
  launchers(sessionId: string): string[] {
    return this.isMember(sessionId) ? this.members().map((m) => m.sessionId) : [sessionId];
  }

  /** Where a result owed to `sessionId` goes: the head, for any member. */
  headOf(sessionId: string): string {
    return this.isMember(sessionId) ? this.members()[0]!.sessionId : sessionId;
  }

  /** For every open of a session: a member runs at the main cap however it was opened. */
  readonly opened = (session: AgentSession): AgentSession => {
    if (this.enabled() && this.isMember(session.id)) session.setCompactionCap(MAIN_COMPACTION_CAP);
    return session;
  };

  /** The alias send: resolve the head, rotating it first when due, then dispatch to its own key. */
  send(message: Omit<InboundMessage, "key">): Promise<{ sessionId: string; rotated?: ChainReason }> {
    return this.serial(async (session) => {
      await this.deps.router.dispatch({ ...message, key: webKey(session.id) });
    });
  }

  /** The head a message sent now would reach, rotated first when due — so a
   *  surface can be watching the new head before its first message fails there. */
  resolve(): Promise<{ sessionId: string; rotated?: ChainReason }> {
    return this.serial(async () => {});
  }

  private serial(then: (head: AgentSession) => Promise<void>): Promise<{ sessionId: string; rotated?: ChainReason }> {
    const done = this.queue.then(async () => {
      const { session, rotated } = await this.current();
      await then(session);
      return { sessionId: session.id, ...(rotated ? { rotated } : {}) };
    });
    this.queue = done.catch(() => undefined);
    return done;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async current(): Promise<{ session: AgentSession; rotated?: ChainReason }> {
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
    if (session.state === "streaming" || this.now() - spoke < CHAIN_IDLE_MS) return { session };
    return { session: await this.rotate("idle", head, session), rotated: "idle" };
  }

  private async rotate(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<AgentSession> {
    mkdirSync(this.deps.home, { recursive: true });
    const session = await this.deps.factory.create({
      cwd: this.deps.home,
      ...(open?.model ? { model: open.model } : {}),
      thinking: open?.thinkingLevel ?? "low",
    });
    const seed = await this.seed(reason, previous, open);
    this.db.prepare("INSERT INTO main_chain(session_id, started_at, reason) VALUES (?, ?, ?)").run(session.id, this.now(), reason);
    this.deps.router.attach(webKey(session.id), session);
    session.setCompactionCap(MAIN_COMPACTION_CAP);
    await session.systemInput(seed, { kind: "session-seed", reason, previousSessionId: previous?.sessionId ?? null }, "append");
    log.info(`main session ${session.id} started (${reason})`);
    return session;
  }

  /** Read fresh at every rotation; a part that cannot be read says so in the seed. */
  async seed(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<string> {
    const today = new Date(this.now());
    const days = [new Date(today.getTime() - 86_400_000), today].map(localDate);
    const runs = this.deps.ledger(this.members().map((m) => m.sessionId), previous?.startedAt ?? this.now());
    const section = (title: string, text: string): string => (text ? `## ${title}\n\n${text}` : "");
    return [
      `[Pier: a new session of the continuous conversation — ${WHY[reason]}. The rest of this note is context, not a message.]`,
      section("MEMORY.md", await this.read("MEMORY.md")),
      section("Runs — in flight, and finished since the previous session started", runs.map((r) => JSON.stringify(r)).join("\n") || "none"),
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
