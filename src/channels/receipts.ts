// Reaction receipts: the whole lifecycle, storage included.
//
// A 👀 goes on an inbound message and comes off when its turn settles. Both
// halves live in Telegram, not in Pier, so anything ending the process between
// them leaves the emoji on a user's message with nobody left to clear it —
// and so does a message whose session never started a turn at all. Making the
// pending set durable is what closes the loop: an adapter clears every receipt
// it finds at startup (nothing in memory can be its own yet), and sweeps its
// own stragglers on a timer.

import type { DatabaseSync } from "node:sqlite";
import { defaultChannelDbPath, openChannelDb } from "./db.js";
import type { ChannelPlatform } from "./types.js";

export interface Receipt {
  /** The conversation whose turn-end clears this receipt. */
  conversationId: string;
  chatId: string;
  /**
   * Opaque platform message token. A string, not a number: Telegram numbers
   * its messages but a Slack `ts` is `1761234567.123456`, which no float holds
   * exactly. Adapters convert at their own API boundary.
   */
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
  // SQLite hands back whatever affinity it stored; the column is TEXT, but
  // coercing keeps a numeric-looking id from arriving as a number.
  messageId: String(row.message_id),
});

export class ReceiptLedger {
  private readonly db: DatabaseSync;

  constructor(
    private readonly platform: ChannelPlatform,
    path = defaultChannelDbPath(),
  ) {
    // A new table rather than the retired `channel_receipts`, whose message_id
    // was INTEGER: a Slack ts under that affinity comes back as a lossy float,
    // and an id we cannot reproduce is a 👀 nobody can ever clear. Nothing is
    // migrated — every receipt is claimed by the next startup sweep anyway, so
    // the worst an upgrade costs is one stale emoji from a process that died.
    this.db = openChannelDb(path, `
      CREATE TABLE IF NOT EXISTS channel_msg_receipts (
        platform TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (platform, chat_id, message_id)
      );
    `);
  }

  /** Re-marking the same message replaces the row rather than duplicating it. */
  add(receipt: Receipt): void {
    this.db.prepare(`
      INSERT INTO channel_msg_receipts(platform, conversation_id, chat_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id, created_at = excluded.created_at
    `).run(this.platform, receipt.conversationId, receipt.chatId, receipt.messageId, Date.now());
  }

  /** Claim a conversation's receipts: returned once, then gone. */
  take(conversationId: string): Receipt[] {
    const rows = this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM channel_msg_receipts
      WHERE platform = ? AND conversation_id = ?
    `).all(this.platform, conversationId) as unknown as ReceiptRow[];
    this.db.prepare("DELETE FROM channel_msg_receipts WHERE platform = ? AND conversation_id = ?")
      .run(this.platform, conversationId);
    return rows.map(toReceipt);
  }

  /** Claim receipts older than `ageMs`; `0` claims everything (startup sweep). */
  takeStale(ageMs: number, now = Date.now()): Receipt[] {
    const cutoff = now - ageMs;
    const rows = this.db.prepare(`
      SELECT conversation_id, chat_id, message_id FROM channel_msg_receipts
      WHERE platform = ? AND created_at <= ?
    `).all(this.platform, cutoff) as unknown as ReceiptRow[];
    this.db.prepare("DELETE FROM channel_msg_receipts WHERE platform = ? AND created_at <= ?")
      .run(this.platform, cutoff);
    return rows.map(toReceipt);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The one platform call the lifecycle needs; `null` clears the reaction.
 * Ids are opaque strings — an adapter converts to whatever its API wants, and
 * names the emoji itself (Slack's remove call needs the short name back).
 */
export interface ReactionApi {
  setReaction(chatId: string, messageId: string, emoji: string | null): Promise<void>;
}

/**
 * Marks messages as being worked on and unmarks them when their turn settles.
 * Lives next to the ledger because the ordering rule spans both: a receipt is
 * booked synchronously (so an instant turn cannot clear an unbooked one) while
 * the platform call is in flight, and the clear must wait for that call to land
 * or the reaction stays up forever.
 */
export class Receipts {
  /** In-flight `setReaction` per marked message. Only this process's own. */
  private readonly applying = new Map<string, Promise<unknown>>();

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

  /** The turn this conversation was running has ended. */
  settle(conversationId: string): Promise<void> {
    return this.clear(this.ledger.take(conversationId));
  }

  /**
   * Everything on the books at startup is orphaned — nothing in memory can be
   * ours yet — and past `staleMs` a receipt's turn is never going to settle.
   */
  sweep(all = false): Promise<void> {
    return this.clear(this.ledger.takeStale(all ? 0 : this.staleMs));
  }

  private async clear(receipts: Receipt[]): Promise<void> {
    for (const { chatId, messageId } of receipts) {
      const key = `${chatId}:${messageId}`;
      await this.applying.get(key);
      this.applying.delete(key);
      await this.api.setReaction(chatId, messageId, null).catch(() => {});
    }
  }
}
