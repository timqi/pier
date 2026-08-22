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
  core/        types.ts, router.ts, hub.ts, queue.ts, reply.ts
  agent/       pi.ts (the ONLY file importing @earendil-works/pi-*)
  channels/    types.ts (config contract), config.ts (store + permission gate),
               conversations.ts (durable chat → session map),
               receipts.ts (durable pending-reaction set), db.ts,
               runtime.ts (adapter lifecycle), routes.ts,
               telegram.ts + telegram-api.ts + telegram-markdown.ts
               [slack.ts, lark.ts: configurable, no adapter yet]
  boards/      boards.ts (scan + manifest + static serving), pier.css
  web/         server.ts, static frontend (ui/ modules)
  tasks/       definitions, runs, groups, execution, callbacks, messages,
               service, store, tool, HTTP routes
  main.ts      wiring only
```

Dependency direction: `channels | web | tasks | boards → core → agent`. Core
never imports platform SDKs or Pi. Nothing imports sideways between channels.
`boards/` is the thinnest surface of all: a filesystem scan plus a static file
handler, importing neither core nor Pi.

The IM channel layer has its own living spec: `docs/design/04-im-channels.md`
covers what is shared versus platform-specific, the checklists a new adapter
follows, and the traps Telegram already paid for. Read it before writing the
Slack or Lark adapter.

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
  `prompt`; if streaming, `followUp`. Text starting with `!` → strip the
  prefix and `steer`. Explicit `mode` always wins. This is the whole policy;
  do not add options.
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
  platform-blind config contract (`channels/types.ts`). `topicMode` itself
  generalizes fine — "one native thread per request" is Slack threads and Lark
  topic groups too — but the kind name does not. Resolve it when the Slack
  adapter lands (likely `"threaded"`), together with whatever else that second
  platform proves wrong about the contract; renaming it now would be guessing.
- Nothing in Pier authenticates: the workbench, the task routes and the channel
  config all trust whoever reaches the loopback port. IM channels raise the
  stakes (a config write decides who may drive an agent in a group chat) but do
  not change the shape of the answer. To be handled once, for every surface, in
  its own step — not per-route. Boards shipped ahead of it, so a board's
  `public` flag is a data state today, not a security boundary: `/p/*` is the
  single prefix that will stay exempt when the middleware lands.
- Remote access and deployment (systemd unit, self-restart, version check) are
  deliberately unbuilt. Today: loopback bind, reached over an SSH tunnel or a
  private network.

## Decisions Log

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
- Persistence: Pi session files own transcripts; one SQLite database owns Task
  definitions, immutable Run snapshots, callback outbox state, the bounded
  Subagent control/supervisor message ledger, and one config row per IM
  channel.
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
