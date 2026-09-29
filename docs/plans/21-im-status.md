# IM status — reactions, one status message, and quiet progress

Status: building (lead branch `im-status`).

Source: three ideas the user approved for the IM home chat (and the web where
it applies): a reaction on the user's message instead of an acknowledgement,
one self-updating status message, and a push only when the user must decide or
an item is done. Each decision below is one of them; the worker branches are
named at the end. Owner docs to update when the code lands: 11 (home chat),
04 (receipts, seam), 10 (open items, the head's contract), 03 (unread, push).

## Decisions

### 1. The user's message wears its item's state (reactions)

Today a 👀 goes on a home-chat message and comes off at the head's turn end.
Now a message whose turn opened an item keeps wearing that item's state until
the item is done:

- **Joining.** `AgentReply.opened?: string[]` (core/types.ts) carries the
  problems the reply's `<open>` markers named, in order, set by `splitReply`
  (core/reply.ts, from `openItemMarkers`). At `Channel.send` on the home key,
  the receipts the turn settles (`ReceiptLedger.take(conversation, began)`)
  are moved to **item receipts** under the first opened problem instead of
  being cleared — the 👀 stays. A turn that opened nothing clears them as
  today. Only the home chat's main flow joins; every other conversation is
  unchanged.
- **States.** One reaction per message, from the item's `OpenStatus`
  (tasks/open-items.ts `openStatus`), applied by `Channel.status` (§2):
  `running` → 👀 (Slack `eyes`, Lark `OnIt`); `waiting on you` → ❓ (Slack
  `question`, Lark `WHAT`); the problem gone from the list (its `<done>`, or
  any other removal) → ✅ (Slack `white_check_mark`, Lark `DONE`) and the
  receipt forgotten; `stopped` and `pending release` → unchanged (the head's
  next marker settles them). A change swaps the reaction (remove the old, add
  the new); no change → no call.
- **Storage.** A new table `item_receipts(platform, chat_id, message_id,
  problem, reaction, created_at)` beside `receipts` (db.ts, one migration).
  The stale and startup sweeps of `receipts.ts` touch turn receipts only. At
  most 20 messages per item; the oldest beyond that is cleared and dropped.
- `Receipts` (channels/receipts.ts) gains the item half: the join at settle
  (`settleAfter(conversation, deliver, meta, joinTo?)`), and
  `items(view)` applying the state diff. Its reaction API becomes
  `addReaction(chatId, messageId, emoji)` / `removeReaction(chatId,
  messageId, emoji)` so a swap names both.

### 2. One status message in the home chat

- `Channel.status(chatId, view: OpenItemsView)` (core/types.ts) is the new
  seam method; `OpenItemsView = { text: string; items: { problem: string;
  status: string }[] }` is declared in core/types.ts, `text` the one
  `/status` string (`openItemsStatus`, tasks/open-items.ts) and `items` each
  item's problem and `OpenStatus`. Only the home chat has one; any other chat
  id rejects.
- main.ts subscribes to the hub's workspace events (`open-items-changed`,
  `task-run-changed`, `task-group-changed`, `session-state`), coalesces them
  on a 1.5 s timer, builds the view from `tasks.openItems()` and hands it to
  `ChannelRuntime.openItems(view)`, which forwards to the home platform's
  adapter while it is live; nothing otherwise.
- The adapter keeps **one** message per home chat, table
  `status_messages(platform, chat_id, message_id, text, behind)`: the label
  `▤ open items` in the platform's emphasis over the text. Same text as last
  posted → nothing. `Nothing open.` → the message is deleted and the row
  dropped. Otherwise edited in place — unless `behind` is set, when it is
  deleted and posted anew at the bottom. `behind` is set whenever the adapter
  posts anything else into the main flow (a reply, a note, a thread root),
  so the status line follows the bot's last post and a user's own message
  never re-posts it. Not pinned: pinning needs a scope neither app has; the
  message following the bot's last post is the degrade on both platforms.
- A refresh runs one at a time per adapter; one arriving mid-run is applied
  after it with the newest view (the older is dropped). Every platform
  failure is logged (`status: …`), never thrown into the hub.
- Shared logic lives in one module, `channels/status.ts` (the row, the
  edit/re-post decision, the item diff handed to `Receipts.items`), with the
  platform calls injected (`post`, `edit`, `delete`).

### 3. Quiet progress

- In the home chat's main flow, notes of kind `task-delegation` and
  `task-callback` are **not posted** (`Channel.notify` returns after logging
  at debug); the web timeline keeps the cards. Every other note kind and
  every other conversation is unchanged.
- A **silent reply** (`isSilentReply`) on the home key posts its
  `stayed silent — <reason>` footer only when the turn settled a user's
  message and opened no item (§5: the user typed and nothing else would
  show); otherwise it posts nothing — the reaction or the status message is
  the trace.
- `DISPATCHER` (agent/roles.ts), the dispatch bullet: a dispatch is silent
  (`<silent>dispatched</silent>` beside the `<open>` marker) unless there is a
  question or something the stage does not say; a callback that only moves
  the stage is silent the same way; on a decision or a done, the reply
  carries what the user needs in the head's words — the callback's text is on
  the web only, not on the phone. One bullet, replacing the sentence "A
  callback's text is already on the user's surface: … never repeats it".
- Web (web/server.ts, web/push.ts): a head turn that stayed silent sets no
  unread mark and sends no push; the push body is the reply's spoken text
  (`splitReply(text).text`), never raw markers.

## Not built

- Pinning the status message; a status message in any chat but the home; a
  per-thread status.
- A reaction on a message answered on the web (there is no message).

## Tests

- `core/reply.test.ts`: `splitReply().opened`.
- `channels/receipts.test.ts`: the join at settle; `items()` diff per state,
  ✅ on a gone problem and the row dropped; sweeps skip item receipts; the
  per-item cap.
- `channels/status.test.ts`: same text → no call; edit in place; `behind` →
  delete + post; empty → delete; failures logged.
- `channels/slack.test.ts`, `lark.test.ts`: a home reply with `opened` keeps
  the 👀 and joins; a delegation/callback note in the home main flow posts
  nothing, in a thread still posts; a silent home reply with a receipt and no
  item posts the footer, with an item posts nothing; `status()` posts, edits,
  re-posts after a reply, deletes on empty; a non-home chat rejects.
- `channels/runtime.test.ts`: `openItems` reaches the home adapter only while live.
- `web/server.test.ts`, `web/push.test.ts`: a silent head turn: no unread, no
  push; the push body is stripped.

## Workers

- `im-status-core` — decisions 1, 2, 3 (channel half), Slack, wiring, docs.
- `im-status-lark` — Lark's adapter, after the core branch.
- `im-status-web` — decision 3's prompt and web half.
