// The stop and its in-flight ledger: every turn is recorded as it starts, the
// stop aborts what runs and adds what only memory held, and the next boot
// resumes each turn in its session or tells its chat why it could not (§5).

import type { DatabaseSync } from "node:sqlite";
import { restartInput, restartQueued } from "./core/reply.js";
import type { AgentSession, ConversationKey, SystemInputOrigin, WorkspaceEvent } from "./core/types.js";
import { logger } from "./log.js";

const log = logger("stop");

/** Under main.ts's 3-second exit timer, so the ledger writes land before it fires. */
const STOP_BUDGET_MS = 2_500;
/** Per seam call: one hung snapshot must not eat the sends' budget. */
const SEAM_MS = 1_000;
const SEND_POLL_MS = 50;

interface LedgerEntry {
  channelId: string;
  conversationId: string;
  note: string;
}

/** What the dying process owes the chats, held for the next one to deliver. */
export class RestartLedger {
  constructor(private readonly db: DatabaseSync) {}

  record(entry: LedgerEntry): void {
    this.db.prepare(
      "INSERT INTO restart_ledger (channel_id, conversation_id, note) VALUES (?, ?, ?)",
    ).run(entry.channelId, entry.conversationId, entry.note);
  }

  list(): (LedgerEntry & { id: number })[] {
    const rows = this.db.prepare(
      "SELECT id, channel_id, conversation_id, note FROM restart_ledger ORDER BY id",
    ).all() as { id: number; channel_id: string; conversation_id: string; note: string }[];
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      note: row.note,
    }));
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM restart_ledger WHERE id = ?").run(id);
  }
}

export interface TurnInFlight {
  sessionId: string;
  key: ConversationKey;
  queued: string[];
  /** The row's last write: at a clean stop, the moment Pier went down. */
  at: number;
}

/** `turns_in_flight`: written as turns start, so a SIGKILL resumes like a clean stop. */
export class TurnsInFlight {
  constructor(private readonly db: DatabaseSync) {}

  /** `queued` is the stop's write, Pi's queue that dies with the process; a
   *  turn's start passes none and keeps it, so neither a turn starting while
   *  the stop runs nor the resumed turn itself erases texts only this row has. */
  record(sessionId: string, key: ConversationKey, queued: string[] | null = null, at = Date.now()): void {
    this.db.prepare(`
      INSERT INTO turns_in_flight (session_id, channel_id, conversation_id, queued, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET channel_id = excluded.channel_id, conversation_id = excluded.conversation_id,
        queued = COALESCE(excluded.queued, turns_in_flight.queued), at = excluded.at
    `).run(sessionId, key.channelId, key.conversationId, queued && JSON.stringify(queued), at);
  }

  clear(sessionId: string): void {
    this.db.prepare("DELETE FROM turns_in_flight WHERE session_id = ?").run(sessionId);
  }

  list(): TurnInFlight[] {
    const rows = this.db.prepare(
      "SELECT session_id, channel_id, conversation_id, queued, at FROM turns_in_flight ORDER BY at",
    ).all() as { session_id: string; channel_id: string; conversation_id: string; queued: string | null; at: number }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      key: { channelId: row.channel_id, conversationId: row.conversation_id },
      queued: JSON.parse(row.queued ?? "[]") as string[],
      at: row.at,
    }));
  }
}

/** A row per streaming session: written at its start, gone once it is idle —
 *  except while stopping, when the resume owns every turn that was running. */
export function trackTurns(
  router: { onTurnStart(listener: (sessionId: string, key: ConversationKey) => void): void; isStopping(): boolean },
  hub: { subscribeWorkspace(fn: (event: WorkspaceEvent) => void): () => void },
  turns: TurnsInFlight,
): void {
  router.onTurnStart((sessionId, key) => turns.record(sessionId, key));
  // Idle, not a turn end: a run that drains a queued follow-up is one streaming stretch.
  hub.subscribeWorkspace((event) => {
    if (event.type === "session-state" && event.state === "idle" && !router.isStopping()) turns.clear(event.sessionId);
  });
}

export interface StopDeps {
  /** Adapters disconnect and the listener stops accepting; outbound stays usable. */
  closeInbound(): Promise<unknown>;
  router: {
    stopping(): void;
    busy(): { session: AgentSession; key: ConversationKey; sending?: true }[];
    attachedSessions(): { session: AgentSession; key: ConversationKey }[];
  };
  turns: TurnsInFlight;
  ledger: RestartLedger;
  tasks: { activeRunCount(): number };
}

/** Resolves when the process may exit: running turns aborted with their queue
 *  recorded, sends given what is left of the budget. Runs stay `running` for
 *  the boot to resume (tasks/service.ts). */
export async function stopForExit(deps: StopDeps, signal: string, budgetMs = STOP_BUDGET_MS): Promise<void> {
  const { router, turns, ledger } = deps;
  const deadline = Date.now() + budgetMs;
  const left = (cap = budgetMs): number => Math.min(cap, Math.max(0, deadline - Date.now()));
  // Not awaited first: an adapter's stop waits on its inbound chains, and the
  // sessions must be snapshotted beside it, not after it.
  const inbound = bounded(deps.closeInbound(), budgetMs, "closing inbound", undefined);
  router.stopping();
  const aborted = await Promise.all(router.attachedSessions().map(async ({ session, key }) => {
    const running = session.state === "streaming";
    const queue = await bounded(
      session.pendingQueue(), left(SEAM_MS),
      `queue snapshot of session ${session.id}`, { steering: [], followUp: [] },
    );
    const queued = [...queue.steering, ...queue.followUp];
    // Snapshot first, so a hung abort cannot cost it.
    if (running || queued.length) turns.record(session.id, key, queued);
    if (running) await bounded(session.abort(), left(SEAM_MS), `abort of session ${session.id}`, undefined);
    return running;
  }));
  const sending = (): { key: ConversationKey }[] => router.busy().filter((b) => b.sending);
  while (sending().length && left() > 0) await new Promise((resolve) => setTimeout(resolve, left(SEND_POLL_MS)));
  // A send cannot be aborted, only owned up to: the exit cuts it off.
  for (const { key } of sending()) {
    ledger.record({
      channelId: key.channelId, conversationId: key.conversationId,
      note: "Pier restarted while sending the last answer — it may have arrived incomplete; the session transcript has all of it.",
    });
  }
  await bounded(inbound, left(), "closing inbound", undefined);
  log.info(
    `${signal} — ${String(aborted.filter(Boolean).length)} turn(s) aborted, ` +
    `${String(deps.tasks.activeRunCount())} run(s) left running for the next boot`,
  );
}

/** A hang or a rejection is logged and answered with the fallback. */
async function bounded<T>(work: Promise<T>, ms: number, what: string, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      log.error(`${what} did not answer within ${String(ms)}ms`);
      resolve(fallback);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        log.error(`${what} failed`, err);
        return fallback;
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ResumeDeps {
  turns: TurnsInFlight;
  ledger: RestartLedger;
  router: {
    ensure(key: ConversationKey): Promise<AgentSession>;
    reportTo(sessionId: string, message: string): void;
  };
  /** The target of a running agent run, which resumes through the run (its queue too). */
  resumedByRun(sessionId: string): boolean;
}

const isAlias = (key: ConversationKey): boolean => key.channelId === "web" || key.channelId === "task";

/** Once per boot, adapters up: each recorded turn continues in its session. The
 *  row stays until the resumed turn ends, so a second crash resumes it again.
 *  Opened by the recorded session id, never by the chat key: a chat's lookup
 *  creates a session when it maps to none (the home chat maps to none), and the
 *  router hands an opened session its live chat by itself. */
export async function resumeTurns(deps: ResumeDeps, now = Date.now()): Promise<void> {
  for (const row of deps.turns.list()) {
    if (deps.resumedByRun(row.sessionId)) continue;
    const downMs = now - row.at;
    const origin: SystemInputOrigin = { kind: "restart", at: now, downMs };
    let session: AgentSession;
    try {
      session = await deps.router.ensure({ channelId: "web", conversationId: row.sessionId });
    } catch (err) {
      deps.turns.clear(row.sessionId);
      unresumed(deps.ledger, row, err instanceof Error ? err.message : String(err));
      continue;
    }
    const failed = (err: unknown): void =>
      deps.router.reportTo(row.sessionId, `could not resume the turn the restart cut: ${String(err)}`);
    // A user got there first: the running turn has the transcript, and its end retires the row.
    if (session.state === "streaming") {
      if (row.queued.length) session.systemInput(restartQueued(row.queued), origin, "followUp").catch(failed);
      continue;
    }
    session.systemInput(restartInput(now, downMs, row.queued), origin, "prompt").catch(failed);
  }
}

function unresumed(ledger: RestartLedger, row: TurnInFlight, why: string): void {
  // A web or task key has no chat; its stream already carries the open failure.
  if (isAlias(row.key)) {
    log.warn(
      `session ${row.sessionId}: the turn the restart cut could not resume (${why})` +
      (row.queued.length ? `; ${String(row.queued.length)} queued message(s) dropped` : ""),
    );
    return;
  }
  const note = [
    `Pier restarted while answering and could not pick the answer back up (${why}) — send the message again.`,
    ...(row.queued.length ? ["Queued and not delivered:", ...row.queued.map((text) => `> ${text}`)] : []),
  ].join("\n");
  ledger.record({ channelId: row.key.channelId, conversationId: row.key.conversationId, note });
}

/** Each entry is removed only after confirmed delivery: a duplicate apology is
 *  preferable to silence. */
export async function deliverLedger(
  ledger: RestartLedger,
  notify: (entry: LedgerEntry) => Promise<boolean>,
): Promise<void> {
  for (const entry of ledger.list()) {
    const target = `${entry.channelId}:${entry.conversationId}`;
    const delivered: boolean | null = await notify(entry).catch((err: unknown) => {
      log.error(`restart note to ${target} failed`, err);
      return null;
    });
    if (delivered === true) ledger.remove(entry.id);
    else if (delivered === false) log.warn(`restart note waiting — ${target} is not running: ${entry.note}`);
  }
}
