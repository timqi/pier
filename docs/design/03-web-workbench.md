# Web Workbench (living spec)

Browser surface for chat + live observability: a consumer of core over
REST + SSE, no agent logic. Kept current as the workbench evolves.
Visual hierarchy, interaction constraints and review criteria are defined in
[UI/UX design guidelines](06-ui-ux.md); keep the two specifications aligned.

## Backend (`src/web/server.ts`, Hono)

`server.ts` is the session half only — sessions, turns, queue, SSE and the
static frontend. Every other surface owns its own routes and is mounted beside
it; the file is a route table, and logic appearing in a row is the thing to
catch, not the line count.

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` joined with live router state, unread flags and working-set `rank`; `modified` is metadata, not the rail's ordering key |
| `POST /api/sessions` | body `{cwd?}` → create session, returns `{id}` |
| `POST /api/sessions/:id/rename` | body `{name}` → append the name to the session's transcript (empty clears it), returns `{ok}`; the new title reaches every surface as a `sessions-changed` re-read |
| `POST /api/sessions/:id/read` | mark the session's last finished turn seen; clears the unread dot on every client |
| `POST /api/sessions/:id/turns/:index/edit` | body `{text}` → rewind the latest user turn and re-dispatch the new text; 409 for older user turns or while streaming, rechecked after history loads |
| `GET /api/sessions/:id/history` | session **snapshot**: resume/attach on demand via `router.ensure`, returns `{turns, epoch, lastSeq, model, state, context, queue, backgroundRuns}`; 404 if unknown, 503 if events race all three snapshot attempts. Compressed, like the steps route below — a long transcript is the one large answer here |
| `GET /api/sessions/:id/turns/:index/steps` | one turn's thinking/progress/tool steps; tool args and output are fetched when its Activity group opens, while progress text and step identities remain in the snapshot |
| `GET /api/sessions/:id/models` | available models (auth-configured) for the session |
| `GET /api/models` | the same list without a session, for pickers |
| `POST /api/sessions/:id/model` | body `{provider, id}` → switch model, returns `{model}` |
| `GET/POST /api/sessions/:id/thinking` | read or set the reasoning level (history also carries `thinkingLevel`) |
| `POST /api/sessions/:id/messages` | body `{text, mode}` (`mode` defaults `auto`; non-blank text required — attachments were already uploaded and ride the text as marker lines) → build `InboundMessage` with `key={channelId:"web", conversationId:id}`, hand to core router. Returns 202 immediately. |
| `POST /api/inbox` | body `{name?, mimeType, data}` (base64, ≤32MB) → saved via `core/inbox.ts` under `$PIER_HOME/inbox/web/`, returns `{path}`; the client appends `[name](file:///path)` to the message it then sends |
| `POST /api/sessions/:id/abort` | abort the current run |
| `POST /api/sessions/:id/queue/deliver` | body `{mode:"steer"\|"restart"}` → clear the queue and re-dispatch it: steer into the running turn, or abort the turn and send as a fresh prompt. 202 with `{delivered}`, 409 if the queue is empty |
| `POST /api/sessions/:id/queue/recall` | clear pending queue, returns `{messages}` for composer restore |
| `POST /api/sessions/:id/compact` | compact the transcript now (API only; no session-menu action). 202 when it starts; 409 while a turn runs, and 409 again when the seam says it is already compacting — relayed as itself, not flattened to a 404. The one system line it leaves in the transcript is the only trace a compaction leaves anywhere (§5b), automatic ones included |
| `POST /api/reload` | `pier reload` from the Console: re-read channel configuration, then let go of idle sessions (watched included) so the next message opens them with the current agent files, skills and credentials. Returns `{recycled, busy}` — `busy` counts the sessions mid-turn that keep what they opened with. 500 when the adapters could not be re-read. |
| `GET /api/activity` | *(served by `tasks/routes.ts`, drawn by the Console)* active or last-24h sessions, task runs, and Subagent control/supervisor message edges |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. |
| `GET /api/sessions/:id/events` | SSE. `id:` = `epoch:seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `epoch:lastSeq` from history, including zero) in one write, then live. Missing, foreign or uncovered cursors receive a named `reset` event requiring a fresh snapshot. Text deltas are live-only, not replay gaps: a covered reconnect gets final text from `turn-end` and thinking from replay. A reader that lets 4MB queue up is dropped and reconnects. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` (`/sw.js` is served `no-cache`: a cached worker is a released fix that never ships) |

- **Unread is this workbench's own attention.** `streaming → idle` marks the
  session unread, but only the sessions a browser here is the reader of: an IM
  turn was delivered to the chat it came from and a run's to its supervisor by
  callback, and neither could ever be acked — the ack needs the session on
  screen. The two facts are the ones a rail row already carries: no durable
  conversation row (`conversations.channelOf`), and not a session a task run
  made for itself. Decided at the write, so the dot, the two badges and Web
  Push read one flag instead of each subtracting the same rows again.

The other route owners, each a file with one reason to exist — the routes
themselves live there and are not mirrored here:
`auth.ts` (the password boundary ahead of everything, `/login`, `/logout`,
`/api/password`), `config.ts` (`/api/config*`, scoped Pi config editing),
`fs.ts` (`/api/fs/{ls,file,mkdir}` — and the containment check behind every
browse the Console makes; `/api/sessions/:id/files` shares only its size cap
and headers, because the boundary there is the password, not a tree),
`explorer.ts`
(`/api/explorer/{git,diff}` for the Files view, read-only), `instance.ts`
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

- **Sessions** (left): the server-maintained working set first, remaining
  sessions by creation time. Creating a session or speaking to one promotes it
  to the front of the working set; background activity does not reorder rows
  under the pointer. ⌘⇧[ / ⌘⇧] select the previous / next row in that order,
  wrapping, and stand down under a modal dialog. A session is titled by its
  first message; when Settings → Models names a title model, one bare request
  on it after the first reply renames the session (a `renamed` session event
  re-lists every surface), and a failed request is reported in the session
  while the first message stays the title. State dots,
  titles and session actions share the existing listing and event state. More
  sessions remain available through pagination and the search palette. New
  session opens a menu on its button, not a dialog: the listing's recent
  distinct directories (current one ticked, at most eight) then Browse…, and
  picking one creates the session. A labeled
  New session button and a separate magnifier button share one row below the
  brand. New session uses the primary blue fill; Search uses a muted neutral
  fill with a contrasting icon. Search keeps its accessible name
  and the existing shortcut hover hint. Status dots appear after the title only
  when needed; idle sessions reclaim their width. Title left edges stay aligned,
  while status and action changes may alter trailing truncation. Action buttons
  take no space until desktop hover or keyboard focus reveals them. On touch,
  the current session keeps its action visible; other rows reclaim that width.
  List refreshes retain
  the focused session control, and Load more focuses the first added session.
  An expanded menu keeps its trigger visible and reuses that button across list
  refreshes so closing the menu can restore focus. Pagination also retains focus
  on refresh, falling back to a remaining session when Load more disappears.
  The mobile drawer removes hidden controls from the tab order, contains focus
  while open, and restores the visible drawer or desktop rail toggle on dismissal
  or a breakpoint change; Escape dismisses it before
  reaching the conversation's stop shortcut. Touch controls have 44px minimum
  targets. On desktop, the sidebar floats in an 8px inset panel with a 20px
  radius, a glass surface, a thin border and a soft shadow. Its system sans-serif
  type is 0.875rem with 1.4 line height and 2rem minimum rows (about 16/22/36px
  at the default scale). Compact section and action spacing leaves room for
  sessions. The mobile drawer stays full-height without exterior margins,
  rounds its outer corners, and keeps 0.9375rem type with 1.5 leading. Section
  labels use sentence case; selected rows use medium weight and a flat blue
  tint, and channel initials retain readable secondary contrast.
- **Search palette** (search icon, ⌘K): sessions searchable by title, directory
  and channel, under Running / Recent / Sessions, plus Console destinations.
  Working-set rank and unread state belong to `web/session-state.ts`; the
  browser does not maintain a second session order or summary store.
- **Snapshot then deltas**: the stream carries deltas only, so a fresh client
  starts from `/history` — transcript (including each assistant turn's `steps`,
  thinking/progress/tool activity rebuilt from the Pi transcript), run `state` and
  pending `queue` — then applies SSE events after `lastSeq`. Nothing about a
  session's state is defaulted client-side; a reload shows real step counts and
  the correct composer buttons.
- **Chat header**: title, compact model/reasoning/context metadata and the `⋯`
  session menu. On desktop it uses an 8px inset, rounded glass strip matching the
  sidebar material, with the collapsed rail handle aligned inside it. The mobile
  top bar retains the title and session actions on the page's solid canvas color.
- **Workbench color and installed chrome**: a pale neutral canvas with subtle
  mist-blue and mint gradients confined to the lower conversation area; message
  surfaces remain solid. CSS `--workbench-canvas` is the runtime source for the
  page edge and `theme-color` metadata. The pre-bundle script mirrors its light
  and dark values for startup, follows the system when storage is unavailable,
  and the manifest uses the light value for its launch fallback. Native window
  chrome remains browser/OS controlled; these values request a matching tint.
- **Session menu** (`menu.ts`): one anchored popover primitive, one open at a
  time, closed by outside pointerdown / focus leaving / Esc / page scroll (scrolling *inside*
  the panel does not close it). Below 640px it becomes a bottom sheet with the
  session title and an explicit close button; its backdrop consumes the dismissal
  click so background controls do not activate. Rail actions remain keyboard
  reachable and visible while focused or open. Menus focus a control on open,
  support arrow / Home / End navigation, and return focus when dismissed from
  inside. Session actions have no reserved checkmark column and are grouped as
  Rename / Session info, New session here / Browse files, Model & reasoning.
  Model and directory hints truncate; model loading is immediate and a cancelled
  load cannot reopen the panel. Manual compaction remains an API capability.
  Session info has a solid reading surface, title, close button and a return
  button when opened from the menu. Its directory/ID, model/context and time
  groups use label/value columns on desktop and stacked fields on phones;
  only directory and ID have copy buttons. Snapshot-only details appear for the
  selected session. `model-picker.ts` is the
  standalone grouped-by-provider list, with the Settings-managed Pinned
  model/reasoning combinations first and no browser-local favorites. A pin is
  always a combination: it is created through this same picker, with the level
  the picker is on, so selecting one sets model and reasoning together. Provider
  groups are collapsed except the one holding
  the current model — separate because model choice will also be needed outside
  chat (scheduled tasks). The session model panel caps its desktop content at
  24rem and truncates its title; the picker fills the available width. Reasoning
  effort expands inline into styled radio choices, with native arrow-key
  selection and a visible current value; it does not open a platform select menu.
- **Console Activity**: active Session table plus a directed task dependency
  graph. Invocation edges are solid, callbacks dashed, and Subagent control or
  supervisor messages dotted; Session nodes open chat and run edges open Runs.
  Active and last-24h scopes include every queued or running task, regardless
  of age or newer history. Last-24h adds up to 200 terminal runs, excluding
  successful unmatched watch probes; that history limit never hides live work.
- **Task communication**: detached task calls create live Background Run rows in
  the invoking chat, updated in place from `task-status` session events. Agent
  delegation and callback inputs are persisted Pi custom messages rendered as
  distinct System input rows with source Session and Run links, never as user
  messages. Snapshot `backgroundRuns` restores recent detached work.
- **Automation**: Tasks, Runs and Activity share a tab strip. New task is a
  list-only action in that strip; its editor loading/navigation guards remain
  owned by Tasks. Runs keeps unmatched probes inside its filter group; date
  fields start collapsed unless active, and Reset includes all active filters.
- **Chat** (center): right-aligned mist-blue user bubbles and left-aligned
  opaque final-answer bubbles. Provisional text streams into the work log;
  tool/reasoning boundaries retain it as progress, and `turn-end` promotes the
  final answer without duplicating it in the log. Snapshot reconstruction
  folds intermediate assistant messages, preserving user/system boundaries.
  Gap/day time separators include an age refreshed locally every minute;
  precise message timestamps remain in hover titles. Only the latest user
  message offers editing, with the icon outside its bubble and explicit
  Cancel / Send edit controls. Esc cancels; Enter submits; Shift+Enter inserts
  a newline. New user input cancels a stale editor; the API rejects older or
  busy edits before rewinding. See the UI/UX guide for presentation details.
  Composer semantics: **Send** = `mode:"auto"` (idle starts a
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
- **Activity groups** (in-chat): an independent collapsible work log before
  the final reply, collecting thinking, intermediate progress and tool activity.
  The headline shows status, tool count and duration; progress is not counted
  as a fake tool. Tool rows reveal args/output and thinking rows reveal their
  tail-capped text. Expanded logs scroll independently. Final text leaves its
  provisional row before becoming a bubble; simple replies leave no empty log.
  Interrupted work and partial answers remain visible. System input cards
  show a four-line preview with type/status chips and short coloured markers,
  and can expand to full text.
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

- Initial data arrives through REST snapshots; workspace and session SSE
  events signal changes. The frontend never polls server state. Commands go
  out over REST, so multi-client synchronization needs no duplex channel.
- Reconnect: EventSource auto-reconnect + `Last-Event-ID` replay must survive
  a server restart gap without duplicating rendered events (dedupe by seq).
- Assistant answers render as markdown (`marked` + DOMPurify sanitization,
  `@tailwindcss/typography` for prose styling). Provisional text uses incremental
  markdown painting inside the work log; completed intermediate updates retain
  their source text there. The final answer renders markdown, attachments and
  next-step controls in its bubble. User/error rows remain plain text.

## Tests

- Backend: vitest + a fake `AgentFactory`/`AgentSession` (scripted event
  emitter). Cover: message → router → session call; SSE replay from
  `Last-Event-ID`; abort route.
- Frontend: Vitest coverage in `src/web/ui/*.test.ts`, plus browser interaction
  checks for layout, edit lifecycle, overlays, disclosures and replay. Use the
  UI/UX guide's validation matrix; state browser coverage explicitly.

## Acceptance

- Two browser tabs on one session see identical timelines (fan-out works).
- While a long turn streams: plain send queues (queue panel updates via `queue-state`),
  the queue's Send now action steers pending input into the running turn.
- In an isolated test server, restart and reconnect without duplicated events.

## Shared UI vocabulary

`ui/form.ts` owns the Console's controls — card, field, toggle, inputs, select,
textarea, badge, empty, `helpBadge` — and `.btn`/`.btn-primary` from
`style.css` are its button. Channels and Tasks each grew their own set first,
which is why the two tabs used to read as different apps; a new Console surface
starts from `form.ts` and adds to it rather than beside it.

`ui/icons.ts` renders decorative Lucide icons from named imports. The shell's explicit
`data-icon` slots initialize once at boot, retaining their IDs/classes and cached DOM
references (including Send/Queue visibility). Dynamic views create icons directly when
they render; there is no library-wide scan or observer on streaming updates. The native
select/directory-trigger chevron is a CSS background generated from the same Lucide
ChevronDown node at boot. `lucide` is pinned in the lockfile: its dependency-free,
tree-shaken icon data replaces scattered SVG paths and platform-dependent glyphs.
Brand assets, the Activity dependency graph and symbols in content are outside this convention.

`ui/dom.ts` is `h()`, `$()`, `detailsRow()` and `prose()`. `prose()` renders
inline markdown with the `marked`/DOMPurify already bundled for the transcript,
so walkthrough copy is written as strings instead of `h()` call chains.

Two rules the Console inherited the hard way:

- **A turn that says nothing still renders something.** A deliberate silent
  reply shows `Stayed silent — <reason>`. Missing replies and failures must not
  look like blank content or be mislabeled as deliberate silence. See
  `AGENTS.md` principle 5b.
- **`overflow-hidden` on a card clips any popover inside it.** The document
  never scrolls; every scrollable region is an inner pane with sticky headers.
