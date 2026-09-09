# Web Workbench (living spec)

Browser surface for chat + live observability: a consumer of core over
REST + SSE, no agent logic. Presentation: [06-ui-ux.md](06-ui-ux.md).

## Backend (`src/web/server.ts`, Hono)

`server.ts` is sessions, turns, queue, SSE and the static frontend; every other
surface owns its routes and is mounted beside it.

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` joined with live router state, unread flags and working-set `rank`; `modified` is metadata, not the rail's ordering key |
| `GET /api/sessions/:id` | one session's row, the list's filters aside — a task run's own session is never in the listing, and the header that opened it from Runs names it and fills its info panel from here; 404 if unknown |
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
| `POST /api/sessions/:id/compact` | compact the transcript now (API only; no session-menu action). 202 when it starts; 409 while a turn runs, and 409 again when the seam says it is already compacting — relayed as itself, not flattened to a 404. The one system line it leaves in the transcript is the only trace a compaction leaves anywhere (§5), automatic ones included |
| `POST /api/reload` | `pier reload` from the Console: re-read channel configuration, then let go of idle sessions (watched included) so the next message opens them with the current agent files, skills and credentials. Returns `{recycled, busy}` — `busy` counts the sessions mid-turn that keep what they opened with. 500 when the adapters could not be re-read. |
| `GET /api/activity` | *(served by `tasks/routes.ts`, drawn by the Console)* active or last-24h sessions, task runs, and Subagent control/supervisor message edges |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. A reader that lets 4MB queue up is dropped and reconnects. |
| `GET /api/sessions/:id/events` | SSE. `id:` = `epoch:seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `epoch:lastSeq` from history, including zero) in one write, then live. Missing, foreign or uncovered cursors receive a named `reset` event requiring a fresh snapshot. Text deltas are live-only, not replay gaps: a covered reconnect gets final text from `turn-end` and thinking from replay. A reader that lets 4MB queue up is dropped and reconnects. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` (`/sw.js` is served `no-cache`: a cached worker is a released fix that never ships) |

- **Unread**: `streaming → idle` marks the session unread when no durable
  conversation row exists (`conversations.channelOf`) and no task run made the
  session for itself. One flag, read by the dot, the badges and Web Push.

Other route owners: `auth.ts` (`/login`, `/logout`, `/api/password`),
`config.ts` (`/api/config*`), `fs.ts` (`/api/fs/{ls,file,mkdir}` and the
containment check; `/api/sessions/:id/files` shares only its size cap and
headers), `explorer.ts` (`/api/explorer/{git,diff}`, read-only), `instance.ts`
(`/api/settings`, `/api/update`, `/api/secrets*`, `/api/client-log`),
`providers.ts` + `provider-flows.ts` (`/api/providers*`, including the probe
that sends one real request), `push.ts` (below), `tasks/routes.ts`,
`channels/routes.ts`, `boards/boards.ts` (`/boards/*`, `/p/*`).

## Notifications (`src/web/push.ts` + `src/web/webpush.ts`)

Web Push: Chrome and Edge on desktop, iOS/iPadOS 16.4+ once Pier is on the Home
Screen. Composed in `main.ts` as a second consumer of the event stream.

| Route | Behavior |
| ----- | -------- |
| `GET /api/push` | `{publicKey}` — the instance's VAPID public key, what a browser subscribes with |
| `POST /api/push/subscribe` | a `PushSubscription` (`{endpoint, keys:{p256dh, auth}, label}`) → stored; upsert, so a browser re-posting on every load repairs a lost row. 400 on anything that is not one |
| `POST /api/push/unsubscribe` | body `{endpoint}` → forgotten |
| `POST /api/push/test` | send a test notification to every subscribed device, `{sent, failed}`; 409 when none is subscribed |

- `streaming → idle` starts a 6s settle window; a session *still* unread when
  it closes is notified. Sessions answering an IM conversation
  (`router.conversationOf(id)`) are not.
- `webpush.ts` is the wire format — RFC 8291 `aes128gcm` and RFC 8292 VAPID on
  `node:crypto`, the RFC's worked example as the golden test. No dependency.
- Only 404/410 costs a subscription; every other failure is logged with the
  push service's answer (principle 5).
- `sw.js` caches nothing; its one `fetch` handler is a navigation fallback, and
  a notification only ever opens a same-origin URL.
- One VAPID key pair per instance, minted on first use, never rotated on its
  own; the private half is sealed by `Secrets` in `push_identity`.

## Frontend (`src/web/ui/`, Vite + Tailwind, vanilla TS, no framework)

`src/web/ui/` (index.html + main.ts + style.css) builds via Vite to
`src/web/public/` (gitignored). Custom classes live in `style.css` (`.btn`,
`.select`, `.md`, …). `npm run dev:web` gives HMR with an `/api` proxy to
:3141; `tsconfig.web.json` is the typecheck gate.

`main.ts` orchestrates (session state, SSE streams, routing, header); surface
modules (`sidebar.ts`, `chat.ts`, `composer.ts`, the Console views) receive
explicit deps and never import main back. No state, router or component
library. Working-set rank and unread state live in `web/session-state.ts`; the
browser keeps no second session order.

### Data flow

- **Snapshot then deltas**: `/history` (transcript with each turn's `steps`,
  `state`, `queue`, `backgroundRuns`), then SSE with `?after=epoch:lastSeq`.
  Nothing about a session's state is defaulted client-side.
- REST snapshots + SSE change signals; the frontend never polls. Commands go
  out over REST.
- Reconnect: EventSource auto-reconnect + `Last-Event-ID` replay survives a
  server restart without duplicated events (dedupe by seq).
- Own sends render optimistically and reconcile against the seam's
  `user-message` event by text; a queued message the agent picks up renders as
  a user turn from that same event.
- Assistant markdown: `marked` + DOMPurify, `@tailwindcss/typography`.
  Provisional text paints incrementally in the work log; the final bubble
  renders markdown, attachments and next-step controls. User/error rows are
  plain text.
- Auto-scroll sticks to the bottom only when already near it; own sends
  force-scroll.

### Sessions rail (`sidebar.ts`)

- Order: working set first, then by creation time. Creating or speaking to a
  session promotes it; background activity never reorders. Pagination and the
  palette reach the rest.
- Title: the first message. If Settings → Models names a title model, one bare
  request after the first reply renames the session (`renamed` event re-lists
  every surface); a failed request is reported in the session.
- **New session** menu: recent distinct directories (current ticked, at most
  eight), then Browse…. Browse…: focus starts on the editable path line; ↓
  first folder, ↑ last, ↵ descends, Home/End are the caret's; Use and New
  folder are Tab's.
- Worktrees (`<repo>.<branch>` whose `<repo>` sibling is also listed) are left
  out of directory lists, here and in the palette; compared on `realpath`ed
  paths.
- Chords: ⌘⇧[ / ⌘⇧] previous / next row (wrapping); ⌘⇧O New session menu; ⌘K
  palette. All stand down under a modal.
- Focus: refreshes retain the focused control; Load more focuses the first
  added row; an open menu reuses its trigger across refreshes. The mobile
  drawer removes hidden controls from the tab order, contains focus, restores
  the toggle on dismissal or breakpoint change; Escape dismisses it before the
  stop shortcut.

### Search palette (`palette.ts`, ⌘K)

- Empty: Running, the first seven of the rail as Recent, Actions (New session
  here; New session in… → the rail's directory menu), Console destinations.
- Typed: Actions (matching directories, Console entries) and one Sessions
  list — title/directory/channel matches from the list in hand, then content
  hits from `GET /api/search?q=` (user messages and replies, never steps;
  indexed by `agent/listing.ts`; one hit per session; matched line under the
  name).
- Local rows render on the keystroke; the server is asked after 80ms with the
  previous request aborted. States: `Searching messages…`, `No sessions match`,
  `Message search unavailable` (reason on hover).
- A content hit selects the session, scrolls to the turn stamped with the hit's
  time and rings it; a turn no longer there just opens the session.
- Keys: ↑↓ / ⌃N ⌃P / ⌃J ⌃K walk, ↵ opens, Esc or backdrop closes; hover never
  moves the selection.

### Menus (`menu.ts`, `model-picker.ts`)

- One anchored popover primitive, one open at a time; closed by outside
  pointerdown, focus leaving, Esc, page scroll (not scroll inside). Below 640px
  a bottom sheet with title and close button; its backdrop consumes the click.
- Focus a control on open; arrow / ⌃N ⌃P / ⌃J ⌃K / Home / End (the palette's
  `listStep`), from wherever the focus sits rather than only from inside the
  panel; return focus on dismissal. A panel that is not all list marks the part
  that is (`data-list`, the directory tree's folders) and keeps Home/End for
  its text field. An open menu owns those keys: ⌘K/⌃K stands down. ⌘N/⌘P are
  never bound.
- Session menu: Rename / Session info, New session here / Browse files, Model &
  reasoning. Model loading is immediate; a cancelled load cannot reopen the
  panel. Manual compaction is API-only.
- Session info: directory/ID (copy buttons), model/context, time groups; a
  return button when opened from the menu.
- `model-picker.ts`: grouped by provider, Settings-managed Pinned combinations
  first, no browser-local favorites. A pin is model + level, created here with
  the picker's current level; selecting one sets both. Groups collapse except
  the current model's. Reasoning effort: inline styled radios.

### Chat pane (`chat.ts`, `composer.ts`)

- Transcript: provisional text streams into the work log; tool/reasoning
  boundaries retain it as progress; `turn-end` promotes the final answer
  without duplicating it. Snapshot reconstruction folds intermediate assistant
  messages, preserving user/system boundaries. Gap/day separators carry an age
  refreshed every minute; exact timestamps on hover.
- **Activity groups**: collapsible work log before the reply — thinking,
  progress, tool activity; headline shows status, tool count (progress not
  counted), duration; tool rows reveal args/output, thinking rows tail-capped
  text; expanded logs scroll independently; simple replies leave no empty log;
  interrupted work stays visible. System input cards: four-line preview,
  type/status chips, expandable.
- **Task communication**: detached task calls create Background Run rows,
  updated from `task-status` events; the header's running chip (`activeRuns`
  from the session list) reveals the newest one still in flight. Delegation and
  callback inputs render as System input rows with Session and Run links, never
  as user messages.
- **Edit**: latest user message only; Esc cancels, Enter submits, Shift+Enter
  newline; new input cancels a stale editor; the API rejects older or busy
  edits.
- **Composer**: **Send** = `mode:"auto"`, **Send now** = `mode:"steer"`
  (streaming only), **Stop** = abort (streaming only). Enter sends, never during
  IME composition (`isComposing`/229).
- **Queue panel**: `queue-state` snapshots with mode chips; **Send now**
  (steer), **Abort & send** (abort, fresh prompt), **Recall all** (append to the
  composer draft). Queued messages join with newlines.
- **Attachments**: paste, drag-drop, `+` → pending strip; on send each file goes
  to `POST /api/inbox` and its `[name](file:///…)` marker joins the text, so
  sent, optimistic and echoed text are identical. The strip is per session, in
  memory only. User bubbles strip markers and render them via
  `web/ui/attachments.ts`; images open in the lightbox.
- **Lightbox**: click magnifies about the point, second click fits; drag pans
  (mouse and finger); scrim, ✕, Esc close; ‹ › and ← / → page the gallery the
  image came from (transcript or strip, never across), hidden for one image.
  Controls pin to the viewport edges; ≥ `md` the image leaves them gutters; on
  a phone the arrows overlay the image (darker fill, white rim).

### Console views

- **Activity**: Session table + directed task graph. Invocation edges solid,
  callbacks dashed, Subagent control/supervisor messages dotted; Session nodes
  open chat, run edges open Runs. Active and last-24h include every queued or
  running task regardless of age; last-24h adds up to 200 terminal runs,
  excluding successful unmatched watch probes.
- **Automation**: Tasks, Runs, Activity share the head's tabs; New task is a
  head action, its editor guards owned by Tasks. Filter card and list are one
  inset panel each; the list panel scrolls with a sticky table header. Runs
  keeps unmatched probes in its filter group; date fields start collapsed
  unless active; Reset covers all active filters.
- **Settings**: cards or panels on the canvas. Channels: segmented platform
  switch, sticky in the topic's scroller. Agent: two panels (what a session is
  made of / what the selected item affords), Scope in the Console's control
  skin. An agent file opens in `code.ts`'s viewer; **Edit**/**View** swap,
  rendering the editor's own text; Save keeps `expected` for the conflict check
  and reports saved / unsaved / failed.

## Tests

- Backend: vitest + a fake `AgentFactory`/`AgentSession` (scripted event
  emitter). Cover: message → router → session call; SSE replay from
  `Last-Event-ID`; abort route.
- Frontend: Vitest in `src/web/ui/*.test.ts`, plus browser interaction checks
  for layout, edit lifecycle, overlays, disclosures and replay. Use the UI/UX
  guide's validation matrix; state browser coverage explicitly.

## Acceptance

- Two browser tabs on one session see identical timelines (fan-out works).
- While a long turn streams: plain send queues (queue panel updates via
  `queue-state`), the queue's Send now action steers pending input into the
  running turn.
- In an isolated test server, restart and reconnect without duplicated events.

## Shared UI vocabulary

- `ui/form.ts` owns the Console's controls — card, field, toggle, inputs,
  select, textarea, badge, empty, `helpBadge`; `.btn`/`.btn-primary` in
  `style.css` are its button. New Console surfaces start from it.
- `ui/icons.ts`: Lucide from named imports. Shell `data-icon` slots initialize
  once at boot (IDs, classes and cached references kept); dynamic views create
  icons as they render; no library-wide scan or observer. The native select
  chevron is a CSS background from the same ChevronDown node.
- `ui/dom.ts`: `h()`, `$()`, `detailsRow()`, `prose()` (inline markdown via the
  bundled `marked`/DOMPurify).
- A turn that says nothing still renders `Stayed silent — <reason>`; missing
  replies and failures never look like blank content or deliberate silence
  (principle 5).
- `overflow-hidden` on a card clips any popover inside it. The document never
  scrolls; every scrollable region is an inner pane with sticky headers.
