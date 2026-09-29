// Keeping the home chat's one status message current (docs/design/11-im-conversation.md
// §Status): a refresh edits it, re-posts it below the adapter's last main-flow
// post or deletes it, handing its view on to `Receipts.items`. The platform's
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
  private queued?: { chatId: string; view: OpenItemsView; seen: number };
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: ChannelPlatform,
    private readonly db: DatabaseSync,
    private readonly api: StatusApi,
    private readonly receipts: Pick<Receipts, "items">,
    private readonly log: (message: string) => void,
    /** The view's text under the platform's label. */
    private readonly render: (text: string) => string,
  ) {}

  /** The adapter posted something else into the chat's main flow: the next
   *  refresh re-posts the status below it. */
  behind(chatId: string): void {
    this.db.prepare("UPDATE status_messages SET behind = 1 WHERE platform = ? AND chat_id = ?").run(this.platform, chatId);
  }

  /** One refresh at a time; one arriving mid-run waits, and a newer view
   *  replaces the one waiting. Never rejects. */
  show(chatId: string, view: OpenItemsView): Promise<void> {
    const idle = !this.queued;
    this.queued = { chatId, view, seen: Date.now() };
    if (idle) this.tail = this.tail.then(() => {
      const next = this.queued!;
      this.queued = undefined;
      return this.apply(next.chatId, next.view, next.seen).catch((err: unknown) => this.log(`status: refresh failed: ${String(err)}`));
    });
    return this.tail;
  }

  private async apply(chatId: string, view: OpenItemsView, seen: number): Promise<void> {
    await this.receipts.items(view, seen);
    const row = this.db.prepare("SELECT message_id, text, behind FROM status_messages WHERE platform = ? AND chat_id = ?")
      .get(this.platform, chatId) as { message_id: string; text: string; behind: number } | undefined;
    const empty = view.text === NOTHING_OPEN;
    if (row ? !row.behind && row.text === view.text : empty) return;
    const body = this.render(view.text);
    if (row && !row.behind && !empty) {
      const edited = await this.api.edit(chatId, row.message_id, body)
        .then(() => true, (err: unknown) => void this.log(`status: edit failed, posting anew: ${String(err)}`));
      if (edited) return this.save(chatId, row.message_id, view.text);
    }
    if (row) {
      await this.api.delete(chatId, row.message_id)
        .catch((err: unknown) => this.log(`status: delete failed: ${String(err)}`));
      this.db.prepare("DELETE FROM status_messages WHERE platform = ? AND chat_id = ?").run(this.platform, chatId);
    }
    if (empty) return;
    const posted = await this.api.post(chatId, body)
      .catch((err: unknown) => void this.log(`status: post failed: ${String(err)}`));
    if (posted) this.save(chatId, posted, view.text);
  }

  private save(chatId: string, messageId: string, text: string): void {
    this.db.prepare(`
      INSERT INTO status_messages(platform, chat_id, message_id, text, behind) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(platform, chat_id) DO UPDATE SET
        message_id = excluded.message_id, text = excluded.text, behind = 0
    `).run(this.platform, chatId, messageId, text);
  }
}
