# IM Channels (living spec)

Platform adapters in front of Pi sessions. Telegram, Slack and Lark (Feishu)
all have adapters. This document is for whoever writes the next one: what is
already shared, what is genuinely platform-specific, and which mistakes are
already paid for.

Slack was the second adapter and cost four new files plus one branch in
`runtime.ts` — the shared layer needed two additions (`ChannelConfig.appToken`,
`ChannelControl.knows`) and one fix (receipt ids are strings, not numbers).
Lark was the third and cost five files (its outbound path was born split, the
lesson Slack paid for at 449 lines) plus the same one-line `runtime.ts` entry
— and the shared layer needed exactly one change: `balanceFences` moved from
slack-render into chunk.ts, because a second copy of fence repair is the third
copy rule waiting to fire. `ChannelControl` needed nothing new.

`docs/architecture.md` owns the rules. This file owns the *how*.

## What a channel provides

The product surface, so a new platform is a checklist instead of a feature
request per feature. "Shared" means the behaviour is already implemented off
the adapter and comes for free; "adapter" means the platform has to render or
detect something itself.

| Feature | Behaviour | Shared / adapter | TG | Slack | Lark |
| --- | --- | --- | :-: | :-: | :-: |
| Session per conversation | One chat (or thread) is one persisted Pi session, stable across restarts | shared (`conversations.ts`) | ✅ | ✅ | ✅ |
| Thread-per-request | A message in the parent chat opens a native thread and its own session; replies and commands stay put | shared policy, adapter creates the thread | ✅ | ✅ | ✅ |
| Steer by default | Inbound joins the running turn rather than queueing behind it | shared (`mode: "steer"`) | ✅ | ✅ | ✅ |
| Progress receipts | Every message that entered a turn wears 👀 until it settles; no intermediate reasoning is ever posted | shared ledger, adapter calls the reaction API | ✅ | ✅ | ✅ |
| Turn footer | `45s · 32K tok` under each reply | shared (`formatTurnMeta`) | ✅ | ✅ | ✅ |
| Next-step buttons | The agent's `[label]` row becomes buttons; a click sends the label as an ordinary message | shared parse, adapter renders + feeds back | ✅ | ✅ | ✅ |
| File attachments | Inbound files (images, documents) land in `$PIER_HOME/inbox/` and ride the prompt as `[name](file:///…)` lines (bytes: `core/inbox.ts`, grammar: `core/inbound-file.ts`); a failed or oversized download becomes an `[attachment lost: …]` line, never silence; the agent reads a file only when it chooses to | adapter (download after the gate) | ✅ | ✅ | ✅ |
| Outbound attachments | A `file://` link in a reply is dead on anyone else's machine, so the file is uploaded to the platform and the link's label stays in the text; over the cap, missing or refused becomes an `[attachment lost: …]` line (shared: `channels/attach.ts`, upload per `*-api.ts`) | shared split/read/report, adapter uploads | ✅ | ✅ | ✅ |
| System notes | Task delegation / callback / supervisor input is posted to the same thread before the turn it triggers | shared (`Channel.notify`) | ✅ | ✅ | ✅ |
| Failure notices | Any error reaches the conversation, not just the web timeline | shared (`Router.report`) | ✅ | ✅ | ✅ |
| Visible empty turns | A turn with no text still posts one muted line saying why | shared (`AgentReply.silence`), adapter renders | ✅ | ✅ | ✅ |
| Speaker identity | `[name<id> time]` above a message, only when it changes | shared (`core/identity.ts`), adapter resolves the name | ✅ | ✅ | ✅ |
| Deliberate silence | `<silent>` sends no reply, so a group thread is bearable | shared (`splitReply`) | ✅ | ✅ | ✅ |
| Stop | Abort the conversation's running turn | shared (`runtime` → `abortConversation`) | ✅ | ✅ | ✅ |
| Bind | Redeem a Console-issued single-use code in a DM | shared | ✅ | ✅ | ✅ |
| Permissions | Chat enable · require mention (groups) · bind (always in DMs) | shared (`gate()`) | ✅ | ✅ | ✅ |
| Per-chat launch config | cwd, model, reasoning level for the sessions a chat opens | shared (`launchFor`) | ✅ | ✅ | ✅ |
| Console tab | One page per platform: token, defaults, bound users, discovered chats; autosaved, token masked | shared (`routes.ts`, `web/ui/channels.ts`) | ✅ | ✅ | ✅ |
| Setup walkthrough | Hover help for getting a token and enabling threads | adapter copy, shared badge | ✅ | ✅ | ✅ |
| Settings panel | In-chat panel: read out session + policy, change model / reasoning / cwd (a new session), stop | shared control, adapter renders | ✅ | ✅ | ✅ |
| Agent access (platform as a tool) | An agent session reads/posts through the platform | adapter + skill (`slack-tool.ts`) | — | ✅ | —¹ |

✅ done · — not started · ¹ explicitly not wanted (operator decision, 2025)

Command *spelling* is per-platform, not shared: Telegram and Lark take
`/stop`, `/settings`, `/bind <code>`, and Slack takes the same words without
the slash (see Slack specifics) — Lark delivers a leading `/` verbatim, so
slash commands are free there the way they are on Telegram. The behaviour
behind them is identical.

### Deliberately not features

Rejected on purpose; re-adding any of them is a design decision, not a gap.

- **Backend / agent selection in chat** — Pier has one backend (Pi).
- **Message-visibility toggles** — intermediate reasoning is never sent to IM by
  design, so there is nothing to toggle.
- **Per-thread setting overrides** — settings stop at the chat level; a topic
  inherits its group and nothing else.
- **Admin / bind management from chat** — that is the Console's job.
- **Webhook inbound** — a local process should not require public inbound HTTP.
- **Registered Slack slash commands** — manifest setup for a second, weaker way
  to say what a bare word in the thread already says.
- **Posting in a Slack channel's main flow** — every reply lives in a thread,
  so there is no "reply here instead" mode to configure.
- **Editing a live session's cwd** — Pi fixes cwd at creation, so "change the
  working directory" is "start a new session there", and says so.

## Layout

```
src/channels/
  types.ts            config contract; type-only imported by web/ui — no node builtins
  config.ts           ChannelStore (one JSON doc per platform) + gate() — SHARED
  gatekeeper.ts       the inbound verdict + its drop log, and the bind-hint
                      throttle — SHARED
  chains.ts           one promise chain per conversation, and a bounded drain — SHARED
  chunk.ts            cut a long turn at the last break that fits — SHARED
  dedup.ts            the bounded seen-set both push transports need — SHARED
  lines.ts            what the shared control moments say — SHARED
  commands.ts         parseCommand() — SHARED
  conversations.ts    durable conversation → session map — SHARED
  receipts.ts         the reaction-receipt lifecycle, storage included — SHARED
  control.ts          ChannelControl: session reads/writes an adapter may make — SHARED
  runtime.ts          adapter lifecycle and control wiring — SHARED
  routes.ts           /api/channels/:platform — SHARED
  panel.ts            the settings panel, minus the platform — SHARED
  telegram.ts         the adapter
  telegram-api.ts     Bot API client (the only file touching api.telegram.org)
  telegram-render.ts  how a reply looks: markdown → HTML, and buttons
  telegram-panel.ts   the panel's Telegram half: HTML, keyboard, forced reply
  slack.ts            the adapter
  slack-api.ts        Web API + Socket Mode (the only file touching slack.com)
  slack-render.ts     how a reply looks: markdown → mrkdwn, and Block Kit
  slack-outbound.ts   how a turn becomes messages: renderer choice + chunking
  slack-panel.ts      the panel's Slack half: mrkdwn, Block Kit, modal
  slack-tool.ts       the agent-facing tool (intent in, Pier performs it)
  slack-directory.ts  channel kind/name + user names, cached for the process
  lark.ts             the adapter
  lark-api.ts         SDK wrapper (the only file importing @larksuiteoapi/node-sdk)
  lark-render.ts      how a reply looks: card 2.0 markdown, buttons, footer
  lark-outbound.ts    how a turn becomes cards: chunking, empty-turn wording
  lark-panel.ts       the panel's Lark half: card markup, a form for the cwd
```

Everything but the per-platform quartets is shared. A fourth adapter should
add four or five files and touch nothing else except `runtime.ts` (one entry
in `ADAPTERS`) and the Console copy in `web/ui/channel-help.ts`.

### The shared layer

Shared only where a second copy being *subtly different* is a bug, not a style
difference: gate verdict logging (`Gatekeeper`), the per-chat promise chains
with a `catch` on every link and a bounded drain (`Chains`), the TTL'd
`Dedup` set both push transports need, `chunkText` / `balanceFences`, the
inbound attachment loop with its size gate and lost-marker line
(`core/inbox.ts`), `Receipts.settleAfter`, `chatOf`, the fixed wording in
`lines.ts`, and the panel state machine in `panel.ts` — a platform supplies
markup, one send/edit/delete and one way to ask for a typed answer;
`PanelView` is titled groups of lines plus buttons, laid out by the platform.

Kept apart on purpose: the markdown→HTML and markdown→mrkdwn renderers (each
emits materially different output; Lark needs no translation at all), the
per-process user-name memos, the `discovered` chat sets.

## The seam

`Channel` (`core/types.ts`) is four methods:

- `start(onMessage)` — begin receiving; hand normalized `InboundMessage`s to core.
- `send(conversationId, reply)` — an assistant turn. **Called on every
  `turn-end`, empty text included.** Empty means "the turn settled with nothing
  to say", which is when per-turn UI (reaction receipts) must come off.
- `notify(conversationId, {text, origin})` — a note the chat should see that is
  not an assistant turn. Two origins: a persisted `system-input` (task
  delegation, callback, supervisor message), and **`{kind:"error"}`**. Sent *before* the turn it triggers,
  so an answer nobody asked for has a visible cause. Never rendered as an
  assistant turn, and it must not retire the receipts — that turn is still running.
- `stop()` — must **drain in-flight work**, because `runtime.reload()` starts a
  replacement immediately.

`AgentReply` carries `suggestions` (the agent's next-step labels) and `meta`
(`TurnMeta`). Surfaces without hover render `meta` as a footer, using
`formatTurnMeta()` from `core/reply.ts` — the wording and units live there so
web and every adapter agree (`45s · 32K tok`).

**A failure the chat cannot see is a failure nobody can debug.** `Router` posts
every error into the conversation as a `{kind:"error"}` note — session errors
(a tool that threw, a lost connection), a prompt that was rejected, and a
delivery that failed. This is shared and automatic: an adapter that implements
`notify` gets it, and must not reimplement it.

The failure mode it exists for: the receipts come off on turn-end, so an IM user
sees the eyes disappear and no reply arrive, which is indistinguishable from a
deliberate silence. The web had the error in its timeline all along, which is
exactly why this went unnoticed — the surface being debugged from was not the
surface that showed the problem. Notes are trimmed to 600 characters, and a
notify that itself fails is reported to the hub once, never retried into a loop.

**Control that is not a prompt does not go through the seam.** `ChannelControl`
(`control.ts`) is a narrow, platform-blind wrapper over the router and the
factory — abort, read status, list/set model, set reasoning, start a new
session, ask whether a conversation is already known — injected by `runtime.ts`,
which owns both. The seam keeps exactly one inbound path (`onMessage`); add the
next control here, not there. Slack's arrival added exactly one method
(`knows()`, for "is this thread already mine?"), which is the size a second
adapter should expect to add.

## The in-chat panel

`@bot` on its own (the text is empty once the mention is stripped) and
`settings` are the same request. Both panels implement the same contract; the
parts a third adapter should copy rather than reinvent:

- **One message, edited in place.** A new message per tap buries the chat.
- **Namespaced payloads.** Panel buttons are `cfg:<action>[:<arg>]` and are
  consumed by the panel; anything else is one of the agent's next-step labels,
  whose payload *is* the message to send. Without the namespace the two are
  indistinguishable.
- **Index, not name, in the payload.** Model lists are paged and referenced by
  index because payloads are size-capped; the page's list is cached per panel.
- **A panel from a previous process has no state.** Reopening on the first tap
  is the only honest recovery, and it costs one tap.
- **Changing the directory is one action, and it says so.** Pi fixes cwd at
  session creation, so the button reads "New session in…", asks for one typed
  answer, and rejects a relative path without changing anything. Telegram uses
  `force_reply` and must consume that answer *before* the prompt path — it is an
  answer to us, not a message for the agent. Slack uses a modal and carries the
  conversation id in `private_metadata`, which sidesteps the problem entirely:
  prefer a modal wherever the platform has one.

## Agent access: the platform as a tool, not just a surface

Everything above is Pier *receiving*. `slack-tool.ts` is the other direction: an
agent session asking Pier to read or write Slack. Two files, one config flag,
one skill (`skills/pier-slack/`), and a deliberate shape:

- **The agent states an intent; Pier performs it.** The bot token never reaches
  the model, and the tool takes a `#name` and an ISO time rather than a channel
  id and a Slack `ts`. If the agent had to know what a `ts` is, this would be a
  documented API instead of a tool — and the skill would be a Slack manual
  rather than nine operations.
- **"Here" is the default target.** Omitting `channel` acts on the conversation
  the calling session is answering, resolved through
  `Router.conversationOf(sessionId)`. Without this the agent could read and post
  anywhere *except* the thread it was standing in, and had to ask the human to
  paste a channel id and their own user id — which is what shipping it without
  this actually did. `context` reports the same thing explicitly.
  - Resolved **per call**, never captured at session creation: a Slack thread
    outlives the process and `AgentFactory.resume()` takes no launch options,
    so anything baked in at creation is gone after the first restart. That is
    also why this is not a per-session system prompt.
  - `thread_ts: "none"` is the explicit opt-out that starts a top-level
    message; a `thread_ts` from one channel is never inherited into another.
- **A transcript is lines, not objects.** `<ts> | <time, UTC> | <name>[<id>] |
  <text>`, declared in the reply's `format` field. Four hundred six-key objects
  spend most of their tokens on repeated key names. The name is what makes a
  transcript readable; the id is the only thing `<@…>` can be built from —
  returning only the name is why the agent once asked a human for their own
  user id. A thread's `threadTs` is hoisted out of the lines, and a channel
  read marks parents with `[thread: N replies]` so opening one is a decision
  rather than a probe. An upload is named the same way —
  `[file: <name> <F… id> <size>]` — because a line that dropped `files`
  entirely made a posted PDF read as a message about nothing.
- **A file is fetched explicitly, never automatically.** `fetch_file` takes the
  `F…` id off that line, resolves it through `files.info` and saves the bytes
  into `$PIER_HOME/inbox/slack/` — the same place an upload to Pier lands — and
  answers with the marker line alone, so the agent spends the context only if it
  opens the file. Downloading every file a read mentions would pull a hundred
  attachments nobody asked about, and only the agent knows which one the
  question is about; a refusal or a file over the cap comes back in the shared
  `[attachment lost: … ]` wording rather than as a stack.
- **The agent states an intent; Pier does the API work.** A channel and a
  range, a thread, or `after: <the last ts I saw>` — paging, cursors, ordering,
  dedup and the caps are Pier's problem. `after` filters strictly, because
  Slack's own bounds are inclusive-ish and a boundary message returned twice is
  a duplicate the agent has to reason about.
- **A failed page returns what came before it.** Paging is Pier's business, but
  a partial answer is the agent's: a thrown error looks exactly like a quiet
  channel. The reply carries `incomplete` with a reason, and Slack's error
  codes are translated into the action they imply (`not_in_channel` → invite
  the bot) rather than passed through as jargon.
- **Every read goes to Slack.** This replaced a cache-first design
  (`slack-archive.ts`, `slack_messages` + a `slack_sync` coverage span) that
  rested on "history is immutable once written". It is not: edits, deletions
  and retention all change it, and nothing invalidated the copy — a covered
  window served a deleted message forever, labelled `source: "cache"`. The
  cache was also a second copy of message text at rest, which is the one thing
  Pier deliberately does not keep.
  - What it bought was rate limit, and Pier does not need it: as a
    workspace-internal app `conversations.history`/`replies` are Tier 3 (~50+
    req/min) and a read is one or two pages. **If Pier is ever distributed as a
    non-Marketplace app** (1 req/min, 15 objects per response), that arithmetic
    inverts and a cache has to come back — with invalidation this time.
  - What SQL used to do and the tool now does in memory: reverse Slack's
    newest-first order, drop the duplicate on a page seam, slice to `limit`.
  - Keeping history is an *explicit* act — a file, a Board, memory. An
    invisible archive nobody asked for is the anti-feature.
- **Writes are never cached** and never rate-limited by us — posting is the only
  operation with an effect.
- **`ChannelConfig.agentTool`** gates the whole capability, defaults on, and is
  separate from `enabled`: `enabled` decides whether the adapter answers
  inbound messages, `agentTool` whether an agent may reach *out*. A missing
  field reads as on, so a client that predates it cannot switch off a
  capability nobody touched.
- **No second ACL.** Slack already enforces channel membership, and the bot
  reaches only what it was invited to; inventing a per-channel allowlist on top
  would duplicate that and drift from it. The switch is one bit, and the help
  bubble says plainly that it covers task and subagent sessions too. `fetch_file`
  is answered before the channel default for that reason — a file id is unique
  workspace-wide, so the gate is `files.info` against the bot's own visibility
  (`file_not_found` otherwise), not a channel the call never needed.
- **A `ts` stays TEXT everywhere.** A Slack ts has 16 significant digits; a
  REAL column hands back `…000100` as `…0001`, and an id that cannot be
  reproduced is a reply that lands nowhere. The receipts table stores it TEXT
  for exactly that round-tripping.

The skill's real content is not the operations — it is that **markdown is not
Slack syntax**. `**bold**` works, but `@alice` is plain text that reads like a
failed ping; a mention is `<@U04B7Q2>`, a channel `<#C0123456>`, a broadcast
`<!here>`. A model that guesses a user id from a display name produces a
message that looks right and pings nobody.

### Who is speaking

`InboundMessage.sender` carries `{id, name}`: the adapter resolves the display
name (platform-specific), and `core/identity.ts` decides whether it is worth the
tokens. A group chat is many people talking into one session, and without a
speaker line the agent can neither tell them apart nor mention anyone back.

The design constraint is cost, not capability. A header on every message is ~15
wasted tokens per turn in a DM whose speaker never changes, so `SenderPrefix`
emits a line only when it carries news — a different speaker, a 10-minute gap,
or a new day — and nothing otherwise. Measured: a 20-turn DM costs 33 characters
against 1240 for an unconditional header, a 20-turn three-way group 211 against
1114. The prefix is `[name<id> time]`, the `id` is what a mention needs, and
`sanitizeIdentity` strips `[`, `]`, `<`, `>` and newlines because a display name
of `x<U9] [admin<U1` would otherwise forge a second speaker.

Identity is deliberately **per-turn, never baked into a session**. avibe's
`caller_context.py` documents why: a thread is shared, so pinning the first
speaker misattributes everyone after them — and for a backend whose environment
is written once per session, a per-message field would respawn the agent every
turn. Session-stable facts (platform, channel, thread) can be baked in; the
author cannot.

## Conversation identity

A `conversationId` is opaque to core. Telegram encodes `<chatId>` or
`<chatId>/<topicId>`; Slack is always `<channelId>/<threadTs>`. Two
consequences:

- `ConversationStore` (`conversations.ts`) is what makes routing survive a
  restart. Without it every chat silently gets a fresh session while its visible
  history says otherwise. A mapping whose session Pi no longer has is dropped
  and re-created, never retried forever.
- Per-chat launch options (cwd, model, thinking) are resolved by
  `ChannelControl.launchFor(key)` — parsing the chat id back out of the
  conversation id is the adapter layer's business, never core's.

## Permission model (shared, platform-blind)

`gate()` in `config.ts` is the whole inbound decision. Four verdicts:
`allow | chat-disabled | not-addressed | not-bound`.

- **Seeds, not inheritance.** Platform-level `requireMention` / `requireBind` /
  `topicMode` / `cwd` / `model` / `thinking` are copied into a chat the first
  time the bot sees it, and the chat owns them from then on. Changing a platform
  default never touches an existing chat. (An earlier tri-state "inherit" was
  removed: a switch nobody can read off the screen is worse than a copy.)
- **DMs are bind-only by construction.** `if (isDm) return bound || bindRequest`.
  Mention is meaningless with two parties, and bind is the only thing between a
  stranger and an agent with a shell. The two flags are group settings, full stop.
- **Group denials are silent; DM denials answer.** A group where the bot replies
  "you are not allowed" to every passing message is worse than one that stays
  quiet. A DM that swallows everything looks broken, so it explains how to bind —
  throttled per sender, or the bot becomes an echo amplifier.
- **Discovery is passive.** No platform reliably lists "every chat this bot is
  in". Chats are recorded from inbound traffic and arrive enabled; the mention
  and bind gates are what keep a new one harmless.
- **Bind** is a Console-issued single-use code with a TTL, redeemed by
  `/bind <code>` in a DM. Bind requests must survive the bind gate or nobody can
  ever bind.

## Commands

`parseCommand()` (`commands.ts`) is shared: trim both ends, require a leading
`/`, split an `@target` off the name, lowercase the name, keep args **verbatim**
(a path or a sentence must not be re-joined from split words). The caller
decides whether `target` is itself — a command aimed at another bot in the same
group is not ours to answer, and travels on as ordinary text.

**A platform may not allow slashes at all.** Slack's client resolves a leading
`/` before any app sees it, so the adapter falls back to bare words and layers
its own rule on top of `parseCommand()`: a closed set *and* an exact argument
count per command (`stop`/`settings` take none, `bind` takes one). Anything
longer is prose and goes to the agent. Check question 8 in the verification
table before assuming `/stop` can even reach you.

## Inbound checklist for a new adapter

1. Normalize to `InboundMessage`. IM inbound is `mode: "steer"` — a human
   watching a chat window expects the next message to reach the running turn.
2. Detect *addressing* (mention entity, reply-to-bot, targeted slash command)
   before stripping it; strip a leading mention so the agent never sees it.
3. `discoverChat()`, then `gate()`. Log every drop with its verdict.
4. Download attachments **after** the gate. An unauthorized sender must not be
   able to make the bot pull bytes.
5. Order per conversation, concurrency across them. `telegram.ts` keeps one
   promise chain per chat: a slow photo download must not stall another group,
   and a steer must never overtake the message it interrupts. Bound the number
   of active chains, and only advance the platform's ack cursor for updates you
   actually accepted.
6. Assume at-least-once delivery. The last batch before a crash is replayed.

## Outbound checklist

1. Render markdown to the platform's accepted subset and **escape first**
   (`telegram-render.ts` extracts code, escapes, then re-introduces exactly
   the six tags Telegram documents).
2. Chunk to the platform's message limit; put interactive elements on the last
   chunk only.
3. Suggestions become buttons. The payload is an **index**, never the label
   (see the traps below); the label is read back off the message's own keyboard,
   so a button survives a restart. Pack short labels onto shared rows by
   rendered width — buttons in one row split the width, so a long label beside a
   short one truncates both. Retire the keyboard once one option is taken.
4. Append `formatTurnMeta(reply.meta)` as a footnote — one newline, not a blank
   line, since there is no small text to fall back on.
5. Reaction receipts: intermediate reasoning never goes to IM. Instead every
   message that entered a turn wears 👀 until the turn settles. See below.

## Reaction receipts, and why they are persisted

`receipts.ts` is a SQLite table, not a `Map`, because both halves of the
lifecycle live on the platform: the emoji is added on the way in and removed on
turn-end, and anything that ends the process in between leaves it on a user's
message forever. So:

- Book the receipt **synchronously, before dispatching** the message. A turn
  that settles instantly must not clear a receipt that is not recorded yet.
- Clear only what the ending turn was working on: pass `reply.meta` to
  `settle`/`settleAfter`, which scopes the claim to receipts booked by the time
  that turn began. One Pi run can end several turns — a message queued mid-turn
  is drained and answered inside the same run — and taking the emoji off a
  message the agent has not reached yet reads as an answer that never comes.
- Await the in-flight "add" before issuing the "clear". Clearing a reaction the
  platform has not applied yet leaves it up permanently.
- On `start()`, clear every receipt on the books — none can belong to this
  process yet. Sweep your own stragglers on a timer (30 min) for turns that
  never started at all.

All three rules live in one class (`Receipts`) because they are one invariant;
an adapter only calls `mark`, `settle` and `sweep`.

## Console surface

One tab per platform, one document per platform: token, defaults, bound users
and discovered chats on the same page (splitting them the way avibe does was
explicitly rejected). Routes:

| Route | Behavior |
| ----- | -------- |
| `GET /api/channels/:platform` | config with the token **masked** |
| `PUT /api/channels/:platform` | full document; masked token = unchanged token |
| `POST /api/channels/:platform/bind-code` | issue a single-use code |
| `DELETE /api/channels/:platform/users/:id` | unbind |
| `GET /api/models` | backend model catalog, no session needed |
| `GET /api/fs/ls`, `POST /api/fs/mkdir` | directory browsing / mkdir for the cwd picker |

Two behaviours a second platform inherits for free: the save is **non-destructive**
(it walks the stored chat list and overlays the client's edits, so a chat
discovered while the page was open is not deleted by a stale client), and it is
**autosaved** (debounced, serialized, coalesced — and a deferred save carries its
own platform so it cannot land on the tab the user switched to).

## Verify on the platform before writing the adapter

Every one of these produced a bug in Telegram. Answer them first — the Slack
and Lark columns are filled in because answering them up front is what made
those adapters mostly mechanical.

| # | Question | Telegram | Slack | Lark |
| - | -------- | -------- | ----- | ---- |
| 1 | **Interactive payload size?** | `callback_data` 64 **bytes** (~21 CJK chars) | `action_id` 255 chars, `value` 2000 | `value` is a JSON object; exact cap undocumented — Pier sends `{key, root}` (~40 bytes) and never a label |
| 2 | **Does it echo the component back** on the message a click came from? | yes, `reply_markup` | yes, `message.blocks` | **no, and it cannot be fetched either** — `message.get` on a 2.0 card answers a "please upgrade your client" post, so the button's `value` is the only echo; the label travels inside it |
| 3 | **Can a bot add _and remove_ its own reactions?** | yes, one per message | yes, but by **short name** (`eyes`), never the codepoint | add yes; remove is **list-then-delete by reaction_id**; keys are names (👀 = `OnIt`) |
| 4 | **Thread primitive, and what right to create one?** | forum topics; needs admin + `Manage Topics` | `thread_ts`; no right at all, no setup | `reply_in_thread` on the reply call; no right, no setup, works in DMs |
| 5 | **Length cap and rate limit** | 4096 chars, ~1 msg/s per chat (`429` + `retry_after`) | 3000 per section block, ~1 msg/s per channel (`429` + `Retry-After`) | card request 30KB in **bytes** (chunk budget 7000 chars); QPS limits not yet hit in anger |
| 6 | **What is "addressed", and is the mention stripped?** | mention entity / reply-to-bot; not stripped | `<@BOTID>` anywhere in text; not stripped | `mentions[]` + `@_user_N` placeholder left in the text; not stripped |
| 7 | **Small or muted text?** | none — footers must be italics | yes, the `context` block | notation-size markdown + `<font color='grey'>` (schema 2.0 removed `note`) |

Two more that Slack added to the list:

8. **Can the user even send a `/command`?** Slack's client resolves a leading
   `/` itself and never delivers an unregistered one, so slash commands are not
   a free feature the way they are on Telegram. (Lark delivers them verbatim.)
9. **Is delivery exactly-once, and is one user action one event?** Slack
   redelivers anything it did not see acked *and* sends `app_mention` alongside
   `message.channels` for the same mention — with a different `event_id`, so
   dedup cannot save you. Ignore one of the two at the source. (Lark is
   at-least-once too: dedup on `event_id`, and the SDK acks only when the handler returns.)

## Telegram facts

- Long polling, not webhooks. Node's `fetch` ignores `HTTP_PROXY` unless
  `NODE_USE_ENV_PROXY=1`, and never supports SOCKS.
- Privacy mode (`/setprivacy` → `Disable`) is the usual reason a bot looks dead
  in a group.
- Topic mode needs admin + `Manage Topics`; every reason it declines is logged
  by name. General is topic `1`; messages there usually omit
  `message_thread_id`.
- `429` carries `parameters.retry_after`; a chunked turn hits the per-chat limit.
- Topic deep links: `https://t.me/<username>/<topicId>` (public),
  `https://t.me/c/<chat id without -100>/<topicId>` (private); members only.
- No small text: footers are italics. One unescaped `<` in a formatted send is
  a 400 for the whole message.
- `callback_data` is 64 bytes — send an index, read the label back off the
  message's own keyboard. A payload cap bites non-Latin first.

## Slack facts

- **Threads are the whole design.** Pier never posts into a channel's main
  flow: a conversation is `<channel>/<threadTs>` and a thread *is* a session.
  DMs follow the same rule (`threadOf` = `thread_ts ?? ts`): every top-level DM
  opens its own session. `topicMode` has no meaning; the Console shows
  "Thread mode: always on". Lark follows this rule too.
- **Two credentials.** `xapp-` (`connections:write`) opens Socket Mode;
  `xoxb-` signs Web API calls. `ChannelConfig.appToken` under the same
  "masked means unchanged" rule as `token`.
- **Setup is a manifest** (`SLACK_MANIFEST`, one button to
  `api.slack.com/apps?new_app=1&manifest_json=…`). Two steps no manifest can
  do: mint the app-level token by hand, and invite the bot to a channel.
  Least-privilege: no `app_mentions:read` (duplicate event), `reactions:read`,
  `commands`, `im:read`; `mpim:read` is needed because a click carries no
  `channel_type`; `files:write` for `channels/attach.ts`.
- **Socket Mode without the SDK**: `apps.connections.open` + Node's
  `WebSocket`, behind `SocketLike`. Slack recycles connections every few hours
  (`disconnect: refresh_requested`). "Too many connections" is an accepted
  socket closed immediately — time the connection, anything younger than ~5s
  is a failed attempt. Re-check the stop flag after every await. **Ack before
  handling**: a turn outlives the ack deadline by minutes, and Slack
  redelivers anything unacked.
- **Read methods take form encoding**, not JSON (`SlackApi.read`).
- **Commands have no slash** — the client intercepts unregistered `/`. `stop`,
  `settings`, `bind <code>` are bare words matched as the *whole* message with
  an exact arity.
- **`app_mention` duplicates `message.channels`** with its own `event_id`;
  ignored at the source.
- **A forwarded message hides in `attachments`** (`is_share`, `author_id`,
  `channel_id`, `ts`, `reply_count`, its own `files`), with or without
  `subtype: "message_share"`; never detect by `is_msg_unfurl`, which a pasted
  permalink also sets. A shared thread parent is read eagerly when
  `reply_count <= 30` (token budget) through `readThread`; otherwise the
  coordinates are given, naming the slack tool only when `agentTool` is on.
- **Reactions are short names** (`eyes`); `already_reacted` / `no_reaction`
  are successes.
- **`ts` is an opaque string**, never a number: 16 significant digits do not
  survive a double, and an id you cannot reproduce is a 👀 nobody can clear.
- **"Addressed" is durable state**: a reply in a thread Pier owns asks
  `ChannelControl.knows()`, not adapter memory — `reload()` rebuilds the
  adapter on every Console save.
- **The body is a `markdown` block** (12,000 chars, standard markdown, no
  "Show more"), one message per turn. A workspace that refuses it
  (`invalid_blocks` / `unsupported_block_type`, not `invalid_arguments`)
  latches to the mrkdwn path for the process: one `section` per paragraph,
  3000 chars each, fence balancing, a block cap that folds rather than
  slices. mrkdwn spells bold with `*`: substitute last.
- `unfurl_links`/`unfurl_media` default to `false` in `slack-api.ts`. The
  footer is a `context` block. The cwd prompt is a `views.open` modal with the
  conversation id in `private_metadata`.
- `parseConversation("C100")` yields an empty thread; posting with
  `thread_ts: ""` lands in the main flow. Refused loudly, receipts settled.
- Layout has no local oracle: golden tests check blocks, not how Slack draws
  them. A new adapter gets one real look at a long reply, a split code block
  and a link-heavy reply before it is believed.

## Lark facts

- **The SDK carries the transport** (`@larksuiteoapi/node-sdk`, official):
  the long connection is protobuf-framed with server-pushed reconnect config.
  Confined to `lark-api.ts` behind `LarkClient`; domain pinned to Feishu.
- **The SDK acks when the handler resolves**, and Lark redelivers what it
  never saw answered — handlers hand off and return immediately; work runs on
  the per-chat chains. Dedup on `event_id`.
- **Everything outbound is a card, schema 2.0**: buttons, `message.patch` and
  the muted footer exist only there, and only 2.0 delivers `card.action.trigger`
  over the WebSocket. The chat list previews a card as「卡片」; interactions
  expire after 30 days. No `note` component: the footer is a notation-sized
  markdown element with `<font color='grey'>`. Two markdown elements render
  with a gap, so the footer folds into the last body chunk (`withFooter`).
- **The markdown element takes the agent's markdown unmodified**; unknown
  syntax degrades to literal text. Card request cap is 30 KB in bytes (chunk
  budget 7000 chars).
- **`content` is a double-encoded JSON string**; parse at the boundary, drop
  malformed with a log line. `post` is a runs structure.
- **A card callback carries no thread id**, only message and chat — every
  button value carries the thread root (`LarkActionValue.root`), the cwd form
  carries it in the submit button's `name`.
- **A sent 2.0 card cannot be read back** (`message.get` answers a "please
  upgrade" post), so the next-step label rides in the button value
  (`LarkActionValue.label`) and retiring a taken row is best-effort from a
  bounded in-process copy of the sent card. The one sanctioned exception to
  "never key interaction state on adapter memory": the failure is a leftover
  row, not a dead button.
- **Reactions are named keys** (👀 = `OnIt`); removal is list-then-delete by
  `reaction_id`, filtered to `operator_type === "app"`.
- **The cwd prompt is a form card** (a WebSocket app cannot open a modal);
  the submission arrives as `action.form_value`.
- **Threads follow Slack's rule**, DMs included: `reply_in_thread` roots a
  topic per top-level message; `root_id` continues it.
- **Permissions and the `im.message.receive_v1` subscription take effect only
  after a version is published and approved** — the usual reason a configured
  bot stays silent.
- Credentials are App ID (`token`) + App Secret (`appToken`). No agent-facing
  tool, by the operator's decision.

## Rules every adapter paid for

- Never key interaction state on adapter-instance memory: `reload()` rebuilds
  the adapter. Recover from the platform or SQLite.
- A bot cannot post as the user: echo a tap as `▸ <label>` and put the 👀 on
  the echo.
- An empty turn still posts one muted line naming which nothing it was
  (`stayed silent — <reason>` / `no reply`) plus the footer.
- A per-conversation promise chain needs a `catch` on every link; bound every
  wait a request holds open (`stop()` and `reload()` drain handlers).
- Maps keyed by sender id are fed by strangers: prune, never grow.
- Test the degenerate shapes: a turn that is only an options block, a code
  block longer than one chunk, a test double whose long-poll resolves
  instantly (the fake should park until fed).
- `ChannelStore.get()` hands out a clone; mutate, then save.
