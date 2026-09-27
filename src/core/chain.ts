// Which session takes the user's message: an ordered chain of main sessions in
// `$PIER_HOME/home`, whose newest — the head — takes every one, rotated lazily
// once idle past an hour or full (docs/design/10-continuous-session.md).

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDefaults } from "../agent/types.js";
import { transact } from "../db.js";
import { logger } from "../log.js";
import { day } from "./identity.js";
import type { Router } from "./router.js";
import { CHAIN_FULL_TOKENS, CHAIN_IDLE_MS, isChatCommand } from "./types.js";
import type {
  AgentFactory, AgentSession, ChainMember, ChainReason, ChatCommand, ChatTurn, ConversationKey, InboundMessage, LedgerRun,
} from "./types.js";

const log = logger("core");

const EXCHANGES = 3;

export interface ChainDeps {
  factory: AgentFactory;
  router: Router;
  home: string;
  /** Runs launched by any of `sessionIds`, newest first: in flight, or finished at or after `since`. */
  ledger: (sessionIds: string[], since: number) => LedgerRun[];
  /** The open items' one text, for `/status` and the seed; `sessions`, run id → session id, for the card to link. */
  status: (now: number) => { text: string; sessions: Record<string, string> };
  /** The operator's Settings default model and reasoning, read at each new head. */
  defaults: () => Promise<AgentDefaults>;
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

/** `/skills`' answer on every surface, the head's and a thread's (channels/). */
export const skillsText = (skills: { name: string; description: string }[]): string =>
  skills.map((s) => `${s.name} — ${s.description}`).join("\n") || "no skills";

/** Only the exact word is a command: the composer is not a shell. */
function chatCommand(text: string): ChatCommand | undefined {
  const draft = text.trim().toLowerCase();
  const word = draft.slice(1);
  return /^[/%]/.test(draft) && isChatCommand(word) ? word : undefined;
}

export class MainChain {
  /** Sends pass one at a time, so two cannot both find the head idle and rotate twice. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The chat the send in flight came from, if any: the head is attached under
   *  it before anything is appended, so the seed reaches the chat too. */
  private chat?: ConversationKey;

  constructor(private readonly db: DatabaseSync, private readonly deps: ChainDeps) {}

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

  /** Resolve the head, rotating it first when due, then dispatch to `key` (a
   *  chat's) or else the head's own; `command` names a chat command, answered
   *  without a turn. */
  send(message: Omit<InboundMessage, "key">, key?: ConversationKey): Promise<{ sessionId: string; rotated?: ChainReason; command?: ChatCommand }> {
    const command = chatCommand(message.text);
    if (command) return this.serial(key, (session, rotated) => this.command(command, session, rotated)).then((head) => ({ ...head, command }));
    return this.serial(key, async (session) => {
      await this.deps.router.dispatch({ ...message, key: key ?? webKey(session.id) });
    });
  }

  /** `status`, `stop` and `skills` answer with a card on the head; `new` answers with the
   *  next head's seed card — a head just rotated for its own reason is that answer. */
  private async command(command: ChatCommand, session: AgentSession, rotated?: ChainReason): Promise<Head | undefined> {
    const origin = { kind: "chat-command" as const, command };
    if (command === "new") {
      if (session.state === "streaming") throw new ChatCommandRefused("the conversation is replying — /stop first");
      if (rotated) return undefined;
      return { session: await this.rotate("new", this.members()[0], session), rotated: "new" };
    }
    if (command === "skills") {
      await session.systemInput(skillsText(session.skills()), origin, "append");
      return undefined;
    }
    if (command === "stop") {
      const running = session.state === "streaming";
      if (running) await session.abort();
      await session.systemInput(running ? "stopped" : "nothing running", origin, "append");
      return undefined;
    }
    const { text, sessions } = this.deps.status(this.now());
    await session.systemInput(text, { ...origin, sessions }, "append");
    return undefined;
  }

  /** `then` may rotate again and return the head it made; the caller's answer is that one. */
  private serial(key: ConversationKey | undefined, then: (head: AgentSession, rotated?: ChainReason) => Promise<Head | undefined | void>): Promise<{ sessionId: string; rotated?: ChainReason }> {
    const done = this.queue.then(async () => {
      this.chat = key;
      const found = await this.current();
      if (key) this.deps.router.attach(key, found.session);
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
    // An unset or unreadable default keeps the previous head's choice, then Pi's model at low effort.
    const defaults = await this.deps.defaults().catch((err: unknown) => {
      log.warn("the Settings defaults could not be read — the next main session keeps the previous one's model", err);
      return { defaultModel: null, defaultThinkingLevel: null };
    });
    const model = defaults.defaultModel ?? open?.model;
    mkdirSync(this.deps.home, { recursive: true });
    const session = await this.deps.factory.create({
      cwd: this.deps.home,
      ...(model ? { model } : {}),
      thinking: defaults.defaultThinkingLevel ?? open?.thinkingLevel ?? "low",
    });
    transact(this.db, () => {
      this.db.prepare("INSERT INTO main_chain(session_id, started_at, reason) VALUES (?, ?, ?)").run(session.id, this.now(), reason);
      // A lost head has no transcript to page back to; the new head's reason says it went.
      if (reason === "lost" && previous) this.db.prepare("DELETE FROM main_chain WHERE session_id = ?").run(previous.sessionId);
    });
    this.deps.router.attach(webKey(session.id), session);
    if (this.chat) this.deps.router.attach(this.chat, session);
    await session.systemInput(seed, { kind: "session-seed", reason, previousSessionId: previous?.sessionId ?? null }, "append");
    log.info(`main session ${session.id} started (${reason})`);
    return session;
  }

  /** Read fresh at every rotation; a part that cannot be read says so in the seed. */
  private async seed(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<string> {
    const today = new Date(this.now());
    const days = [new Date(today.getTime() - 86_400_000), today].map(day);
    const runs = this.deps.ledger(this.members().map((m) => m.sessionId), previous?.startedAt ?? this.now());
    const section = (title: string, text: string): string => (text ? `## ${title}\n\n${text}` : "");
    return [
      `[Pier: a new session of the continuous conversation — ${WHY[reason]}. The rest of this note is context, not a message.]`,
      section("MEMORY.md", await this.read("MEMORY.md")),
      section("Open", this.deps.status(this.now()).text),
      section("Runs — in flight, and finished since the previous session started", runs.map(ledgerLine).join("\n") || "none"),
      ...(await Promise.all(days.map(async (date) => section(`memory/${date}.md`, await this.read(join("memory", `${date}.md`)))))),
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
