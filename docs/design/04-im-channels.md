# IM Channels (living spec)

Platform adapters in front of Pi sessions: Slack and Lark (Feishu).
`docs/architecture.md` owns the rules; this file owns the *how*.

## What a channel provides

| Feature | Behaviour | Shared / adapter | Slack | Lark |
| --- | --- | --- | :-: | :-: |
| Session per conversation | One chat (or thread) is one persisted Pi session, stable across restarts | shared (`conversations.ts`) | ✅ | ✅ |
| Thread-per-request | A message in the parent chat opens a native thread and its own session; replies and commands stay put | shared policy, adapter creates the thread | ✅ | ✅ |
| Steer by default | Inbound joins the running turn rather than queueing behind it | shared (`mode: "steer"`) | ✅ | ✅ |
| Progress receipts | Every message that entered a turn wears 👀 until it settles; no intermediate reasoning is ever posted | shared ledger, adapter calls the reaction API | ✅ | ✅ |
| Turn footer | `45s · 32K tok` under each reply | shared (`formatTurnMeta`) | ✅ | ✅ |
| Next-step buttons | The agent's `[label]` row becomes buttons; a click sends the label as an ordinary message | shared parse, adapter renders + feeds back | ✅ | ✅ |
| File attachments | Inbound files (images, documents) land in `$PIER_HOME/inbox/` and ride the prompt as `[name](file:///…)` lines (bytes: `core/inbox.ts`, grammar: `core/inbound-file.ts`); a failed or oversized download becomes an `[attachment lost: …]` line, never silence; the agent reads a file only when it chooses to | adapter (download after the gate) | ✅ | ✅ |
| Outbound attachments | A `file://` link in a reply is dead on anyone else's machine, so the file is uploaded to the platform and the link's label stays in the text; over the cap, missing or refused becomes an `[attachment lost: …]` line (shared: `channels/attach.ts`, upload per `*-api.ts`) | shared split/read/report, adapter uploads | ✅ | ✅ |
| System notes | Task delegation / callback / supervisor input is posted to the same thread before the turn it triggers | shared (`Channel.notify`) | ✅ | ✅ |
| Failure notices | Any error reaches the conversation, not just the web timeline | shared (`Router.report`) | ✅ | ✅ |
| Visible empty turns | A turn with no text still posts one muted line saying why | shared (`AgentReply.silence`), adapter renders | ✅ | ✅ |
| Speaker identity | `[name<id> time place]` above a message (`[name time platform]` where ids are opaque), only when it changes | shared (`core/identity.ts`), adapter resolves the name | ✅ | ✅ |
| Deliberate silence | `<silent>` sends no reply, so a group thread is bearable | shared (`splitReply`) | ✅ | ✅ |
| Stop | Abort the conversation's running turn | shared (`runtime` → `abortConversation`) | ✅ | ✅ |
| Bind | Redeem a Console-issued single-use code in a DM | shared | ✅ | ✅ |
| Permissions | Chat enable · require mention (groups) · bind (always in DMs) | shared (`gate()`) | ✅ | ✅ |
| Per-chat launch config | cwd, model, reasoning level for the sessions a chat opens | shared (`launchFor`) | ✅ | ✅ |
| Console tab | One page per platform: token, defaults, bound users, discovered chats; autosaved, token masked | shared (`routes.ts`, `web/ui/channels.ts`) | ✅ | ✅ |
| Setup walkthrough | Hover help for getting a token and enabling threads | adapter copy, shared badge | ✅ | ✅ |
| Settings panel | In-chat panel: a thread without a session drafts one (cwd, pinned model & reasoning, a pending question) and Starts it; a thread with one reads it out, picks model & reasoning, stops | shared control, adapter renders | ✅ | ✅ |
| Continue from web | The workbench binds a web session to a new thread in a chat the bot knows; Pier posts the one root message | shared (`handoff.ts`), adapter posts the root (`openThread`) | ✅ | ✅ |
| Continue in this thread | The panel of a thread with no session binds it to an unbound web session | shared (`handoff.ts` → `panel.ts`) | ✅ | ✅ |
| Agent access | An agent session reads/posts through the platform from a shell, with the token from the vault | `pier <platform>` subcommand (`slack-cli.ts`) + skill (`skills/pier-slack/`) | ✅ | —¹ |

✅ done · — not started · ¹ explicitly not wanted (operator decision, 2025)

Command spelling is per-platform: Lark takes `/stop`, `/settings`,
`/bind <code>`; Slack the same words without the slash. `s <text>` is the same
on both ([the panel](#the-in-chat-panel)).

### Deliberately not features

Re-adding any of these is a design decision, not a gap: backend / agent
selection in chat; message-visibility toggles; per-thread setting overrides;
admin / bind management from chat; webhook inbound; registered Slack slash
commands; posting in a Slack channel's main flow (the handoff root excepted);
editing a live session's cwd (Pi fixes cwd at creation — a new directory is a
new thread); moving a session between threads.

## Layout

File list: `docs/architecture.md`; each file's header comment names its one
reason. Everything but the per-platform files (`<platform>.ts`, `-api`,
`-render`, `-panel`, and `-outbound` / `-directory` / `-thread` / `-cli` /
`-transcript` where present) is shared. A fourth adapter adds four or five files and touches only `runtime.ts`
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
(`control.ts`): abort, read status, pins, set model / reasoning, start a new
session, recent directories, `knows()` — injected by `runtime.ts`, which owns
router and factory. The panel's pull of a web session is the handoff's
`unbound` / `continueHere` (`PanelHandoff`), injected the same way. The seam
keeps one inbound path (`onMessage`); add the next control here.

**Opening a thread is channels-internal.** `ImChannel` (`runtime.ts`) is
`Channel` plus `openThread(chatId, note)`: post the handoff root, answer the
new conversation id. `ChannelRuntime.openThread` throws `<platform> is not
running`; `running()` lists the live platforms.

## Continue from web, and from a thread (`handoff.ts`)

Both directions share the guards and the binding, in this order:

| Step | Refusal |
| --- | --- |
| `continueIn` only: platform running | 409 `Slack is not running — enable it in Settings → Channels.` |
| `continueIn` only: chat known, enabled | 404 / 409 `That chat is not enabled for the bot.` |
| `continueHere` only: thread has no row | 409 `This thread already has a session.` |
| session on disk | 404 `Session <id8> has no transcript yet — send it one message first.` |
| not already bound | 409 `Already answers in <platform> · <chat name>.` |
| `continueIn` only: post the root (`openThread`) | 502 with the platform's message; nothing written |
| bind: `conversations.set` → attach the session when the web has it loaded → `sessions-changed` | — |

Post before row: a row for a thread that does not exist is worse than a root
with no row. `unbound(limit)` is the picker's list: the backend's listing
minus `conversations.boundSessions()` and the sessions task runs created for
themselves (`taskSessions`), in the web rail's order: its working set
(`SessionStateStore.flags()` rank) first, then newest first.

- The note is `{title, url}`: `sessionLabel` (`core/identity.ts`) and
  `<publicUrl>/#/session/<id>`, `""` without a public URL, which the root says
  (`(no public URL set — Settings → Instance)`) rather than refusing.
- Slack root (mrkdwn, no `thread_ts`): `Continued from web: *<title>*` /
  link / `_Reply in this thread to continue._`. Lark: one root card
  (`createCard`) then one in-thread card `Reply here to continue.` — on the
  phone a topic has its own composer only once it has a reply.
- A reply in the thread without a mention is admitted: the row exists, so
  `knows()` is true. A Lark DM user typing in the main flow starts a new
  session, as for every DM.
- Restart: the row is the truth. The thread speaking first resumes under the
  chat key; the web speaking first attaches it through the router's
  `chatKeyOf` hook, so the reply reaches the thread.
- Crash between the post and the row: an orphan root; a retry posts a second.

## The in-chat panel

`@bot` on its own (empty text once the mention is stripped) and `settings` are
the same request. `s <text>` (`settingsDraft`, `commands.ts`; Lark also
`/s <text>`) opens it with the text as the *pending question*, only on a
**thread root** — a Slack message with no other `thread_ts`, a Lark message
with no `root_id` — where the session it drafts would be created; inside a
thread, and a bare `s`, are prose. The panel has two states, decided by the
thread's row (`ChannelControl.knows`).

- One message, edited in place.
- Panel buttons are `cfg:<action>[:<arg>]`, consumed by the panel; any other
  payload is a next-step label and *is* the message to send.
- Lists are paged and picked by **index** (payloads are size-capped).

**No session — a draft.** Line 1 `Starts in <cwd> · <model> · <reasoning>` is
what Start creates with: the draft over the chat defaults (`launchFor`), the
group suffixed `· chat defaults` while no pick changed it. Line 2, with a
question, `▸ <question>` cut at 80 characters. Buttons: Model & reasoning,
Directory…, Continue web session… / Start, Close.

- Model & reasoning and Directory… set the draft and redraw; nothing is
  created. A typed path sets the draft's directory too (modal title
  `Directory`, submit `Set`).
- Start (`cfg:start`): `newSession(key, draft)` creates and binds, then the
  question goes to the router as the tapper's `InboundMessage` (`sender` the
  tapper, the 👀 on the card). The card settles on the session — the Session
  group, no button, no `Recent` — and the panel state is released: `Started
  <id8> in <cwd>.` or `Started <id8> — running your question.` A row that
  appeared meanwhile (a message raced the tap) is not replaced: `This thread
  already has a session — send your question as a message.`
- Continue web session… binds an existing session; the draft is discarded and
  the card settles the same way, with `Recent` — the excerpt is what tells a
  phone reader which conversation this is.
- **The card is the store.** Every button's value (Slack `value`, Lark
  `LarkActionValue.draft`) carries the draft `{cwd?, model?, thinking?, q?,
  dropped?}`; a tap whose in-memory state is gone (a restart) rebuilds it from
  the value and the card's own id (Slack `message.ts`, Lark
  `open_message_id`), then honours the tap on that card — an index pick's
  list is gone, so it prints "no longer listed". The Slack modal carries
  `{conversation, ts, draft}` in `private_metadata`; Lark's form-submit button
  carries no value, so a typed path after a restart keeps the card, not the
  earlier picks.
- A question over 1500 UTF-8 bytes is not held (`dropped`; Slack caps a value
  at 2000 characters, Lark a card at 30 KB, and the draft rides eleven
  buttons): line 2 says `Your question is too long to hold — send it again
  after Start.` and Start creates without it.

**With a session.** The Session group: `<id8> · <state>` (`created, no
message yet` before the first turn), directory, model · reasoning, context.
Buttons: Model & reasoning / ⏹ Stop while streaming — nothing else: the
conversation is right above the card (no `Recent`), a fresh session is a fresh
thread, and the card stays. No Channel group: the Console owns the gates.

The `Recent` group is an excerpt — never a summary — of the last two exchanges
(`ChannelControl.recent`), one line each, `▸ <user>` / `◂ <reply>` oldest
first, whitespace flattened and cut at 150 characters, the speaker header,
attachment markers, next-step block and `<silent>` reason stripped. No turn
yet, no group; an unanswered last turn is a `▸` alone; a read that failed is
one line `Could not read the transcript: <reason>`. Only the card Continue web
session… settles on carries it.

- Opening it on an evicted session resumes that session (one Pi open,
  truthful values).
- A tap on a settled card — an old button after a redeploy — rebuilds the
  state, so an index pick answers "no longer listed" and the card is redrawn
  in place; nothing is posted.
- "Model & reasoning" (`cfg:pins:<page>`) lists the operator's pinned models
  (`settings.modelMenu`, read per tap through `ChannelControl.pins`), eight a
  page, each a numbered line `<id> · <level> — <note>` (no note, no dash) with
  ✓ on the pin matching the session's (or the draft's) model *and* level, and
  one button each (`cfg:pin:<i>`, labelled `<n> <id>` — a platform truncates a
  long label). A tap applies both (`setModel`, then `setThinking`) and the
  note reads `Model set to <id> · <level>.` Nothing pinned: `No pinned models
  — Settings → Models → Model menu.`; the catalog is the Console's, not a
  chat's.
- "Directory…" (`cfg:cwd`, draft state only) lists up to six recent
  directories — the distinct cwds of the session listing, newest first, the
  chat's own default first (`ChannelControl.recentDirs`) — as numbered full
  paths with one button each (`cfg:cwd:<i>`, label the last two segments),
  then "Type a path…" (`cfg:cwdtype`) and Back. A tap sets the draft's
  directory; a thread that has a session is refused with the sentence Start
  uses. The typed answer rejects a relative path. Slack: a modal. Prefer a
  modal wherever the platform has one.
- "Continue web session…" (`cfg:sessions:<page>`, draft state only): the 40
  newest unbound sessions, eight a page (`‹ Prev` / `Next ›` / Back as for the
  pins), each a numbered line — title or directory name cut at 40 characters ·
  directory basename · age — with one button (`cfg:session:<i>`). A tap is
  `continueHere`; the note reads `Continuing session <id8> — reply in this
  thread.` and the card settles on the session. Nothing to list: `No
  unbound sessions.`; a listing that failed says so instead. A refused pick
  prints the refusal sentence.
- A session the panel creates has no transcript until its first reply, so
  its row carries the launch record ([Conversation identity](#conversation-identity)).

## Agent access: the platform from a shell

`pier slack <subcommand> …` (`channels/slack-cli.ts`, dispatched from
`cli.ts`), the token `$SLACK_BOT_TOKEN` or the vault's `SLACK_TOKEN` over the
CLI socket ([08-cli-socket.md](08-cli-socket.md)). No tool, no Console switch, no
ownership guard: the vault level of `SLACK_TOKEN` is the operator's switch,
and Slack refuses `chat.update`/`chat.delete` on anyone else's message. The
session learns its own channel and thread from the `place` token of the
speaker header.

- The CLI runs on the adapter's `SlackApi` (public `read`; four rate-limit
  waits where the adapter takes one), `SlackDirectory` for names and
  `slack-render`'s markdown block. A read paginates fully and can write to
  disk (`--out`). `skills/pier-slack/SKILL.md` describes the transcript
  format; no header repeats it.
- The adapter's one read, `slack-thread.ts`: a forwarded thread parent with
  `reply_count <= 30` is inlined into the prompt through
  `slack-transcript.ts` — the renderer `pier slack` prints with, ts and ids
  on.
- A `ts` stays TEXT everywhere (16 significant digits; REAL loses them).
- Markdown is not Slack syntax: a mention is `<@U04B7Q2>`, a channel
  `<#C0123456>`, a broadcast `<!here>`.

### Who is speaking

`InboundMessage.sender` carries `{id, name}`: the adapter resolves the display
name; `core/identity.ts`'s `SenderPrefix` emits `[name<id> time place]` only on
a different speaker, a 10-minute gap, a new day, or a different conversation.
`place` is `<channelId>:<conversationId>` verbatim (`slack:C079TC7GUBG/1712.345600`),
said once per session and again only after `forgetSender`;
alias keys (`web:`, `task:`) name no place. A channel that declares
`opaqueIds` — no `pier <platform>` CLI, no mention syntax out, so Lark —
gets `[name time platform]` instead: the name always beside the
time, which is the only thing telling a bare name from body text. `sanitizeIdentity` strips `[`, `]`,
`<`, `>` and newlines so a display name cannot forge a second speaker.
Identity is **per-turn, never baked into a session**: a thread is shared.
`splitSpeaker` reads every shape back for the web bubble and the listing index.

## Conversation identity

A `conversationId` is opaque to core. Slack and Lark spell it
`<channelId>/<threadTs>`; the chat half has one decoder (`chatOf`).

`ConversationStore` (`conversations.ts`) makes routing survive a restart. A
row made by `newSession` carries the launch it was created with, amended by
every model / reasoning pick (Pi writes nothing before the first reply, so
until then the record is the session). A mapping whose session Pi no longer
has is dropped and re-created — from that record when there is one, else from
the chat defaults — and the thread is told which (`resolveConversation`'s
`onStale`, wired in `main.ts`). Per-chat launch options (cwd, model, thinking)
come from `ChannelControl.launchFor(key)` — parsing the chat id out of the
conversation id is the adapter's business.

## Permission model (shared, platform-blind)

`gate()` in `config.ts` is the whole inbound decision. Four verdicts:
`allow | chat-disabled | not-addressed | not-bound`.

- **Seeds, not inheritance.** Platform-level `requireMention` / `requireBind` /
  `cwd` / `model` / `thinking` are copied into a chat the first
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

`parseCommand()` (`commands.ts`): trim both ends, require a leading `/`,
lowercase the name, keep args **verbatim**. Slack never delivers an
unregistered `/`, so its adapter matches bare words: a closed set with an exact
argument count (`stop`/`settings` none, `bind` one); anything longer is prose,
`s <text>` (`settingsDraft`) the one exception.

## Inbound checklist for a new adapter

1. Normalize to `InboundMessage`, `mode: "steer"`.
2. Detect *addressing* (mention entity, reply-to-bot) before stripping it;
   strip a leading mention.
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
| `GET /api/handoff/targets` | `{targets: HandoffTarget[]}` — running platforms × enabled chats |
| `POST /api/handoff` | body `HandoffRequest` → 201 `HandoffResult`; 400 invalid body; 404 / 409 / 502 `{error}` per the order above |

The save is **non-destructive** (stored chat list overlaid with the client's
edits, so a chat discovered while the page was open survives) and **autosaved**
(debounced, serialized, coalesced; a deferred save carries its own platform).

## Verify on the platform before writing the adapter

Answer these first.

| # | Question | Slack | Lark |
| - | -------- | ----- | ---- |
| 1 | **Interactive payload size?** | `action_id` 255 chars, `value` 2000 | `value` is a JSON object; exact cap undocumented — Pier sends `{key, root}` (~40 bytes) and never a label |
| 2 | **Does it echo the component back** on the message a click came from? | yes, `message.blocks` | **no, and it cannot be fetched either** — `message.get` on a 2.0 card answers a "please upgrade your client" post, so the button's `value` is the only echo; the label travels inside it |
| 3 | **Can a bot add _and remove_ its own reactions?** | yes, but by **short name** (`eyes`), never the codepoint | add yes; remove is **list-then-delete by reaction_id**; keys are names (👀 = `OnIt`) |
| 4 | **Thread primitive, and what right to create one?** | `thread_ts`; no right at all, no setup | `reply_in_thread` on the reply call; no right, no setup, works in DMs |
| 5 | **Length cap and rate limit** | 3000 per section block, ~1 msg/s per channel (`429` + `Retry-After`) | card request 30KB in **bytes** (chunk budget 7000 chars); QPS limits not yet hit in anger |
| 6 | **What is "addressed", and is the mention stripped?** | `<@BOTID>` anywhere in text; not stripped | `mentions[]` + `@_user_N` placeholder left in the text; not stripped |
| 7 | **Small or muted text?** | yes, the `context` block | notation-size markdown + `<font color='grey'>` (schema 2.0 removed `note`) |

8. **Can the user even send a `/command`?** Slack's client resolves a leading
   `/` itself and never delivers an unregistered one. Lark delivers them verbatim.
9. **Is delivery exactly-once, and is one user action one event?** Slack
   redelivers anything it did not see acked *and* sends `app_mention` alongside
   `message.channels` for the same mention — with a different `event_id`, so
   dedup cannot save you; ignore one of the two at the source. Lark is
   at-least-once too: dedup on `event_id`, and the SDK acks only when the handler returns.

## Slack facts

- **Threads are the whole design.** Pier never posts into a channel's main
  flow but the handoff root: a conversation is `<channel>/<threadTs>` and a thread *is* a session.
  DMs too (`threadOf` = `thread_ts ?? ts`): every top-level DM opens its own
  session. The Console's Connection card states it beside a help badge. Lark
  follows this rule too.
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
  `reply_count <= 30` (token budget) through `slack-thread.ts`; otherwise the
  coordinates are given for `pier slack`.
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
  topic per top-level message; `root_id` continues it. `createCard`
  (`im.v1.message.create`, `receive_id_type: chat_id`) is the one root Pier
  posts, for the handoff; it needs the send-as-bot scope.
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
