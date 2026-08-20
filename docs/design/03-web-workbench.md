# Design 03 — Web Workbench v1

Goal: browser surface for chat + live observability. Proves steering, queued
messages, and the event stream end to end. This is a consumer of core; it
contains no agent logic.

## Backend (`src/web/server.ts`, Hono, ≤ 300 lines)

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` + live state from router |
| `POST /api/sessions` | body `{cwd?}` → create session, returns `{id}` |
| `POST /api/sessions/:id/messages` | body `{text, mode}` (`mode` defaults `auto`) → build `InboundMessage` with `key={channelId:"web", conversationId:id}`, hand to core router. Returns 202 immediately. |
| `POST /api/sessions/:id/abort` | abort the session |
| `GET /api/sessions/:id/events` | SSE. `id:` = event `seq`; on `Last-Event-ID`, replay from hub ring buffer, then live. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` |

The web surface implements `Channel` only if it falls out naturally; do not
force it — SSE already delivers outbound content, so `send()` may be a no-op.

## Frontend (`src/web/public/`, Vite + vanilla TS, no framework)

Single page, three panes:

- **Session list** (left): sessions with state dot (idle/streaming), click to
  switch, "New session" button.
- **Chat** (center): rendered turns; streaming text appended from
  `text-delta`. Input box: Enter sends `mode:"auto"`; `!` prefix works via
  queue policy; explicit "Steer" and "Queue" buttons send `mode:"steer"` /
  `"followUp"`. When the session is streaming, show which mode a send will use.
- **Timeline** (right): raw observability. One row per event: tool calls with
  name/args/collapsed output, thinking deltas collapsed, state changes,
  queued messages. This pane renders EVERY SessionEvent — it is the "what is
  the agent doing right now" view.

Keep it plain: one `.ts` entry, one `.css`, EventSource + fetch. No state
library, no router, no components framework. Third repeat rule applies before
introducing any abstraction.

## Rules

- All data arrives via the SSE event stream; the frontend never polls except
  the initial session list.
- Reconnect: EventSource auto-reconnect + `Last-Event-ID` replay must survive
  a server restart gap without duplicating rendered events (dedupe by seq).
- No markdown-rendering dependency in v1; render text pre-wrap. (Revisit later.)

## Tests

- Backend: vitest + a fake `AgentFactory`/`AgentSession` (scripted event
  emitter). Cover: message → router → session call; SSE replay from
  `Last-Event-ID`; abort route.
- Frontend: none in v1 beyond typecheck; manual sanity per AGENTS.md.

## Acceptance

- Two browser tabs on one session see identical timelines (fan-out works).
- While a long turn streams: plain send queues (`queued` event visible),
  `!text` visibly interrupts the run.
- Kill/restart server, tab reconnects and replays without duplicates.
