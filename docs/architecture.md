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
               chunk.ts, dedup.ts (the bounded seen-set both push transports
               need), lines.ts (what the shared control moments say),
               commands.ts (slash-command parse), control.ts,
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
               auth.ts, config.ts (scoped agent-file editing),
               fs.ts (one confined resolver, and the listing/bytes/mkdir
               routes on it), explorer.ts (what git knows about a project
               directory: refs, worktrees, diffs), session-state.ts (what
               the workbench decided about a session: unread, working set),
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
               does the downloading; `rtk` is an extension that ships as one,
               so the Console's catalog is one list with a kind, not two, and a
               custom tool is the body of its ubix block, guarded structurally
               rather than by vocabulary. `~/.pier/tools/bin` goes first on the
               PATH everything Pier spawns inherits. One sync at a time per
               machine: the whole operation runs inside a lock that is a row in
               pier.db (both processes already open it, and BEGIN IMMEDIATE is
               the mutual exclusion a lock file would have to invent), and
               because a heartbeat cannot prove a holder is dead, the holder
               re-checks that row before every step that changes anything —
               bounding an overlap to one already-started step, over a floor of
               ubix's own flock. The contract in tools.ts says what that leaves
               open and why
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
`paths.ts`, `db.ts`, `log.ts`, `secrets.ts` and `settings.ts` are the
root-leaf exceptions: every area may import them, and they import nothing
outside the root layer (`settings.ts` also names types from `core/types.ts`,
type-only), because `$PIER_HOME` is process configuration, a schema version is
one number per database, and a log line is not a seam crossing. Logging goes to
stdout/stderr only — journald owns time, history and rotation
(docs/deploy.md); `PIER_LOG=debug` adds per-message tracing, `PIER_LOG=silent`
is what test runs use.
`tools.ts` and `tools-task.ts` are instance-layer but not leaves: only
`main.ts`, `cli.ts`, `tools-task.ts` and `settings.ts` reach `tools.ts`
(managing binaries is an instance operation, and `settings.ts` takes one
function from it — what a custom tool may be — because the vocabulary it
validates against lives with the installer), and `tools-task.ts` is reachable
from `main.ts` alone. It is the one root module that imports `tasks/` (the
service type-only, `isTerminal` for a run state): the task belongs to the
instance, and a leaf that scheduled itself would be two modules.
`boards/` is the thinnest surface of all: a filesystem scan plus a static file
handler, importing neither core nor Pi.

The IM channel layer has its own living spec: `docs/design/04-im-channels.md`
covers what is shared versus platform-specific, the checklists a new adapter
follows, and the traps Telegram, Slack and Lark already paid for. Read it
before writing the next adapter.

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
  turn-settled signal an adapter retires per-turn UI on. A turn ends per
  *answer*, not per Pi run: Pi drains a message queued mid-turn inside the same
  run, so `agent/events.ts` ends the turn on the assistant message that stopped
  with nothing left to run (`turn_end`), and leaves `agent_end` the ways a run
  ends without an answer — error, abort, truncation Pi will retry. `notify` carries a
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
  model get/set/list, clearQueue, create/resume, `list`/`find` (one
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
- **Queue promotion recovery** (`core/router.ts`): manual promotion, automatic
  promotion and recall share exclusion only through queue removal, optional
  abort and submission launch, never for a whole model turn. Each promotion
  retains the original queue arrays until its submission promise settles.
  Failure before invocation is `not-submitted`; rejection after invocation is
  `uncertain`, not proof that the agent never accepted it. Failed batches stay
  outside the agent queue, visible through the existing session event stream
  and history snapshot, until explicitly acknowledged. Recovery copies exact
  individual messages without an operator prefix; it never automatically
  resends. Separate batch IDs keep later queue arrivals and late settlements
  independent. Records survive runtime eviction, but are memory-only: a process
  restart loses them. This is not a crash-durability or exactly-once guarantee.
  Unresolved recovery holds automatic promotion only: a queue event followed
  by rejection may describe the same input. Manual live-queue controls still
  work, and acknowledgement itself never launches a promotion.
  Post-invocation rejection also sets one independent, memory-only uncertainty
  hold per session. ACK removes the copy, not this hold. Only an explicit manual
  deliver/recall whose queue clear succeeds removes it; events, settlement and
  eviction cannot. The existing recovery event/snapshot carries the hold, and
  its pause notice offers recall even for an empty live queue. A later rejection
  can set the hold again. Neither a queue snapshot nor text matching proves
  whether the original input was accepted.
- **Event hub** (`core/hub.ts`): per-session monotonic `seq`, in-memory ring
  buffer (last 1000 events) for SSE replay via `Last-Event-ID`, synchronous
  fan-out to subscribers. Text deltas are fanned out but not buffered — they
  would be the only thing in the ring, and `turn-end` carries the turn's full text. No persistence — pi's session files are the durable
  record. Pi's `queue_update` is translated to a `queue-state` event at the
  seam (`agent/events.ts`), so surfaces can show what is waiting.
  The hub exposes replay coverage using the highest discarded replayable seq,
  not gaps left by live-only deltas. Web owns a per-server epoch: history
  includes `epoch` and `lastSeq`, and SSE ids / `?after` are `epoch:seq`.
  Foreign, missing or uncovered cursors receive a named `reset` event; the
  client replaces its snapshot before reconnecting. History retries up to
  three times if events arrive across async reads, then reports 503 rather
  than pairing stale content with a newer cursor. Load generations prevent
  obsolete history responses or streams from changing the selected pane.
- **Routing** (`core/router.ts`): `ConversationKey → sessionId` map, in-memory.
  Unknown conversation → create a session lazily via the injected resolver.
  Durability is the caller's business, not core's: web conversation ids already
  *are* session ids, task definitions persist their target, and IM channels
  keep `channels/conversations.ts` — without it a restart would hand every
  chat a fresh session while its visible history says otherwise. A mapping
  whose session Pi no longer has is dropped and re-created, never retried
  forever.
- **Outbound to IM channels**: on `turn-end`, core sends the turn's full text
  to the owning channel, one reply at a time per conversation — an adapter's
  send is several platform calls, and a run that ends two turns must not
  interleave two answers in the chat. IM surfaces get turn granularity; only the web
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

## Decisions

One line each; the reasoning is in the commit that made it.

- One shared password guards every HTTP surface (`web/auth.ts`); `/p/*` is the
  only exemption, so a board's `public` flag is a real boundary. Single-account
  on purpose: Pier has one workspace.
- Loopback bind, reached over a tunnel or reverse proxy. Updates run in the
  updater's own cgroup, never from a timer (`docs/deploy.md`).
- Pi **SDK** over RPC; the seam stays RPC-compatible (no Pi types leave `agent/`).
- Standalone program, not a Pi extension. Bundled extensions load as inline
  factories, never copied to disk, and stand down when a copy on disk registers
  the same tools. Pier is not an extension manager.
- Boards are directories under `$PIER_HOME/boards`, found by scanning; only
  `site/` is served; static HTML against one shipped stylesheet, no toolchain.
- Pi session files own transcripts; one SQLite database owns everything else.
  One connection opened by `db.ts`; append-only migrations in one transaction,
  upgrades only, a newer database is refused. A store owns its queries, never
  its tables or its handle. Nothing restart-relevant lives in a JSON file.
- IM chats are discovered from traffic, not registered; new chats arrive
  enabled behind the mention and bind gates.
- Telegram over raw Bot API long polling: no framework, no webhooks.
- Vite + Tailwind, static CSS, zero runtime, no UI framework.
- A subagent is a Task run in a fresh or reused session; context travels as a
  written handoff in the prompt. `fork` (copying the caller's transcript) was
  removed; stored runs with `sessionMode: "fork"` are refused by name.
- No project concept: a flat rail, a directory chosen once at creation.
- The rail never reorders itself: a working set of five on top, entered when a
  human speaks to a session; everything else by birth (`web/session-state.ts`).
- Known debt: `ChatKind` `"forum"` and `topicMode` (`channels/types.ts`) are
  Telegram facts in the shared config contract — Slack and Lark report
  `"group"` and ignore the flag. The fix is an adapter capability, taken when
  the stored contract next migrates for its own reasons.
