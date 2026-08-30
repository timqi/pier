# Web Workbench (living spec)

Browser surface for chat + live observability: a consumer of core over
REST + SSE, no agent logic. Kept current as the workbench evolves.

## Backend (`src/web/server.ts`, Hono)

`server.ts` is the session half only — sessions, turns, queue, SSE and the
static frontend. Every other surface owns its own routes and is mounted beside
it; the file is a route table, and logic appearing in a row is the thing to
catch, not the line count.

| Route | Behavior |
| ----- | -------- |
| `POST /api/projects/order` | body `{sessions?, projects?}` (lists of ids) → the sidebar's two manual orders, the only ones the UI owns |
| `GET /api/sessions` | `AgentFactory.list()` + live state from router + `listed`/`unread` from the pin store (`listed` = pinned: membership ends when a hand ends it, nothing expires) |
| `GET /api/projects` | the same rows, filtered to `listed` — the rail reads no second store |
| `POST /api/sessions` | body `{cwd?}` → create session (auto-pinned), returns `{id}` |
| `POST /api/sessions/:id/pin` | body `{pinned}` → add/remove from Projects, returns `{pinned}`; the directory it records comes from the listing, 404 when nothing can place the session |
| `POST /api/sessions/:id/rename` | body `{name}` → append the name to the session's transcript (empty clears it), returns `{ok}`; the new title reaches every surface as a `sessions-changed` re-read |
| `POST /api/sessions/:id/read` | mark the session's last finished turn seen; clears the unread dot on every client |
| `POST /api/sessions/:id/turns/:index/edit` | body `{text}` → rewind to that user turn and re-dispatch the new text; 409 while streaming |
| `GET /api/sessions/:id/history` | session **snapshot**: resume/attach on demand via `router.ensure`, returns `{turns, lastSeq, model, state, context, queue, backgroundRuns}`; 404 if unknown. Compressed, like the steps route below — a long transcript is the one large answer here |
| `GET /api/sessions/:id/turns/:index/steps` | one finished turn's thinking/tool steps, fetched when its Activity group is opened rather than shipped with the snapshot |
| `GET /api/sessions/:id/models` | available models (auth-configured) for the session |
| `GET /api/models` | the same list without a session, for pickers |
| `POST /api/sessions/:id/model` | body `{provider, id}` → switch model, returns `{model}` |
| `GET/POST /api/sessions/:id/thinking` | read or set the reasoning level (history also carries `thinkingLevel`) |
| `POST /api/sessions/:id/messages` | body `{text, mode}` (`mode` defaults `auto`; non-blank text required — attachments were already uploaded and ride the text as marker lines) → build `InboundMessage` with `key={channelId:"web", conversationId:id}`, hand to core router. Returns 202 immediately. |
| `POST /api/inbox` | body `{name?, mimeType, data}` (base64, ≤32MB) → saved via `core/inbox.ts` under `$PIER_HOME/inbox/web/`, returns `{path}`; the client appends `[name](file:///path)` to the message it then sends |
| `POST /api/sessions/:id/abort` | abort the current run |
| `POST /api/sessions/:id/queue/deliver` | body `{mode:"steer"\|"restart"}` → clear the queue and re-dispatch it: steer into the running turn, or abort the turn and send as a fresh prompt. 202 with `{delivered}`, 409 if the queue is empty |
| `POST /api/sessions/:id/queue/recall` | clear pending queue, returns `{messages}` for composer restore |
| `POST /api/sessions/:id/compact` | compact the transcript now (the ⋯ menu). 202 when it starts; 409 while a turn runs, and 409 again when the seam says it is already compacting — relayed as itself, not flattened to a 404. The one system line it leaves in the transcript is the only trace a compaction leaves anywhere (§5b), automatic ones included |
| `POST /api/reload` | `pier reload` from the Console: re-read channel configuration, then let go of idle sessions (watched included) so the next message opens them with the current agent files, skills and credentials. Returns `{recycled, busy}` — `busy` counts the sessions mid-turn that keep what they opened with. 500 when the adapters could not be re-read. |
| `GET /api/activity` | *(served by `tasks/routes.ts`, drawn by the Console)* active or last-24h sessions, task runs, and Subagent control/supervisor message edges |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. |
| `GET /api/sessions/:id/events` | SSE. `id:` = event `seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `lastSeq` from history), then live. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` (`/sw.js` is served `no-cache`: a cached worker is a released fix that never ships) |

The other route owners, each a file with one reason to exist — the routes
themselves live there and are not mirrored here:
`auth.ts` (the password boundary ahead of everything, `/login`, `/logout`,
`/api/password`), `files.ts` (`/api/config*` scoped Pi config editing,
`/api/fs/dirs` for the cwd pickers, `/api/sessions/:id/files`), `explorer.ts`
(`/api/explorer/{ls,file,git,diff}` for the Files view, read-only),
`terminal.ts` (`/api/terminal`, the one WebSocket upgrade), `instance.ts`
(`/api/settings`, `/api/update`, `/api/secrets*`, `/api/client-log`),
`providers.ts` + `provider-flows.ts` (`/api/providers*`, including the probe
that sends one real request), `push.ts` (below), `tasks/routes.ts` and
`channels/routes.ts` (their own areas), `boards/boards.ts` (`/boards/*`,
`/p/*`).

## Notifications (`src/web/push.ts` + `src/web/webpush.ts`)

Web Push, so a finished turn reaches a workbench nobody has open — Chrome and
Edge on desktop, and iOS/iPadOS 16.4+ once Pier is on the Home Screen (Apple
grants push only to the installed app). Composed in `main.ts` beside the other
surfaces, not inside `server.ts`: it is a second, independent consumer of the
same event stream.

| Route | Behavior |
| ----- | -------- |
| `GET /api/push` | `{publicKey}` — the instance's VAPID public key, what a browser subscribes with |
| `POST /api/push/subscribe` | a `PushSubscription` (`{endpoint, keys:{p256dh, auth}, label}`) → stored; upsert, so a browser re-posting on every load repairs a lost row. 400 on anything that is not one |
| `POST /api/push/unsubscribe` | body `{endpoint}` → forgotten |
| `POST /api/push/test` | send a test notification to every subscribed device, `{sent, failed}`; 409 when none is subscribed |

- **The rule is the unread dot, read late.** `streaming → idle` starts a settle
  window (6s); if the session is *still* unread when it closes, nobody was
  looking and a notification goes out. A second notion of attention would drift
  from the dot within a release.
- **Only the workbench's own sessions.** A turn answering a Slack, Telegram or
  Lark conversation was already delivered there (`router.conversationOf(id)`
  names the channel); notifying about it too is the same reply twice on the
  same phone.
- **The wire format is `webpush.ts` and nothing else** — RFC 8291 `aes128gcm`
  encryption and RFC 8292 VAPID authorization on `node:crypto`, with the RFC's
  own worked example as the golden test. No dependency: the format is one ECDH,
  two HKDFs, one AES-GCM record and a JWT.
- **Only 404/410 costs a subscription.** Every other failure is logged with what
  the push service said; a notification that never arrives must not look like
  one nobody tapped (principle 5b).
- **`sw.js` caches nothing.** The shell revalidates on every navigation and the
  bundles are content-hashed; its one `fetch` handler is a navigation fallback
  so an offline tap on the app icon says who is unreachable.
- **The keys are per instance.** One VAPID key pair, minted on first use, never
  rotated on its own — every live subscription is bound to it.

The web surface implements `Channel` only if it falls out naturally; do not
force it — SSE already delivers outbound content, so `send()` may be a no-op.

## Frontend (`src/web/ui/`, Vite + Tailwind, vanilla TS, no framework)

`src/web/ui/` (index.html + main.ts + style.css) builds via Vite to
`src/web/public/` (gitignored). Tailwind utilities carry the styling; the few
custom classes live in `style.css` (`.btn`, `.select`, `.md`, … — the file is
the list). `npm run dev:web` gives HMR with an
`/api` proxy to :3141. `tsconfig.web.json` stays as the typecheck gate.

Single page, with chat plus Console views (the raw timeline pane was folded into
per-turn Activity groups):

- **Projects** (left): a working set, not an archive — the pinned sessions,
  for as long as a hand leaves them pinned. A seven-day lease used to hide the
  quiet ones and `kept` used to opt out of it; both are gone (migration 11).
  Expiry destroyed nothing — the transcript, the place in the order and the
  pin all survived it — so what it actually did was hide rows nobody asked it
  to hide, and it needed a second state to say "not this one". The ✓ on the row
  is the only way out. The rows are the listing joined with what `session_state` owns:
  no second copy of a summary, so nothing to keep in step. Grouped
  by project (derived from session cwd). Sessions created in Pier are pinned
  automatically; everything else stays out of the sidebar. The row's `✓` gives
  membership up — the session, its transcript and its place all stay, and All
  sessions pins it back. One group is one *repository*, not one directory:
  `web/repos.ts` reports the common git dir behind each cwd (off the request
  path — the first read answers without it and a `sessions-changed` regroups
  the rail), so every worktree of a repo lands in the same group with its
  branch on the row, and "New session" offers one row per checkout. Each project is a collapsible group (collapse
  state in `localStorage`) whose header shows the session count, or a green dot
  while any of its sessions stream; rows carry a state dot, relative time and a
  hover `⋯` opening the session menu. The section header carries the only two
  sidebar actions as icons (avibe layout): search → All sessions, plus → the
  "New session" dialog with cwd input + known-project suggestions.
- **All sessions** (search icon → modal): everything `AgentFactory.list()`
  knows about, searchable over title + cwd, grouped by project, each row with a
  pin toggle; click opens the session. Pins, the unread dot and the two
  manual orders are the only UI-owned persisted state — ownership flags on the
  `session_state` table (`src/web/session-state.ts`), everything else derived
  from the transcript; outside the seams, injected into `createServer` so tests
  stay hermetic.
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
- **Attachments**: paste, drag-drop, or attach via the `+` button → pending
  strip (removable) above the composer; on send each file is uploaded to
  `POST /api/inbox` and its `[name](file:///…)` marker line joins the message
  text — so the text sent, rendered optimistically and echoed by the
  `user-message` event are identical. User bubbles strip the marker lines and
  render them through the same thumbnail/card pipeline as agent attachments
  (`web/ui/attachments.ts`); images open in the lightbox.
- Auto-scroll sticks to the bottom only when the user is already near it;
  own sends force-scroll.

Keep it plain: one `.css`, EventSource + fetch, plain modules. `main.ts` is
the orchestrator (session state, SSE streams, routing, header); rendering
lives in surface modules — `sidebar.ts`, `chat.ts`, `composer.ts`, and the
Console views (tasks, activity, boards and the tabbed Settings — the `ui/`
directory is the list) — that receive explicit
deps and never import main back. No state library, no router library, no
components framework. Third repeat rule applies before introducing any
abstraction.

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

## Shared UI vocabulary

`ui/form.ts` owns the Console's controls — card, field, toggle, inputs, select,
textarea, badge, empty, `helpBadge` — and `.btn`/`.btn-primary` from
`style.css` are its button. Channels and Tasks each grew their own set first,
which is why the two tabs used to read as different apps; a new Console surface
starts from `form.ts` and adds to it rather than beside it.

`ui/dom.ts` is `h()`, `$()`, `detailsRow()` and `prose()`. `prose()` renders
inline markdown with the `marked`/DOMPurify already bundled for the transcript,
so walkthrough copy is written as strings instead of `h()` call chains.

Two rules the Console inherited the hard way:

- **A turn that says nothing still renders something.** An empty assistant turn
  shows `Stayed silent — <reason>`; an empty bubble reads as a bug. See
  `AGENTS.md` principle 5b.
- **`overflow-hidden` on a card clips any popover inside it.** The document
  never scrolls; every scrollable region is an inner pane with sticky headers.
