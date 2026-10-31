// The home chat's status card (docs/design/11-im-conversation.md §Status): the
// web sidebar's layout, which each platform renders, posted as `/status`'s answer.

import { openItemGroups, UNMATCHED_DONE } from "../core/open-items.js";
import { waitsOnYou } from "../core/reply.js";
import type { OpenItemsView } from "../core/types.js";

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

/** The sidebar's groups, waiting first, laid out while they fit the budget; the
 *  items past it are counted, never cut mid-item. */
export function statusLayout<E>(view: StatusView, layout: StatusLayout<E>): E[] {
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

/** `/status`'s answer in the home chat's main flow: a new card every time, none edited or deleted. */
export class StatusMessage<B> {
  constructor(
    private readonly post: (chatId: string, body: B) => Promise<unknown>,
    private readonly log: (message: string) => void,
    /** The view under the platform's label. */
    private readonly render: (view: StatusView) => B,
  ) {}

  /** False — nothing open and no other chain to list, or the post failed — leaves the answer to the note. */
  async answer(chatId: string, view: StatusView): Promise<boolean> {
    if (!view.snapshot.items.length && !view.others?.length) return false;
    return this.post(chatId, this.render(view))
      .then(() => true, (err: unknown) => {
        this.log(`status: post failed: ${String(err)}`);
        return false;
      });
  }
}
