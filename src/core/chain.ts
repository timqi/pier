// Which session takes the user's message: an ordered chain of main sessions in
// `$PIER_HOME/home`, whose newest — the head — takes every one, rotated lazily
// once idle past an hour or full (docs/design/10-continuous-session.md).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDefaults } from "../agent/types.js";
import { transact } from "../db.js";
import { logger } from "../log.js";
import { day, userLanguage, withLanguage } from "./identity.js";
import { cut, openItemMarkers } from "./reply.js";
import type { Router } from "./router.js";
import { CHAIN_FULL_TOKENS, CHAIN_IDLE_MS, chatCommand } from "./types.js";
import type {
  AgentFactory, AgentSession, ChainMember, ChainReason, ChatCommand, ChatTurn, ConversationKey, InboundMessage, LedgerRun, OpenItemsStatus,
} from "./types.js";

const log = logger("core");

const EXCHANGES = 3;
// Seed budgets in chars (10 §Head lifecycle); the ledger is newest first, so its oldest lines go.
const MEMORY_CHARS = 4_000;
// Across every day's notes together: a return after a week still sees the week's last state.
const NOTES_CHARS = 2_000;
const EXCHANGES_CHARS = 4_000;
const LEDGER_CHARS = 4_000;
/** `cut` from the front, whole lines: notes and exchanges grow at the end,
 *  so the newest part stays; the marker says how much went and where it is. */
function tail(text: string, max: number, rest: string): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  let kept = 0;
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size + lines[i]!.length + 1 <= max; i--, kept++) size += lines[i]!.length + 1;
  const dropped = lines.length - kept;
  return [`… ${String(dropped)} lines omitted, the rest in ${rest}`, ...lines.slice(dropped)].join("\n");
}


interface ChainDeps {
  factory: AgentFactory;
  router: Router;
  home: string;
  /** Runs launched by any of `sessionIds`, newest first: in flight, or finished at or after `since`. */
  ledger: (sessionIds: string[], since: number) => LedgerRun[];
  /** A single read supplies the complete seed, compact answer and fixed command snapshot. */
  status: (now: number) => OpenItemsStatus;
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

/** The seed lists what still needs the head: a run that ended well is `pier task runs`' to show. */
const SEED_RUNS_HIDDEN: ReadonlySet<string> = new Set(["succeeded", "skipped"]);

/** `/skills`' answer on every surface, the head's and a thread's (channels/). */
export const skillsText = (skills: { name: string; description: string }[]): string =>
  skills.map((s) => `${s.name} — ${s.description}`).join("\n") || "no skills";

export class MainChain {
  /** Sends pass one at a time, so two cannot both find the head idle and rotate twice. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The chat the send in flight came from, if any: the head is attached under
   *  it before anything is appended, so the seed reaches the chat too. */
  private chat?: ConversationKey;

  constructor(private readonly db: DatabaseSync, private readonly deps: ChainDeps) {
    deps.router.onTurnEnd((sessionId, text) => {
      if (this.members()[0]?.sessionId === sessionId) this.note(sessionId, text);
    });
  }

  /** The head's `<note>` lines, appended to today's daily note: a note costs the head no tool call. */
  private note(sessionId: string, text: string): void {
    const { notes } = openItemMarkers(text);
    if (!notes.length) return;
    const file = join("memory", `${day(new Date(this.now()))}.md`);
    const path = join(this.deps.home, file);
    try {
      mkdirSync(join(this.deps.home, "memory"), { recursive: true });
      // A file the head edited may end mid-line; a note never joins that line.
      const midLine = /[^\n]$/.test(readFileSync(path, { encoding: "utf8", flag: "a+" }));
      appendFileSync(path, (midLine ? "\n" : "") + notes.map((n) => `- ${n}\n`).join(""));
    } catch (err) {
      this.deps.router.reportTo(sessionId, `notes: could not append to ${file} (${String(err)}): ${notes.join(" | ")}`);
    }
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

  /** The current compact answer, complete seed and shared status presentation. */
  status(): OpenItemsStatus {
    return this.deps.status(this.now());
  }

  /** Resolve the head, rotating it first when due, then dispatch to `key` (a
   *  chat's) or else the head's own. */
  send(message: Omit<InboundMessage, "key">, key?: ConversationKey): Promise<{ sessionId: string; rotated?: ChainReason }> {
    const command = chatCommand(message.text);
    if (command) return this.serial(key, (session, rotated) => this.command(command, session, rotated));
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
    const { text, sessions, snapshot } = this.status();
    await session.systemInput(text, { ...origin, sessions, statusSnapshot: snapshot }, "append");
    return undefined;
  }

  /** `then` may rotate again and return the head it made; the caller's answer is that one. */
  private serial(key: ConversationKey | undefined, then: (head: AgentSession, rotated?: ChainReason) => Promise<Head | undefined | void>): Promise<{ sessionId: string; rotated?: ChainReason }> {
    return this.queued(async () => {
      this.chat = key;
      const found = await this.current();
      this.deps.router.heard(key ?? webKey(found.session.id), found.session);
      const { session, rotated } = (await then(found.session, found.rotated)) ?? found;
      return { sessionId: session.id, ...(rotated ? { rotated } : {}) };
    });
  }

  /** A read that finds the head gone from Pi starts the next one, as a send
   *  would; undefined when `sessionId` is not the head or is not gone. */
  replaceLost(sessionId: string): Promise<string | undefined> {
    return this.queued(async () => {
      const head = this.members()[0];
      if (head?.sessionId !== sessionId || !(await this.gone(head))) return undefined;
      this.chat = undefined;
      log.warn(`main session ${head.sessionId} is gone from Pi — starting the next one`);
      return (await this.rotate("lost", head)).id;
    });
  }

  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const done = this.queue.then(fn);
    this.queue = done.catch(() => undefined);
    return done;
  }

  private async gone(head: ChainMember): Promise<boolean> {
    return this.deps.router.stateOf(head.sessionId) === undefined && !(await this.deps.factory.find(head.sessionId));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async current(): Promise<Head> {
    const head = this.members()[0];
    if (!head) return { session: await this.rotate("first"), rotated: "first" };
    if (await this.gone(head)) {
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
    this.deps.router.attach(webKey(session.id), session);
    // The surface the send came from, before the seed: a web send posts no card in the chat.
    this.deps.router.heard(this.chat ?? webKey(session.id), session);
    await session.systemInput(seed, { kind: "session-seed", reason, previousSessionId: previous?.sessionId ?? null }, "append");
    // Only a seeded head joins the chain: one whose seed failed is not the conversation.
    transact(this.db, () => {
      this.db.prepare("INSERT INTO main_chain(session_id, started_at, reason) VALUES (?, ?, ?)").run(session.id, this.now(), reason);
      // A lost head has no transcript to page back to; the new head's reason says it went.
      if (reason === "lost" && previous) this.db.prepare("DELETE FROM main_chain WHERE session_id = ?").run(previous.sessionId);
    });
    log.info(`main session ${session.id} started (${reason})`);
    return session;
  }

  /** Read fresh at every rotation; a part that cannot be read says so in the seed. */
  private async seed(reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<string> {
    const runs = this.deps.ledger(this.members().map((m) => m.sessionId), previous?.startedAt ?? this.now())
      .filter((r) => !SEED_RUNS_HIDDEN.has(r.state));
    const section = (title: string, text: string): string => (text ? `## ${title}\n\n${text}` : "");
    const spoken = open ? await open.history() : [];
    // The user's language rides the seed: a callback landing before they speak here must not answer in its own.
    return withLanguage(userLanguage(spoken), [
      `[Pier: a new session of the continuous conversation — ${WHY[reason]}. The rest of this note is context, not a message.]`,
      section("MEMORY.md", cut(await this.read("MEMORY.md"), MEMORY_CHARS)),
      section("Open", this.deps.status(this.now()).seed),
      section("Runs — in flight, or ended short of success since the previous session started (succeeded and skipped: `pier task runs`)", cut(runs.map(ledgerLine).join("\n"), LEDGER_CHARS) || "none"),
      ...(await this.notes()).map(([name, text]) => section(name, text)),
      // Only a full rotation carries the subject: the user was mid-sentence. An idle, new or lost head starts without it.
      section("The previous session's last exchanges", open && reason === "full" ? tail(lastExchanges(spoken, EXCHANGES), EXCHANGES_CHARS, `session ${open.id}`) : ""),
    ].filter(Boolean).join("\n\n"));
  }

  /** The newest notes under one budget, collected newest day first and listed
   *  oldest first, each under its own file name so the head sees how old the latest is. */
  private async notes(): Promise<[name: string, text: string][]> {
    const files = await readdir(join(this.deps.home, "memory")).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      log.warn("seed: could not list memory/", err);
      return `(could not be read: ${String(err)})`;
    });
    if (typeof files === "string") return [["memory/", files]];
    const parts: [string, string][] = [];
    let left = NOTES_CHARS;
    for (const file of files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()) {
      const name = `memory/${file}`;
      const text = left > 0 ? await this.read(name) : "";
      if (!text) continue;
      parts.unshift([name, tail(text, left, name)]);
      left -= text.length + 1;
    }
    return parts;
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
