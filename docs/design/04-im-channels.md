# IM Channels (living spec)

Platform adapters in front of Pi sessions. Telegram is the first one; Slack and
Lark are configurable in the Console but have no adapter yet. This document is
for whoever writes the second adapter: what is already shared, what is genuinely
platform-specific, and which mistakes are already paid for.

`docs/architecture.md` owns the rules. This file owns the *how*.

## What a channel provides

The product surface, so a new platform is a checklist instead of a feature
request per feature. "Shared" means the behaviour is already implemented off
the adapter and comes for free; "adapter" means the platform has to render or
detect something itself.

| Feature | Behaviour | Shared / adapter | TG | Slack | Lark |
| --- | --- | --- | :-: | :-: | :-: |
| Session per conversation | One chat (or thread) is one persisted Pi session, stable across restarts | shared (`conversations.ts`) | ✅ | — | — |
| Thread-per-request | A message in the parent chat opens a native thread and its own session; replies and commands stay put | shared policy, adapter creates the thread | ✅ | — | — |
| Steer by default | Inbound joins the running turn rather than queueing behind it | shared (`mode: "steer"`) | ✅ | — | — |
| Progress receipts | Every message that entered a turn wears 👀 until it settles; no intermediate reasoning is ever posted | shared ledger, adapter calls the reaction API | ✅ | — | — |
| Turn footer | `45s · 32K tok` under each reply | shared (`formatTurnMeta`) | ✅ | — | — |
| Next-step buttons | The agent's `[label]` row becomes buttons; a click sends the label as an ordinary message | shared parse, adapter renders + feeds back | ✅ | — | — |
| Image attachments | Inbound images reach the agent | adapter (download after the gate) | ✅ | — | — |
| System notes | Task delegation / callback / supervisor input is posted to the same thread before the turn it triggers | shared (`Channel.notify`) | ✅ | — | — |
| `/stop` | Abort the conversation's running turn | shared (`runtime` → `abortConversation`) | ✅ | — | — |
| `/bind <code>` | Redeem a Console-issued single-use code in a DM | shared | ✅ | — | — |
| Permissions | Chat enable · require mention (groups) · bind (always in DMs) | shared (`gate()`) | ✅ | — | — |
| Per-chat launch config | cwd, model, reasoning level for the sessions a chat opens | shared (`launchFor`) | ✅ | — | — |
| Console tab | One page per platform: token, defaults, bound users, discovered chats; autosaved, token masked | shared (`routes.ts`, `web/ui/channels.ts`) | ✅ | ⬜ | ⬜ |
| Setup walkthrough | Hover help for getting a token and enabling threads | adapter copy, shared badge | ✅ | — | — |
| `@bot` / `/settings` panel | In-chat panel: read out session + policy, change model / reasoning / cwd (a new session), stop | shared control, adapter renders | ✅ | — | — |

✅ done · ⬜ configurable, no adapter · — not started

### Deliberately not features

Rejected on purpose; re-adding any of them is a design decision, not a gap.

- **Backend / agent selection in chat** — Pier has one backend (Pi).
- **Message-visibility toggles** — intermediate reasoning is never sent to IM by
  design, so there is nothing to toggle.
- **Per-thread setting overrides** — settings stop at the chat level; a topic
  inherits its group and nothing else.
- **Admin / bind management from chat** — that is the Console's job.
- **Webhook inbound** — a local process should not require public inbound HTTP.
- **Editing a live session's cwd** — Pi fixes cwd at creation, so "change the
  working directory" is "start a new session there", and says so.

## Layout

```
src/channels/
  types.ts            config contract; type-only imported by web/ui — no node builtins
  config.ts           ChannelStore (one JSON doc per platform) + gate() — SHARED
  commands.ts         parseCommand() — SHARED
  conversations.ts    durable conversation → session map — SHARED
  receipts.ts         the reaction-receipt lifecycle, storage included — SHARED
  db.ts               path + WAL + mkdir for the above
  control.ts          ChannelControl: session reads/writes an adapter may make — SHARED
  runtime.ts          adapter lifecycle and control wiring — SHARED
  routes.ts           /api/channels/:platform — SHARED
  telegram.ts         the adapter
  telegram-api.ts     Bot API client (the only file touching api.telegram.org)
  telegram-render.ts  how a reply looks: markdown → HTML, and buttons
  telegram-panel.ts   the in-chat settings panel
```

Everything but the last four is shared. A second adapter should add four files
and touch nothing else except `runtime.ts` (one branch) and the Console's
`supported` flag.

## The seam

`Channel` (`core/types.ts`) is four methods:

- `start(onMessage)` — begin receiving; hand normalized `InboundMessage`s to core.
- `send(conversationId, reply)` — an assistant turn. **Called on every
  `turn-end`, empty text included.** Empty means "the turn settled with nothing
  to say", which is when per-turn UI (reaction receipts) must come off.
- `notify(conversationId, {text, origin})` — a persisted `system-input`: task
  delegation, callback, supervisor message. Sent *before* the turn it triggers,
  so an answer nobody asked for has a visible cause. Never rendered as an
  assistant turn, and it must not retire the receipts — that turn is still running.
- `stop()` — must **drain in-flight work**, because `runtime.reload()` starts a
  replacement immediately.

`AgentReply` carries `suggestions` (the agent's next-step labels) and `meta`
(`TurnMeta`). Surfaces without hover render `meta` as a footer, using
`formatTurnMeta()` from `core/reply.ts` — the wording and units live there so
web and every adapter agree (`45s · 32K tok`).

**Control that is not a prompt does not go through the seam.** `ChannelControl`
(`control.ts`) is a narrow, platform-blind wrapper over the router and the
factory — abort, read status, list/set model, set reasoning, start a new session
— injected by `runtime.ts`, which owns both. The seam keeps exactly one inbound
path (`onMessage`); add the next control here, not there.

## The in-chat panel

`@bot` on its own (the text is empty once the mention is stripped) and
`/settings` are the same request. `telegram-panel.ts` is the reference
implementation; the parts a second adapter should copy rather than reinvent:

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
  answer (Telegram `force_reply`), and rejects a relative path without changing
  anything. That typed answer must be consumed before the prompt path — it is
  an answer to us, not a message for the agent.

## Conversation identity

A `conversationId` is opaque to core. Telegram encodes `<chatId>` or
`<chatId>/<topicId>`; a Slack adapter will likely use `<channelId>` or
`<channelId>/<threadTs>`. Two consequences:

- `ConversationStore` (`conversations.ts`) is what makes routing survive a
  restart. Without it every chat silently gets a fresh session while its visible
  history says otherwise. A mapping whose session Pi no longer has is dropped
  and re-created, never retried forever.
- Per-chat launch options (cwd, model, thinking) are resolved by
  `ChannelRuntime.launchFor(key)` — parsing the chat id back out of the
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
   (`telegram-markdown.ts` extracts code, escapes, then re-introduces exactly
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
| `GET /api/channels/:platform` | config with the token **masked**, plus `supported` |
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

Every one of these produced a bug in Telegram. Answer them first:

1. **How big may an interactive payload be, in bytes?** Telegram: 64 — about 21
   CJK characters. Assume Latin test data will hide the problem.
2. **Does the platform echo the interactive component back** on the message a
   tap came from? If yes, resolve labels from there and keep no state at all.
3. **Can a bot add _and remove_ its own reactions**, and react to its own
   messages? The whole receipt lifecycle depends on it.
4. **Is there a thread primitive**, and can the bot create one? What right does
   that need?
5. **Message length cap, and rate limits per chat.** Both bite a long turn split
   into chunks.
6. **What counts as "addressed to the bot"**, and does the platform strip the
   mention for you?
7. **Does it have small or muted text?** Telegram does not, which constrains
   every footer and label.

## Traps already paid for

Ordered by how much time each cost.

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

## What Slack and Lark will change

Expectations, not facts — revisit when the code exists:

- **Transport**: Socket Mode / Events API instead of a poll loop. The receive
  loop is adapter-local; everything downstream of `onMessage` is not.
- **Threads**: `topicMode` generalizes — "one native thread per request" is a
  Slack thread and a Lark topic. `ChatKind`'s `"forum"` member does not
  generalize and should be renamed then (see architecture.md → Open Questions).
- **Rendering**: Slack Block Kit and Lark cards instead of an HTML subset;
  `telegram-markdown.ts` has no shared part worth extracting yet.
- **Buttons**: both have richer payloads than 64 bytes, so the label-as-payload
  shortcut may stay or may become an id map.
- **Reactions**: verify each platform actually allows a bot to add *and remove*
  its own reaction before relying on the receipt lifecycle.
