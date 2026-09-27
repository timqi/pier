# IM home chat

The contract for one IM DM joining the continuous conversation
([10](10-continuous-session.md)): which chat, how its messages reach the head,
how the head's replies, notes and buttons render there, and what the web
stops doing meanwhile. Everything not named here is [04](04-im-channels.md)'s.

## The home chat

- At most one chat per instance, a DM, on either platform: `ChatConfig.home`
  (`channels/types.ts`), set from the Console's chat row (a DM row's "This DM
  is the conversation" switch); a save that sets it clears every other row
  on both platforms (`ChannelStore.setHome`, `ChannelStore.home()`).
- A group is never the home: its main flow belongs to the people in it; groups
  stay thread-per-session. Any other DM stays thread-per-session too.
- `ChannelControl.isHome(key)`: the key is the home chat's main flow —
  `<platform>` + `<chatId>` with no thread half, the one shape
  [04 §Conversation identity](04-im-channels.md#conversation-identity)
  refuses today.

## Routing

The home chat is the head's and nothing else's: every message in it,
top-level or in any thread, goes to the head (`MainChain.send`) under the key
`<chatId>`. No thread session, no panel, no `knows()` per message.

- Setting the home drops that chat's `conversations` rows
  (`ConversationStore.forgetChat`): a thread session opened there before is
  unreachable from the chat and reads the same as a live one; its transcript
  stays on the web.
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
  chat's adapter is live (`ChannelRuntime.live`), else the `conversations` row
  as today; an older member gets no home key, so an adapter's start cannot
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

## Rendering in the DM

Main flow, no thread: Slack posts with `thread_ts` omitted; Lark posts a card
by `message.create` to the chat (`LarkApi.sendCard(chatId, card)`) and
uploads files the same way. `send`/`notify` accept a conversation id with no
thread half only for the home chat; any other is refused as today.

| What | Renders as |
| --- | --- |
| the head's reply | the turn as today: chunks, footer `45s · 32K tok`, `file://` links uploaded, `stayed silent — <reason>` / `no reply` |
| next-step buttons | the last chunk's row; a click on a main-flow message is the home's message: echo `▸ <label>` top-level, 👀 on the echo, the row retired (Lark: button value `root: ""` names the home) |
| a task callback / delegation | the system note as today (`noteBody` digest, `↩ task callback` · `▶ delegated task`), before the turn it triggers |
| the seed | `↺ new session · <reason>` over the digest's first lines (`originLabel` gains `session-seed`) |
| a chat command's answer | `/status` · `/new` · `/stop` label, the text **whole** (bounded: the open-items text, `stopped`, `nothing running`); `originLabel` gains `chat-command` |
| a failure | `⚠ failed` note, as today |
| a restart note (`drain.ts`) | the same `notify`, main flow |

- Receipts: the 👀 on a home message is keyed by the home conversation id and
  comes off with the head's turn-end, as any conversation's. A chat command
  wears none — its answer is a note, and no turn would take it off — and
  neither does a `chat-command` or `session-seed` note (`awaitsTurn`): the
  message that caused a seed already wears its own.
- `originLabel` today labels every non-task origin `↩ task callback`; the two
  new kinds are the first non-task origins to reach an adapter.

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
| `/status` | the head's open items (`MainChain.send`) | prose |
| `/new` | the next head now; a streaming head refuses (`the conversation is replying — /stop first`) | prose |
| `/stop` | aborts the head's turn, children untouched: `stopped` · `nothing running` | aborts the thread's session: `⏹ Stopped.` |
| `/skills` | one `<name> — <description>` line per skill (§Skill commands by prefix) | the same, for the thread's session |
| `/settings` | prose | the panel on the thread ([04 §The in-chat panel](04-im-channels.md#the-in-chat-panel)) |
| `/s <text>` | prose | on a thread root, the draft with `<text>` as its question; inside a thread, prose |
| `/bind <code>` (a DM) | bind | bind |

- A head command's answer is the `chat-command` note above; the transcript
  records it as a web-sent command does.
- An unknown `/word` or `%word` is a message, never an error, on every
  surface ([10](10-continuous-session.md#chat-commands)).

### Skill commands by prefix

A skill is invoked as `/skill:<name> <text>` (Pi's own expansion); on a phone
the full name is not typeable reliably, and IM has no completion. So the
router resolves a short spelling before Pi sees it (`Router.dispatch`,
against `session.skills()` of the session the message reaches — the head or a
thread's):

- `/<word> <text>` or `%<word> <text>`, `word` no chat command and no
  `skill:` — `word` names a skill when it is a prefix of the skill's name or
  of the name after any `-` (`/pier-t`, `/tasks`, `/ta` → `pier-tasks`;
  `/skill:pier-t` the same with the `skill:` kept). Exactly one match:
  rewritten to `/skill:<name> <text>` and dispatched; the transcript shows
  the rewritten line, so the web's bubble reads what Pi ran.
- More than one: not sent; the chat is told `/pier- matches pier-tasks,
  pier-web, pier-slack — say more` (the `{kind: "error"}` note; on the web the
  send's 4xx says it). None: a message, as today.
- `/skills` (`%skills`) is a chat command on every surface (`CHAT_COMMANDS`
  gains `skills: "the skills this session can run, by name"`): the answer is
  one line per skill, `<name> — <description>`, the `chat-command` note, so
  the names are on screen where they are typed. It answers for any session,
  not only the head: `MainChain.send` takes it for the head, and a thread's
  adapter routes it through the same `chatCommand` seam with the thread's
  session (`ChannelControl.skills(key)`).
- Tests: `core/router.test.ts` (unique, ambiguous, none, `skill:` kept);
  `core/chain.test.ts` (`/skills`).

## Attachments

Unchanged. Inbound files land in the inbox past the gate and ride the prompt
as `[name](file:///…)` lines to the head; a reply's `file://` links upload to
the DM's main flow, an `[attachment lost: …]` line on failure.

## Group chats

Unchanged: thread-per-session, mention and bind gates, the speaker header per
turn. A group cannot be the home; the head is reached from a group only
through what main launches (`pier task`), never by a group's message.

## Notifications

- The home chat is the conversation's notification. While the head is
  attached under the home key, `channelOf(head)` is the platform, so Web Push
  sends nothing for it and the web sets no unread mark on it (the existing
  rule: a turn delivered to a chat is not notified about again). The web
  timeline shows every turn regardless.
- A message typed on the web is not mirrored into the DM; the head's answer
  is, whichever surface asked. The web is the record, the DM the phone.
- No home chat, or its adapter down: Web Push as today.

## Storage

- `ChatConfig.home?: true` in the channel document, one across both
  platforms; no new table. `PUT /api/channels/:platform` with a `home` row
  clears the other platform's.
- No `conversations` row, no `main_chain` change.

## Build order

1. Lark: the home flag and Console switch, the dispatch split, `chatKeyOf`,
   `sendCard`/upload to chat, main-flow buttons, the `%` prefix, `originLabel`
   and the whole `chat-command` note — the operator's first look.
2. Slack: the same on `postMessage` without `thread_ts`, after 1 is judged.

## Not built

- A run card per child as a thread root in the home DM, bound to the child's
  session (talk to a lead or worker from the phone): the callback note names
  the run; the web and `pier task` reach the child.
- More than one home chat; a group as the home; a web message mirrored into
  the DM.
- The Lark `pier lark` CLI (operator's decision, [04](04-im-channels.md)).

## Tests

- `channels/lark.test.ts` (then `slack.test.ts`): a home message, top-level or
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

## Acceptance

- A day of use from the phone: every reply, callback, seed and `/status`
  answer of the head appears in the DM's main flow in order, with 👀 on each
  message until answered; nothing appears twice on the phone (no push beside
  the DM); the web timeline matches.
- Disabling the platform in the Console returns the head to the web with
  Web Push, with no restart.
