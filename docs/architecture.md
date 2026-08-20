# Pier Architecture

This document is the system contract. Module implementers must not deviate
from the interfaces and dependency rules here; changing them is a design
decision that happens in this file first, code second.

## System Shape

One Node process. Channels and the web workbench feed normalized messages
into core; core routes them to Pi sessions through the agent seam; every
session emits one ordered event stream that all surfaces consume.

```
Slack / Telegram / Lark          Web workbench (browser)
        │ Channel seam                  │ HTTP + SSE
        ▼                               ▼
┌─────────────────────── core ───────────────────────┐
│ router (conversation → session)                    │
│ queue policy (idle→prompt, busy→steer/followUp)    │
│ event hub (per-session buffer + fan-out)           │
│ scheduler (cron → prompt)            [step 5]      │
└──────────────────────┬─────────────────────────────┘
                       │ AgentSession seam
                       ▼
                agent/ (Pi SDK)
```

## Directory Layout

```
src/
  core/        types.ts, router.ts, hub.ts, queue.ts
  agent/       pi.ts (the ONLY file importing @earendil-works/pi-*)
  channels/    telegram.ts, slack.ts, lark.ts   [step 4+]
  web/         server.ts, static frontend       [step 3]
  tasks/       scheduler.ts, task tool          [step 5]
  main.ts      wiring only
```

Dependency direction: `channels | web | tasks → core → agent`. Core never
imports platform SDKs or Pi. Nothing imports sideways between channels.

## Core Types

`src/core/types.ts` is the normative contract — the file itself is the source
of truth (this doc stopped mirroring it to avoid drift). The seams:

- `Channel` — platform ↔ core: `start(onMessage)`, `send(conversationId,
  markdown)`, `stop()`. One implementation per platform.
- `AgentSession` / `AgentFactory` — core ↔ Pi: prompt/steer/followUp (all
  accept optional image attachments), abort, history, model get/set/list,
  clearQueue, and a payload-only `subscribe`. Must stay implementable over RPC.
- `SessionEventPayload` — the only observability currency: turn/text/thinking/
  tool events, `state`, `queued`, `queue-state` snapshots, `error`. The hub
  stamps `seq`/`ts`/`sessionId`.
- Pi → Pier event translation lives in `src/agent/events.ts` with golden-table
  tests; changing a mapping is a design decision.

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
- **Routing** (`core/router.ts`): `ConversationKey → sessionId` map, in-memory
  for v1 (moves to SQLite with the scheduler). Unknown conversation → create a
  session lazily via `AgentFactory`.
- **Outbound to IM channels**: on `turn-end`, core sends the turn's full text
  to the owning channel. IM surfaces get turn granularity; only the web
  workbench gets deltas.
- **Errors**: a malformed inbound message is logged and dropped at the seam.
  Agent errors surface as `error` events, never as thrown exceptions across
  a seam.

## Decisions Log

- Pi **SDK** over RPC; seam kept RPC-compatible (no Pi types leak out of `agent/`).
- Standalone program, not a Pi extension; Pier registers custom tools into
  the sessions it creates (task tool, step 5).
- Web workbench before IM channels (fastest loop for steering/observability).
- Show pages: static HTML + optional SSE reload; Pi `export_html` for replay.
- Persistence: pi session files now; one SQLite db arrives with step 5.
- Frontend build: Vite + Tailwind (static CSS, zero runtime). Adopted early by
  explicit decision instead of the original no-bundler plan; still no UI
  framework until componentization is needed.
- Projects are derived, not registered: a project is a distinct session cwd.
  No project store exists; the sidebar groups by cwd and the new-session
  dialog suggests known cwds. A real registry only arrives if derivation
  proves insufficient.
