# Design 03 — Web Workbench v1

Goal: browser surface for chat + live observability. Proves steering, queued
messages, and the event stream end to end. This is a consumer of core; it
contains no agent logic.

## Backend (`src/web/server.ts`, Hono, ≤ 300 lines)

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` + live state from router |
| `POST /api/sessions` | body `{cwd?}` → create session, returns `{id}` |
| `GET /api/sessions/:id/history` | resume/attach on demand via `router.ensure`, returns `{turns, lastSeq, model}`; 404 if unknown |
| `GET /api/sessions/:id/models` | available models (auth-configured) for the session |
| `POST /api/sessions/:id/model` | body `{provider, id}` → switch model, returns `{model}` |
| `POST /api/sessions/:id/messages` | body `{text, mode}` (`mode` defaults `auto`) → build `InboundMessage` with `key={channelId:"web", conversationId:id}`, hand to core router. Returns 202 immediately. |
| `POST /api/sessions/:id/abort` | abort the session |
| `GET /api/sessions/:id/events` | SSE. `id:` = event `seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `lastSeq` from history), then live. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` |

The web surface implements `Channel` only if it falls out naturally; do not
force it — SSE already delivers outbound content, so `send()` may be a no-op.

## Frontend (`src/web/ui/`, Vite + Tailwind, vanilla TS, no framework)

`src/web/ui/` (index.html + main.ts + style.css) builds via Vite to
`src/web/public/` (gitignored). Tailwind utilities carry the styling; the only
custom classes are `.btn`/`.btn-primary`. `npm run dev:web` gives HMR with an
`/api` proxy to :3141. `tsconfig.web.json` stays as the typecheck gate.

Single page, two panes (the raw timeline pane was folded into per-turn
Activity groups):

- **Session list** (left): grouped by project (derived from session cwd),
  rows with state dot (idle/streaming) and relative time, click to switch,
  "New session" dialog with cwd input + known-project suggestions.
- **Chat header**: title, cwd, model picker (switches the session's model),
  state badge, abort while streaming.
- **Chat** (center): rendered turns; streaming text appended from
  `text-delta`. Input box: Enter sends `mode:"auto"`; `!` prefix works via
  queue policy; explicit "Steer" and "Queue" buttons send `mode:"steer"` /
  `"followUp"`. When the session is streaming, show which mode a send will use.
- **Activity groups** (in-chat): one collapsible bubble per turn collects
  thinking + tool activity (avibe AgentActivityGroup concept): status
  (running/done/failed/interrupted), step count, duration, latest step in the
  headline while running; expandable rows show tool name/args with output on
  hover. Idle-without-turn-end marks the group interrupted.
- Auto-scroll sticks to the bottom only when the user is already near it;
  own sends force-scroll.

Keep it plain: one `.ts` entry, one `.css`, EventSource + fetch. No state
library, no router, no components framework. Third repeat rule applies before
introducing any abstraction.

Selecting a session loads `/history` first (renders completed turns), then
opens the SSE stream with `?after=lastSeq` so replayed ring-buffer events
never duplicate history.

## Rules

- All data arrives via the SSE event stream; the frontend never polls except
  the initial session list.
- Reconnect: EventSource auto-reconnect + `Last-Event-ID` replay must survive
  a server restart gap without duplicating rendered events (dedupe by seq).
- Assistant content renders as markdown (`marked` + DOMPurify sanitization,
  `@tailwindcss/typography` for prose styling). Streamed text stays plain
  while in flight and is markdown-rendered when the block finalizes
  (tool-start or turn-end). User/queued/error bubbles stay plain text.

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
