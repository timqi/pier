// A graceful restart: refuse new work, let running turns finish, and write
// down what the deadline had to cut off so the next boot can tell the chats.
//
// The trigger is SIGUSR2 (main.ts); systemd's `Restart=always` is the "start
// again" half. SIGTERM stays the fast path systemd expects — this file is only
// the slow one. Nothing here is persisted for its own sake: everything durable
// (transcripts, the chat → session map, task runs) already survives a restart,
// so the ledger below holds only the one thing that would otherwise vanish
// silently — turns and queued messages the deadline aborted (§5b).

import type { DatabaseSync } from "node:sqlite";
import type { AgentSession, ConversationKey } from "./core/types.js";
import { logger } from "./log.js";

const log = logger("drain");

/** How long running turns may take before they are aborted. Generous: a turn
 *  can be a subagent fan-out, and an abort still persists the partial work. */
export const DRAIN_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 1_000;
/** Per seam call during deadline cleanup. The deadline is a promise to exit;
 *  a session that will not answer `pendingQueue` or `abort` must not turn it
 *  into a hang the operator can only SIGKILL out of. */
const SEAM_BOUND_MS = 10_000;

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

/**
 * Resolve when the process may exit: every turn settled and every task run
 * terminal, or the deadline reached and the stragglers aborted into the
 * ledger. The caller (main.ts) owns what happens next — the ordinary shutdown,
 * minus aborting task runs: the boot-time interrupted marking is the recovery
 * path (tasks/service.ts start()), not a teardown race against dying channels.
 */
export async function drainForRestart(
  deps: DrainDeps,
  deadlineMs = DRAIN_DEADLINE_MS,
  pollMs = POLL_MS,
  seamBoundMs = SEAM_BOUND_MS,
): Promise<void> {
  const { router, tasks, ledger } = deps;
  router.beginDrain();
  tasks.pause();
  const deadline = Date.now() + deadlineMs;
  let lastReport = "";
  for (;;) {
    // Sleep first: a prompt accepted just before the gate closed may not have
    // flipped its session to streaming yet, and exiting on that blink would
    // cut off the very turn the drain exists to protect.
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
      for (const { session, key } of busy) await abortToLedger(session, key, ledger, seamBoundMs);
      return;
    }
    const report = `draining: ${String(busy.length)} turn(s), ${String(runs)} active task run(s)`;
    if (report !== lastReport) log.info((lastReport = report));
  }
}

/** A seam call the deadline cannot wait on forever: a hang or a rejection is
 *  logged and answered with the fallback, and cleanup moves on. */
const bounded = <T>(work: Promise<T>, ms: number, what: string, fallback: T): Promise<T> =>
  Promise.race([
    work.catch((err: unknown) => {
      log.error(`${what} failed`, err);
      return fallback;
    }),
    new Promise<T>((resolve) => {
      setTimeout(() => {
        log.error(`${what} did not answer within ${String(ms)}ms`);
        resolve(fallback);
      }, ms).unref();
    }),
  ]);

/** Write the chat's entry, then abort the turn. The ledger comes first so a
 *  hung abort cannot cost the note; the abort persists the partial transcript;
 *  the pending queue would just vanish, so its texts ride along. */
async function abortToLedger(
  session: AgentSession,
  key: ConversationKey,
  ledger: RestartLedger,
  seamBoundMs: number,
): Promise<void> {
  const queued = await bounded(
    session.pendingQueue(), seamBoundMs,
    `queue snapshot of session ${session.id}`, { steering: [], followUp: [] },
  );
  const pending = [...queued.steering, ...queued.followUp];
  // A web or task key has no chat to write to: the transcript shows the
  // aborted turn, and a task run's interruption is reported by its callback
  // recovery. Only a dropped queue would be invisible there, so it is at
  // least logged.
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
  await bounded(session.abort(), seamBoundMs, `abort of session ${session.id}`, undefined);
}

/**
 * Deliver what a previous process wrote on its way out. Runs at boot once the
 * adapters are up, and again on a Console unlock. Each entry is removed only
 * after its delivery attempt: delivered or thrown is terminal (a throw is
 * logged, never retried across boots into a stale apology), but a platform
 * that simply is not running keeps its entry for the next start.
 */
export async function deliverLedger(
  ledger: RestartLedger,
  notify: (entry: LedgerEntry) => Promise<boolean>,
): Promise<void> {
  for (const entry of ledger.list()) {
    const target = `${entry.channelId}:${entry.conversationId}`;
    const delivered = await notify(entry).catch((err: unknown) => {
      log.error(`restart note to ${target} failed`, err);
      return true; // attempted: logged is the terminal state, not a retry
    });
    if (delivered) ledger.remove(entry.id);
    else log.warn(`restart note waiting — ${target} is not running: ${entry.note}`);
  }
}
