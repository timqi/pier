// Which session takes the user's message: per chain, an ordered list of main
// sessions in `$PIER_HOME/home`, whose newest — the head — takes every one,
// rotated lazily once idle past an hour or full (docs/design/10-continuous-session.md).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDefaults } from "../agent/types.js";
import { transact } from "../db.js";
import { logger } from "../log.js";
import { day, minute, userLanguage, withLanguage } from "./identity.js";
import { ChainArchived, type ChainRow, type Chains } from "./chains.js";
import { chainCounts } from "./open-items.js";
import { cut, openItemMarkers, replyTopic } from "./reply.js";
import type { Router } from "./router.js";
import { CHAIN_FULL_TOKENS, CHAIN_IDLE_MS, chatCommand } from "./types.js";
import type {
  AgentFactory, AgentSession, ChainMember, ChainReason, ChatCommand, ChatTurn, ConversationKey, InboundMessage, LedgerRun, OpenItemsStatus,
} from "./types.js";

const log = logger("core");

// Seed budgets in chars (10 §Head lifecycle); the ledger is newest first, so its oldest lines go.
// MEMORY_CHARS is each index's, the global one and the chain's.
const MEMORY_CHARS = 4_000;
// Across every day's notes together: a return after a week still sees the week's last state.
const NOTES_CHARS = 2_000;
const GLOBAL_NOTES_CHARS = 1_000;
const LEDGER_CHARS = 4_000;
/** `cut` from the front, whole lines: notes grow at the end,
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
  chains: Chains;
  /** Runs launched by any of `sessionIds`, newest first: in flight, or finished at or after `since`. */
  ledger: (sessionIds: string[], since: number) => LedgerRun[];
  /** One chain's items: a single read supplies the complete seed, compact answer and fixed command snapshot. */
  status: (now: number, chainId: string) => OpenItemsStatus;
  /** Settings' chainMode: `/chain new` in Session mode turns it on. */
  mode: { get(): boolean; set(on: boolean): Promise<void> };
  /** A `/chain` command switched to, created, renamed or archived a chain, from any surface:
   *  every chain list and the home chat's status card re-read (`chains-changed`). */
  changed: () => void;
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

/** Where the previous head left off, and the one fetch that replays it (15 §Head context). */
function previousSession(id: string, turns: ChatTurn[]): string {
  const last = [...turns].reverse().find((t) => t.role === "assistant");
  const at = last?.meta?.completedAt;
  const item = (last && replyTopic(last.text)) ?? "none";
  if (at === undefined) return `session ${id}, last on ${item}`;
  return `session ${id}, last on ${item} at ${minute(at)}\nreplay: \`pier search --in ${id} --around "${minute(at)}"\``;
}

const ledgerLine = (r: LedgerRun): string =>
  `${r.runId} · ${r.name} · ${r.state} · session ${r.targetSessionId ?? "—"} · ${r.cwd ?? "—"}`;

/** The seed lists what still needs the head: a run that ended well is `pier task runs`' to show. */
const SEED_RUNS_HIDDEN: ReadonlySet<string> = new Set(["succeeded", "skipped"]);

/** `/skills`' answer on every surface, the head's and a thread's (channels/). */
export const skillsText = (skills: { name: string; description: string }[]): string =>
  skills.map((s) => `${s.name} — ${s.description}`).join("\n") || "no skills";

/** What `send` did: the head that took the message; for `/chain <name>`,
 *  `/chain new` and `/chain archive`, the chain the surface switches to, its
 *  head when it has one yet — no head is touched or rotated by a switch; or
 *  `/chain`'s list, answered to the surface when the chain has no head to say it on. */
export type ChainSent =
  | { sessionId: string; chainId: string; rotated?: ChainReason; switched?: undefined; answer?: undefined }
  | { sessionId?: string; chainId: string; switched: ChainRow; answer?: undefined }
  | { sessionId?: undefined; chainId: string; switched?: undefined; answer: string };

export class MainChain {
  /** Per chain, sends pass one at a time, so two cannot both find its head idle and rotate twice. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Per chain, the user's newest message: the chain list's order. */
  private readonly lastUser = new Map<string, number>();

  constructor(private readonly db: DatabaseSync, private readonly deps: ChainDeps) {
    deps.router.onTurnEnd((sessionId, text) => {
      const chain = this.chainOf(sessionId);
      if (chain?.members[0] === sessionId) this.note(sessionId, chain.chainId, text);
    });
    void this.warm();
  }

  /** The head's `<note>` lines go to its chain's daily note, `<note global>` to the
   *  instance's: a note costs the head no tool call. */
  private note(sessionId: string, chainId: string, text: string): void {
    const { notes, globalNotes } = openItemMarkers(text);
    this.append(sessionId, join("chains", chainId, "memory"), notes);
    this.append(sessionId, "memory", globalNotes);
  }

  private append(sessionId: string, dir: string, notes: string[]): void {
    if (!notes.length) return;
    const file = join(dir, `${day(new Date(this.now()))}.md`);
    const path = join(this.deps.home, file);
    try {
      mkdirSync(join(this.deps.home, dir), { recursive: true });
      // A file the head edited may end mid-line; a note never joins that line.
      const midLine = /[^\n]$/.test(readFileSync(path, { encoding: "utf8", flag: "a+" }));
      appendFileSync(path, (midLine ? "\n" : "") + notes.map((n) => `- ${n}\n`).join(""));
    } catch (err) {
      this.deps.router.reportTo(sessionId, `notes: could not append to ${file} (${String(err)}): ${notes.join(" | ")}`);
    }
  }

  /** A restart has no sends yet: each head's last user message orders the list until one comes. */
  private async warm(): Promise<void> {
    for (const { chainId, sessionId } of this.heads()) {
      try {
        const turns = await this.deps.factory.readHistory(sessionId);
        const at = turns?.reduce<number | undefined>((last, t) => (t.role === "user" && t.at ? t.at : last), undefined);
        if (at !== undefined && !this.lastUser.has(chainId)) this.lastUser.set(chainId, at);
      } catch (err) {
        log.warn(`chain ${chainId}: head ${sessionId}'s last user message could not be read — the chain list orders it last`, err);
      }
    }
  }

  /** The register this chain list reads: its surfaces name, create and archive through it. */
  get chains(): Chains {
    return this.deps.chains;
  }

  /** Newest first; the head is `[0]`. */
  members(chainId: string): ChainMember[] {
    const rows = this.db.prepare("SELECT session_id, started_at, reason FROM main_chain WHERE chain_id = ? ORDER BY started_at DESC, rowid DESC")
      .all(chainId) as { session_id: string; started_at: number; reason: ChainReason }[];
    return rows.map((r) => ({ sessionId: r.session_id, startedAt: r.started_at, reason: r.reason }));
  }

  /** The chain `sessionId` is a member of, with every member's id newest first: a
   *  member's launches are its chain's, and a result owed to it goes to that head. */
  chainOf(sessionId: string): { chainId: string; members: string[] } | undefined {
    const row = this.db.prepare("SELECT chain_id FROM main_chain WHERE session_id = ?").get(sessionId) as { chain_id: string } | undefined;
    return row && { chainId: row.chain_id, members: this.members(row.chain_id).map((m) => m.sessionId) };
  }

  /** Every chain's members, each to its chain, in one read: the session list marks them all. */
  memberships(): Map<string, string> {
    const rows = this.db.prepare("SELECT session_id, chain_id FROM main_chain").all() as { session_id: string; chain_id: string }[];
    return new Map(rows.map((r) => [r.session_id, r.chain_id]));
  }

  /** An archived chain's head too: a run it launched still reports there. */
  headOf(sessionId: string): string {
    return this.chainOf(sessionId)?.members[0] ?? sessionId;
  }

  /** Where whatever no chain claims goes; null before the first chain's first message. */
  firstHead(): string | null {
    return this.members(this.deps.chains.first().id)[0]?.sessionId ?? null;
  }

  /** Every chain's head, archived ones included, in the chain list's order. */
  heads(): { chainId: string; sessionId: string }[] {
    return this.deps.chains.list().flatMap((c) => {
      const head = this.members(c.id)[0];
      return head ? [{ chainId: c.id, sessionId: head.sessionId }] : [];
    });
  }

  isHead(sessionId: string): boolean {
    return this.chainOf(sessionId)?.members[0] === sessionId;
  }

  lastUserAt(chainId: string): number | undefined {
    return this.lastUser.get(chainId);
  }

  /** The chain's current compact answer, complete seed and shared status presentation. */
  status(chainId: string): OpenItemsStatus {
    return this.deps.status(this.now(), chainId);
  }

  /** `/chain`'s answer: each chain with its counts, the current one ticked, archived ones last. */
  chainsText(currentId: string): string {
    return this.deps.chains.list()
      .map((c) => `${c.id === currentId ? "✓ " : ""}${this.chainLine(c)}${c.archivedAt === null ? "" : " (archived)"}`).join("\n");
  }

  /** One chain as `/chain` and the seed's `## Chains` list it. */
  private chainLine(c: ChainRow): string {
    const { open, waiting } = chainCounts(this.status(c.id).snapshot.items);
    return `${c.name} · ${String(open)} open · ${String(waiting)} waiting on you`;
  }

  /** Resolve `chainId`'s head, rotating it first when due, then dispatch to `key`
   *  (a chat's) or else the head's own. An archived chain takes nothing but a switch away. */
  async send(message: Omit<InboundMessage, "key">, chainId: string, key?: ConversationKey): Promise<ChainSent> {
    const command = chatCommand(message.text);
    const switched = command?.command === "chain" ? await this.switchTo(command.args, chainId) : undefined;
    if (switched) {
      this.deps.changed();
      const head = this.members(switched.id)[0];
      return { ...(head ? { sessionId: head.sessionId } : {}), chainId: switched.id, switched };
    }
    const chain = this.deps.chains.get(chainId);
    if (!chain) throw new Error(`chain: no chain ${chainId}`);
    // The list and a rename need no head: a chain without one yet, or archived, answers on the surface.
    if (command?.command === "chain" && (chain.archivedAt !== null || !this.members(chainId).length)) {
      return { chainId, answer: this.chainCommand(command.args, chainId) };
    }
    if (chain.archivedAt !== null) throw new ChainArchived(chain.name);
    if (command) return this.serial(chainId, key, (session, rotated) => this.command(command, chain, key, session, rotated));
    this.lastUser.set(chainId, this.now());
    return this.serial(chainId, key, async (session) => {
      await this.deps.router.dispatch({ ...message, key: key ?? webKey(session.id) });
    });
  }

  /** `/chain <name>`, `/chain new <name>` and `/chain archive` answer with the chain
   *  to switch to; the list and `rename` are answered on the head (`command`). */
  private async switchTo(args: string, current: string): Promise<ChainRow | undefined> {
    const [word = "", ...rest] = args.split(/\s+/);
    const verb = word.toLowerCase();
    if (!args || verb === "rename") return undefined;
    if (verb === "new") {
      // Session mode is exactly one active chain: chain mode comes first, so a second never exists
      // without it, and goes back off when the name is refused.
      const was = this.deps.mode.get();
      if (!was) await this.deps.mode.set(true);
      let created: ChainRow;
      try {
        created = this.deps.chains.create(rest.join(" "));
      } catch (err) {
        if (!was) await this.deps.mode.set(false);
        throw err;
      }
      this.lastUser.set(created.id, this.now());
      return created;
    }
    if (verb === "archive" && !rest.length) {
      this.deps.chains.archive(current);
      return this.deps.chains.first();
    }
    const found = this.deps.chains.resolve(args);
    if (found.archivedAt !== null) throw new ChainArchived(found.name);
    return found;
  }

  /** `status`, `stop`, `skills` and `chain` answer with a card on the head; `new` answers with the
   *  next head's seed card — a head just rotated for its own reason is that answer. */
  private async command(
    { command, args }: { command: ChatCommand; args: string }, { id: chainId, name: chain }: ChainRow, key: ConversationKey | undefined, session: AgentSession, rotated?: ChainReason,
  ): Promise<Head | undefined> {
    const origin = { kind: "chat-command" as const, command };
    if (command === "new") {
      if (session.state === "streaming") throw new ChatCommandRefused("the conversation is replying — /stop first");
      if (rotated) return undefined;
      return { session: await this.rotate(chainId, "new", key, this.members(chainId)[0], session), rotated: "new" };
    }
    if (command === "chain") {
      await session.systemInput(this.chainCommand(args, chainId), origin, "append");
      return undefined;
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
    const { text, sessions, snapshot } = this.status(chainId);
    await session.systemInput(`Chain: ${chain}\n\n${text}`, { ...origin, sessions, statusSnapshot: { ...snapshot, chain } }, "append");
    return undefined;
  }

  /** `/chain` and `/chain rename <name>`: the rename, then the list. */
  private chainCommand(args: string, chainId: string): string {
    if (args) {
      this.deps.chains.rename(chainId, args.replace(/^rename\s*/i, ""));
      this.deps.changed();
    }
    return this.chainsText(chainId);
  }

  /** `then` may rotate again and return the head it made; the caller's answer is that one. */
  private serial(
    chainId: string, key: ConversationKey | undefined, then: (head: AgentSession, rotated?: ChainReason) => Promise<Head | undefined | void>,
  ): Promise<ChainSent> {
    return this.queued(chainId, async () => {
      const found = await this.current(chainId, key);
      this.deps.router.heard(key ?? webKey(found.session.id), found.session);
      const { session, rotated } = (await then(found.session, found.rotated)) ?? found;
      return { sessionId: session.id, chainId, ...(rotated ? { rotated } : {}) };
    });
  }

  /** A read that finds a head gone from Pi starts the next one, as a send
   *  would; undefined when `sessionId` is not a head or is not gone. */
  replaceLost(sessionId: string): Promise<string | undefined> {
    const chainId = this.chainOf(sessionId)?.chainId;
    if (chainId === undefined) return Promise.resolve(undefined);
    return this.queued(chainId, async () => {
      const head = this.members(chainId)[0];
      if (head?.sessionId !== sessionId || !(await this.gone(head))) return undefined;
      log.warn(`main session ${head.sessionId} is gone from Pi — starting the next one`);
      return (await this.rotate(chainId, "lost", undefined, head)).id;
    });
  }

  private queued<T>(chainId: string, fn: () => Promise<T>): Promise<T> {
    const done = (this.queues.get(chainId) ?? Promise.resolve()).then(fn);
    this.queues.set(chainId, done.catch(() => undefined));
    return done;
  }

  private async gone(head: ChainMember): Promise<boolean> {
    return this.deps.router.stateOf(head.sessionId) === undefined && !(await this.deps.factory.find(head.sessionId));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async current(chainId: string, key: ConversationKey | undefined): Promise<Head> {
    const head = this.members(chainId)[0];
    if (!head) return { session: await this.rotate(chainId, "first", key), rotated: "first" };
    if (await this.gone(head)) {
      log.warn(`main session ${head.sessionId} is gone from Pi — starting the next one`);
      return { session: await this.rotate(chainId, "lost", key, head), rotated: "lost" };
    }
    const session = await this.deps.router.ensure(webKey(head.sessionId));
    // A head with no user message yet counts from its start: its seed is not the user speaking.
    const spoke = (await session.history()).reduce((at, t) => (t.role === "user" && t.at ? t.at : at), head.startedAt);
    if (session.state === "streaming") return { session };
    if (this.now() - spoke >= CHAIN_IDLE_MS) return { session: await this.rotate(chainId, "idle", key, head, session), rotated: "idle" };
    // Unknown right after a compaction: that head is small again, not full.
    if ((session.contextUsage?.tokens ?? 0) <= CHAIN_FULL_TOKENS) return { session };
    return { session: await this.rotate(chainId, "full", key, head, session), rotated: "full" };
  }

  /** `chat` is the surface the send came from, if any: the head is attached under
   *  it before anything is appended, so the seed reaches the chat too. */
  private async rotate(chainId: string, reason: ChainReason, chat: ConversationKey | undefined, previous?: ChainMember, open?: AgentSession): Promise<AgentSession> {
    // Built before anything is created: a seed that fails leaves no orphan session.
    const seed = await this.seed(chainId, reason, previous, open).catch((err: unknown) => {
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
    this.deps.router.heard(chat ?? webKey(session.id), session);
    await session.systemInput(seed, { kind: "session-seed", reason, previousSessionId: previous?.sessionId ?? null }, "append");
    // Only a seeded head joins the chain: one whose seed failed is not the conversation.
    transact(this.db, () => {
      this.db.prepare("INSERT INTO main_chain(session_id, chain_id, started_at, reason) VALUES (?, ?, ?, ?)").run(session.id, chainId, this.now(), reason);
      // A lost head has no transcript to page back to; the new head's reason says it went.
      if (reason === "lost" && previous) this.db.prepare("DELETE FROM main_chain WHERE session_id = ?").run(previous.sessionId);
    });
    log.info(`main session ${session.id} of chain ${chainId} started (${reason})`);
    return session;
  }

  /** Read fresh at every rotation; a part that cannot be read says so in the seed. */
  private async seed(chainId: string, reason: ChainReason, previous?: ChainMember, open?: AgentSession): Promise<string> {
    const name = this.deps.chains.get(chainId)?.name ?? chainId;
    const own = join("chains", chainId);
    const runs = this.deps.ledger(this.members(chainId).map((m) => m.sessionId), previous?.startedAt ?? this.now())
      .filter((r) => !SEED_RUNS_HIDDEN.has(r.state));
    const section = (title: string, text: string): string => (text ? `## ${title}\n\n${text}` : "");
    const spoken = open ? await open.history() : [];
    // The user's language rides the seed: a callback landing before they speak here must not answer in its own.
    return withLanguage(userLanguage(spoken), [
      `[Pier: a new session of chain "${name}" — ${WHY[reason]}. Your chain's memory: ${own}/MEMORY.md, notes ${own}/memory/. The rest of this note is context, not a message.]`,
      section("MEMORY.md", cut(await this.read("MEMORY.md"), MEMORY_CHARS)),
      section(`${own}/MEMORY.md`, cut(await this.read(join(own, "MEMORY.md")), MEMORY_CHARS)),
      section("Open", this.status(chainId).seed),
      section("Chains", this.chainLines(chainId)),
      section("Runs — in flight, or ended short of success since the previous session started (succeeded and skipped: `pier task runs`)", cut(runs.map(ledgerLine).join("\n"), LEDGER_CHARS) || "none"),
      ...(await this.notes("memory", GLOBAL_NOTES_CHARS)).map(([file, text]) => section(file, text)),
      ...(await this.notes(join(own, "memory"), NOTES_CHARS)).map(([file, text]) => section(file, text)),
      // Only a full rotation points back: the user was mid-sentence. An idle, new or lost head starts without it.
      section("Previous session", open && reason === "full" ? previousSession(open.id, spoken) : ""),
    ].filter(Boolean).join("\n\n"));
  }

  /** Every active chain with its counts, so the head knows where another topic lives;
   *  none in Session mode, whose one chain's items `## Open` already lists. */
  private chainLines(current: string): string {
    if (!this.deps.mode.get()) return "";
    return this.deps.chains.list().filter((c) => c.archivedAt === null)
      .map((c) => `${this.chainLine(c)}${c.id === current ? " (this one)" : ""}`).join("\n");
  }

  /** The newest notes in `dir` under one budget, collected newest day first and listed
   *  oldest first, each under its own file name so the head sees how old the latest is. */
  private async notes(dir: string, budget: number): Promise<[name: string, text: string][]> {
    const files = await readdir(join(this.deps.home, dir)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      log.warn(`seed: could not list ${dir}/`, err);
      return `(could not be read: ${String(err)})`;
    });
    if (typeof files === "string") return [[`${dir}/`, files]];
    const parts: [string, string][] = [];
    let left = budget;
    for (const file of files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()) {
      const name = `${dir}/${file}`;
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
