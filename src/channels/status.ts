// Keeping the home chat's one status message current (docs/design/11-im-conversation.md
// §Status): a refresh edits it in place or deletes it, `/status` re-posts it at
// the bottom, and each view is handed on to `Receipts.items`. The platform's
// three calls are injected.

import type { DatabaseSync } from "node:sqlite";
import { NOTHING_OPEN, type OpenItemsView } from "../core/types.js";
import type { Receipts } from "./receipts.js";
import type { ChannelPlatform } from "./types.js";

/** One main-flow message; `post` answers its id. */
export interface StatusApi {
  post(chatId: string, body: string): Promise<string>;
  edit(chatId: string, messageId: string, body: string): Promise<void>;
  delete(chatId: string, messageId: string): Promise<void>;
}

export class StatusMessage {
  /** `repost` survives a newer view replacing this one: `/status` asked for the bottom. */
  private queued?: { chatId: string; view: OpenItemsView; seen: number; repost: boolean };
  private tail: Promise<void> = Promise.resolve();
  /** The last view shown, so `/status` can re-post it without waiting for an event. */
  private last?: { chatId: string; view: OpenItemsView; seen: number };

  constructor(
    private readonly platform: ChannelPlatform,
    private readonly db: DatabaseSync,
    private readonly api: StatusApi,
    private readonly receipts: Pick<Receipts, "items">,
    private readonly log: (message: string) => void,
    /** The view's text under the platform's label. */
    private readonly render: (text: string) => string,
  ) {}

  /** `/status` in the main flow: the status message, re-posted below with the
   *  answer's text, is the one reply when a view is known and something is
   *  open; false — nothing open, no view yet, or the post failed — leaves the
   *  answer to the note. */
  async answer(chatId: string, text: string): Promise<boolean> {
    if (this.last?.chatId !== chatId || text === NOTHING_OPEN) return false;
    await this.show(chatId, { ...this.last.view, text }, this.last.seen, true);
    // The re-post forgets the old row first, so a row now is the one it posted.
    return this.db.prepare("SELECT 1 FROM status_messages WHERE platform = ? AND chat_id = ?").get(this.platform, chatId) !== undefined;
  }

  /** One refresh at a time; one arriving mid-run waits, and a newer view
   *  replaces the one waiting. Never rejects. */
  show(chatId: string, view: OpenItemsView, seen = Date.now(), repost = false): Promise<void> {
    const idle = !this.queued;
    this.last = { chatId, view, seen };
    this.queued = { ...this.last, repost: repost || (this.queued?.chatId === chatId && this.queued.repost) };
    if (idle) this.tail = this.tail.then(() => {
      const next = this.queued!;
      this.queued = undefined;
      return this.apply(next.chatId, next.view, next.seen, next.repost).catch((err: unknown) => this.log(`status: refresh failed: ${String(err)}`));
    });
    return this.tail;
  }

  private async apply(chatId: string, shown: OpenItemsView, seen: number, repost: boolean): Promise<void> {
    await this.receipts.items(shown, seen);
    const view = shown;
    // The home moved within the platform: the old chat's card would read as current.
    const stale = this.db.prepare("SELECT chat_id, message_id FROM status_messages WHERE platform = ? AND chat_id <> ?")
      .all(this.platform, chatId) as { chat_id: string; message_id: string }[];
    for (const old of stale) await this.forget(old.chat_id, old.message_id);
    const row = this.db.prepare("SELECT message_id, text FROM status_messages WHERE platform = ? AND chat_id = ?")
      .get(this.platform, chatId) as { message_id: string; text: string } | undefined;
    const empty = view.text === NOTHING_OPEN;
    if (row ? !repost && row.text === view.text : empty) return;
    const body = this.render(view.text);
    if (row && !repost && !empty) {
      const edited = await this.api.edit(chatId, row.message_id, body)
        .then(() => true, (err: unknown) => void this.log(`status: edit failed, posting anew: ${String(err)}`));
      if (edited) return this.save(chatId, row.message_id, view.text);
    }
    if (row) await this.forget(chatId, row.message_id);
    if (empty) return;
    const posted = await this.api.post(chatId, body)
      .catch((err: unknown) => void this.log(`status: post failed: ${String(err)}`));
    if (posted) this.save(chatId, posted, view.text);
  }

  private async forget(chatId: string, messageId: string): Promise<void> {
    await this.api.delete(chatId, messageId)
      .catch((err: unknown) => this.log(`status: delete failed: ${String(err)}`));
    this.db.prepare("DELETE FROM status_messages WHERE platform = ? AND chat_id = ?").run(this.platform, chatId);
  }

  private save(chatId: string, messageId: string, text: string): void {
    this.db.prepare(`
      INSERT INTO status_messages(platform, chat_id, message_id, text) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, chat_id) DO UPDATE SET
        message_id = excluded.message_id, text = excluded.text
    `).run(this.platform, chatId, messageId, text);
  }
}
