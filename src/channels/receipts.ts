// Reaction receipts: a 👀 goes on an inbound message and comes off when its
// turn settles. Durable, because the emoji lives on the platform: a process
// ending between the two halves would leave it with nobody to clear it.

import type { DatabaseSync } from "node:sqlite";
import type { TurnMeta } from "../core/types.js";
import { pierDb } from "../db.js";
import type { ChannelPlatform } from "./types.js";

/** Adapters ask on every inbound envelope; the books change on the scale of `staleMs`. */
const SWEEP_EVERY_MS = 60_000;

export interface Receipt {
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
  private readonly db: DatabaseSync;

  constructor(
    private readonly platform: ChannelPlatform,
    db: DatabaseSync = pierDb(),
  ) {
    this.db = db;
  }

  add(receipt: Receipt): void {
    this.db.prepare(`
      INSERT INTO receipts(platform, conversation_id, chat_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id, created_at = excluded.created_at
    `).run(this.platform, receipt.conversationId, receipt.chatId, receipt.messageId, Date.now());
  }

  /** Returned once, then gone. `bookedBy` claims only what was on the books by
   *  then — see `Receipts.settle`. */
  take(conversationId: string, bookedBy?: number): Receipt[] {
    const scope = bookedBy === undefined ? "" : " AND created_at <= ?";
    const args = bookedBy === undefined ? [] : [bookedBy];
    const rows = this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM receipts
      WHERE platform = ? AND conversation_id = ?${scope}
    `).all(this.platform, conversationId, ...args) as unknown as ReceiptRow[];
    this.db.prepare(`DELETE FROM receipts WHERE platform = ? AND conversation_id = ?${scope}`)
      .run(this.platform, conversationId, ...args);
    return rows.map(toReceipt);
  }

  /** Claim receipts older than `ageMs`; `0` claims everything (startup sweep). */
  takeStale(ageMs: number, now = Date.now()): Receipt[] {
    const cutoff = now - ageMs;
    const rows = this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM receipts
      WHERE platform = ? AND created_at <= ?
    `).all(this.platform, cutoff) as unknown as ReceiptRow[];
    this.db.prepare("DELETE FROM receipts WHERE platform = ? AND created_at <= ?")
      .run(this.platform, cutoff);
    return rows.map(toReceipt);
  }

}

/** `null` clears the reaction. */
export interface ReactionApi {
  setReaction(chatId: string, messageId: string, emoji: string | null): Promise<void>;
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
    /** After this, a receipt's turn is assumed never to settle. */
    private readonly staleMs: number,
  ) {}

  mark(conversationId: string, chatId: string, messageId: string): void {
    this.applying.set(
      `${chatId}:${messageId}`,
      this.api.setReaction(chatId, messageId, this.emoji)
        .catch((err) => this.log(`reaction failed: ${String(err)}`)),
    );
    this.ledger.add({ conversationId, chatId, messageId });
  }

  /** Only the messages *this* turn was working on: a message queued mid-turn
   *  is still owed an answer. `meta` says when the turn began; no meta clears
   *  everything (the refusal paths have no turn to scope by). */
  settle(conversationId: string, meta?: TurnMeta): Promise<void> {
    const began = meta && meta.completedAt - meta.durationMs;
    return this.clear(this.ledger.take(conversationId, began));
  }

  /** Settles whatever happens; the error still propagates, because a failed
   *  delivery is the router's to report. */
  async settleAfter(
    conversationId: string,
    deliver: () => Promise<void>,
    meta?: TurnMeta,
  ): Promise<void> {
    try {
      await deliver();
    } finally {
      await this.settle(conversationId, meta);
    }
  }

  /** `all` is the startup sweep: everything on the books is orphaned then. */
  sweep(all = false): Promise<void> {
    const now = Date.now();
    if (!all && now - this.sweptAt < SWEEP_EVERY_MS) return Promise.resolve();
    this.sweptAt = now;
    return this.clear(this.ledger.takeStale(all ? 0 : this.staleMs));
  }

  private async clear(receipts: Receipt[]): Promise<void> {
    // A slow apply must not let a later receipt clear first.
    await Promise.all(receipts.map(({ chatId, messageId }) =>
      this.applying.get(`${chatId}:${messageId}`)));
    for (const { chatId, messageId } of receipts) this.applying.delete(`${chatId}:${messageId}`);
    await Promise.all(receipts.map(({ chatId, messageId }) =>
      this.api.setReaction(chatId, messageId, null)
        .catch((err: unknown) => this.log(`reaction clear failed: ${String(err)}`))));
  }
}
