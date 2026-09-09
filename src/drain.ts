// A graceful restart: refuse new work, let running turns finish, and write
// down what the deadline cut off so the next boot can tell the chats (§5b).
// Everything else durable already survives a restart.

import type { DatabaseSync } from "node:sqlite";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { logger } from "./log.js";

const log = logger("drain");

/** Generous: a turn can be a subagent fan-out. */
const DRAIN_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 1_000;
/** Shared across sessions, so N hung seams cost this long, not N times it. */
const CLEANUP_BOUND_MS = 10_000;

export interface LedgerEntry {
  channelId: string;
  conversationId: string;
  note: string;
}

/** What the dying process owes the chats, held for the next one to deliver. */
export class RestartLedger {
  constructor(private readonly db: DatabaseSync) {}

  record(entry: LedgerEntry): void {
    this.db.prepare(
      "INSERT INTO restart_ledger (channel_id, conversation_id, note, created_at) VALUES (?, ?, ?, ?)",
    ).run(entry.channelId, entry.conversationId, entry.note, Date.now());
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

export interface DrainDeps {
  router: {
    beginDrain(): void;
    busy(): { session: AgentSession; key: ConversationKey }[];
  };
  tasks: { pause(): void; activeRunCount(): number };
  ledger: RestartLedger;
}

/** Resolves when the process may exit: everything settled, or the deadline
 *  reached and the stragglers aborted into the ledger. Task runs are left to
 *  the boot-time interrupted marking (tasks/service.ts). */
export async function drainForRestart(
  deps: DrainDeps,
  deadlineMs = DRAIN_DEADLINE_MS,
  pollMs = POLL_MS,
  cleanupBoundMs = CLEANUP_BOUND_MS,
): Promise<void> {
  const { router, tasks, ledger } = deps;
  router.beginDrain();
  tasks.pause();
  const deadline = Date.now() + deadlineMs;
  let lastReport = "";
  for (;;) {
    // Sleep first: a prompt accepted just before the gate closed may not have
    // flipped its session to streaming yet.
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const busy = router.busy();
    const runs = tasks.activeRunCount();
    if (busy.length === 0 && runs === 0) {
      log.info("drained — nothing running");
      return;
    }
    if (Date.now() >= deadline) {
      log.warn(
        `drain deadline after ${String(Math.round(deadlineMs / 1000))}s — aborting ${String(busy.length)} turn(s); ` +
        `${String(runs)} task run(s) will be marked interrupted at boot`,
      );
      const cleanupDeadline = Date.now() + cleanupBoundMs;
      await Promise.all(busy.map(({ session, key }) =>
        abortToLedger(session, key, ledger, cleanupDeadline)));
      return;
    }
    const report = `draining: ${String(busy.length)} turn(s), ${String(runs)} active task run(s)`;
    if (report !== lastReport) log.info((lastReport = report));
  }
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

/** Ledger first, so a hung abort cannot cost the note; the pending queue would
 *  just vanish, so its texts ride along. */
async function abortToLedger(
  session: AgentSession,
  key: ConversationKey,
  ledger: RestartLedger,
  cleanupDeadline: number,
): Promise<void> {
  const remaining = (): number => Math.max(0, cleanupDeadline - Date.now());
  const queued = await bounded(
    session.pendingQueue(), remaining(),
    `queue snapshot of session ${session.id}`, { steering: [], followUp: [] },
  );
  const pending = [...queued.steering, ...queued.followUp];
  // A web or task key has no chat: the transcript shows the aborted turn, and
  // only a dropped queue would be invisible, so that is logged.
  if (key.channelId === "web" || key.channelId === "task") {
    if (pending.length) {
      log.warn(`session ${session.id}: ${String(pending.length)} queued message(s) dropped by the restart`);
    }
  } else {
    const note = [
      "Pier restarted before this turn finished — the last message may be unanswered.",
      ...(pending.length ? ["Queued and not delivered:", ...pending.map((text) => `> ${text}`)] : []),
    ].join("\n");
    ledger.record({ channelId: key.channelId, conversationId: key.conversationId, note });
  }
  await bounded(session.abort(), remaining(), `abort of session ${session.id}`, undefined);
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
