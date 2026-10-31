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
- A `MainChain.send` that rejects (an archived chain, a seed that failed) is
  posted as an error note in the home chat (§5): the runtime catches it and
  calls `Channel.notify` with `{kind: "error"}`; the web's 4xx is not a surface
  the IM user sees.

## Chains

The home chat speaks to one chain at a time
([plans/30 §IM](../plans/30-multi-chain.md)): a pointer, never a thread or a
second DM.

- `home_chain` (`ChannelStore.homeChain`/`setHomeChain`, one row) is the
  chat's current chain; none is the first chain (`Chains.first()`). A
  different home (`setHome`), the home chat's removal (`removeChat`) or a bot
  swap that drops it (`claimBot`) deletes it.
- Every home-chat message is `MainChain.send(msg, current, <chatId>)`, one at a
  time in the runtime, so a `/chain <name>` moves the pointer the next message
  reads; a `switched` answer writes it and posts `↔ chain · <name>`
  (`chat-command` note, never model context).
- A pointer on an archived chain (archived from the web) falls back to the
  first chain on the next message: written, and said as
  `↔ chain · <first> — <old> is archived`.
- `/status`, `/new`, `/stop`, `/skills` and `/chain` reach the current chain's
  head through the same send (§Chat commands).
- Every chain's head answers in the home chat (§The head's key), whichever
  holds its key. A main-flow reply from a head whose chain is not the current
  one (a callback's answer after the switch) opens on a grey `chain · <name>`
  line — Slack a `context` block, Lark a grey markdown line; the current
  chain's replies carry none (`HomeChains.speaker`, `channels/control.ts`,
  from `Router.replyingOn`: the session whose reply the adapter was handed).
- A main-flow button names the chain whose head offered it — Lark the value's
  `chain`, Slack the button's `value` — and its click goes to that chain
  (`HomeChains.tap`), the pointer unmoved.

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
- Each chain's head is a head: one whose key another chain's head took (the
  chat switched and spoke) still answers in the home chat while no user spoke
  to it on the web — an alias defers to the durable chat at delivery
  (`Router.answerKey`) without taking the key back.
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
  today (`designFinal`, `router.onTurnEnd`); the head's callback note is
  left to `/status` and the web, not posted in the main flow (§Status). The thread stays bound after the design closes;
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
| the head's reply | the turn: chunks, footer `45s · 32K tok`, `file://` links uploaded; a silent one `▶ <run name> · <tier>` per run the turn launched (`HomeChains.speaker(meta)`, the ledger from the turn's start; the tier where recorded), else `stayed silent — <reason>` / `no reply` (a silent main-flow reply: §Status) |
| next-step buttons | the last chunk's row; a click on a main-flow message is the home's message: echo `▸ <label>` top-level, the receipt booked on the echo, the row retired (Lark: button value `root: ""` names the home), sent to the chain that offered it (§Chains) |
| a task callback / delegation | main flow: nothing (logged at debug) unless the run failed, was cancelled or interrupted, which is posted as in a thread; `/status`'s card and the web timeline carry the rest. A thread of the home chat: the system note (`noteBody` digest, `↩ task callback` · `▶ delegated task`, each followed outside the emphasis by the run's `tier · model id · reasoning` where recorded), before the turn it triggers |
| the seed | `↺ new session · <reason>` over the digest's first lines (`originLabel`, `session-seed`) |
| a chat command's answer | `/<command>` label, the text **whole** (bounded: the open-items text, `stopped`, `nothing running`, the skill lines); `originLabel`, `chat-command` |
| an unmatched `<done>` | `▤ open items` over the digest: the keys that closed nothing and the open keys to resend (`originLabel`, `open-items`) |
| a failure | `⚠ failed` note |
| a turn or agent run resumed | restart system input in the transcript and the note the chat gets before the reply |
| a turn that could not resume | ledger note to its chat; log for web/task keys |
| an agent run that could not resume | run `failed`, callback carries the reason; home chat via `owesNotice` |
| a non-agent run the stop cut | `interrupted`, callback, home chat via `owesNotice` |
| a cut send | ledger note, as today |
| the stop itself | journal: `SIGTERM — N turn(s) aborted, K run(s) left running for the next boot` |

- Receipts: the home chat, main flow and threads, wears no reaction unless the
  message reached a head mid-turn or waits past 20 s ([04 §Reaction
  receipts](04-im-channels.md#reaction-receipts)); its messages are still booked under the home conversation id and settled by the
  head's turn-end, which tells a silent turn whether it settled one (§Status).
  A chat command is not booked — its answer is a note, and no turn would
  settle it — and neither is a `chat-command`, `open-items` or `session-seed` note
  (`awaitsTurn`): the message that caused a seed carries its own.

## Status

`/status` typed in the home chat's main flow is answered by a new status card
(`channels/status.ts`) posted every time: nothing refreshes, edits or deletes
a card, and no table keeps one.

- The `chat-command` note carrying `statusSnapshot` reaches the adapter's
  `notify`, which posts the card over that snapshot (`StatusMessage.answer`) with
  `Other chains` from `HomeChains.others()` (the runtime's `viewOf` per chain,
  the current chain left out); `Nothing open.` with no other chain listed, a
  thread's `/status` or a failed post is the plain note. A `/status` from the web
  is answered on the web, so the chat's last card stays where it was.
- The card is `▤ open items · <chain>` — the current chain's name —
  in the platform's emphasis over the view's snapshot, one per home chat, laid out by `statusLayout` in the sidebar's
  groups and words ([10 §Open items](10-continuous-session.md#open-items)):
  `Waiting on you · N`, `In progress · N`, `Other open · N`; per item the title in
  bold with its status label as a tag (`Queued`, `Stopped`, …; none while
  running; `Needs you` omitted in the `Waiting on you` group), the stage — for a
  waiting item what the user is needed for, `in the design session` kept — on its
  own line, then time/goal/worker metadata. Lark:
  one markdown element per item, the tag a `text_tag`, a waiting item's stage
  orange, headings and metadata grey; Slack: Block Kit, headings and
  metadata `context` blocks, the item a `section` with the tag in code and a
  waiting stage quoted, under the compact text as the message's `text` for
  notifications. Each field is cut at a fixed length; items past the budget
  (Lark 7000 chars and 100 elements, Slack 50 blocks) are left out whole behind
  `… N more`. Under the groups, one minor section (Lark one notation-size
  element, Slack one `context` block) under a plain `Other chains`: a line per
  other chain, its name then `· N waiting · M in progress` — an active chain when either
  is non-zero, an archived one only while something waits on the user,
  tagged `archived`; no such chain, no section. No run IDs appear, and old text-only `/status` notes retain the
  legacy `withoutRunIds` transform.
- A silent main-flow turn that settled a booked message — the user's, or a
  note posted before it — posts its footer, `<open>` marker or not: the runs it
  launched as `▶ <run name> · <tier>` (the dispatch's receipt, since the main
  flow posts no delegation note), else `stayed silent — <reason>`; one with
  nothing booked, a callback `/status` and the web show, posts nothing.
- A failed post or a failed read of the other chains is logged with a
  `status:` prefix, never thrown into the hub.

## Chat commands

The one command table for every surface; other docs point here. In the home
chat a head command acts on the chat's current chain (§Chains). A command is
the whole message `<prefix><word>` (args after the word where a command takes
them), the prefix `/` or `%`, trimmed and case-insensitive. `%` exists because
Slack's client eats an unregistered `/`; it is accepted everywhere so one
spelling works on the phone whichever app it is (`parseCommand` in
`channels/commands.ts` and `chatCommand` in `core/types.ts` both take `[/%]`;
the web composer's completion keeps `/`). There is no other spelling: no bare
words, no unprefixed `s <text>`, and a message that is only a mention (or
empty) is dropped with a log line, never a command.

| Command | The head (home chat, web) | A thread of any other chat |
| --- | --- | --- |
| `/status` | the head's open items (`MainChain.send`); in the home chat's main flow a new status card is the one answer, the note only when nothing is open in any chain or the post failed (§Status) | prose |
| `/new` · `/new <text>` | the next head now, a streaming head stopped first; with `<text>`, that sent to it as its first message (booked as a message, its receipt the turn's) | prose |
| `/stop` | aborts the head's turn, children untouched: `stopped` · `nothing running`, then ` · <N> run(s) still running` while the chain has runs in flight | aborts the thread's session: `⏹ Stopped.` |
| `/skills` | one `<name> — <description>` line per skill (§Skill commands by prefix) | the same, for the thread's session |
| `/chain` | the chains, the current marked `✓`, archived last (`MainChain.send`) | prose |
| `/chain <name>` · `new <name>` · `rename <name>` · `archive` | switch (unique prefix) · create and switch · rename the current · archive the current, refused with open items; a switch answers `↔ chain · <name>` (§Chains) | prose |
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

- A session answers on the surface its last user message took, and nowhere
  else. A message or chat command from the home chat keys the head to it
  (`Router.heard`): every later turn, note and failure — a
  callback's answer included — is delivered there, `channelOf(head)` is the
  platform, so Web Push sends nothing and the web sets no unread mark (a turn
  delivered to a chat is not notified about again). A message typed on the
  web keys the head to the web until the chat speaks again: nothing is posted
  in the DM meanwhile, a `/status` typed there included (§Status), and Web Push goes to the browser that typed it
  ([03 §Notifications](03-web-workbench.md#notifications-srcwebpushts--srcwebwebpushts)).
  A `task:` open never takes the key off a surface a user spoke on, nor does
  an idle eviction's reopen; an adapter's restart does not take the head back
  from the web (`toChat`). A rotation's next head is keyed to the surface the
  send came from before its seed is appended, so a web send posts no seed card
  in the DM.
  The web timeline shows every turn regardless; the DM is never backfilled
  with what it was not told.
- Until a user speaks after a start, the durable rule holds: the home chat
  while its adapter is live, else the web. The last surface is in memory
  only — a restart returns the head to the home chat.
- No home chat, or its adapter down: Web Push.
- A run's abnormal-end notice (`abnormalEnd`, below) goes to the home chat
  through the restart ledger whichever surface the head answers on.
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
- `home_chain(chain_id)`, at most one row: the home chat's current chain (§Chains).
- `status_messages(platform, chat_id, message_id, text, behind)`, one row per
  home chat (db.ts, migration 37).

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
- `core/router.test.ts`: a web message keys the head to the web — no turn-end
  or note reaches the chat, a `task:` open and the adapter's re-register
  leave it there — and the chat's next message takes it back; a chat spoken
  from takes the head back when its adapter returns; an eviction's reopen
  keeps the web.
- `core/chain.test.ts`: a web send's rotation and a web `/new` key the next
  head to the web with no seed card in the chat; a chat `/status` takes it back.
- `core/reply.test.ts`: `originLabel` for `session-seed` and `chat-command`;
  `channels/lines.test.ts`: a `chat-command` note is quoted whole.
- `channels/config.test.ts`: one home across platforms; the chain pointer kept,
  and dropped with its home.
- §Chains: `channels/runtime.test.ts` the current chain per message, a switch's
  pointer and note, the archived fallback, a tap to its chain, the speaker,
  and `HomeChains.others()`, a failed read listing none;
  `channels/slack.test.ts` and `lark.test.ts` `/chain`'s five forms in the home
  and prose in a thread, the grey line and the button's chain;
  `channels/slack-render.test.ts`, `lark-render.test.ts` and
  `status.test.ts` the `Other chains` section.
- `web/push.test.ts`: no push while the head answers a chat; only the browser
  that spoke is notified, nobody when it has no subscription, every device
  when no browser has spoken.
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
- §Status: `channels/receipts.test.ts` a quiet chat booked, settled and
  periodically swept with no reaction call, 👀 on a busy head or past `lateMs`,
  cleared by the startup sweep;
  `channels/status.test.ts` a post on each answer, nothing open, a failed post;
  `channels/lark-render.test.ts` `statusCard` and
  `channels/slack-render.test.ts` `statusMessage` the layout and the budget;
  `channels/slack.test.ts` and `lark.test.ts` no reaction call in the home, a
  silent turn's footer, notes, and `/status` posting a new card each time with
  nothing edited or deleted, the note when nothing is open or in a thread.

## Acceptance

- A day of use from the phone: every spoken reply, seed and `/status` answer
  of the head appears in the DM's main flow in order, no message wears a
  reaction, `/status` posts a card of what is open, and a
  callback shows nowhere in the main flow unless a run failed or the head
  speaks (§Status); nothing appears twice on the phone (no push beside
  the DM); the web timeline matches.
- Disabling the platform in the Console returns the head to the web with
  Web Push, with no restart.
- A design lead launched from the phone asks its first question in a thread
  of the home DM, on Lark and on Slack alike; the discussion and the
  finalize button happen there; the head reports the final design in the
  main flow and the build starts.

