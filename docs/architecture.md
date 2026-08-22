# Pier Architecture

This document is the system contract. Module implementers must not deviate
from the interfaces and dependency rules here; changing them is a design
decision that happens in this file first, code second.

## System Shape

One Node process. Channels and the web workbench feed normalized messages
into core; core routes them to Pi sessions through the agent seam; every
session emits one ordered event stream that all surfaces consume.

```
Slack / Telegram / Lark          Web workbench (browser)       Tasks
        │ Channel seam                  │ HTTP + SSE          HTTP / timer / tool
        ▼                               ▼                         ▼
┌──────────────────────────── core ──────────────────────────────┐
│ router (conversation → session)                                │
│ queue policy (idle→prompt, busy→steer/followUp)                │
│ event hub (per-session buffer + workspace pointers)           │
└──────────────────────────────┬─────────────────────────────────┘
                       │ AgentSession seam
                       ▼
                agent/ (Pi SDK)
```

## Directory Layout

```
src/
  core/        types.ts, router.ts, hub.ts, queue.ts, reply.ts, identity.ts
  agent/       pi.ts (the ONLY file importing @earendil-works/pi-*), events.ts
               (Pi → Pier event translation, no SDK imports), config.ts
               (provider/model files), credentials.ts (sealed store + auth.json
               import), models.ts (catalog curation)
  channels/    types.ts (config contract), config.ts (store + permission gate),
               gatekeeper.ts (verdict + drop log), chains.ts (ordering),
               chunk.ts, commands.ts (slash-command parse), control.ts,
               conversations.ts (durable chat → session map),
               receipts.ts (durable pending-reaction set),
               panel.ts (shared in-chat settings panel),
               runtime.ts (adapter lifecycle), routes.ts,
               telegram.ts + -api + -render + -panel
               slack.ts + -api + -render + -panel + -tool + -outbound + -directory
               [lark.ts: configurable, no adapter yet]
  boards/      boards.ts (scan + manifest + static serving), pier.css
  web/         server.ts, auth.ts, files.ts, session-state.ts,
               ui/ modules (form.ts + dom.ts are the shared vocabulary)
  tasks/       definitions, runs, groups, agent (the child-run runner),
               execution, callbacks, messages, command, service, store, tool,
               HTTP routes
  main.ts      wiring only
  paths.ts     where PIER_HOME resolves, once
  db.ts        the one connection, and the migration list that owns the schema
  log.ts       what a log line looks like, and where it goes
  secrets.ts   layer-1 credential encryption (master.key wraps the DEK)
  settings.ts  the instance facts a human owns (today: the public URL)
  update.ts    whether a newer release exists; checking only, never applying
  cli.ts       what `pier` does when typed; service.ts is the unit it writes
```

Dependency direction: `channels | web | tasks | boards → core → agent`. Core
never imports platform SDKs or Pi. Nothing imports sideways between channels.
`paths.ts`, `db.ts` and `log.ts` are the exceptions to "no sideways": leaves
every area may import and that import nothing (or, for `db.ts`, only the other
two), because `$PIER_HOME` is process configuration (it had otherwise grown a
copy per module that needed a file), a schema version is one number per
database and cannot be owned by five modules, and a log line is not a seam
crossing. Logging goes to stdout/stderr only —
journald owns time, history and rotation (docs/deploy.md); `PIER_LOG=debug`
adds per-message tracing, `PIER_LOG=silent` is what test runs use.
`boards/` is the thinnest surface of all: a filesystem scan plus a static file
handler, importing neither core nor Pi.

`docs/design/06-design-review.md` is the written diagnosis the repo-size
tripwire asks for, with the measured breakdown and which budgets to revise.

The IM channel layer has its own living spec: `docs/design/04-im-channels.md`
covers what is shared versus platform-specific, the checklists a new adapter
follows, and the traps Telegram and Slack already paid for. Read it before
writing the Lark adapter.

### Markdown is repaired once, at the seam

`splitReply()` normalizes the agent's markdown for every surface: it strips
`<silent>` blocks and runs `cjkFriendly()`, which repairs `**strong**` runs that
CommonMark refuses to close when a delimiter sits against punctuation next to a
CJK character. Every parser has some version of that hole and they disagree on
which half — Slack's markdown block and the web's `marked` fail on different
inputs — so the repair belongs where the syntax is already owned, not per
adapter. See `docs/design/04-im-channels.md` for the rule itself.

## Core Types

`src/core/types.ts` is the normative contract — the file itself is the source
of truth (this doc stopped mirroring it to avoid drift). The seams:

- `Channel` — platform ↔ core: `start(onMessage)`, `send(conversationId,
  reply)`, `stop()`. One implementation per platform. `AgentReply` is markdown
  plus next-step labels (`core/reply.ts` parses the agent's trailing `---\n[a] |
  [b]` block once); every surface renders them as buttons that send the label.
  `send` is called on **every** turn-end, empty text included — that is the
  turn-settled signal an adapter retires per-turn UI on. `notify` carries a
  persisted `system-input` (delegation, task callback, supervisor message) to
  the same conversation: a turn the chat never saw being asked for otherwise
  reads as the agent talking to itself. `AgentReply` carries the turn's
  `TurnMeta`, which surfaces without hover render as a footer.
- Slash commands are parsed once for every platform in `channels/commands.ts`:
  trim both ends, require a leading `/`, split off an `@target`, keep args
  verbatim. Channel-level control that is not a prompt (`/stop`) is wired by
  `channels/runtime.ts`, which owns the router — the `Channel` seam has one
  inbound path and keeps it.
- `AgentSession` / `AgentFactory` — core ↔ Pi: prompt/steer/followUp (all
  accept optional image attachments), persisted system input, abort, history,
  model get/set/list, clearQueue, create/fork/resume, and a payload-only
  `subscribe`. Must stay implementable over RPC.
- `SessionEventPayload` — the only observability currency: turn/text/thinking/
  tool events, persisted `system-input`, linked `task-status`, state and queue
  snapshots, and errors. Delegation, callback, steer, and supervisor-message
  provenance survives transcript replay. The hub stamps `seq`/`ts`/`sessionId`.
- Pi → Pier event translation lives in `src/agent/events.ts` with golden-table
  tests; changing a mapping is a design decision. Task delegation/callbacks use
  Pi custom messages so origin metadata survives transcript replay.

## Fixed Behavioral Rules

- **Queue policy** (`core/queue.ts`): `mode:"auto"` → if session idle,
  `prompt`; if streaming, `followUp`. On auto, text starting with `!` → strip
  the prefix and `steer` (idle: prompt — the prefix is consumed either way).
  Explicit `mode` always wins and takes the text verbatim: IM sends steer for
  every message, so a `!` there is content. This is the whole policy; do not
  add options.
- **Event hub** (`core/hub.ts`): per-session monotonic `seq`, in-memory ring
  buffer (last 1000 events) for SSE replay via `Last-Event-ID`, synchronous
  fan-out to subscribers. No persistence — pi's session files are the durable
  record. `queued` events are emitted by the router when the queue policy
  defers a message (pi's `queue_update` is dropped at the seam).
- **Routing** (`core/router.ts`): `ConversationKey → sessionId` map, in-memory.
  Unknown conversation → create a session lazily via the injected resolver.
  Durability is the caller's business, not core's: web conversation ids already
  *are* session ids, task definitions persist their target, and IM channels
  keep `channels/conversations.ts` — without it a restart would hand every
  chat a fresh session while its visible history says otherwise. A mapping
  whose session Pi no longer has is dropped and re-created, never retried
  forever.
- **Outbound to IM channels**: on `turn-end`, core sends the turn's full text
  to the owning channel. IM surfaces get turn granularity; only the web
  workbench gets deltas. Reasoning and tool events never leave core for an IM
  surface: the Telegram adapter reacts 👀 on each message that entered the turn
  and clears them all when it settles. The pending set is durable
  (`channels/receipts.ts`) because the two halves live on the platform, not in
  Pier: an adapter clears every receipt on the books at startup (none can be
  its own yet) and sweeps its own stragglers past 30 minutes, so a crash or a
  message whose turn never started cannot orphan an emoji.
- **IM permission policy** (`channels/config.ts`): one persisted JSON document
  per platform holds the token, global defaults, bound users and the chats
  discovered from inbound traffic. `requireMention` and `requireBind` default
  to true; a chat overrides a flag only with an explicit boolean, so
  `undefined` always means "inherit". `gate()` is the whole inbound decision
  and is platform-blind — denials are silent, never a message in the chat.
- **Topic mode** (Telegram): a message landing in a forum group's General
  opens a topic named after its first line, so one group hosts many parallel
  sessions. Replies and slash commands stay put; a failure falls back to
  General rather than losing the message. Per-chat, inheriting the global.
- **IM inbound is `mode: "steer"`**: a human watching a chat window expects
  the next message to reach the running turn, not to queue behind it.
- **Errors**: a malformed inbound message is logged and dropped at the seam.
  Agent errors surface as `error` events, never as thrown exceptions across
  a seam.

## Open Questions

- `ChatKind`'s `"forum"` member is a Telegram word sitting in the
  platform-blind config contract (`channels/types.ts`), and Slack confirmed it
  does not generalize — the adapter reports every channel as `"group"` because
  a Slack channel is *always* threaded, so `"forum"` would be either always or
  never right. `topicMode` turned out not to generalize either: it is a real
  switch on Telegram and a constant on Slack, which now shows "Thread mode:
  always on" instead. Both want resolving together with Lark — probably by
  making "threads per request" an adapter capability rather than a stored flag.
  Two data points is enough to see the shape; a third decides the name.

## Decisions Log

- One shared password guards every HTTP surface (`web/auth.ts`): a single
  middleware ahead of all routes, a scrypt hash generated on first boot and
  printed once, and a cookie signed with that hash. Single-account on purpose —
  Pier has one workspace, so a boundary is what an exposed instance needs, not
  identities. `/p/*` and the stylesheet boards link are the only exemptions, so
  a board's `public` flag is a real boundary and not just a data state.
- Remote access and deployment: the loopback bind is the posture, reached over
  an SSH tunnel, a private network or a reverse proxy. `pier service install`
  writes the documented service and updater units. Version checks are read-only;
  an explicit `pier update` runs backup, package install and restart in the
  updater's cgroup, never from a timer.
- Pi **SDK** over RPC; seam kept RPC-compatible (no Pi types leak out of `agent/`).
- Standalone program, not a Pi extension; Pier registers custom tools into
  the sessions it creates (task tool, step 4).
- Web workbench before IM channels (fastest loop for steering/observability).
- Boards (avibe's "Show pages", renamed): a board is a *directory* under
  `$PIER_HOME/boards`, derived by scanning like Projects are — no table, no
  store. Only `<board>/site/` is served; sources, README and manifest stay off
  the wire. Many-to-many with sessions and independent of their lifecycle.
  Hand-written static HTML against one shipped classless stylesheet: Pier ships
  no board toolchain and no framework, and a board that needs a build owns it.
  Design: `docs/design/05-boards.md`.
- Persistence: Pi session files own transcripts; one SQLite database owns
  everything else — Task definitions, immutable Run snapshots, callback outbox
  state, the bounded Subagent control/supervisor message ledger, one config row
  per IM channel, the chat → session map, pending reaction receipts, the
  password hash, instance settings and per-session workbench flags. One
  connection, opened by `db.ts` before any store exists, because `user_version`
  is one number per database: the schema is an append-only list of migrations
  applied in a single transaction, upgrades only, and a database from a newer
  Pier is refused rather than half-served. A store owns its queries, never its
  own tables or its own handle. Nothing is stored in a JSON file that a
  restart-safe row can hold.
- IM chats are discovered, not registered: Telegram has no "list my chats"
  API, so a chat appears in the Console after the bot first sees traffic in
  it. New chats arrive enabled; the mention and bind gates are what keep them
  harmless until an operator configures them.
- Telegram over raw Bot API long polling, not a bot framework and not
  webhooks: the surface Pier needs is HTTP + JSON, and webhooks would add an
  inbound public-HTTP requirement to a local process.
- Frontend build: Vite + Tailwind (static CSS, zero runtime). Adopted early by
  explicit decision instead of the original no-bundler plan; still no UI
  framework until componentization is needed.
- Subagent is an Agent Task run in a reused, fresh, or forked persisted Session;
  there is no second scheduler, Agent Profile store, broker, or event stream.
  Fork follows Pi's active compacted branch and excludes the in-flight Task
  tool-call leaf, whose tool result does not exist when the child starts.
- Projects are derived, not registered: a project is a distinct session cwd.
  No project store exists; the sidebar groups by cwd and the new-session
  dialog suggests known cwds. A real registry only arrives if derivation
  proves insufficient.
