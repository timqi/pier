// Reaction receipts: a 👀 goes on an inbound message and comes off when its
// turn settles; a message whose turn opened an open item then wears that
// item's ❓ / ✅ (docs/design/11 §Status). Durable, because the emoji lives on
// the platform: a process ending between the two halves would leave it with
// nobody to clear it.

import type { DatabaseSync } from "node:sqlite";
import { waitsOnYou } from "../core/reply.js";
import type { OpenItemsView, TurnMeta } from "../core/types.js";
import { pierDb } from "../db.js";
import type { ChannelPlatform } from "./types.js";

/** Adapters ask on every inbound envelope; the books change on the scale of `staleMs`. */
const SWEEP_EVERY_MS = 60_000;
/** Messages one item wears its state on; the oldest past it comes clear. */
const ITEM_CAP = 20;
/** An item receipt's reaction while its item runs: the turn's 👀 is gone, and nothing replaces it. */
const NONE = "";

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

/** A message that opened an open item, wearing `reaction` (`NONE` while it runs) until the item is done. */
type ItemReceipt = { chatId: string; messageId: string; problem: string; reaction: string; createdAt: number };

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

  /** Books `receipts` under `problem`, wearing `reaction`; answers that item's
   *  receipts past `ITEM_CAP`, oldest first, already off the books. */
  join(receipts: Receipt[], problem: string, reaction: string, at = Date.now()): ItemReceipt[] {
    const put = this.db.prepare(`
      INSERT INTO item_receipts(platform, chat_id, message_id, problem, reaction, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, chat_id, message_id) DO UPDATE SET
        problem = excluded.problem, reaction = excluded.reaction, created_at = excluded.created_at
    `);
    for (const { chatId, messageId } of receipts) put.run(this.platform, chatId, messageId, problem, reaction, at);
    const over = this.items().filter((i) => i.problem === problem).slice(0, -ITEM_CAP);
    for (const item of over) this.setItem(item, null);
    return over;
  }

  /** Oldest first. */
  items(): ItemReceipt[] {
    return this.db.prepare(`
      SELECT chat_id AS chatId, message_id AS messageId, problem, reaction, created_at AS createdAt
      FROM item_receipts WHERE platform = ? ORDER BY created_at, rowid
    `).all(this.platform) as unknown as ItemReceipt[];
  }

  /** `null` forgets the receipt. */
  setItem({ chatId, messageId }: ItemReceipt, reaction: string | null): void {
    const where = "platform = ? AND chat_id = ? AND message_id = ?";
    if (reaction === null) this.db.prepare(`DELETE FROM item_receipts WHERE ${where}`).run(this.platform, chatId, messageId);
    else this.db.prepare(`UPDATE item_receipts SET reaction = ? WHERE ${where}`).run(reaction, this.platform, chatId, messageId);
  }
}

interface ReactionApi {
  addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(chatId: string, messageId: string, emoji: string): Promise<void>;
}

/** The platform's names for a message's states: `working` a turn's, the other two an item's. */
type Reactions = Record<"working" | "waiting" | "done", string>;

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
    private readonly emoji: Reactions,
    /** After this, a receipt whose conversation is idle is assumed never to
     *  settle. A turn still running keeps its 👀 however long it takes. */
    private readonly staleMs: number,
    private readonly working?: (conversationId: string) => boolean,
  ) {}

  /** `at` is when the turn this receipt belongs to began; it defaults to now,
   *  which is right for a message someone typed. A system note is posted *by*
   *  the turn that will clear it, so booking it at `now` — a round trip after
   *  the turn started — would put it outside that turn's scope and leave the
   *  reaction up until the stale sweep. */
  mark(conversationId: string, chatId: string, messageId: string, at?: number): void {
    this.applying.set(
      `${chatId}:${messageId}`,
      this.api.addReaction(chatId, messageId, this.emoji.working)
        .catch((err) => this.log(`reaction failed: ${String(err)}`)),
    );
    this.ledger.add({ conversationId, chatId, messageId }, at);
  }

  /** Only the messages *this* turn was working on: a message queued mid-turn
   *  is still owed an answer. `meta` says when the turn began; no meta clears
   *  everything (the refusal paths have no turn to scope by). */
  settle(conversationId: string, meta?: TurnMeta, joinTo?: string): Promise<void> {
    const taken = this.ledger.take(conversationId, began(meta));
    return joinTo ? this.join(taken, joinTo) : this.clear(taken);
  }

  /** Settles whatever happens; the error still propagates, because a failed
   *  delivery is the router's to report. `deliver` is told whether the turn
   *  settles any receipt; `joinTo` is the problem the settled ones stay on. */
  async settleAfter(
    conversationId: string,
    deliver: (settles: boolean) => Promise<void>,
    meta?: TurnMeta,
    joinTo?: string,
  ): Promise<void> {
    try {
      await deliver(this.ledger.booked(conversationId, began(meta)).length > 0);
    } finally {
      await this.settle(conversationId, meta, joinTo);
    }
  }

  /** Each item receipt to its item's state in `view`, a gone problem to done
   *  and forgotten. `seen` is when the view was read: a receipt joined after it
   *  belongs to an item the view could not yet name. */
  async items(view: OpenItemsView, seen = Date.now()): Promise<void> {
    const status = new Map(view.items.map((i) => [i.problem, i.status]));
    await Promise.all(this.ledger.items().map(async (item) => {
      const now = status.get(item.problem);
      if (now === undefined && item.createdAt >= seen) return;
      // `stopped` and `pending release` wait for the head's next marker; an item
      // never wears the turn's 👀, so one booked by an older release comes off.
      const want = now === undefined ? this.emoji.done
        : now === "running" ? NONE
        : waitsOnYou(now) ? this.emoji.waiting
        : item.reaction === this.emoji.working ? NONE : item.reaction;
      this.ledger.setItem(item, now === undefined ? null : want);
      if (want !== item.reaction) await this.swap(item.chatId, item.messageId, item.reaction, want);
    }));
  }

  /** `all` is the startup sweep: everything on the books is orphaned then. */
  sweep(all = false): Promise<void> {
    const now = Date.now();
    if (!all && now - this.sweptAt < SWEEP_EVERY_MS) return Promise.resolve();
    this.sweptAt = now;
    // The startup sweep needs no liveness check: no turn survives the process.
    return this.clear(this.ledger.takeStale(all ? 0 : this.staleMs, all ? undefined : this.working));
  }

  /** The 👀 comes off as for any turn; the books move, and an item past its cap comes clear. */
  private async join(receipts: Receipt[], problem: string): Promise<void> {
    await this.clear(receipts);
    await this.clear(this.ledger.join(receipts, problem, NONE));
  }

  private async swap(chatId: string, messageId: string, from: string, to: string): Promise<void> {
    if (from !== NONE) await this.api.removeReaction(chatId, messageId, from).catch((err: unknown) => this.log(`reaction clear failed: ${String(err)}`));
    if (to !== NONE) await this.api.addReaction(chatId, messageId, to).catch((err: unknown) => this.log(`reaction failed: ${String(err)}`));
  }

  /** A slow apply must not let a later receipt clear first. */
  private async landed(receipts: { chatId: string; messageId: string }[]): Promise<void> {
    await Promise.all(receipts.map(({ chatId, messageId }) =>
      this.applying.get(`${chatId}:${messageId}`)));
    for (const { chatId, messageId } of receipts) this.applying.delete(`${chatId}:${messageId}`);
  }

  private async clear(receipts: (Receipt | ItemReceipt)[]): Promise<void> {
    await this.landed(receipts);
    await Promise.all(receipts.map((r) => {
      const emoji = "reaction" in r ? r.reaction : this.emoji.working;
      return emoji === NONE ? undefined : this.api.removeReaction(r.chatId, r.messageId, emoji)
        .catch((err: unknown) => this.log(`reaction clear failed: ${String(err)}`));
    }));
  }
}

const began = (meta?: TurnMeta): number | undefined => meta && meta.completedAt - meta.durationMs;
