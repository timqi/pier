// Keeping the home chat's one status card current (docs/design/11-im-conversation.md
// §Status): a refresh edits it in place, `/status` posts a new one, and none is
// ever deleted. The platform's two calls and its rendering of the sidebar's
// layout are injected.

import type { DatabaseSync } from "node:sqlite";
import { pierDb } from "../db.js";
import { openItemGroups, UNMATCHED_DONE } from "../core/open-items.js";
import { waitsOnYou } from "../core/reply.js";
import { NOTHING_OPEN, type OpenItemsView } from "../core/types.js";
import type { ChannelPlatform } from "./types.js";

/** One main-flow message; `post` answers its id. */
export interface StatusApi<B> {
  post(chatId: string, body: B): Promise<string>;
  edit(chatId: string, messageId: string, body: B): Promise<void>;
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

/** Another chain's line under `Other chains` (docs/plans/30-multi-chain.md §IM). */
export interface OtherChain {
  name: string;
  waiting: number;
  inProgress: number;
  archived: boolean;
}

/** The home chat's current chain's view, and the other chains with something in them. */
export type StatusView = OpenItemsView & { others?: OtherChain[] };

/** A platform's pieces for one heading, row or closing count; `cost` is what the budget counts. */
export interface StatusLayout<E> {
  heading(text: string): E[];
  row(row: StatusRow): E[];
  more(count: number): E[];
  /** The other chains as one minor section under a small heading, a line each. */
  others(chains: OtherChain[]): E[];
  cost(pieces: E[]): number;
  /** Leaves room for `more`'s pieces. */
  max: number;
}

const nothingOpen = (view: StatusView): boolean => !view.snapshot.items.length && !view.snapshot.unmatched?.length;

/** The sidebar's groups, waiting first, laid out while they fit the budget; the
 *  items past it are counted, never cut mid-item. */
export function statusLayout<E>(view: StatusView, layout: StatusLayout<E>): E[] {
  // A card edited to nothing open says so; it is never deleted.
  const out: E[] = nothingOpen(view) ? layout.heading(NOTHING_OPEN) : [];
  let spent = layout.cost(out);
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
  const owed = view.snapshot.unmatched ?? [];
  const others = view.others ?? [];
  // Whole sections after the items, each left out when it does not fit.
  const tails = [
    owed.length ? [...layout.heading(`${UNMATCHED_DONE} · ${String(owed.length)}`), ...owed.flatMap((title) => layout.row({ title, tag: "", stage: "", waiting: false, meta: "" }))] : [],
    others.length ? layout.others(others) : [],
  ];
  for (const pieces of tails) {
    const cost = layout.cost(pieces);
    if (spent + cost > layout.max) break;
    out.push(...pieces);
    spent += cost;
  }
  return out;
}

/** The status message's label, naming the chain its items are in. */
export const statusLabel = (view: StatusView): string =>
  `▤ open items${view.snapshot.chain === undefined ? "" : ` · ${view.snapshot.chain}`}`;

export const otherCounts = (c: OtherChain): string => `${String(c.waiting)} waiting · ${String(c.inProgress)} in progress`;

export class StatusMessage<B = string> {
  /** `repost` survives a newer view replacing this one: `/status` asked for a new card. */
  private queued?: { chatId: string; view: StatusView; repost: boolean };
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: ChannelPlatform,
    private readonly api: StatusApi<B>,
    private readonly log: (message: string) => void,
    /** The view under the platform's label. */
    private readonly render: (view: StatusView) => B,
    private readonly db: DatabaseSync = pierDb(),
  ) {}

  /** `/status` in the main flow: a new card at the bottom, the row edited from
   *  then on, is the one reply; false — nothing open and no other chain to list,
   *  or the post failed — leaves the answer to the note. */
  async answer(chatId: string, view: StatusView): Promise<boolean> {
    if (nothingOpen(view) && !view.others?.length) return false;
    const before = this.messageId(chatId);
    await this.show(chatId, view, true);
    // A failed post keeps the old row, so only a new id is the one it posted.
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
  show(chatId: string, view: StatusView, repost = false): Promise<void> {
    const idle = !this.queued;
    this.queued = { chatId, view, repost: repost || (this.queued?.chatId === chatId && this.queued.repost) };
    if (idle) this.tail = this.tail.then(() => {
      const next = this.queued!;
      this.queued = undefined;
      return this.apply(next.chatId, next.view, next.repost).catch((err: unknown) => this.log(`status: refresh failed: ${String(err)}`));
    });
    return this.tail;
  }

  private async apply(chatId: string, view: StatusView, repost: boolean): Promise<void> {
    // The home moved within the platform: the old chat's card is left as it was, no longer ours.
    this.db.prepare("DELETE FROM status_messages WHERE platform = ? AND chat_id <> ?").run(this.platform, chatId);
    const row = this.db.prepare("SELECT message_id, text FROM status_messages WHERE platform = ? AND chat_id = ?")
      .get(this.platform, chatId) as { message_id: string; text: string } | undefined;
    const body = this.render(view);
    // The rendered body, not the text: the snapshot's layout changes without it.
    const drawn = JSON.stringify(body);
    if (!repost && (row ? row.text === drawn : nothingOpen(view) && !view.others?.length)) return;
    if (row && !repost) {
      const edited = await this.api.edit(chatId, row.message_id, body)
        .then(() => true, (err: unknown) => void this.log(`status: edit failed, posting anew: ${String(err)}`));
      if (edited) return this.save(chatId, row.message_id, drawn);
    }
    // The card posted before stays as it was: nothing here is ever deleted.
    const posted = await this.api.post(chatId, body)
      .catch((err: unknown) => void this.log(`status: post failed: ${String(err)}`));
    if (posted) this.save(chatId, posted, drawn);
  }

  private save(chatId: string, messageId: string, text: string): void {
    this.db.prepare(`
      INSERT INTO status_messages(platform, chat_id, message_id, text) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, chat_id) DO UPDATE SET
        message_id = excluded.message_id, text = excluded.text
    `).run(this.platform, chatId, messageId, text);
  }
}
