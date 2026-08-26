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

### What was extracted, and what deliberately was not

The rule is "the third repeat earns an abstraction", so two adapters mostly do
not justify one. The entries below were pulled out anyway, because in each the second
copy being *subtly different* is a bug rather than a style difference:

| Extracted | Why it could not wait for a third |
| --- | --- |
| `originLabel` → `core/reply.ts` | Byte-identical, and it is *wording*: every surface must spell a system input the same way, which is what that file already owns. |
| `Gatekeeper.admit` | A drop that does not name its verdict is indistinguishable from a bug — the contract is "log every drop", and it has to hold per platform. |
| `Gatekeeper.mayHint` | The throttle map is fed by strangers. Pruning is the invariant; a copy that only sets and never deletes is a slow leak nobody notices. |
| `Chains.run` | Every link needs its own `catch`, or one rejection silences that chat for the life of the process. Fails closed, permanently, and silently. |
| `Chains.drain` | Bounded on purpose: `reload()` runs on the Console's save, so a stuck handler must not hold that request open. |
| `chunkText` | Twelve lines of index arithmetic; having it twice is having it wrong once. |
| `balanceFences` (chunk.ts) | Written for Slack, needed verbatim by Lark — an unterminated ``` swallows the rest of a message on both. Telegram alone shrugs off a cut fence, so the repair is an opt-in call, not part of `chunkText`. |
| `Dedup` | The bounded, TTL'd seen-set both push transports need. The invariant (prune, never grow-only — the map is fed by every chat the bot is in) is exactly the kind that quietly vanishes from a second copy; Lark's arrival made it two identical copies, and one had to win. |
| `lines.ts` | Bind hint/result, "⏹ Stopped.", the `▸` echo — wording that behaves identically by contract, three copies after Lark, agreeing by coincidence. The bind command's spelling is the one legitimate variation, so it is the parameter. |
| `saveInboundAll` (core/inbox.ts) | The attachment loop's invariants — size gate before the fetch, a lost-marker line instead of silence (5b) — existed as three near-copies. Adapters now only describe their files and how to fetch one. |
| `chatOf` (types.ts) | Every adapter spells a conversation `<chatId>[/<thread>]`, and control.ts was importing all three adapters just to take the first segment. The thread half stays per-adapter — its type and meaning genuinely differ. |
| `Receipts.settleAfter` | "Deliver, then settle *whatever happens*" was a try/finally copied into every send(); a copy that loses the finally strands a 👀 for half an hour. |
| `readCapped` (core/inbox.ts) | The mid-stream size refusal Lark needed first: metadata is the platform's word, so Telegram and Slack's `arrayBuffer()` was unbounded whenever the size field was absent or lying. All three downloads now read through one bounded collector. |
| cwd prompt wording (panel.ts) | The one sentence and placeholder were three near-copies despite panel.ts owning panel wording; each platform keeps only its widget's lead-in. |

Still two copies, deliberately (the third occurrence earns each): the
per-process user-name memo (Slack's directory also resolves channel kinds, so
the shapes differ), the `discovered` chat set, and the outbound
`[quiet, meta].join(" · ")` note composition (Telegram composes inline HTML
instead). The markdown→HTML and markdown→mrkdwn renderers are the one
reportable >30-line pair: kept apart on purpose, because each emits materially
different output and Lark needs no translation at all — a shared tokenizer
would be bigger than either renderer.

**The two panels were duplicated on purpose, until they were not.** The
standing decision was to wait for Lark rather than invent a rendering
abstraction from two data points. What overturned it was not a third platform
but evidence: the copies had begun to drift (the chat line's gates, the note
placement, the bolding of a sub-view title), the pair had **no tests at all**,
and the settings vocabulary is in fact repeated a third time in
`web/ui/channels.ts` — the third repeat had already happened, on a surface
nobody was counting.

`panel.ts` now owns the state machine: what the panel says, the `cfg:` dispatch,
model paging by index, the reasoning list, and "start a session in this
directory" with its two failures. A platform supplies markup (an escape and a
code fence), how its one message is sent, edited and deleted, and how it asks
for one typed answer. `PanelView` is deliberately not a rendering abstraction:
it is titled groups of lines plus buttons, and `picks` is a list the platform
*lays out itself* — Slack fits a page of models on one row, Telegram gives each
a row. 502 lines became 462 with 14 tests behind them; the saving is small
because a seam costs lines too, and that is the honest number. The reason to
keep it is that panel behaviour now has one home instead of two that agree by
coincidence.

**Budget note.** The tripwire is `channel adapter ≤ 400` for the adapter file
itself. Telegram and Slack sit just under it — Slack only because the
outbound path lives in its own file (it learned that at 449; Lark was born
with the split). Lark sits at ~414: the overage arrived with the second
review's failure paths (the card read-back notice, named fallback logs, the
mid-stream size refusal), which budget rule 4 exempts — an adapter is not
over because it reports its failures. That split was worth making: "which renderer, chunked to which limit, and
what an empty turn still says" is a different decision from routing inbound
traffic, and it is the half with the test coverage. What remains in each
adapter is irreducibly per-platform: inbound normalization and gate logging
that the platform's own event shape forces. Slack's extra lines over Telegram
are its three envelope types, `event_id` dedup, and the `conversations.info` /
`users.info` lookups Telegram gets inline on the event.

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
  rather than five operations.
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
  rather than a probe.
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
  bubble says plainly that it covers task and subagent sessions too.
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
| `GET|POST /api/fs/dirs` | directory browsing / mkdir for the cwd picker |

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
   at-least-once too: dedup on `event_id`, and see the ack trap below.)

## Traps already paid for

Ordered by how much time each cost. The Slack ones are marked `[slack]`; the
rest were paid for on Telegram and every one of them still applied.

- `[slack]` **A platform id is not a number just because it looks like one.**
  A Slack `ts` in an `INTEGER` column round-trips through a double, and an id you
  cannot reproduce exactly is a 👀 nobody can ever clear. Opaque strings in
  shared code; convert at the adapter's API boundary.
- `[slack]` **A closed command set is not enough without an arity.** Matching
  the first bare word against `{stop, settings, bind}` still turned "settings
  are broken, please help" into a panel and would have turned "stop the deploy
  and tell me why" into an abort. A bare command must be the *whole* message.
  Caught by a test, not by review.
- `[slack]` **One user action can be two events**, with different `event_id`s,
  so dedup cannot save you. Ignore one at the source and log that you did.
- `[slack]` **Ack is not handling.** At-least-once delivery plus a turn that
  outlives the deadline means acking after the work runs every slow turn twice.
- `[slack]` **A push transport needs the same anti-spin floor as a poll loop,
  and it is easier to miss.** Telegram's floor is obvious because the hot loop
  is right there in `poll()`. Socket Mode's is not: Slack answers "too many
  connections" by *accepting* the socket and closing it immediately, so the
  await resolves **normally** and skips the `catch` that held the backoff —
  reopening at one `apps.connections.open` per event-loop tick. The fix is to
  time the connection, not to trust how it ended: anything that died younger
  than ~5s was a failed attempt, however it ended. Measured at 6 calls in 5ms
  before the fix, 2 after.
- `[slack]` **A reconnect loop must re-check the stop flag after every await.**
  `stop()` landing while `apps.connections.open` is in flight otherwise opens a
  socket nobody holds a reference to — and `reload()` on the Console's save is
  exactly that race, once per config change.
- `[slack]` **mrkdwn spells bold with markdown's italic star**, so emitting `*`
  early lets the italic pass eat it again. Sentinel, substitute last.
- `[slack]` **A comment that says "this is fine" was fine on the other
  platform.** `telegram-render.ts` documents that a cut mid-`<pre>` is harmless
  because Telegram closes the tag itself. Slack does not, so the same code
  silently mangled every split code block. Copying logic means re-testing its
  *conclusions*, not just its lines. Chunking needs a golden test with a block
  longer than one chunk.
- `[slack]` **Layout has no local oracle.** Every golden test passed while the
  client hid most of every long reply behind "Show more" — the assertions check
  the blocks Pier builds, not how Slack draws them. Only a screenshot caught it.
  A new adapter needs one real end-to-end look at a long reply, a split code
  block and a link-heavy reply before it is believed.
- `[slack]` **Ask what the platform renders natively before building a
  renderer.** Two rounds went into making `section` behave — paragraph
  splitting, fence balancing, a size budget — for a problem the `markdown` block
  does not have; the mrkdwn layer is now fallback-only. avibe had answered it in
  one line of comment (`slack.py:631`), which is an argument for reading a
  reference implementation's *render* path early, not just its transport.
- **An empty turn must still say something.** The first fix here was to post
  *nothing* when a turn had no text — which produced exactly the failure mode
  the receipts were meant to prevent: the eyes come off, no message arrives, and
  nobody can tell a deliberate silence from a crash. The rule is the opposite:
  an empty turn posts one muted line naming which kind of nothing it was
  (`stayed silent — <reason>` or `no reply`) plus the footer. `AgentReply.silence`
  carries the reason so the adapter can tell the two apart; a turn that is only
  its options is *not* nothing, because the buttons are the reply.
- `[slack]` **A block cap must fold, not slice.** The first fix for the above
  ended `sections()` with `groups.slice(0, MAX_BLOCKS)`, which silently drops
  the end of a long answer — a worse failure than the one being fixed, and
  invisible without a test that counts paragraphs in *and* out.
- `[slack]` **A conversation id you did not mint is a message in the wrong
  place.** `parseConversation("C100")` yields an empty thread, and posting with
  `thread_ts: ""` puts an agent turn in the channel's main flow — exactly what
  the adapter promises never to do. Refuse it loudly and still settle the
  receipts, so a malformed id costs a log line instead of a stranded 👀.
- **A payload cap bites non-Latin first.** Using a next-step label as the
  callback payload passed every English test and dropped *every* button on a
  Chinese reply — and because the parser had already stripped the block from the
  text, the options vanished entirely. Send an index; read the label back off
  the message's own keyboard.
- **Never key interaction state on adapter-instance memory.** Console autosave
  calls `runtime.reload()`, which builds a new adapter — so an in-memory map of
  "what this button means" is empty seconds after the buttons were drawn. If a
  user can click it later, recover it from the platform or from SQLite.
- **A bot cannot post as the user.** A tap therefore has to be echoed and
  labelled (`▸ <label>`), and the 👀 goes on that echo, not on the bot's own
  message. Otherwise the transcript shows answers to invisible questions, and
  there is nothing of the user's to mark as being worked on.
- **Test the degenerate shapes of a turn.** A turn that is *only* an options
  block broke twice over: the parser anchored the block on a preceding newline,
  and the outbound path skipped a reply whose text was empty.
- **Escape every string that reaches a formatted send.** One unescaped `<` in a
  user-derived topic title makes Telegram reject the whole message with 400 —
  the message disappears rather than degrading.
- **A silently skipped branch is indistinguishable from a bug.** Topic mode has
  six reasons to decline; naming each one in a log turned "is this broken?" into
  a one-line answer. Do the same for every gate.
- **A reply quote costs a screenful.** Quote only something short; a marker in
  the text is usually enough.
- **A per-conversation promise chain needs a `catch` on every link.** One
  rejected handler otherwise poisons the chain and silences that chat for the
  life of the process — an ordering mechanism that fails closed, permanently.
- **Bound every wait that a request is holding open.** `stop()` drains in-flight
  handlers, and `reload()` runs on the Console's save; without a timeout a stuck
  handler hangs the save.
- **Maps keyed by sender id are fed by strangers.** Anyone can DM a bot, so the
  bind-hint throttle prunes expired entries instead of keeping one per sender.
- A test double whose long-poll resolves instantly turns the receive loop into a
  hot loop. The adapter has an anti-spin floor; the fake should park until fed.
- `overflow-hidden` on a card clips any help popover inside it. The document
  itself must never scroll (`body` is `h-dvh overflow-hidden`); every scrollable
  region is an inner pane with sticky headers inside it.
- `ChannelStore.get()` hands out a clone. Mutating a config without saving it
  used to silently desync memory from disk.

## Telegram specifics worth knowing

- Long polling, not webhooks: a local process should not need public inbound
  HTTP. Node's `fetch` ignores `HTTP_PROXY` unless `NODE_USE_ENV_PROXY=1`, and
  never supports SOCKS.
- Privacy mode (`/setprivacy` → `Disable`) is the usual reason a bot looks dead
  in a group: otherwise it only receives mentions, replies and commands.
- Topic mode needs the bot to be an admin with `Manage Topics`; without it every
  creation fails and the answer lands in General. Every reason topic mode
  declines is logged by name — six silent conditions are indistinguishable from
  a bug.
- General is topic `1`, and inbound messages there usually omit
  `message_thread_id` entirely.
- `429` responses carry `parameters.retry_after`; a long turn split into chunks
  will hit the per-chat rate limit.
- Topic deep links: `https://t.me/<username>/<topicId>` for a public supergroup,
  `https://t.me/c/<chat id without its -100 prefix>/<topicId>` for a private
  one. Both resolve for members only, which is the audience that needs them.

## Slack specifics worth knowing

The facts you build against. Where a fact also cost a mistake, the mistake is in
**Traps** and not repeated here.

- **Threads are the whole design.** Pier never posts into a channel's main flow:
  a channel message is answered in *its own* thread (`thread_ts` = that
  message's `ts`), a thread message in its thread. A conversation is always
  `<channel>/<threadTs>` and a thread *is* a session. Threads need no admin
  right and no group conversion, so what Telegram must negotiate for is simply
  how this adapter always works — which is why `topicMode` has no meaning here
  and the Console shows "Thread mode: always on".
- **A DM follows the same rule, deliberately.** `threadOf` is `thread_ts ?? ts`
  with no DM case, so every top-level DM opens its own thread and its own
  session; only a reply *inside* one continues it. Telegram does the opposite (a
  DM is one session forever), so this reads as a bug from that side. It was
  checked and kept: on Slack a DM is where you *start* pieces of work, and the
  thread is the unit of work everywhere. Give Lark the same rule.
- **Two credentials.** An app-level token (`xapp-`, `connections:write`) opens
  the Socket Mode socket; the bot token (`xoxb-`) signs every Web API call.
  Hence `ChannelConfig.appToken`, masked by the same "masked means unchanged"
  rule as `token`.
- **Setup is a manifest, not a checklist.** Thirteen scopes and four event
  subscriptions across four config pages is where a setup goes wrong, and it
  fails late as one `missing_scope` at runtime. The Console offers one button to
  `api.slack.com/apps?new_app=1&manifest_json=…` with `SLACK_MANIFEST`
  prefilled, plus a copy fallback. Two steps remain that no manifest can do: an
  app-level token must be **minted by hand** (`Basic Information → App-Level
  Tokens` — missed precisely because Socket Mode is already on), and the bot must
  be invited to a channel. Borrowed from avibe.
- **The manifest is least-privilege and every scope is load-bearing.** Absent on
  purpose: `app_mentions:read` (duplicate event), `reactions:read` (receipts only
  write), `commands` (no slash commands), `im:read` (a `D`-prefixed id is a DM
  by construction). `mpim:read` *is* needed: a button click carries no
  `channel_type` and an mpim id is not `D`-prefixed. `files:write` is in, for
  the one upload path: a file the agent produced (`channels/attach.ts`).
  14 scopes / 4 events against avibe's 18 / 7.
- **Socket Mode, no SDK.** `apps.connections.open` plus Node's built-in
  `WebSocket` is the entire transport; `@slack/socket-mode` would add a
  dependency tree to wrap ~60 lines. Reconnection lives in `slack-api.ts`
  because Slack recycles a connection every few hours with
  `disconnect: refresh_requested` — protocol, not adapter policy. The loop sits
  behind a one-interface seam (`SocketLike`) so it can be tested without a real
  socket. **Envelopes are acked by the transport before handling**, because a
  turn outlives the ack deadline by minutes.
- **JSON bodies are for write methods only.** A read method (`users.info`,
  `conversations.info|history|replies`) ignores a JSON body and then answers for
  the missing parameter, so reads go form-encoded (`SlackApi.read`).
- **Commands have no slash.** Slack's client intercepts a leading `/` and
  refuses an unregistered command before an app sees it, so `stop`, `settings`
  and `bind <code>` are bare words matched against a closed set *with an exact
  argument count*. Registered slash commands are deliberately not a feature:
  manifest setup for a second, weaker path (Slack only sends `thread_ts` for a
  command typed inside a thread).
- **`app_mention` is a duplicate** of `message.channels` with its own
  `event_id`, so the adapter ignores the type and the walkthrough says not to
  subscribe.
- **Reactions are short names.** `reactions.add` rejects 👀 with `invalid_name`;
  it wants `eyes`. `already_reacted` / `no_reaction` are successes.
- **A `ts` is not a float-safe number** (`1761234567.123456`, 16 significant
  digits), so it is an opaque string everywhere — hence
  `receipts.message_id TEXT`. The retired archive stored it in a
  REAL column for range ordering and handed back `…000100` as `…0001`; an id
  that cannot be reproduced is a reply that lands nowhere.
- **"Addressed" needs durable state.** A reply in a thread Pier owns is Slack's
  equivalent of Telegram's reply-to-bot, and it is what lets a conversation flow
  without an `@` on every line. Adapter memory cannot answer it across the
  Console's reload, so it asks `ChannelControl.knows()`.
- **The body is a `markdown` block, not `section`/mrkdwn.** The single most
  useful thing to copy. It takes standard markdown unmodified — tables,
  headers, nested lists, none of which mrkdwn can express — and the client does
  not collapse it behind "Show more", which a tall `section` always is. 12,000
  chars per message against 3000 per section, so a normal turn is one message,
  one block, no chunking.
  - A workspace that refuses it (`invalid_blocks` / `unsupported_block_type`)
    degrades to the translated mrkdwn path, which **latches off** so the failed
    round trip is paid once per process. `invalid_arguments` deliberately does
    *not* trigger it.
  - `toMrkdwn()`, `sections()` and fence balancing exist only on that path —
    which is why the mrkdwn renderer still earns its tests. There, one section
    block per paragraph is required, and paragraphs must not be packed back
    together to fill a budget.
- **Link previews are off on every send.** `unfurl_links`/`unfurl_media` default
  to `false` in `slack-api.ts` rather than per call site, so nothing can forget.
  avibe carries the same switch.
- **The footer gets a real block.** `context` is genuinely small muted text, so
  `formatTurnMeta` needs none of Telegram's italic hack.
- **The cwd prompt is a modal.** No `force_reply` on Slack, so `views.open` asks
  for the path and `private_metadata` carries the conversation id — so the
  submission needs no adapter-side state, strictly better than the Map
  Telegram's force-reply path keeps.

## Lark specifics worth knowing

The facts the adapter is built against. avibe's `modules/im/feishu.py` was the
reference implementation and had verified the expensive ones (card schema 2.0,
the grey footer, the form card) against the live API before Pier started.

- **The SDK carries the transport.** Lark's long connection is a
  protobuf-framed proprietary protocol with server-pushed ping/reconnect
  config — not Slack's ~60 lines of JSON socket — so `@larksuiteoapi/node-sdk`
  (official, MIT) is the one adapter with a platform SDK dependency. It is
  confined to `lark-api.ts` behind `LarkClient`, and it also owns
  tenant-token refresh. Domain is pinned to Feishu (open.feishu.cn).
- **The transport acks only after the handler returns.** The SDK sends the WS
  response frame when the registered handler resolves, and Lark redelivers
  what it never saw answered — so `lark-api.ts` handlers hand the event to the
  adapter and resolve immediately; the work runs on the per-chat chains. "Ack
  is not handling", third platform in a row.
- **Everything outbound is a card, schema 2.0.** Buttons, edit-in-place
  (`message.patch`) and the muted footer only exist on cards, and only schema
  2.0 delivers button callbacks over the WebSocket (`card.action.trigger`).
  Costs accepted: the chat list previews a card as「卡片」, and card
  interactions expire after 30 days. 2.0 removed the `note` component — the
  footer is a notation-sized markdown element with `<font color='grey'>`,
  because the 2.0 markdown element rejects `text_color`.
- **The markdown element takes the agent's markdown near-unmodified** — no
  translation layer and no escaping (Lark degrades unknown syntax to literal
  text). Ask what the platform renders natively before building a renderer:
  answered up front this time, and most of a renderer never got written.
- **Message bodies are JSON strings.** `content` is double-encoded; parse at
  the boundary, drop malformed with a log line. Rich text (`post`) is a runs
  structure, walked for text and embedded images.
- **A card callback does not say which thread its message lives in** — only
  message and chat ids. Every button Pier mints carries the thread root in its
  callback value (`LarkActionValue.root`), and the cwd form carries it in the
  submit button's `name` — so any click reconstructs its conversation with no
  adapter-side state at all.
- **A sent 2.0 card cannot be read back.** `message.get` answers a degraded
  post (`请升级至最新版本客户端…`), verified against the live API after clicks
  crashed on it in the field. Two consequences, both copied from avibe: the
  next-step *label* rides in the button value (`LarkActionValue.label`,
  avibe's `quick_reply:<label>`) — the value is this platform's "read it back
  off the message" — and retiring a taken row is *best-effort from a bounded
  in-process copy of the sent card* (avibe's `_message_text_cache`). The
  memory is cosmetic only: a click after a restart still works off the value;
  the buttons merely stay up, and the skip is logged. This is the one sanctioned
  exception to "never key interaction state on adapter memory", because the
  platform offers nowhere else and the failure mode is a leftover row, not a
  dead button.
- **Two markdown elements render with a visible gap** and no spacing knob is
  documented, so the turn footer folds *into* the last body chunk's own
  element as a trailing grey `<font>` line (`withFooter`); the standalone
  notation-sized footer element appears only on bodiless cards (a quiet turn,
  an options row).
- **Reactions are named keys** (👀 = `OnIt`; the emoji has no exact glyph, the
  key means "being handled"). Removal is list-then-delete by `reaction_id`,
  filtering for `operator_type === "app"` — several people may have used the
  same emoji.
- **The cwd prompt is a form card**, not a modal — a WebSocket app cannot open
  one. The panel message is patched into an input + submit; the submission
  arrives as `action.form_value` keyed by the input's `name`.
- **Threads follow Slack's rule exactly**, DMs included: every top-level
  message roots its own topic (`reply_in_thread`) and its own session; a
  message inside a topic continues it (`root_id`). Feishu DMs thread — avibe
  researched and shipped the same rule.
- **Setup is a checklist that fails late.** Permissions (`im:message`,
  `im:message:send_as_bot`, `im:resource`, `im:message.reactions:*`,
  `im:chat:readonly`, `contact:user.base:readonly`) and the
  `im.message.receive_v1` subscription only take effect after a **version is
  published and approved** — the usual reason a configured bot stays silent,
  and the walkthrough's loudest line.
- **Credentials are an App ID + App Secret pair**: `token` carries the id,
  `appToken` the secret. The "second credential" question this section used
  to ask is answered — the existing field generalized, no per-platform bag
  needed.
- **The agent-facing tool is deliberately absent** — asked and declined by the
  operator, not a gap.
