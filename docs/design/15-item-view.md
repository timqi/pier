# Item view

One problem followed on its own while several run at once: the head's context
carries only what it needs, every item keeps its record after it closes, and
the web shows one item's conversation alone. The head stays one session chain;
nothing here splits it. Behaviour not named here is
[10](10-continuous-session.md)'s and [03](03-web-workbench.md)'s.

## Vocabulary

Extends [10 §Prompt vocabulary](10-continuous-session.md#prompt-vocabulary).

| Word | Means | Not |
| --- | --- | --- |
| item | as [10](10-continuous-session.md): one `<open>` entry keyed by its problem; now kept after `<done>` | topic (the reply tag's name stays) |
| alias | an earlier key of the same item: a rewording, a merged item, a run's new problem | rename |
| item view | the conversation pane showing one item's rows only | filter, topic session |

## Head context

The head is one chain. What enters its context is bounded to the problem at
hand; what it needs from before is one fetch, never a seeded transcript.

- A `full` rotation seeds **no exchanges**. In their place one line under
  `## Previous session`: `session <id>, last on <item> at <YYYY-MM-DD HH:MM>`
  — `<item>` the `replyTopic` of the previous head's last reply, `none` when
  it had none — and the replay command `pier search --in <id> --around "<time>"`.
  `lastExchanges`, `EXCHANGES` and `EXCHANGES_CHARS` go (`core/chain.ts`);
  the seed's `[lang=]` stamp stays.
- The stage is what the next session continues from: the concrete step, the
  open question, the standing authorization. An item whose stage changed is
  `<open>`ed again in the same reply (`DISPATCHER`); a stale stage is the
  bug, never the seed's.
- A reply opened by a run's result speaks of that run's item only: no
  summary of the others, no status round-up unless asked (`DISPATCHER`).
- A message carrying an `[item: <problem>]` line is about that item
  (§Composer): the reply is tagged by it and reads nothing into the others.
- A message with no item line that fits more than one open item (`继续`,
  `可以`, a bare yes) is answered by asking which, in one line, when the
  newest reply on screen is not the only candidate; the head never picks
  (`DISPATCHER`).
- Recall stays on demand (`pier search --in main`, `rg` over `memory/`,
  [10 §Home and memory](10-continuous-session.md#home-and-memory)); the
  `## Open` seed is unchanged.

## Items keep their record

- `open_items` gains `closed_at INTEGER` (null while open), `aliases TEXT`
  (JSON array of earlier keys, `[]` by default) and `sessions TEXT` (JSON
  array of head session ids the item was written in: every `<open>`/`<done>`
  of it appends the writing session once) — one migration, `db.ts`.
- `<done>problem</done>` sets `closed_at`; nothing deletes a row. Every read
  of the open list (`TaskStore.openItems`, the seed, `/status`,
  `GET /api/continuous/open`, `namesKey`) is `closed_at IS NULL`; a closed
  item's runs count as no item's (`unlisted` unchanged).
- `<open>` with a closed item's key reopens it: `closed_at` cleared, aliases
  and sessions kept, its place in the list the reopening's time.
- `<done>old → new</done>` (` → ` or ` -> `, the first one in the body)
  closes `old` and records `old` and `old`'s aliases on `new`'s aliases,
  when `new` is open once the reply's markers are applied (opened in this
  reply or already open); otherwise nothing closes and the marker is
  unmatched, told on the head's next prompt with the existing
  `open-items` input, the line naming the arrow (`unmatchedNote`). The seed
  and `/status` show it under `unmatched <done>` as today.
  `OpenItemMarker` gains `to?: string` (`openItemMarkers`, `core/reply.ts`);
  `replyTopic` of such a reply is `new`.
- Pier's own rename — an `<open>` carrying a run of another item
  (`TaskStore.markOpenItems`) — records the old key as an alias. The items it
  used to delete (the second and later run-less ones) are closed instead,
  their keys aliases of the new item.
- `DISPATCHER`: the key is the user's words and stays; a rewording, a next
  phase of the same problem or two items joined is `<done>old → new</done>`
  beside `<open>new — stage</open>`, never a plain `<done>` and a new
  `<open>`. Over the last month 40 of 612 `<done>`s were such pairs; without
  the arrow the item's history breaks at each.
- `GET /api/continuous/items?q=<words>`: items whose `problem` or any alias
  holds every term (case-insensitive substring), closed included, newest
  `updated_at` first, at most 50: `{items: [{problem, aliases, closedAt?,
  updatedAt, status?}]}`, `status` the open item's as `/open` gives it. An
  empty `q` is the 50 newest.

## Item view (web)

The conversation pane in one item's company: `#/conversation/item/<encodeURIComponent(problem)>`.

- **Entry**: a reply's topic tag (the jump between a topic's replies it did
  until now goes, `topics.ts` `tagRow`); the status panel's row secondary
  action, one per row, ≥ 44 px on touch, the row's click itself still the
  navigation [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts)
  gives; and the panel's search field at its top — `GET /api/continuous/items?q=`
  as the user types, debounced, closed rows under a `Closed` group reading
  `closed <age> ago`, a closed row's click the view (it has nowhere else to
  go). An unknown problem in the hash reads `No item "<problem>"` with the
  way back; a closed item's view is read-only history plus the composer.
- **Rows**: `GET /api/continuous/items/:problem/turns` →
  `{problem, aliases, closedAt?, sessions: [{sessionId, startedAt, turns}]}`,
  the item's `sessions` in chain order, each session's transcript read off
  disk as the history route does and reduced to the item's rows by one rule
  (`itemTurns`, `core/open-items.ts`, pure, keys = problem ∪ aliases):
  - a reply whose `replyTopic` is a key;
  - the user turn a kept reply answers: the nearest user turn above it with
    no reply between, or any user turn carrying `[item: <key>]`;
  - a system input of `task-callback` origin whose run an `<open>` of a key
    named earlier in the chain, or that the item's `run_ids` hold;
  - every session divider (`session-seed`), so the reader sees rotations;
  - nothing else: no `/status` cards, no other items' callbacks.
  The head's own session is included up to the snapshot's `lastSeq`, returned
  as the history route's `{epoch, lastSeq}` so the client subscribes after it.
- **Live**: the view subscribes to the head's stream as the pane does; an
  incoming row is shown when the client's existing tagging
  ([03 §Topics](03-web-workbench.md#chat-pane-chatts-composerts)) tags it with
  a key — a user row the view sent is shown at once — and hidden otherwise,
  never removed from the pane's own transcript. A rotation's divider shows.
- **Exit**: the bar carries the item's dot and problem with `×`; `×`,
  Escape and ‹ return to `#/conversation` at its tail. The hash is the state:
  reload reopens the view.
- **Composer**: a message sent from the view is stamped by the client,
  `withItem(problem, text)` (`core/identity.ts`, beside `withQuote`): the
  first line `[item: <problem>]`, before a quote block when there is one;
  `splitItem` reads it back and surfaces show the message without it, the
  view's bubble carrying the item's tag. Sent to `POST /api/continuous/messages`
  as today; a chat command is sent unstamped. The IM adapters write no item line.
- Unread, the dot and the next-step rows are the pane's rules unchanged.
- The phone: the same materials; the bar's `×` and the panel's row action are
  the touch targets; the search field keeps the panel's keyboard behaviour
  ([06](06-ui-ux.md)).

## Chat surface

`<pier>/AGENTS.md`'s message-header paragraph gains one sentence: a message
whose first line is `[item: <problem>]` is about that open item, written by
the item view, never typed by the sender.

## Token impact

- A `full` rotation's seed is up to 4K chars (~1K tokens) smaller; the
  previous-session line is ~40 tokens.
- An item-stamped message costs its line, ~10–30 tokens; nothing else enters
  the head's context. The view itself costs the model nothing.
- The head's cache is untouched: the system prompt is the same bytes.

## Not built

- IM: the home DM shows every item's flow as today; no thread per item, no
  item line from an adapter.
- No second head, no topic chain, no memory per item: the pain was the pane
  and the seed, and both are answered without them. Revisited only if the
  head's replies mix items after this lands (§Acceptance).
- The view across the pane's trim: the view loads its sessions whole; a chain
  of hundreds of sessions is bounded by the item's `sessions` list, not paged.

## Seams

- `OpenItemMarker.to`, `openItemMarkers` (`core/reply.ts`); `itemTurns`
  (`core/open-items.ts`, browser-safe); `withItem`/`splitItem`
  (`core/identity.ts`).
- `TaskStore.openItems` (open only), `TaskStore.items(q)`, `TaskStore.itemHistory(problem)`,
  `markOpenItems` (closes, aliases, sessions).
- `WebDeps.itemTurns` reads a member's transcript off disk through the same
  factory the history route uses.
- `DISPATCHER` (`agent/roles.ts`): the stage, the callback reply, the item
  line, the ambiguity question, the arrow.

## Tests

- `core/reply.test.ts`: the arrow in both spellings, `replyTopic` of an arrow
  reply, an arrow inside a fence ignored.
- `core/chain.test.ts`: a `full` rotation's seed carries the previous-session
  line and no exchanges.
- `tasks/open-items.test.ts` / `store.test.ts`: `<done>` keeps the row closed,
  reopen, arrow to an open and to a missing `new`, Pier's rename recording
  aliases, `sessions` appended once per session, `items(q)` over aliases.
- `core/open-items.test.ts`: `itemTurns` on a mixed transcript — two items,
  callbacks of each, a `/status` card, a divider, an `[item:]`-stamped user
  turn.
- `web/server.test.ts`: both routes, 404 for an unknown problem.
- `web/ui/chat.test.ts`: the view's live filtering, exit, hash reload, the
  stamped send.

## Acceptance

- Two problems worked in the same hour: the item view of each shows only its
  rows across every rotation, and a message sent from a view is answered
  about that item.
- After a `full` rotation the head continues an item from its stage; the
  user repeats nothing, and the seed has no transcript of the other item.
- A reworded item (`<done>old → new</done>`) keeps its earlier rows in the
  view; a closed item is found by a word of its old key and read whole.
- A `<done>` whose arrow names nothing open closes nothing and is named on
  the head's next prompt.
- The head's transcript over a week shows no reply that summarizes an item
  other than the one its message or callback was about.
