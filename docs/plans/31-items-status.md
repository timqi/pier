# 31 — Closing items, busy receipts, a status card edited in place

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

## C. The IM status card is edited in place, never withdrawn

The user: the card may follow changes on its own, but must not be withdrawn and
posted again over and over (Lark leaves a 撤回 placeholder for each); a message
sent on the web pushes nothing to IM — only a message from IM does.

- The refresh stays: `main.ts` coalesces `STATUS_EVENTS` on a 1.5 s timer into
  `ChannelRuntime.openItems()`, and `startChannels` refreshes once; the
  runtime calls `Channel.status(chatId, view)` on the home adapter.
- The gate: a refresh reaches the chat only while the head of the chain the
  user last wrote to (`MainChain.lastUserAt`) answers in the home chat
  (`Router.answersOn`; a `task:` key or none is the durable rule). After a web
  message nothing in IM is posted, edited or deleted until the user speaks from
  IM again; the first refresh then reconciles the card.
- Nothing is ever deleted: `StatusApi` has no `delete`. A change edits the
  card in place; `Nothing open.` with no other chain edits it to say so, and a
  later item edits it back; a failed edit posts a new card and leaves the old
  one; a home moved within the platform forgets the old chat's row, its card
  left as it was.
- `/status` in the main flow posts a **new** card at the bottom, which becomes
  the `status_messages` row edited from then on; the old card stays as it was.
  `Nothing open.` with no other chain answers with the note.
- A design final no longer re-posts the card (`FINAL_REPOST_MS` gone,
  `designLead` returns nothing): it edits in place as any change does.
- One view builder: the runtime's `viewOf` (constructor, from main.ts) and its
  `others()` build both the refresh's view and, through `HomeChains.others()`,
  `/status`'s `Other chains`; `StatusMessage` keeps no last view.
- `status_messages` stays (no migration drops it; nothing released one).
- Docs: 11 §Status, §Child threads and the tests/acceptance bullets; 04 §The
  seam's `status()` bullet and the System notes row; `core/types.ts`'s
  `Channel.status` comment; pier-help's `/status` line.
- Tests: `channels/status.test.ts` (edit in place; `/status` posts anew, the
  old row untouched; nothing open edits; a failed edit posts anew),
  `channels/runtime.test.ts` (the view, `others()`, the gate),
  `channels/slack.test.ts`/`lark.test.ts` (no delete call on the status path),
  `core/router.test.ts` (`answersOn`), `db.test.ts`.

## Order

A, B, C each on its own worktree off `ux-items-status` (`items-done`,
`busy-receipts`, `status-once`, then `status-edit`), in parallel; integrated here with `git
merge`; the merged branch reviewed as a goal before the done milestone.
