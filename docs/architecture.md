# Pier Architecture

The system contract: interfaces and dependency rules change here first.

## System Shape

One Node process. Channels and the web workbench feed normalized messages into
core; core routes them to Pi sessions through the agent seam; every session
emits one ordered event stream that all surfaces consume.

```
Slack / Lark                     Web workbench (browser)       Tasks
        │ Channel seam                  │ HTTP + SSE          HTTP / timer / socket
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
  core/        types.ts (the conversation seams), router.ts, hub.ts, queue.ts,
               reply.ts, identity.ts, inbox.ts, inbound-file.ts, chain.ts (the
               Pier head: the `main_chain` table, rotation, seed)
  agent/       types.ts (the Pi-config seams the Console asks for: config
               files, packages, providers, config sync, `pier web`'s auth),
               pi.ts (sessions) and packages.ts (the package registry: Pi's
               DefaultPackageManager behind `PackageStore`) — the two files
               importing @earendil-works/pi-*; events.ts
               (Pi → Pier event translation), listing.ts (on-disk sessions,
               indexed in pier.db), config.ts, config-sync.ts (the credential-blind
               configuration projection), credentials.ts (sealed store +
               auth.json import), models.ts, roles.ts (the dispatcher's,
               feature lead's and worker's contracts and the run result's,
               injected from code)
  websearch/   `pier web search|fetch` behind `POST /web`: run.ts (the two
               operations and the validator), cli.ts (argv), provider.ts
               (backend + auth over agent's `WebContext`), anthropic.ts /
               openai.ts (the hosted-tool wire formats), content.ts,
               language.ts, http.ts, json.ts, artifacts.ts (the fetched copy on disk)
  channels/    shared: types, config (store + gate), gatekeeper, chains, attach,
               chunk, dedup, lines, commands, control, conversations, receipts,
               panel, runtime, routes; per platform: slack / lark
               (+ -api, -render, -panel; slack also -outbound, -directory,
               -thread, -cli (`pier slack`) and -transcript (the one
               transcript renderer, for the CLI and the inlined thread); lark
               also -outbound)
  boards/      boards.ts (scan + manifest + static serving), pier.css
  web/         types.ts (wire shapes; the one file the browser may import),
               server.ts (sessions + events), instance.ts, vault.ts (the
               three /api/vault routes), providers.ts +
               provider-flows.ts, auth.ts, passkeys.ts (WebAuthn: CBOR/COSE,
               challenges, store, routes), config.ts (scoped agent-file
               editing), packages.ts (the package registry routes),
               config-sync.ts (the subscription's routes), route.ts (a throwing
               route answers JSON), fs.ts (confined resolver + ls/file/mkdir), explorer.ts
               (git refs, worktrees, diffs), session-state.ts (unread, working
               set), push.ts + webpush.ts (RFC 8291/8292), ui/public/sw.js,
               ui/ (form.ts + dom.ts shared vocabulary; code.ts file viewer)
  tasks/       types, outbox (delivery: proof, backoff, ceiling), definitions,
               runs, groups, agent (child-run runner), execution, callbacks,
               messages, command, service, store, open-items (main's
               markers joined to the ledger), operations (the `/task`
               route: who may ask for what, by the session's role),
               cli (`pier task`: argv → the params object over the socket),
               routes (Settings → Tasks: list, pause/resume, runs)
  main.ts      wiring only
  paths.ts     where PIER_HOME resolves, once
  lock.ts      the claim on the instance directory: one Pier per PIER_HOME
  db.ts        the one connection, and the migration list that owns the schema
  log.ts       what a log line looks like, and where it goes
  secrets.ts   layer-1 credential encryption (master.key wraps the DEK)
  vault.ts     named secrets for `pier vault run`: the vault table and its
               resolution; the value's shape is the level (sealed = auto,
               vt:// = approve); channel tokens are rows here too
               (channels/config.ts)
  socket.ts    the Unix socket (`$PIER_HOME/pier.sock`, 0600) the `pier` CLI
               reaches the running instance through — `/resolve`, `/task`, `/web`, `/login` —
               every request naming its session; the bits are the auth
  settings.ts  instance facts a human owns (public URL, model menu, title
               model, the auto-update switch, which of the built-in `pier`
               package's resources are on, tools, custom tools, accent)
  update.ts    whether a newer release exists and when this instance may become
               it; the install is handed to service.ts's unit
  stop.ts      stop sequence and in-flight ledger (`turns_in_flight`,
               `restart_ledger`)
  cli.ts       what `pier` does when typed; service.ts is the unit it writes;
               `pier slack` is dispatched to channels/slack-cli.ts with the
               token resolved here (env, or the CLI socket), `pier task` to
               tasks/cli.ts with the socket request, `pier web` to
               websearch/cli.ts; `pier vault run` and `pier login` are its own
  tools.ts     managed CLI binaries via ubix (install, update, PATH); a tool
               that registers with Pi does so from its block's `post_install` /
               `pre_remove` hooks, which ubix runs (rtk writes its extension);
               a custom tool is the body of its ubix block. `~/.pier/tools/bin`
               goes first on the PATH everything Pier spawns inherits; at start
               Pier writes a `pier` shim there that execs its own cli (same
               node, same loader), so `pier vault run`/`pier slack`/`pier task`
               are the running build. One sync per machine: a lock row in
               pier.db (BEGIN IMMEDIATE), re-checked before every mutating step
  tools-task.ts a tools switch becomes exactly one run of the one task Pier
               owns, coalescing a burst of switches into a single run
  service.ts   the systemd units `pier service install` writes
  config-sync.ts the configuration subscription: fetch (HTTPS, 1 MiB cap),
               the schema-version gate, apply as one transaction
  config-sync-task.ts the hourly task that subscription owns
```

Dependency rules:

- `channels | web | tasks | boards | websearch → core → agent`. Core never imports platform
  SDKs or Pi; runtime dependencies never go sideways.
- `agent/types.ts` imports no SDK and no `node:*`; any area may import it.
- `websearch/` imports no SDK: it speaks Messages/Responses itself over the
  `WebAuth` seam (`agent/types.ts`), which `agent/pi.ts` implements with
  Pi's `ModelRegistry`; `main.ts` joins the two on the `/web` socket route.
- `agent/packages.ts` is the second SDK-importing file in `agent/` because the
  registry is a second reason: `pi.ts` opens sessions, `packages.ts` changes
  what they open with. Nothing else imports `DefaultPackageManager` or
  `SettingsManager`.
- The browser may import HTTP DTOs from `tasks/types.ts`, `channels/types.ts`
  and `web/types.ts` type-only.
- `web/server.ts` may import `tasks/types.ts` type-only, for the DTOs it
  serves from a callback `main.ts` injects.
- Root leaves `paths.ts`, `db.ts`, `log.ts`, `secrets.ts`, `settings.ts`,
  `vault.ts`: every area may import them; they import nothing outside the root
  layer (`settings.ts` imports `core/types.ts`, the browser-safe vocabulary).
- Logging goes to stdout/stderr only (docs/deploy.md). `PIER_LOG=debug` adds
  per-message tracing; `PIER_LOG=silent` is what test runs use.
- `tools.ts` is reached only by `main.ts`, `cli.ts`, `tools-task.ts` and
  `settings.ts` (one function: what a custom tool may be). `tools-task.ts` and
  `config-sync-task.ts` are reachable from `main.ts` alone and are the root
  modules besides it importing `tasks/` (the service type-only, `isTerminal`).
- `boards/` imports neither core nor Pi.

The IM channel layer's spec is `docs/design/04-im-channels.md`.

### Markdown is repaired once, at the seam

`splitReply()` normalizes the agent's markdown for every surface: it strips
`<silent>` blocks and runs `cjkFriendly()`, which repairs `**strong**` runs that
CommonMark refuses to close when a delimiter sits against punctuation next to a
CJK character. Never per adapter.

## Core Types

`src/core/types.ts` (the conversation) and `src/agent/types.ts` (the Pi
config the Console asks for) are the normative contract; this doc does not
mirror them. The seams:

- `Channel` — platform ↔ core: `start(onMessage)`, `send(conversationId,
  reply)`, `notify(conversationId, note)`, `stop()`. One implementation per
  platform. `AgentReply` is markdown plus next-step labels (`core/reply.ts`
  parses the trailing `---\n[a] | [b]` block once) plus the turn's `TurnMeta`
  (a footer on surfaces without hover). `send` is called on **every** turn-end,
  empty text included. A turn ends per *answer*, not per Pi run:
  `agent/events.ts` ends it on the assistant message that stopped with nothing
  left to run (`turn_end`); `agent_end` covers error, abort, and truncation Pi
  will retry. `notify` carries a persisted `system-input` (delegation, task
  callback, supervisor message) or a service/error note.
- Chat commands are parsed by `channels/commands.ts` (`parseCommand`) and, for
  the head, `core/chain.ts` (`chatCommand`): trim both ends, a leading `/` or
  `%`, args verbatim ([11 §Chat commands](design/11-im-conversation.md#chat-commands)).
  Control that is not a prompt (`/stop`) goes through `ChannelControl`
  (`channels/control.ts`, built in `main.ts`, handed to each adapter by
  `channels/runtime.ts`) — the `Channel` seam has one inbound path.
- `AgentSession` / `AgentFactory` — core ↔ Pi: prompt/steer/followUp (text
  only — an inbound file is saved to `$PIER_HOME/inbox/` by the receiving
  surface and rides the prompt as a `[name](file:///…)` line; bytes in
  `core/inbox.ts`, grammar in `core/inbound-file.ts`), persisted system input,
  abort, history, model get/set/list, clearQueue, create/resume,
  `list`/`find`/`readHistory`, and a payload-only `subscribe`. Must stay
  implementable over RPC.
- `SessionEventPayload` — the only observability currency: turn/text/thinking/
  tool events, persisted `system-input`, linked `task-status`, state and queue
  snapshots, and errors. Delegation, callback, steer and supervisor-message
  provenance survives transcript replay (Pi custom messages). The hub stamps
  `seq`/`ts`/`sessionId`.
- Pi → Pier event translation lives in `src/agent/events.ts` with golden-table
  tests; changing a mapping is a design decision.
- `PackageStore` — Console ↔ Pi's package registry: `list` (every package with
  its resources and switch state, the project scope as view when a `cwd` is
  given), `install`, `remove`, `update` (global scope, answering when done;
  Pi's progress steps are logged at the seam), `setEnabled`, `checkUpdates`.
  One package operation at a time, named by `busy`; refusals are a
  `PackageError` with a reason the route maps to a status. Wire shapes and
  rules: `docs/design/03-web-workbench.md`.

## Fixed Behavioral Rules

- **Queue policy** (`core/queue.ts`): `mode:"auto"` → if session idle,
  `prompt`; if streaming, `followUp`. On auto, text starting with `!` → strip
  the prefix and `steer` (idle: prompt — the prefix is consumed either way).
  Explicit `mode` always wins and takes the text verbatim: IM sends steer for
  every message, so a `!` there is content. This is the whole policy; do not
  add options.
- **Queue promotion** (`core/router.ts`): manual, automatic and recall
  exclude each other only for the queue clear, optional abort and submission
  launch — never for a whole turn. A failed promotion reports the error with
  the original text to the conversation (`reportTo`) and keeps nothing.
- **Event hub** (`core/hub.ts`): per-session monotonic `seq`, in-memory ring
  buffer (last 1000 events) for SSE replay via `Last-Event-ID`, synchronous
  fan-out. Text deltas are fanned out but not buffered; `turn-end` carries the
  full text. No persistence — Pi's session files are the record. Pi's
  `queue_update` becomes `queue-state` at the seam. Replay coverage is the
  highest discarded replayable seq. Web owns a per-server epoch: history carries
  `epoch` and `lastSeq`; SSE ids / `?after` are `epoch:seq`; foreign, missing
  or uncovered cursors get a named `reset` event. History retries up to three
  times if events arrive across async reads, then 503.
- **Routing** (`core/router.ts`): `ConversationKey → sessionId` map, in-memory.
  Unknown conversation → create a session lazily via the injected resolver.
  One live `AgentSession` per session id: an IM key is looked up to its
  session id (injected `sessionIdOf`) before opening, so a chat and the
  `web:`/`task:` aliases share one lock and attach to one object; the chat is
  the delivery key whenever it is attached, and an alias opening a session
  whose durable chat is known (injected `chatKeyOf`) attaches that chat at
  once. Durability is the caller's: web conversation ids *are* session ids,
  task definitions persist their target, IM channels keep
  `channels/conversations.ts`. A mapping whose session Pi no longer has is
  dropped and re-created, never retried forever
  ([04](design/04-im-channels.md#conversation-identity)). The continuous
  conversation (`core/chain.ts`) resolves its head, rotating first when due,
  and dispatches to the head's own `web:` key, or the home chat's key for a
  message from it ([11](design/11-im-conversation.md)); the router knows nothing of it.
- **Outbound to IM channels**: on `turn-end`, core sends the turn's full text
  to the owning channel, one reply at a time per conversation. Only the web
  gets deltas; reasoning and tool events never leave core for IM. Adapters
  react 👀 on each message that entered the turn and clear them when it settles;
  the pending set is durable (`channels/receipts.ts`), cleared at startup and
  swept past 10 minutes unless the conversation is still working.
- **IM permission policy** (`channels/config.ts`): one persisted JSON document
  per platform: token, platform-level seed values, bound users, discovered
  chats. `requireMention` and `requireBind` default to true; a new chat
  *copies* the platform values once — no runtime inheritance. `gate()` is the
  whole inbound decision; denials are silent.
- **IM inbound is `mode: "steer"`.**
- **Errors**: a malformed inbound message is logged and dropped at the seam.
  Agent errors surface as `error` events, never as thrown exceptions across
  a seam.

## Decisions

One line each; the reasoning is in the commit that made it.

- One shared password guards every HTTP surface (`web/auth.ts`); the exemptions
  are `/p/*`, so a board's `public` flag is a real boundary, `/b/*` (the signed
  8-hour prefix `/boards/*` redirects to, so no board page is ever served on a
  cookie-authorized URL, `design/05-boards.md`), the two passkey
  login routes (`web/passkeys.ts`, on the password's throttle), `/login/:token`
  (the one-time link `pier login` mints over the CLI socket, same throttle) and
  `/config-sync/:token`, guarded by its token. Single-account on purpose: Pier
  has one workspace; a registered passkey replaces the password rather than
  joining it.
- Loopback bind, reached over a tunnel or reverse proxy. Updates run in the
  updater's own cgroup, never from a timer (`docs/deploy.md`).
- Pi **SDK** over RPC; the seam stays RPC-compatible (no Pi types leave `agent/`).
- Standalone program, not a Pi extension. Pier is the Console over Pi's
  package manager: one registry (settings.json `packages` plus Pi's local
  `extensions`/`skills` dirs), Pier writes it, never a second list; Pier
  ships no extension of its own — its tools are CLIs (`pier slack`, `pier
  task`, `pier web`) documented by skills, so no tool schema rides in context.
- Boards are directories under `$PIER_HOME/boards`, found by scanning; only
  `site/` is served; static HTML against one shipped stylesheet, no toolchain.
- **One writer per instance directory**, enforced before the database opens:
  `$PIER_HOME/pier.lock`, a pid file hard-linked into place from a private
  file so it is never seen empty, held for the process's lifetime, taken over
  only when that pid is gone — moved aside, never unlinked in place, and only
  by the process that read it (`lock.ts`). A
  second `pier serve` names the holder and exits 1 whatever port it was given;
  the other commands claim nothing, since they run while Pier is up.
- Pi session files own transcripts; one SQLite database owns everything else.
  One connection opened by `db.ts`; append-only migrations in one transaction,
  upgrades only, a newer database is refused. A store owns its queries, never
  its tables or its handle. `turns_in_flight` records running turns for restart
  resumption; `task_runs` records running runs.
- IM chats are discovered from traffic, not registered; new chats arrive
  enabled behind the mention and bind gates.
- Vite + Tailwind, static CSS, zero runtime, no UI framework.
- A subagent is a Task run in a fresh or reused session; context travels as a
  written handoff in the prompt. `fork` was removed; stored runs with
  `sessionMode: "fork"` are refused by name.
- No project concept: a session's directory is chosen once, by whoever creates it.
- The session list never reorders itself: every session by birth; the store keeps only
  the unread mark (`web/session-state.ts`).
