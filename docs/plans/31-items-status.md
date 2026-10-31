# 31 — Closing items, busy receipts, a quiet status card

Branch `ux-items-status`. Three independent changes from the UX research run
(`ctpznw02yr8fjgsm`, items 6 and 9, and the user's own ask on the IM status
card), each with tests and its design sections, green on
`npm run check && npm run lint && npm test`. Another lead (`ux-quick-wins`) is
in `core/chain.ts`'s idle timer, `/new`, `/stop` and `core/reply.ts`'s footer:
touch those files only where named below. `native/` is untouched.

## A. The user closes an item (`/done <prefix>`, a Close action on the web)

Today only the head's `<done>` closes an item; a stale one lingers and blocks
`/chain archive`.

- `TaskService.closeItem(chainId, query, now)` — the one close path for both
  surfaces: resolves `query` against the chain's open keys as
  `Chains.resolve` does (`TaskStore.openItems(chainId)` problems; exact match
  case-insensitive first, else `startsWith` on the lowercased problem; one →
  close, several → refuse `/done <q> matches <a>, <b> — say more`, none →
  refuse `no open item "<q>"`); closes it through the store (a public
  `TaskStore.closeOpenItem(chainId, key, now)` wrapping the private
  `closeItem` in a transaction; a `<done>` closes and nothing deletes, same
  as the head's), emits `open-items-changed`, and tells the chain's head, when
  one is attached, with an `open-items` system input, mode `append`, no turn:
  `[Pier: the user closed <key>]` — the head's context still believes it is
  open, and without this its later `<done>` would read as unmatched. Returns
  the closed key. The refusals are one error class the surfaces map
  (`ItemNotFound`/`ItemAmbiguous` or one `ItemRefused` carrying the message).
- IM/web composer: `done` joins `CHAT_COMMANDS` (`core/types.ts`, line
  `close an open item — /done <its name or a unique prefix>`); `chatCommand`
  lets `done` take args like `chain` does (a bare `/done` is refused: `/done
  <item> — which one?`). `MainChain.command` (`core/chain.ts`) handles it in a
  few lines: `ChainDeps.close(chainId, args)` → the key, answered on the head
  as a `chat-command` note `✓ closed · <key>`; a refusal throws
  `ChatCommandRefused(message)` — IM shows it as the error note, the web as
  the send's 409 (already wired, `web/server.ts`). main.ts wires
  `close: (chainId, q) => tasks.closeItem(chainId, q, Date.now())`.
- Web status panel (`web/ui/drawer.ts`, `web/ui/open-items.ts`): an item row
  gets a second secondary action beside **Item view**, **Close** (an `X`/check
  icon button, 44px on a coarse pointer, `aria-label "Close — <title>"`),
  calling `POST /api/continuous/items/:chain/:problem/close` →
  `TaskService.closeItem` with the exact problem (404 on none, 409 on a
  refusal). Optimistic: the row is removed at once; the stream's
  `open-items-changed` reconciles; a failed call restores it and shows the
  error where the panel shows its search errors. Not in grouped cards or the
  item view — the panel only.
- Docs: 10 §Open items (a bullet: who may close, the resolution rule, the
  head's note) and §Chat commands; 11 §Chat commands table (`/done <item>` row,
  head column: `closes the item (unique prefix), answers ✓ closed · <key>`;
  thread column `prose`); 03 §Bar and status panel (the second action,
  `POST …/close` in the route table); `skills/pier-help/SKILL.md` one-line copy
  of the row.
- Tests: `tasks/service.test.ts` or `tasks/open-items.test.ts` (exact, prefix,
  ambiguous, none, head told, event emitted); `core/chain.test.ts` (`/done x`
  → note; refusal → `ChatCommandRefused`); `web/server.test.ts` (the route);
  `web/ui/drawer.test.ts` (the action).
- Budgets: `core/` is at 2179 of 2.2k; a few lines in chain.ts/types.ts are
  fine, but say in the commit what they buy. `web/` at 13680 of 13.7k —
  crossing it raises the ceiling in AGENTS.md with its clause.

## B. A busy head wears 👀 (`channels/receipts.ts`)

The home chat is quiet: no reaction on its main flow or threads. A message
that arrives while the head is mid-turn gets no signal until that turn ends.

- `Receipts.mark` in a quiet chat: if `working(conversationId)` is true at
  mark time, the reaction is added as in a loud chat; otherwise a timer
  (`lateMs`, a constructor parameter, default 20 000) adds it if the receipt is
  still on the books when it fires (`ledger.booked` finds the message). The
  timer is `unref`'d and cleared when the receipt clears.
- `clear` in a quiet chat removes the reaction only for a receipt that got
  one (the `applying` map knows; read it before `landed` deletes the key); the
  startup sweep (`everywhere`) still clears every quiet receipt.
- Adapters unchanged except nothing: `working` and `quiet` are already passed.
- Doc: 04 §Reaction receipts (the quiet-chat bullet gains the two exceptions);
  04 line 13's `Progress receipts` row says the same in a clause; 11 §Status's
  mention of quiet stays true.
- Tests (`channels/receipts.test.ts`): quiet + idle → no reaction; quiet +
  working → added and cleared on settle; quiet + idle → added after `lateMs`,
  not when settled before it; startup sweep unchanged.

## C. The IM status card only answers `/status`

The user: the card must not refresh with every change, must not move when the
last message went to the web, and `/status` must not delete the previous card
(Lark leaves a 撤回 placeholder).

- No automatic refresh: `main.ts` drops `STATUS_EVENTS`, `refreshStatus`,
  `FINAL_REPOST_MS` and the design-final re-post (line ~168), and
  `startChannels`' refresh; `ChannelRuntime.openItems` and `Channel.status`
  (`core/types.ts`, both adapters' `status()`) go; `Router.answersOn` goes if
  nothing else reads it (its tests too).
- `/status` typed in the home chat's main flow is the one trigger: the
  `chat-command` note with `statusSnapshot` reaches the adapter's `notify`;
  the adapter renders and **posts a new card** every time — nothing edited,
  nothing deleted, no `status_messages` row. `Nothing open.` with no other
  chain to list stays the plain note. A `/status` from the web never reaches
  IM (the head answers where the user last spoke), so the IM card does not
  move.
- `Other chains` on the card: the runtime builds it (`other()` stays) from a
  `viewOf: (chainId) => OpenItemsView` the constructor now takes (main.ts
  passes `openItemsStatus(tasks.openItems(id), Date.now())`); `HomeChains`
  gains `others(): OtherChain[]` (the current chain excluded), which the
  adapters call when answering `/status`.
- `channels/status.ts` shrinks to the layout (`statusLayout`, `statusLabel`,
  `otherCounts`, the row/view types) plus a `StatusMessage.answer(chatId, view)`
  that posts and returns whether it did (false → the note); the DB handle,
  `show`, `apply`, `forget`, `save`, `last`, queue go. `db.ts` adds a
  migration dropping `status_messages` (the style of 38; `db.test.ts`'s
  list follows).
- Docs: 11 §Status rewritten to the new contract (one paragraph: what
  triggers it, that nothing edits or deletes, `Other chains`, failures
  logged with `status:`); 04 §The seam's `status(chatId, view)` bullet and
  the `Channel` table rows go/are reworded; `core/types.ts`'s `Channel` doc
  comment follows.
- Kept as is, flagged to the user: `shownByStatus` (`core/reply.ts`, the
  other lead's file) still keeps delegation and succeeded-callback notes out
  of the home main flow; with the card frozen, such a callback shows on IM
  only through the head's reply.
- Tests: `channels/status.test.ts` (post on each answer, no edit/delete,
  nothing-open → false), `channels/runtime.test.ts` (`others()`),
  `channels/slack.test.ts`/`lark.test.ts` (the `/status` note posts a card and
  nothing else; a second `/status` posts a second one, the first untouched),
  `main`'s wiring has no test — `npm run check` covers it.

## Order

A, B, C each on its own worktree off `ux-items-status` (`items-done`,
`busy-receipts`, `status-once`), in parallel; integrated here with `git
merge`; the merged branch reviewed as a goal before the done milestone.
