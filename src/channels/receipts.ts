// Reaction receipts: an inbound message is booked when it arrives and settled
// when its turn ends, wearing a 👀 meanwhile except in a quiet chat (the home).
// Durable, because the emoji lives on the platform: a process ending between
// the two halves would leave it with nobody to clear it.

import type { DatabaseSync } from "node:sqlite";
import type { TurnMeta } from "../core/types.js";
import { pierDb } from "../db.js";
import type { ChannelPlatform } from "./types.js";

/** Adapters ask on every inbound envelope; the books change on the scale of `staleMs`. */
const SWEEP_EVERY_MS = 60_000;

interface Receipt {
  /** The conversation whose turn-end clears this receipt. */
  conversationId: string;
  chatId: string;
  /** A string: a Slack `ts` is `1761234567.123456`, which no float holds exactly. */
  messageId: string;
}

interface ReceiptRow {
  conversation_id: string;
  chat_id: string;
  message_id: string;
}

const toReceipt = (row: ReceiptRow): Receipt => ({
  conversationId: row.conversation_id,
  chatId: row.chat_id,
  // The column is TEXT, but a numeric-looking id could still arrive as a number.
  messageId: String(row.message_id),
});

export class ReceiptLedger {
  /** The adapter's other books (channels/status.ts) live beside these. */
  readonly db: DatabaseSync;

  constructor(
    private readonly platform: ChannelPlatform,
    db: DatabaseSync = pierDb(),
  ) {
    this.db = db;
  }

  add(receipt: Receipt, createdAt = Date.now()): void {
    this.db.prepare(`
      INSERT INTO receipts(platform, conversation_id, chat_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id, created_at = excluded.created_at
    `).run(this.platform, receipt.conversationId, receipt.chatId, receipt.messageId, createdAt);
  }

  /** Returned once, then gone. `bookedBy` claims only what was on the books by
   *  then — see `Receipts.settle`. */
  take(conversationId: string, bookedBy?: number): Receipt[] {
    const rows = this.booked(conversationId, bookedBy);
    const scope = bookedBy === undefined ? "" : " AND created_at <= ?";
    this.db.prepare(`DELETE FROM receipts WHERE platform = ? AND conversation_id = ?${scope}`)
      .run(this.platform, conversationId, ...(bookedBy === undefined ? [] : [bookedBy]));
    return rows;
  }

  /** What `take` would claim, left on the books. */
  booked(conversationId: string, bookedBy?: number): Receipt[] {
    const scope = bookedBy === undefined ? "" : " AND created_at <= ?";
    return (this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM receipts
      WHERE platform = ? AND conversation_id = ?${scope}
    `).all(this.platform, conversationId, ...(bookedBy === undefined ? [] : [bookedBy])) as unknown as ReceiptRow[]).map(toReceipt);
  }

  /** Claim receipts older than `ageMs`; `0` claims everything (startup sweep).
   *  A conversation `working` says yes to is skipped, whatever its age: its
   *  turn is still going to settle. */
  takeStale(
    ageMs: number,
    working: (conversationId: string) => boolean = () => false,
    now = Date.now(),
  ): Receipt[] {
    const cutoff = now - ageMs;
    const rows = this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM receipts
      WHERE platform = ? AND created_at <= ?
    `).all(this.platform, cutoff) as unknown as ReceiptRow[];
    const claimed = rows.map(toReceipt).filter(({ conversationId }) => !working(conversationId));
    const drop = this.db.prepare(
      "DELETE FROM receipts WHERE platform = ? AND chat_id = ? AND message_id = ?",
    );
    for (const { chatId, messageId } of claimed) drop.run(this.platform, chatId, messageId);
    return claimed;
  }
}

interface ReactionApi {
  addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
}

/** A receipt is booked synchronously (an instant turn must not clear an
 *  unbooked one) while the platform call is in flight, and the clear waits for
 *  that call to land or the reaction stays up forever. */
export class Receipts {
  private readonly applying = new Map<string, Promise<unknown>>();
  private sweptAt = 0;

  constructor(
    private readonly api: ReactionApi,
    private readonly ledger: ReceiptLedger,
    private readonly log: (message: string) => void,
    private readonly emoji: string,
    /** After this, a receipt whose conversation is idle is assumed never to
     *  settle. A turn still running keeps its 👀 however long it takes. */
    private readonly staleMs: number,
    private readonly working?: (conversationId: string) => boolean,
    /** A quiet chat is booked and settled without a reaction call. */
    private readonly quiet: (chatId: string) => boolean = () => false,
  ) {}

  /** `at` is when the turn this receipt belongs to began; it defaults to now,
   *  which is right for a message someone typed. A system note is posted *by*
   *  the turn that will clear it, so booking it at `now` — a round trip after
   *  the turn started — would put it outside that turn's scope and leave the
   *  reaction up until the stale sweep. */
  mark(conversationId: string, chatId: string, messageId: string, at?: number): void {
    if (!this.quiet(chatId)) this.applying.set(
      `${chatId}:${messageId}`,
      this.api.addReaction(chatId, messageId, this.emoji)
        .catch((err) => this.log(`reaction failed: ${String(err)}`)),
    );
    this.ledger.add({ conversationId, chatId, messageId }, at);
  }

  /** Only the messages *this* turn was working on: a message queued mid-turn
   *  is still owed an answer. `meta` says when the turn began; no meta clears
   *  everything (the refusal paths have no turn to scope by). */
  settle(conversationId: string, meta?: TurnMeta): Promise<void> {
    return this.clear(this.ledger.take(conversationId, began(meta)));
  }

  /** Settles whatever happens; the error still propagates, because a failed
   *  delivery is the router's to report. `deliver` is told whether the turn
   *  settles any receipt. */
  async settleAfter(
    conversationId: string,
    deliver: (settles: boolean) => Promise<void>,
    meta?: TurnMeta,
  ): Promise<void> {
    try {
      await deliver(this.ledger.booked(conversationId, began(meta)).length > 0);
    } finally {
      await this.settle(conversationId, meta);
    }
  }

  /** `all` is the startup sweep: everything on the books is orphaned then. */
  sweep(all = false): Promise<void> {
    const now = Date.now();
    if (!all && now - this.sweptAt < SWEEP_EVERY_MS) return Promise.resolve();
    this.sweptAt = now;
    // The startup sweep needs no liveness check: no turn survives the process.
    return this.clear(this.ledger.takeStale(all ? 0 : this.staleMs, all ? undefined : this.working));
  }

  /** A slow apply must not let a later receipt clear first. */
  private async landed(receipts: { chatId: string; messageId: string }[]): Promise<void> {
    await Promise.all(receipts.map(({ chatId, messageId }) =>
      this.applying.get(`${chatId}:${messageId}`)));
    for (const { chatId, messageId } of receipts) this.applying.delete(`${chatId}:${messageId}`);
  }

  private async clear(receipts: Receipt[]): Promise<void> {
    await this.landed(receipts);
    await Promise.all(receipts.filter((r) => !this.quiet(r.chatId)).map((r) =>
      this.api.removeReaction(r.chatId, r.messageId, this.emoji)
        .catch((err: unknown) => this.log(`reaction clear failed: ${String(err)}`))));
  }
}

const began = (meta?: TurnMeta): number | undefined => meta && meta.completedAt - meta.durationMs;
