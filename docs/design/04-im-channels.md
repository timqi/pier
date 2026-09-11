# IM Channels (living spec)

Platform adapters in front of Pi sessions: Telegram, Slack and Lark (Feishu).
`docs/architecture.md` owns the rules; this file owns the *how*.

## What a channel provides

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
| Speaker identity | `[name<id> time place]` above a message, only when it changes | shared (`core/identity.ts`), adapter resolves the name | ✅ | ✅ | ✅ |
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

Command spelling is per-platform: Telegram and Lark take `/stop`, `/settings`,
`/bind <code>`; Slack the same words without the slash.

### Deliberately not features

Re-adding any of these is a design decision, not a gap: backend / agent
selection in chat; message-visibility toggles; per-thread setting overrides;
admin / bind management from chat; webhook inbound; registered Slack slash
commands; posting in a Slack channel's main flow; editing a live session's cwd
(Pi fixes cwd at creation — the panel offers "New session in…" instead).

## Layout

File list: `docs/architecture.md`; each file's header comment names its one
reason. Everything but the per-platform files (`<platform>.ts`, `-api`,
`-render`, `-panel`, and `-outbound` / `-tool` / `-directory` where present) is
shared. A fourth adapter adds four or five files and touches only `runtime.ts`
(one entry in `ADAPTERS`) and the Console copy in `web/ui/channel-help.ts`.

Shared: `Gatekeeper`, `Chains` (a `catch` on every link, bounded drain),
`Dedup`, `chunkText` / `balanceFences`, the inbound attachment loop
(`core/inbox.ts`), `Receipts`, `chatOf`, `lines.ts`, and the panel state
machine in `panel.ts` — a platform supplies markup, one send/edit/delete and
one way to ask for a typed answer; `PanelView` is titled groups of lines plus
buttons. Kept apart: the renderers, the user-name memos, the `discovered` sets.

## The seam

`Channel` (`core/types.ts`; the method list is in `docs/architecture.md`):

- `send` is called on every `turn-end`, empty text included — the moment
  per-turn UI (reaction receipts) comes off.
- `notify(conversationId, {text, origin})` — origins: a persisted
  `system-input` (task delegation, callback, supervisor message) and
  `{kind:"error"}`. Sent *before* the turn it triggers; never rendered as an
  assistant turn; must not retire the receipts.
- `stop()` must **drain in-flight work**: `runtime.reload()` starts a
  replacement immediately.
- `meta` (`TurnMeta`) renders as a footer via `formatTurnMeta()` from
  `core/reply.ts` (`45s · 32K tok`).

`Router` posts every error into the conversation as a `{kind:"error"}` note —
session errors, a rejected prompt, a failed delivery. Shared and automatic; an
adapter must not reimplement it. Notes are trimmed to 600 characters; a notify
that itself fails is reported to the hub once, never retried.

**Control that is not a prompt does not go through the seam.** `ChannelControl`
(`control.ts`): abort, read status, list/set model, set reasoning, start a new
session, `knows()` — injected by `runtime.ts`, which owns router and factory.
The seam keeps one inbound path (`onMessage`); add the next control here.

## The in-chat panel

`@bot` on its own (empty text once the mention is stripped) and `settings` are
the same request.

- One message, edited in place.
- Panel buttons are `cfg:<action>[:<arg>]`, consumed by the panel; any other
  payload is a next-step label and *is* the message to send.
- Model lists are paged and referenced by **index** (payloads are size-capped);
  the page's list is cached per panel.
- A panel from a previous process has no state: reopen on the first tap.
- The cwd button reads "New session in…", asks for one typed answer, rejects a
  relative path. Telegram: `force_reply`, consumed *before* the prompt path.
  Slack: a modal with the conversation id in `private_metadata`. Prefer a modal
  wherever the platform has one.

## Agent access: the platform as a tool

`slack-tool.ts` + `ChannelConfig.agentTool` + `skills/pier-slack/`: an agent
session asking Pier to read or write Slack.

- The agent states an intent (`#name`, ISO time); Pier does the API work
  (paging, cursors, ordering, dedup, caps). The bot token never reaches the
  model.
- Omitting `channel` acts on the calling session's conversation, resolved
  **per call** through `Router.conversationOf(sessionId)`, never captured at
  creation. `context` reports it. `thread_ts: "none"` starts a top-level
  message; a `thread_ts` is never inherited across a `channel` change.
- A transcript is lines: `<ts> | <time, UTC> | <name>[<id>] | <text>`
  (`format` field). `threadTs` is hoisted; parents carry `[thread: N replies]`;
  an upload is `[file: <name> <F… id> <size>]`.
- `fetch_file` takes the `F…` id, resolves via `files.info` (the bot's own
  visibility is the gate; no channel needed), saves into
  `$PIER_HOME/inbox/slack/`, answers with the marker line alone; refused or over
  the cap → `[attachment lost: … ]`.
- `after` filters strictly newer. A failed page returns what came before it
  with `incomplete` and a reason; Slack error codes become the action they
  imply (`not_in_channel` → invite the bot).
- Every read goes to Slack; nothing is cached; writes are never cached or
  rate-limited by us. Reads are Tier 3 (~50+ req/min) as a workspace-internal
  app; **if Pier is ever distributed as a non-Marketplace app** (1 req/min, 15
  objects per response) a cache has to come back, with invalidation.
- `agentTool` defaults on (missing reads as on) and is separate from `enabled`
  (inbound). No second ACL: Slack enforces channel membership; the switch covers
  task and subagent sessions.
- A `ts` stays TEXT everywhere (16 significant digits; REAL loses them).
- Markdown is not Slack syntax: a mention is `<@U04B7Q2>`, a channel
  `<#C0123456>`, a broadcast `<!here>`.

### Who is speaking

`InboundMessage.sender` carries `{id, name}`: the adapter resolves the display
name; `core/identity.ts`'s `SenderPrefix` emits `[name<id> time place]` only on
a different speaker, a 10-minute gap, a new day, or a different conversation.
`place` is `<channelId>:<conversationId>` verbatim (`slack:C079TC7GUBG/1712.345600`,
`telegram:-100/7`), so a session can hand its own channel and thread to a
script (`skills/pier-slack`); a session never changes conversation, so it is
said once, on the first message, and again only after `forgetSender`. Alias
keys (`web:`, `task:`) name no place. `sanitizeIdentity` strips `[`, `]`,
`<`, `>` and newlines so a display name cannot forge a second speaker.
Identity is **per-turn, never baked into a session**: a thread is shared.
`splitSpeaker` reads every shape back for the web bubble and the listing index.

## Conversation identity

A `conversationId` is opaque to core. Telegram encodes `<chatId>` or
`<chatId>/<topicId>`; Slack and Lark are always `<channelId>/<threadTs>`.

`ConversationStore` (`conversations.ts`) makes routing survive a restart; a
mapping whose session Pi no longer has is dropped and re-created. Per-chat
launch options (cwd, model, thinking) come from `ChannelControl.launchFor(key)`
— parsing the chat id out of the conversation id is the adapter's business.

## Permission model (shared, platform-blind)

`gate()` in `config.ts` is the whole inbound decision. Four verdicts:
`allow | chat-disabled | not-addressed | not-bound`.

- **Seeds, not inheritance.** Platform-level `requireMention` / `requireBind` /
  `topicMode` / `cwd` / `model` / `thinking` are copied into a chat the first
  time the bot sees it; a platform default never touches an existing chat.
- **DMs are bind-only**: `if (isDm) return bound || bindRequest`. The two flags
  are group settings.
- Group denials are silent; DM denials say how to bind, throttled per sender.
- Chats are discovered from inbound traffic and arrive enabled behind the
  gates — groups always, a DM only from a bound sender (`gate.mayDiscover()`),
  so a stranger's DM writes no row.
- **Bind**: a Console-issued single-use code with a TTL, redeemed by `/bind
  <code>` in a DM; bind requests pass the bind gate. Five wrong tries void the
  code, and the fifth reply says so.

## Commands

`parseCommand()` (`commands.ts`): trim both ends, require a leading `/`, split
an `@target` off the name, lowercase the name, keep args **verbatim**. A command
aimed at another bot travels on as ordinary text. Slack never delivers an
unregistered `/`, so its adapter matches bare words: a closed set with an exact
argument count (`stop`/`settings` none, `bind` one); anything longer is prose.

## Inbound checklist for a new adapter

1. Normalize to `InboundMessage`, `mode: "steer"`.
2. Detect *addressing* (mention entity, reply-to-bot, targeted slash command)
   before stripping it; strip a leading mention.
3. `gate.mayDiscover()` → `discoverChat()`, then `gate.admit()`. Log every drop
   with its verdict.
4. Download attachments **after** the gate.
5. One promise chain per chat, concurrency across chats; bound the active
   chains; advance the platform's ack cursor only for accepted updates.
6. Assume at-least-once delivery.

## Outbound checklist

1. Render markdown to the platform's subset, **escape first** (extract code,
   escape, re-introduce the allowed tags).
2. Chunk to the message limit; interactive elements on the last chunk only.
3. Suggestions become buttons: payload is an **index**, label read back off the
   message's own keyboard. Pack short labels onto shared rows by rendered
   width. Retire the keyboard once one option is taken.
4. Append `formatTurnMeta(reply.meta)` as a footnote — one newline, not a blank
   line.
5. Reaction receipts (below).

## Reaction receipts

`receipts.ts` is a SQLite table, not a `Map`. An adapter calls `mark`, `settle`
and `sweep`:

- Book the receipt **synchronously, before dispatching** the message.
- Clear only what the ending turn was working on: pass `reply.meta` to
  `settle`/`settleAfter` (one Pi run can end several turns).
- Await the in-flight "add" before issuing the "clear".
- On `start()`, clear every receipt on the books; sweep stragglers every 30 min.

## Console surface

One tab and one document per platform: token, defaults, bound users, discovered
chats. The token fields save through `ChannelStore` into the vault under fixed
names (`CREDENTIAL_NAMES` in `config.ts`, [07-vault.md](07-vault.md)); the
channel row holds no credential.

| Route | Behavior |
| ----- | -------- |
| `GET /api/channels/:platform` | config with the token **masked** |
| `PUT /api/channels/:platform` | full document; masked token = unchanged token |
| `POST /api/channels/:platform/bind-code` | issue a single-use code |
| `DELETE /api/channels/:platform/users/:id` | unbind |
| `GET /api/models` | backend model catalog, no session needed |
| `GET /api/fs/ls`, `POST /api/fs/mkdir` | directory browsing / mkdir for the cwd picker |

The save is **non-destructive** (stored chat list overlaid with the client's
edits, so a chat discovered while the page was open survives) and **autosaved**
(debounced, serialized, coalesced; a deferred save carries its own platform).

## Verify on the platform before writing the adapter

Answer these first.

| # | Question | Telegram | Slack | Lark |
| - | -------- | -------- | ----- | ---- |
| 1 | **Interactive payload size?** | `callback_data` 64 **bytes** (~21 CJK chars) | `action_id` 255 chars, `value` 2000 | `value` is a JSON object; exact cap undocumented — Pier sends `{key, root}` (~40 bytes) and never a label |
| 2 | **Does it echo the component back** on the message a click came from? | yes, `reply_markup` | yes, `message.blocks` | **no, and it cannot be fetched either** — `message.get` on a 2.0 card answers a "please upgrade your client" post, so the button's `value` is the only echo; the label travels inside it |
| 3 | **Can a bot add _and remove_ its own reactions?** | yes, one per message | yes, but by **short name** (`eyes`), never the codepoint | add yes; remove is **list-then-delete by reaction_id**; keys are names (👀 = `OnIt`) |
| 4 | **Thread primitive, and what right to create one?** | forum topics; needs admin + `Manage Topics` | `thread_ts`; no right at all, no setup | `reply_in_thread` on the reply call; no right, no setup, works in DMs |
| 5 | **Length cap and rate limit** | 4096 chars, ~1 msg/s per chat (`429` + `retry_after`) | 3000 per section block, ~1 msg/s per channel (`429` + `Retry-After`) | card request 30KB in **bytes** (chunk budget 7000 chars); QPS limits not yet hit in anger |
| 6 | **What is "addressed", and is the mention stripped?** | mention entity / reply-to-bot; not stripped | `<@BOTID>` anywhere in text; not stripped | `mentions[]` + `@_user_N` placeholder left in the text; not stripped |
| 7 | **Small or muted text?** | none — footers must be italics | yes, the `context` block | notation-size markdown + `<font color='grey'>` (schema 2.0 removed `note`) |

8. **Can the user even send a `/command`?** Slack's client resolves a leading
   `/` itself and never delivers an unregistered one. Lark delivers them verbatim.
9. **Is delivery exactly-once, and is one user action one event?** Slack
   redelivers anything it did not see acked *and* sends `app_mention` alongside
   `message.channels` for the same mention — with a different `event_id`, so
   dedup cannot save you; ignore one of the two at the source. Lark is
   at-least-once too: dedup on `event_id`, and the SDK acks only when the handler returns.

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
  DMs too (`threadOf` = `thread_ts ?? ts`): every top-level DM opens its own
  session. `topicMode` has no meaning; the Console shows "Thread mode: always
  on". Lark follows this rule too.
- **Two credentials.** `xapp-` (`connections:write`) opens Socket Mode;
  `xoxb-` signs Web API calls. `ChannelConfig.appToken` under the same
  "masked means unchanged" rule as `token`.
- **Setup is a manifest** (`SLACK_MANIFEST`, one button to
  `api.slack.com/apps?new_app=1&manifest_json=…`); by hand: mint the app-level
  token, invite the bot to a channel. Scopes omitted: `app_mentions:read`
  (duplicate event), `reactions:read`, `commands`, `im:read`. Needed:
  `mpim:read` (a click carries no `channel_type`), `files:write`
  (`channels/attach.ts`).
- **Socket Mode without the SDK**: `apps.connections.open` + Node's
  `WebSocket`, behind `SocketLike`. Slack recycles connections every few hours
  (`disconnect: refresh_requested`). "Too many connections" is an accepted
  socket closed immediately — anything younger than ~5s is a failed attempt.
  Re-check the stop flag after every await. **Ack before handling**: Slack
  redelivers anything unacked past the deadline.
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
  survive a double.
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
  bounded in-process copy of the sent card — the one sanctioned exception to
  "never key interaction state on adapter memory"; the failure is a leftover
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
