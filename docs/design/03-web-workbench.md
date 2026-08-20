# Web Workbench (living spec)

Browser surface for chat + live observability: a consumer of core over
REST + SSE, no agent logic. Kept current as the workbench evolves.

## Backend (`src/web/server.ts`, Hono, ≤ 300 lines)

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` + live state from router + `pinned` from the pin store |
| `POST /api/sessions` | body `{cwd?}` → create session (auto-pinned), returns `{id}` |
| `POST /api/sessions/:id/pin` | body `{pinned}` → add/remove from Projects, returns `{pinned}` |
| `GET /api/sessions/:id/history` | session **snapshot**: resume/attach on demand via `router.ensure`, returns `{turns, lastSeq, model, state, context, queue, backgroundRuns}`; 404 if unknown |
| `GET /api/sessions/:id/models` | available models (auth-configured) for the session |
| `POST /api/sessions/:id/model` | body `{provider, id}` → switch model, returns `{model}` |
| `POST /api/sessions/:id/messages` | body `{text, mode, images?}` (`mode` defaults `auto`; images = base64 `{data, mimeType}`, max 8 × 8MB, validated at the seam; text or images required) → build `InboundMessage` with `key={channelId:"web", conversationId:id}`, hand to core router. Returns 202 immediately. |
| `GET /api/sessions/:id/images/:ordinal` | bytes of the ordinal-th transcript image (`content-type` from the message), 404 past the end |
| `POST /api/sessions/:id/abort` | abort the current run |
| `POST /api/sessions/:id/queue/deliver` | body `{mode:"steer"\|"restart"}` → clear the queue and re-dispatch it: steer into the running turn, or abort the turn and send as a fresh prompt. 202 with `{delivered}`, 409 if the queue is empty |
| `POST /api/sessions/:id/queue/recall` | clear pending queue, returns `{messages}` for composer restore |
| `GET /api/activity` | Active or last-hour sessions, task runs, and Subagent control/supervisor message edges for Console Activity |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. |
| `GET /api/sessions/:id/events` | SSE. `id:` = event `seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `lastSeq` from history), then live. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` |

The web surface implements `Channel` only if it falls out naturally; do not
force it — SSE already delivers outbound content, so `send()` may be a no-op.

## Frontend (`src/web/ui/`, Vite + Tailwind, vanilla TS, no framework)

`src/web/ui/` (index.html + main.ts + style.css) builds via Vite to
`src/web/public/` (gitignored). Tailwind utilities carry the styling; the only
custom classes are `.btn`/`.btn-primary`. `npm run dev:web` gives HMR with an
`/api` proxy to :3141. `tsconfig.web.json` stays as the typecheck gate.

Single page, with chat plus Console views (the raw timeline pane was folded into
per-turn Activity groups):

- **Projects** (left): only *pinned* sessions, grouped by project (derived from
  session cwd). Sessions created in Pier are pinned automatically; everything
  else stays out of the sidebar. Each project is a collapsible group (collapse
  state in `localStorage`) whose header shows the session count, or a green dot
  while any of its sessions stream; rows carry a state dot, relative time and a
  hover `⋯` opening the session menu. The section header carries the only two
  sidebar actions as icons (avibe layout): search → All sessions, plus → the
  "New session" dialog with cwd input + known-project suggestions.
- **All sessions** (search icon → modal): everything `AgentFactory.list()`
  knows about, searchable over title + cwd, grouped by project, each row with a
  pin toggle; click opens the session. Pins are the only UI-owned persisted
  state — a plain id array in `$PIER_HOME|~/.pier/pins.json` (`src/web/pins.ts`),
  outside the seams, injected into `createServer` so tests stay hermetic.
- **Snapshot then deltas**: the stream carries deltas only, so a fresh client
  starts from `/history` — transcript (including each assistant turn's `steps`,
  the thinking/tool activity rebuilt from the Pi transcript), run `state` and
  pending `queue` — then applies SSE events after `lastSeq`. Nothing about a
  session's state is defaulted client-side; a reload shows real step counts and
  the correct composer buttons.
- **Chat header**: title and the `⋯` session menu — nothing else; details live
  in the menu instead of taking permanent header space.
- **Session menu** (`menu.ts`): one anchored popover primitive, one open at a
  time, closed by outside pointerdown / Esc / page scroll (scrolling *inside*
  the panel does not close it). Opened from the chat header and from project
  rows; holds session info (title, cwd, id, model, context usage from the
  snapshot), pin-to-Projects and the model picker. `model-picker.ts` is the
  standalone grouped-by-provider list, groups collapsed except the one holding
  the current model — separate because model choice will also be needed outside
  chat (scheduled tasks).
- **Console Activity**: active Session table plus a directed task dependency
  graph. Invocation edges are solid, callbacks dashed, and Subagent control or
  supervisor messages dotted; Session nodes
  open chat and edges open Tasks. Active and last-hour scopes share the same
  task-run records.
- **Task communication**: detached task calls create live Background Run rows in
  the invoking chat, updated in place from `task-status` session events. Agent
  delegation and callback inputs are persisted Pi custom messages rendered as
  distinct System input rows with source Session and Run links, never as user
  messages. Snapshot `backgroundRuns` restores recent detached work.
- **Chat** (center): Slack-style full-width rows, no bubbles — user turns
  carry an indigo accent bar + tint, agent turns stay plain; consecutive
  same-sender rows group tighter. Agent rows show a hover meta chip
  (completion time · duration · cumulative tokens) from `turn-end.meta` /
  history `meta`. Streaming text appended from `text-delta`. Composer semantics: **Send** = `mode:"auto"` (idle starts a
  turn; streaming queues as follow-up), **Send now** = `mode:"steer"`
  (streaming only), **Stop** = abort (streaming only). Enter sends; Enter
  during IME composition never sends (`isComposing`/229 guard). A pending
  **queue panel** above the composer renders `queue-state` snapshots with
  mode chips and three actions on the whole queue: **Send now** (steer it into
  the running turn), **Abort & send** (stop the turn, send it as a new prompt)
  and **Recall all** (clear it back into the composer — append, never clobber
  the draft). Multiple queued messages are joined with newlines. When the agent
  actually picks a queued message up, the seam's `user-message` event renders it
  as a real user turn; own sends render optimistically and reconcile against
  that event by text instead of drawing twice.
- **Activity groups** (in-chat): one collapsible group per turn collects
  thinking + tool activity (avibe AgentActivityGroup concept): status icon
  (spinner/✓/✕/⏸) + rotating chevron, step count, duration, latest step in
  the headline while running. Each step is its own expandable details row:
  tool rows reveal full args + output pre blocks; the thinking row shows its
  latest line collapsed and the full (tail-capped) text expanded.
  Idle-without-turn-end marks the group interrupted.
- **Images**: paste, drag-drop, or attach via the `+` button → pending
  thumbnail strip (removable) above the composer; sent as base64 attachments
  and rendered in the optimistic user row. History carries image *refs*
  (`{mimeType, ordinal}`); each thumbnail lazily pulls its bytes from
  `/api/sessions/:id/images/:ordinal` and opens full size in a lightbox.
  IM channels still get the `[n images]` text marker.
- Auto-scroll sticks to the bottom only when the user is already near it;
  own sends force-scroll.

Keep it plain: one `.ts` entry, one `.css`, EventSource + fetch. No state
library, no router, no components framework. Third repeat rule applies before
introducing any abstraction.

Selecting a session loads `/history` first (renders completed turns), then
opens the SSE stream with `?after=lastSeq` so replayed ring-buffer events
never duplicate history.

## Rules

- All data arrives via the SSE event streams (workspace + per session); the
  frontend never polls. Multi-client sync needs no duplex channel: commands go
  out over REST, everything else comes back on the streams, so every open tab
  shows the same lists, run states and transcripts.
- Reconnect: EventSource auto-reconnect + `Last-Event-ID` replay must survive
  a server restart gap without duplicating rendered events (dedupe by seq).
- Assistant content renders as markdown (`marked` + DOMPurify sanitization,
  `@tailwindcss/typography` for prose styling). Streamed text stays plain
  while in flight and is markdown-rendered when the block finalizes
  (tool-start or turn-end). User/error rows stay plain text.

## Tests

- Backend: vitest + a fake `AgentFactory`/`AgentSession` (scripted event
  emitter). Cover: message → router → session call; SSE replay from
  `Last-Event-ID`; abort route.
- Frontend: none in v1 beyond typecheck; manual sanity per AGENTS.md.

## Acceptance

- Two browser tabs on one session see identical timelines (fan-out works).
- While a long turn streams: plain send queues (queue panel updates via `queue-state`),
  `!text` visibly interrupts the run.
- Kill/restart server, tab reconnects and replays without duplicates.
