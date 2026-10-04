# IM home chat

The contract for one IM DM joining the Pier head
([10](10-continuous-session.md)): which chat, how its messages reach the head,
how the head's replies, notes and buttons render there, what the web stops
doing meanwhile, and the one kind of thread the chat has (§Child threads).
Everything not named here is [04](04-im-channels.md)'s.

## The home chat

- At most one chat per instance, a DM, on either platform: `ChatConfig.home`
  (`channels/types.ts`), set from the Console's chat row (a DM row's "This DM
  is the conversation" switch); a save that sets it clears every other row
  on both platforms (`ChannelStore.setHome`, `ChannelStore.home()`).
- A group is never the home: its main flow belongs to the people in it; groups
  stay thread-per-session. Any other DM stays thread-per-session too.
- `ChannelControl.isHome(key)`: the key's platform is the home's and its
  chat half (`chatOf`) is the home chat — top-level or in a thread; the home
  key itself is `<chatId>` with no thread half
  ([04 §Conversation identity](04-im-channels.md#conversation-identity)).

## Routing

The home chat is the head's: every message in it goes to the head
(`MainChain.send`) under the key `<chatId>` — top-level, or in any thread
that is not a child's. A thread with a `conversations` row (§Child threads)
is that session's, routed as any thread of any chat (`Router.dispatch`, the
panel, `/stop`, `/skills`): the adapter asks `control.knows(<chatId>/<thread>)`
for a threaded message in the home chat, and nothing else per message.

- Setting the home drops that chat's `conversations` rows
  (`ConversationStore.forgetChat`): a thread session opened there before is
  unreachable from the chat and reads the same as a live one; its transcript
  stays on the web. Child threads are the only rows the home chat has after
  that.
- `/settings` and `/s <text>` are prose here (§Chat commands): the head
  has no cwd to pick (the home) and its model & reasoning are the web's ⋯
  menu ([10 §Web](10-continuous-session.md#web)).
  Real work in a directory is what the head delegates (`pier task run`), never
  a session the phone opens by hand.
- `ChannelRuntime` hands an adapter's message to `MainChain.send` when
  `control.isHome(msg.key)`, else to `Router.dispatch`; `MainChain.send` takes
  the message's key and dispatches to it (the head is attached under it, below)
  instead of the `web:` alias, so the speaker header carries the place
  (`[qiqi<U…> 14:23 slack:D0…]`) and `pier slack` can reach the DM.
- A `MainChain.send` that rejects (a refused `/new`, a seed that failed) is
  posted as an error note in the home chat (§5): the runtime catches it and
  calls `Channel.notify` with `{kind: "error"}`; the web's 4xx is not a surface
  the IM user sees.

## The head's key

- The home key is the head's delivery key: `Router`'s `chatKeyOf(sessionId)`
  (wired in `main.ts`) answers the home key for the head while the home
  chat's adapter is live (`ChannelRuntime.live`), else the `conversations` row; an older member gets no home key, so an adapter's start cannot
  re-key it over the head. Attaching the head under `web:` or `task:`
  takes the chat key by the existing rule (an alias never outranks a chat), so
  every turn-end and every system input of the head reaches the home chat
  through the existing `Router.attach` subscription — callbacks, delegations,
  the seed, a chat command's answer, an error — and the web sees the same
  events on the hub.
- A rotation attaches the next head the same way; the previous head keeps
  no delivery (`Router.attach` moves the key: the session that held it goes
  back to its own alias).
- `conversations` never holds a row for the home key: `Router.ensure(home)`
  is reached only after `MainChain.send` attached the head, so nothing can
  resolve the home key into a new session. `control.knows(home)` is false and
  nothing asks it.
- The adapter is down (token broken, disabled): `chatKeyOf` answers nothing,
  the head is web-only, Web Push resumes. Silence is never the outcome of a
  dead adapter.

## Child threads

A child that waits on the user — a design lead, today the only one
([09 §Decisions](09-tasks-cli.md#decisions)) — gets a thread in the home DM
bound to its session, so the design is discussed and finalized from the phone.
Both platforms, the same rule.

- **When**: a run on a design lead's session settles as `LEAD_TURN` (a turn
  that is the user's, not the head's — `settleCallback`,
  `tasks/callbacks.ts`) and the session has no chat yet (`conversations.keyOf`
  is empty). `TaskService` reports it (`designLead(run, "waiting")`, wired in
  `main.ts`) to `ChannelRuntime.designLead`.
- **Where**: the home chat, while its adapter is live. No home, or its adapter
  down: nothing — the web's needs-you already carries it, and the thread is
  never opened later.
- **How**: `Channel.openThread(chatId, note)` posts the note as a main-flow
  root and returns the thread's conversation id (Slack: `<chat>/<ts>` of the
  post; Lark: `<chat>/<messageId>`, which a reply in the topic carries as
  `root_id`). The note is `▷ <run name> · design — waiting for you` (origin
  `task-callback`, the run's `source`/`state`). The runtime then
  `conversations.set(thread, session)`, `Router.ensure(thread)` (resolved
  through the row like any thread's message; the chat outranks the `task:`
  alias, so every later turn of the lead lands in the thread), and
  `Channel.send(thread, splitReply(result))` — the result that already ended,
  buttons included (the finalize button), which the turn-end delivered
  nowhere. A failure after the root is posted is an error note in the thread;
  before, in the main flow.
- **Then**: the user's replies in the thread are the lead's messages; a button
  tap echoes into the thread; a reply carrying `Design final:` is recorded as
  today (`designFinal`, `router.onTurnEnd`); the head's callback note is the
  status message's, not the main flow's (§Status). The thread stays bound after the design closes;
  it reaches the same session.
- **The root is edited in place** (`Channel.editRoot(thread, note)`: Slack
  `chat.update`, Lark `message.patch`) on two transitions only: `Design
  final:` recorded → `✓ <run name> · design final`; a run of the lead that did
  not succeed → `⚠ <run name> · design — <error>`. Any other state the
  thread itself shows. One `designLead(run, state)` hook carries all three
  (`waiting`, `final`, `failed`); a failed edit is an error note in the
  thread, never silent.
- The web: the lead's session lists `channel: <platform>` and takes no unread
  mark or push while bound (a turn delivered to a chat), as any thread session
  opened on the web; the design's needs-you row is the store's and
  unaffected. Talking to the lead from the web mirrors its answer into the
  thread (an alias never outranks a chat).
- A lost session (Pi has no transcript) re-creates from the chat defaults like
  any thread's, without the lead's role; the home changing forgets the thread
  with the rest.

## Rendering in the DM

Main flow, no thread: Slack posts with `thread_ts` omitted; Lark posts a card
by `message.create` to the chat (`LarkApi.sendCard(chatId, card)`) and
uploads files the same way. `send`/`notify` accept a conversation id with no
thread half only for the home chat; any other is refused.

| What | Renders as |
| --- | --- |
| the head's reply | the turn: chunks, footer `45s · 32K tok`, `file://` links uploaded, `stayed silent — <reason>` / `no reply` (a silent main-flow reply: §Status) |
| next-step buttons | the last chunk's row; a click on a main-flow message is the home's message: echo `▸ <label>` top-level, 👀 on the echo, the row retired (Lark: button value `root: ""` names the home) |
| a task callback / delegation | main flow: nothing (logged at debug) unless the run failed, was cancelled or interrupted, which is posted as in a thread; the status message and the web timeline carry the rest. A thread of the home chat: the system note (`noteBody` digest, `↩ task callback` · `▶ delegated task`, each followed outside the emphasis by the run's `tier · model id · reasoning` where recorded), before the turn it triggers |
| the seed | `↺ new session · <reason>` over the digest's first lines (`originLabel`, `session-seed`) |
| a chat command's answer | `/<command>` label, the text **whole** (bounded: the open-items text, `stopped`, `nothing running`, the skill lines); `originLabel`, `chat-command` |
| a failure | `⚠ failed` note |
| a turn or agent run resumed | restart system input in the transcript and the note the chat gets before the reply |
| a turn that could not resume | ledger note to its chat; log for web/task keys |
| an agent run that could not resume | run `failed`, callback carries the reason; home chat via `owesNotice` |
| a non-agent run the stop cut | `interrupted`, callback, home chat via `owesNotice` |
| a cut send | ledger note, as today |
| the stop itself | journal: `SIGTERM — N turn(s) aborted, K run(s) left running for the next boot` |

- Receipts: the 👀 on a home message is keyed by the home conversation id and
  comes off with the head's turn-end, as any conversation's — unless that turn
  opened an item, when it stays as the item's state (§Status). A chat command
  wears none — its answer is a note, and no turn would take it off — and
  neither does a `chat-command` or `session-seed` note (`awaitsTurn`): the
  message that caused a seed already wears its own.

## Status

The home chat's main flow shows the open items in one status message and on
the messages that opened them (`channels/status.ts`, `channels/receipts.ts`).

- `AgentReply.opened` is the problems the reply's `<open>` markers named, in
  order (`splitReply`). A home main-flow reply with `opened` moves the
  receipts its turn settles to item receipts under the first problem, silent
  reply or not; the 👀 stays.
- An item receipt wears its item's `OpenStatus`: `running` → 👀, `waiting on
  you` → ❓, gone from the list → ✅ and forgotten; `stopped` and `pending
  release` keep what they wear, except a 👀, which comes off. A change removes the old reaction and adds the
  new one; no change, no call. At most 20 messages per item; the oldest past
  that is cleared and forgotten. The stale and startup sweeps skip them.
- main.ts coalesces `open-items-changed`, `task-run-changed`,
  `task-group-changed` and `session-state` on a 1.5 s timer into an
  `OpenItemsView` (`tasks.openItems()`, `openItemsStatus`: the compact text, its
  snapshot, and Settings' public address as `web`) and hands it to
  `ChannelRuntime.openItems`, which calls `Channel.status` on the home
  platform's live adapter; nothing otherwise.
- The status message is `▤ open items` in the platform's emphasis over the
  view's snapshot, one per home chat, laid out by `statusLayout` in the sidebar's
  groups and words ([10 §Open items](10-continuous-session.md#open-items)):
  `Waiting on you · N`, `In progress · N`, `Other open · N`; per item the title in
  bold with its status label as a tag (`Queued`, `Stopped`, …; none while
  running; `Needs you` omitted in the `Waiting on you` group), the stage — for a
  waiting item what the user is needed for, `in the design session` kept — on its
  own line, then time/goal/worker metadata and `Open on web`, a link to
  `<web>/app/#/session/<id>` where the item has a session and `web` is set. Lark:
  one markdown element per item, the tag a `text_tag`, a waiting item's stage
  orange, headings and metadata grey; Slack: Block Kit, headings and
  metadata `context` blocks, the item a `section` with the tag in code and a
  waiting stage quoted, under the compact text as the message's `text` for
  notifications. Each field is cut at a fixed length; items past the budget (Lark
  7000 chars and 100 elements, Slack 50 blocks) are left out whole behind
  `… N more`. No run IDs appear, and old text-only `/status` notes retain the
  legacy `withoutRunIds` transform. Same rendered body as last posted → nothing;
  `Nothing open.` → deleted; otherwise edited in place (posted when there is
  none). Replies, notes and thread roots never move it; only `/status` in the
  main flow posts it anew at the bottom, with the answer's text and snapshot
  (`StatusMessage.answer`), then deletes the old one without waiting; a failed
  re-post keeps the old one; `startChannels` refreshes once, after the restart
  note. One refresh runs at a time; the newest waiting view replaces
  the older. A home moved within the platform loses the old chat's card on the
  next refresh; moved across platforms, the old card stays until that adapter
  refreshes.
- A silent head reply in the main flow posts its `stayed silent — <reason>`
  footer only when its turn settled a message and opened no item; otherwise
  nothing — the reaction or the status message is the trace.
- Every platform failure is logged with a `status:` or `reaction` prefix and
  never thrown into the hub.

| Emoji | Slack | Lark |
| --- | --- | --- |
| working | `eyes` | `OnIt` |
| waiting on you | `question` | `WHAT` |
| done | `white_check_mark` | `DONE` |

## Chat commands

The one command table for every surface; other docs point here. A command is
the whole message `<prefix><word>` (args after the word where a command takes
them), the prefix `/` or `%`, trimmed and case-insensitive. `%` exists because
Slack's client eats an unregistered `/`; it is accepted everywhere so one
spelling works on the phone whichever app it is (`parseCommand` in
`channels/commands.ts` and `chatCommand` in `core/chain.ts` both take `[/%]`;
the web composer's completion keeps `/`). There is no other spelling: no bare
words, no unprefixed `s <text>`, and a message that is only a mention (or
empty) is dropped with a log line, never a command.

| Command | The head (home chat, web) | A thread of any other chat |
| --- | --- | --- |
| `/status` | the head's open items (`MainChain.send`); in the home chat's main flow the status message re-posted at the bottom is the one answer, the note only when nothing is open or the re-post failed | prose |
| `/new` | the next head now; a streaming head refuses (`the conversation is replying — /stop first`) | prose |
| `/stop` | aborts the head's turn, children untouched: `stopped` · `nothing running` | aborts the thread's session: `⏹ Stopped.` |
| `/skills` | one `<name> — <description>` line per skill (§Skill commands by prefix) | the same, for the thread's session |
| `/settings` | prose | the panel on the thread ([04 §The in-chat panel](04-im-channels.md#the-in-chat-panel)) |
| `/s <text>` | prose | on a thread root, the draft with `<text>` as its question; inside a thread, prose |
| `/bind <code>` (a DM) | bind | bind |

- A head command's answer is the `chat-command` note above; the transcript
  records it as a web-sent command does, and it never enters the model's context.
- An unknown `/word` or `%word` is a message, never an error, on every
  surface ([10](10-continuous-session.md#chat-commands)).
- `skills/pier-help/SKILL.md` (§In-chat commands and the settings panel) carries a one-line copy of
  each row: the npm package ships skills without `docs/design`. Changing a row
  changes both.

### Skill commands by prefix

A skill is invoked as `/skill:<name> <text>` (Pi's own expansion); on a phone
the full name is not typeable reliably, and IM has no completion. So the
router resolves a short spelling before Pi sees it (`Router.dispatch`,
against `session.skills()` of the session the message reaches — the head or a
thread's):

- `/<word> <text>` or `%<word> <text>`, `word` two characters or more and no
  chat command — `word` names a skill when it is a prefix of the skill's name
  or of the name after any `-` (`/pier-t`, `/tasks`, `/ta` → `pier-tasks`;
  `/skill:pier-t` the same with the `skill:` kept). Exactly one match:
  rewritten to `/skill:<name> <text>` and dispatched; the transcript shows
  the rewritten line, so the web's bubble reads what Pi ran.
- More than one: not sent; the chat is told `/pier- matches pier-tasks,
  pier-web, pier-slack — say more` (the `{kind: "error"}` note; on the web the
  send's 4xx says it). None: a message.
- `/skills` answers for any session: `MainChain.send` takes it for the head,
  and a thread's adapter asks `ChannelControl.skills(key)`.
- Tests: `core/router.test.ts` (unique, ambiguous, none, `skill:` kept);
  `core/chain.test.ts` (`/skills`).

## Attachments

Unchanged. Inbound files land in the inbox past the gate and ride the prompt
as `[name](file:///…)` lines to the head; a reply's `file://` links upload to
the DM's main flow, an `[attachment lost: …]` line on failure.

## Group chats

Unchanged: thread-per-session, mention and bind gates, the speaker header per
turn. A group cannot be the home; the head is reached from a group only
through what the head launches (`pier task`), never by a group's message.

## Notifications

- The home chat is the head's notification. While the head is
  attached under the home key, `channelOf(head)` is the platform, so Web Push
  sends nothing for it and the web sets no unread mark on it (the existing
  rule: a turn delivered to a chat is not notified about again). The web
  timeline shows every turn regardless.
- A message typed on the web is not mirrored into the DM; the head's answer
  is, whichever surface asked. The web is the record, the DM the phone.
- No home chat, or its adapter down: Web Push.
- A run a session launched that ends abnormally is told in the home chat when
  nothing else there would say so (`owesNotice`, `tasks/service.ts`): an
  interruption always; a failure, or a cancel no one asked for the user (asked
  by a session other than the head — not the head's, a cascade's or a
  first-wins join's), only when its result goes to a lead or nobody: to the
  head, its callback note is posted in the main flow even there — a note whose
  `origin.state` is not `succeeded`/`skipped` is never left to the status
  message (`shownByStatus`, `core/reply.ts`). A run that restarts the service
  resumes after it; it is not interrupted and needs no exemption.

## Storage

- `ChatConfig.home?: true` in the channel document, one across both
  platforms. `PUT /api/channels/:platform` with a `home` row
  clears the other platform's.
- No `conversations` row, no `main_chain` change.
- `item_receipts(platform, chat_id, message_id, problem, reaction,
  created_at)` beside `receipts`; `status_messages(platform, chat_id,
  message_id, text, behind)`, one row per home chat (db.ts, migration 37).

## Not built

- A thread for any other child (a build lead, a worker): the callback note
  names the run; the head and `pier task` reach it. A thread opened on demand
  for a session that has none, or for a design that waited while there was
  no home.
- More than one home chat; a group as the home; a web message mirrored into
  the DM.
- The Lark `pier lark` CLI (operator's decision, [04](04-im-channels.md)).

## Tests

- `channels/lark.test.ts` and `slack.test.ts`: a home message, top-level or
  in a thread, reaches the conversation sink with the home key; `/settings`
  there is prose; `/stop` and `%stop` split by chat; a main-flow button
  click echoes top-level with the home key; a home `send`/`notify` posts
  without a thread, a non-home one is still refused.
- `channels/commands.test.ts`, `core/chain.test.ts`: `%` parses as `/` does;
  `%` alone and `%unknown` are prose.
- `channels/runtime.test.ts`: dispatch splits on `isHome`; a rejected
  `MainChain.send` is notified as an error.
- `core/router.test.ts`: `chatKeyOf` answering for an alias attach delivers the
  turn-end to the channel.
- `core/reply.test.ts`: `originLabel` for `session-seed` and `chat-command`;
  `channels/lines.test.ts`: a `chat-command` note is quoted whole.
- `channels/config.test.ts`: one home across platforms.
- `web/push.test.ts`: no push while the head answers a chat.
- `channels/runtime.test.ts`: `designLead` binds the thread, attaches the
  session and posts the result there, then edits the root on `final` and
  `failed`; nothing without a live home or when the session already has a
  chat; a failed open is an error note in the main flow. `channels/lark.test.ts` and `slack.test.ts`,
  each: a threaded home message with a row goes to `Router.dispatch` under
  `<chat>/<thread>`, without one to the head; `openThread` returns the thread
  id and posts the root in the main flow. `tasks/lead.test.ts`: `designLead`
  fires `waiting` on `LEAD_TURN`, `final`, `failed`, for a design lead only.
  `tasks/service.test.ts` (§abnormal-end notice): which ends owe a notice, the
  cancel's asker, the boot write-off, a throwing reporter.
- §Status: `core/reply.test.ts` `opened`; `channels/receipts.test.ts` the
  join, the state diff, the sweeps, the cap; `channels/status.test.ts` edit,
  `/status`'s re-post, delete, failures; `channels/lark-render.test.ts`
  `statusCard` and `channels/slack-render.test.ts` `statusMessage` the layout,
  the link and the budget; `channels/slack.test.ts` the join at send,
  quiet notes and replies, `status()`; `channels/runtime.test.ts`
  `openItems` to the live home adapter only.

## Acceptance

- A day of use from the phone: every spoken reply, seed and `/status` answer
  of the head appears in the DM's main flow in order, a message wears its
  item's state until it is done, one status message shows what is open, and a
  callback shows only as that message changing in place unless a run failed or the head
  speaks (§Status); nothing appears twice on the phone (no push beside
  the DM); the web timeline matches.
- Disabling the platform in the Console returns the head to the web with
  Web Push, with no restart.
- A design lead launched from the phone asks its first question in a thread
  of the home DM, on Lark and on Slack alike; the discussion and the
  finalize button happen there; the head reports the final design in the
  main flow and the build starts.

