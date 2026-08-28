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
  core/        types.ts, router.ts, hub.ts, queue.ts, reply.ts, identity.ts,
               inbox.ts, inbound-file.ts
  agent/       pi.ts (the only file outside extensions/ importing
               @earendil-works/pi-*), events.ts (Pi → Pier event translation,
               no SDK imports), listing.ts (what is on disk, indexed in
               pier.db so a transcript is read once), config.ts
               (provider/model files),
               credentials.ts (sealed store + auth.json import), models.ts
               (catalog curation)
  extensions/  index.ts (the list Pier ships and nothing else),
               web/ (web_search + web_fetch on the provider's own hosted
               web tools)
  channels/    types.ts (config contract), config.ts (store + permission gate),
               gatekeeper.ts (verdict + drop log), chains.ts (ordering),
               attach.ts (outbound file links → uploads),
               chunk.ts, commands.ts (slash-command parse), control.ts,
               conversations.ts (durable chat → session map),
               receipts.ts (durable pending-reaction set),
               panel.ts (shared in-chat settings panel),
               runtime.ts (adapter lifecycle), routes.ts,
               telegram.ts + -api + -render + -panel
               slack.ts + -api + -render + -panel + -tool + -outbound + -directory
               lark.ts + -api + -render + -panel + -outbound
  boards/      boards.ts (scan + manifest + static serving), pier.css
  web/         types.ts (the wire shapes its answers carry, and the one file
               here the browser may import), server.ts (sessions + events),
               instance.ts (settings, update,
               secrets, client error reports), providers.ts + provider-flows.ts,
               auth.ts, files.ts, session-state.ts (what the workbench
               decided about a session: pinned, unread, order),
               repos.ts (which repository a project directory belongs to),
               push.ts (who is notified of a finished turn) + webpush.ts
               (the RFC 8291/8292 wire format), ui/public/sw.js,
               ui/ modules (form.ts + dom.ts are the shared vocabulary;
               code.ts renders every file the Console did not write)
  tasks/       types (incl. the shared delivery record), outbox (the one
               delivery engine: proof, backoff, ceiling), definitions,
               runs, groups, agent (the child-run runner),
               execution, callbacks, messages, command, service, store, tool,
               HTTP routes
  main.ts      wiring only
  paths.ts     where PIER_HOME resolves, once
  db.ts        the one connection, and the migration list that owns the schema
  log.ts       what a log line looks like, and where it goes
  limits.ts    the numbers more than one area has to agree on
  secrets.ts   layer-1 credential encryption (master.key wraps the DEK)
  settings.ts  the instance facts a human owns (the public URL, the model menu,
               the auto-update switch, which bundled extensions are on)
  update.ts    the newer release: whether one exists, and when this instance may
               become it — the install itself is handed to service.ts's unit
  drain.ts     the graceful restart: finish running turns, ledger what the
               deadline cut off for the next boot to deliver
  cli.ts       what `pier` does when typed; service.ts is the unit it writes
  tools.ts     the CLI binaries Pier manages (install, update, PATH) — ubix
               does the downloading, tools-task.ts owns the task that calls
               it; `rtk` is an extension that ships as one, so the Console's
               catalog is one list with a kind, not two; a custom tool is the
               body of its ubix block, guarded structurally, not by
               vocabulary; one sync at a time per machine, under a lock the
               whole operation is inside — a row in pier.db, because both
               processes already open it and BEGIN IMMEDIATE is the mutual
               exclusion a lock file would have to invent. A heartbeat cannot
               prove a holder is dead, so the holder is fenced rather than
               trusted: it re-checks the row before every step that changes
               anything, and a sync that was taken over fails saying so — which
               bounds an overlap to one already-started step rather than
               excluding it, over a floor of ubix's own flock (the contract in
               tools.ts says what that leaves open, and why it is left)
  tools-task.ts a tools switch becomes exactly one run of the one task Pier
               owns: what that task runs, keeping it the task Pier wrote, and
               coalescing a burst of switches into a single run
```

Dependency direction: `channels | web | tasks | boards → core → agent`. Core
never imports platform SDKs or Pi, and runtime dependencies never go sideways.
`extensions/` sits beside `agent/` rather than under it: an extension takes an
`ExtensionAPI`, so it is Pi-shaped by construction and is the second area
allowed to import the SDK. Only `agent/pi.ts` registers one (as an inline
factory) and only `main.ts` reads the catalog, as `CatalogEntry` data for the
Console; nothing else imports the area.
The browser may import owner-defined HTTP DTOs from `tasks/types.ts`,
`channels/types.ts` and `web/types.ts` type-only: these imports are erased at build, keep wire
shapes single-sourced, and do not let web implement either area.
`tools.ts` is instance-layer too, but not a leaf anything may import: only
`main.ts`, `cli.ts`, `tools-task.ts` and `settings.ts` reach it, because
managing binaries is an instance operation and no area needs one.
`tools-task.ts` is reachable from `main.ts` alone, and is the one root module
that imports `tasks/` (the service type-only, `isTerminal` for a run state):
the task belongs to the instance, and a leaf that scheduled itself would be two
modules. (`settings.ts` takes one function —
what a custom tool may be; the vocabulary it validates against, ubix's sources
and the names Pier already owns, lives with the installer, and a second copy of
it in the settings file would be the third-copy bug one release later.) It
imports node stdlib, `paths.ts`, `log.ts`, `db.ts` (the sync lock is a row, not
a file) and — type-only, like `settings.ts` — `core/types.ts`, whose
`CatalogEntry` is the Console's view of one switch, bundled extension and
managed binary alike, and must stay importable by a browser.
`paths.ts`, `db.ts`, `log.ts`, `secrets.ts` and `settings.ts` are the
root-leaf exceptions: every area may import them, and they import
nothing outside the root layer (`settings.ts` also names types from
`core/types.ts`, type-only), because `$PIER_HOME` is process configuration (it had otherwise grown a
copy per module that needed a file), a schema version is one number per
database and cannot be owned by five modules, and a log line is not a seam
crossing. Logging goes to stdout/stderr only —
journald owns time, history and rotation (docs/deploy.md); `PIER_LOG=debug`
adds per-message tracing, `PIER_LOG=silent` is what test runs use.
`boards/` is the thinnest surface of all: a filesystem scan plus a static file
handler, importing neither core nor Pi.

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
  reply)`, `notify(conversationId, note)`, `stop()`. One implementation per
  platform. `AgentReply` is markdown
  plus next-step labels (`core/reply.ts` parses the agent's trailing `---\n[a] |
  [b]` block once); every surface renders them as buttons that send the label.
  `send` is called on **every** turn-end, empty text included — that is the
  turn-settled signal an adapter retires per-turn UI on. `notify` carries a
  persisted `system-input` (delegation, task callback, supervisor message) or a
  service/error note such as restart recovery to the same conversation: a turn
  the chat never saw being asked for otherwise reads as the agent talking to
  itself. `AgentReply` carries the turn's
  `TurnMeta`, which surfaces without hover render as a footer.
- Slash commands are parsed once for every platform in `channels/commands.ts`:
  trim both ends, require a leading `/`, split off an `@target`, keep args
  verbatim. Channel-level control that is not a prompt (`/stop`) is wired by
  `channels/runtime.ts`, which owns the router — the `Channel` seam has one
  inbound path and keeps it.
- `AgentSession` / `AgentFactory` — core ↔ Pi: prompt/steer/followUp (text
  only — an inbound file is saved to `$PIER_HOME/inbox/` by the surface that
  received it and rides the prompt as a `[name](file:///…)` line; bytes in
  `core/inbox.ts`, marker grammar in `core/inbound-file.ts`), persisted
  system input, abort, history, rename,
  model get/set/list, clearQueue, create/fork/resume, `list`/`find` (one
  session by id, so no surface scans the whole listing for one), and a
  payload-only `subscribe`. Must stay implementable over RPC.
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
  record. Pi's `queue_update` is translated to a `queue-state` event at the
  seam (`agent/events.ts`), so surfaces can show what is waiting.
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
  per platform holds the token, platform-level seed values, bound users and
  the chats discovered from inbound traffic. `requireMention` and
  `requireBind` default to true; a newly discovered chat *copies* the platform
  values once and owns its flags from then on — there is no runtime
  inheritance, so changing a platform default never silently reconfigures an
  existing chat. `gate()` is the whole inbound decision and is platform-blind
  — denials are silent, never a message in the chat.
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
  switch on Telegram and a constant on Slack and Lark, which both show "Thread
  mode: always on" instead. The third data point (Lark) landed on Slack's side
  — `reply_in_thread` works everywhere, so the adapter reports `"group"` and
  ignores the flag. The shape is now clear: `"forum"` and `topicMode` are
  Telegram facts living in shared types, and the eventual fix is an adapter
  capability ("threads per request") rather than a stored flag. Not renamed
  yet — it is a stored-config migration, worth doing when the contract next
  changes for its own reasons.

## Decisions Log

- One shared password guards every HTTP surface (`web/auth.ts`): a single
  middleware ahead of all routes, a scrypt hash generated on first boot and
  printed once, and a cookie signed with that hash. Single-account on purpose —
  Pier has one workspace, so a boundary is what an exposed instance needs, not
  identities. `/p/*` — published boards and the stylesheet they link — is the
  only exemption, so
  a board's `public` flag is a real boundary and not just a data state.
- Remote access and deployment: the loopback bind is the posture, reached over
  an SSH tunnel, a private network or a reverse proxy. `pier service install`
  writes the documented service and updater units. Version checks are read-only;
  an explicit `pier update` runs backup, package install and restart in the
  updater's cgroup, never from a timer.
- Pi **SDK** over RPC; seam kept RPC-compatible (no Pi types leak out of `agent/`).
- Standalone program, not a Pi extension; Pier registers custom tools into
  the sessions it creates (task tool, step 4).
- Bundled extensions (`src/extensions/`) ship *inside* the package and load as
  Pi inline factories — nothing is ever copied into `<agentDir>/extensions`.
  A copy on disk has an owner problem: an update either clobbers the edits
  someone made to it or skips them forever. Two rules keep it honest: the
  Console's switch is an instance setting read when a session opens (so it
  reaches sessions exactly like an edited agent file, and saving recycles the
  idle ones), and a bundled extension stands down when an extension on disk
  already registers one of its tools — the user's copy wins and the journal
  says which one answered. Pier is not an extension manager: installing
  third-party extensions stays Pi's job, and this list is only what Pier
  ships.
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
