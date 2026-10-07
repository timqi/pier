// Keeping the home chat's one status message current (docs/design/11-im-conversation.md
// §Status): a refresh edits it in place or deletes it, and only `/status`
// re-posts it at the bottom. The platform's three calls and its rendering of
// the sidebar's layout are injected.

import type { DatabaseSync } from "node:sqlite";
import { openItemGroups } from "../core/open-items.js";
import { waitsOnYou } from "../core/reply.js";
import { NOTHING_OPEN, type OpenItemsSnapshot, type OpenItemsView } from "../core/types.js";
import type { ChannelPlatform } from "./types.js";

/** One main-flow message; `post` answers its id. */
export interface StatusApi<B> {
  post(chatId: string, body: B): Promise<string>;
  edit(chatId: string, messageId: string, body: B): Promise<void>;
  delete(chatId: string, messageId: string): Promise<void>;
}

/** One item in the web sidebar's words: `tag` its status label, none under the
 *  waiting group's heading as in the sidebar's grouped list, and `stage` what
 *  it is at — for a waiting item, the question. */
export interface StatusRow {
  title: string;
  tag: string;
  stage: string;
  waiting: boolean;
  meta: string;
}

/** A platform's pieces for one heading, row or closing count; `cost` is what the budget counts. */
export interface StatusLayout<E> {
  heading(text: string): E[];
  row(row: StatusRow): E[];
  more(count: number): E[];
  cost(pieces: E[]): number;
  /** Leaves room for `more`'s pieces. */
  max: number;
}

/** The sidebar's groups, waiting first, laid out while they fit the budget; the
 *  items past it are counted, never cut mid-item. */
export function statusLayout<E>(view: OpenItemsView, layout: StatusLayout<E>): E[] {
  const out: E[] = [];
  let spent = 0;
  let left = view.snapshot.items.length;
  for (const group of openItemGroups(view.snapshot.items)) {
    const heading = layout.heading(`${group.title} · ${String(group.items.length)}`);
    for (const [n, item] of group.items.entries()) {
      const row = layout.row({
        title: item.title, tag: waitsOnYou(item.status) ? "" : item.statusLabel, stage: item.stage, waiting: waitsOnYou(item.status), meta: item.metadata.join(" · "),
      });
      const pieces = n ? row : [...heading, ...row];
      const cost = layout.cost(pieces);
      if (spent + cost > layout.max) return [...out, ...layout.more(left)];
      out.push(...pieces);
      spent += cost;
      left--;
    }
  }
  return out;
}

export class StatusMessage<B = string> {
  /** `repost` survives a newer view replacing this one: `/status` asked for the bottom. */
  private queued?: { chatId: string; view: OpenItemsView; repost: boolean };
  private tail: Promise<void> = Promise.resolve();
  /** The last view shown, so `/status` can re-post it without waiting for an event. */
  private last?: { chatId: string; view: OpenItemsView };

  constructor(
    private readonly platform: ChannelPlatform,
    private readonly db: DatabaseSync,
    private readonly api: StatusApi<B>,
    private readonly log: (message: string) => void,
    /** The view under the platform's label. */
    private readonly render: (view: OpenItemsView) => B,
  ) {}

  /** `/status` in the main flow: the status message, re-posted below with the
   *  answer's text and snapshot, is the one reply when a view is known and
   *  something is open; false — nothing open, no view yet, or the post failed —
   *  leaves the answer to the note. */
  async answer(chatId: string, text: string, snapshot?: OpenItemsSnapshot): Promise<boolean> {
    if (this.last?.chatId !== chatId || text === NOTHING_OPEN) return false;
    const before = this.messageId(chatId);
    await this.show(chatId, { ...this.last.view, text, ...(snapshot ? { snapshot } : {}) }, true);
    // A failed re-post keeps the old row, so only a new id is the one it posted.
    const after = this.messageId(chatId);
    return after !== undefined && after !== before;
  }

  private messageId(chatId: string): string | undefined {
    const row = this.db.prepare("SELECT message_id FROM status_messages WHERE platform = ? AND chat_id = ?")
      .get(this.platform, chatId) as { message_id: string } | undefined;
    return row?.message_id;
  }

  /** One refresh at a time; one arriving mid-run waits, and a newer view
   *  replaces the one waiting. Never rejects. */
  show(chatId: string, view: OpenItemsView, repost = false): Promise<void> {
    const idle = !this.queued;
    this.last = { chatId, view };
    this.queued = { ...this.last, repost: repost || (this.queued?.chatId === chatId && this.queued.repost) };
    if (idle) this.tail = this.tail.then(() => {
      const next = this.queued!;
      this.queued = undefined;
      return this.apply(next.chatId, next.view, next.repost).catch((err: unknown) => this.log(`status: refresh failed: ${String(err)}`));
    });
    return this.tail;
  }

  private async apply(chatId: string, view: OpenItemsView, repost: boolean): Promise<void> {
    // The home moved within the platform: the old chat's card would read as current.
    const stale = this.db.prepare("SELECT chat_id, message_id FROM status_messages WHERE platform = ? AND chat_id <> ?")
      .all(this.platform, chatId) as { chat_id: string; message_id: string }[];
    for (const old of stale) await this.forget(old.chat_id, old.message_id);
    const row = this.db.prepare("SELECT message_id, text FROM status_messages WHERE platform = ? AND chat_id = ?")
      .get(this.platform, chatId) as { message_id: string; text: string } | undefined;
    const empty = view.text === NOTHING_OPEN;
    const body = this.render(view);
    // The rendered body, not the text: links and layout change without it.
    const drawn = JSON.stringify(body);
    if (row ? !repost && !empty && row.text === drawn : empty) return;
    if (row && !repost && !empty) {
      const edited = await this.api.edit(chatId, row.message_id, body)
        .then(() => true, (err: unknown) => void this.log(`status: edit failed, posting anew: ${String(err)}`));
      if (edited) return this.save(chatId, row.message_id, drawn);
    }
    if (row && empty) return this.forget(chatId, row.message_id);
    const posted = await this.api.post(chatId, body)
      .catch((err: unknown) => void this.log(`status: post failed: ${String(err)}`));
    if (!posted) return;
    this.save(chatId, posted, drawn);
    // Off the reply's path: the new card already answers; a failed delete leaves only a stale copy.
    if (row) void this.api.delete(chatId, row.message_id)
      .catch((err: unknown) => this.log(`status: delete failed: ${String(err)}`));
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
