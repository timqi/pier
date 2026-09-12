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
| `POST /api/sessions/:id/queue/recovery/:batchId/ack` | acknowledge a failed promotion batch (architecture.md, queue promotion recovery): the copy leaves the history snapshot; returns `{ok}`, 404 for an unknown batch, 409 while its submission has not settled |
| `GET /api/sessions/:id/files?path=` | one file by absolute path for the chat's previews and attachment cards; 400 without `path`, 404 when not a file, 413 over the size cap it shares with `fs.ts` |
| `GET /api/search?q=` | content hits for the palette (below): `{hits}`, empty for an empty query |
| `POST /api/sessions/:id/compact` | compact the transcript now (API only; no session-menu action). 202 when it starts; 409 while a turn runs, and 409 again when the seam says it is already compacting — relayed as itself, not flattened to a 404. The one system line it leaves in the transcript is the only trace a compaction leaves anywhere (§5), automatic ones included |
| `POST /api/reload` | `pier reload` from the Console: re-read channel configuration, then let go of idle sessions (watched included) so the next message opens them with the current agent files, skills and credentials. Returns `{recycled, busy}` — `busy` counts the sessions mid-turn that keep what they opened with. 500 when the adapters could not be re-read. |
| `GET/PUT /api/config/defaults` | *(served by `config.ts`)* the model and reasoning effort a new session starts on — settings.json's `defaultProvider`+`defaultModel` pair and `defaultThinkingLevel`, as `{defaultModel: {provider, id} \| null, defaultThinkingLevel: level \| null}`; PUT takes both fields, writes the pair whole and leaves every other key alone, then answers with the stored state and recycles idle sessions like an agent-file save. 400 for a half body or a settings.json that is not valid JSON |
| `GET /api/packages` | *(served by `packages.ts`, as are the five below)* the whole Settings → Agent registry in one answer: `{packages: [{source, kind: "pier"\|"local"\|"npm"\|"git"\|"path", scope: "global"\|"project", version: string \| null, installedPath: string \| null, updateAvailable: boolean, resources: [{kind: "extension"\|"skill", name, path, enabled, state: string \| null, locked?: true}]}], checkedAt: iso \| null, busy: source \| null}`. `?cwd=` adds the project scope's packages and overrides as rows of their own; `state` is the one line a row shows instead of a plain switch reading (`installed by the rtk tool`); `locked` marks a switch that is another surface's (`<agentDir>/extensions/rtk.ts` is the rtk tool's under Tools; `PUT` on it is 409); `busy` is the source an install, remove or update is running for, so the UI draws its "installing…" row and refetches. 400 when settings.json is not valid JSON |
| `POST /api/packages` | body `{source}` → `installAndPersist` into the global scope; answers `{package}` (the new row) when the install finishes; Pi's progress steps go to the log. 400 for an empty source or a local path that does not exist, 409 when the source is already configured or another package operation is running, 502 when the install itself fails. Idle sessions are recycled on success, like an agent-file save |
| `POST /api/packages/remove` | body `{source}` → `removeAndPersist` (global scope), returns `{ok}`. 404 for a source not in settings.json, 409 for `pier` and `local` (built in, not removable) or while another operation runs, 502 when the remove itself fails |
| `POST /api/packages/update` | body `{source?}` → `update(source)`; `source` absent updates every unpinned npm/git package (`busy` reads `every package` meanwhile; the Console never sends this form). Answers `{packages}`, the rows it moved, when done. 404 unknown, 409 for a local/path or version-pinned source (nothing to move) or while another operation runs, 502 when the update itself fails. Never called by anything but a Console click |
| `POST /api/packages/check` | `checkForAvailableUpdates` now, returns the `GET` answer with `checkedAt` fresh. 502 with `{error}` when a registry or remote could not be reached; the previous answer stays shown |
| `PUT /api/packages/resource` | body `{source, kind, path, enabled, cwd?}` → one switch. `pier` resources flip the pier.db `skillsOff` list; any other resource writes `+path` / `-path` into that package's filter arrays (or the top-level `extensions`/`skills` arrays for `local`) in the global settings.json, or in `.pi/settings.json` when `cwd` is given. Answers the resource row. 400 bad body, 404 unknown resource |
| `GET /api/vault` | *(served by `web/vault.ts`, as are the two below; [07-vault.md](07-vault.md) owns the store)* `[{name, level: "auto"\|"approve", updatedAt}]` — names and levels, never values |
| `PUT /api/vault/:name` | body `{level, value}` → `Vault.put`; answers the row. 400 for a name that is not `^[A-Z][A-Z0-9_]{0,63}$`, a level that is neither, or an empty value; 423 when `auto` cannot seal because the store is locked; 503 when `approve` could not create its `vt://` record, the error carrying `vt doctor`'s report; 504 when `vt create` is still waiting on an approval after 15s — the put keeps running and a late approval still files the row |
| `DELETE /api/vault/:name` | remove; 204, or 404 `{error: "no secret named X"}` |
| `GET /api/activity` | *(served by `tasks/routes.ts`, as is every `/api/task*` row below; the Console's Tasks, Runs and Activity views are their only client — agents use `pier task`)* active or last-24h sessions, task runs, and control message (steer / follow-up) edges |
| `GET /api/tasks` | definitions of `?kind=` (default `task`; `subagent` one-shots only when asked), filtered by `?trigger=` and `?state=active\|archived`, each with `lastRun` |
| `POST /api/tasks` | body: a definition, or `{task, runNow?}`; 201 `{task, runId}`; 400 `{error}` from `parseDraft` |
| `GET /api/tasks/:id` | one definition; 404 |
| `PATCH /api/tasks/:id` | body: the whole draft, incl. `trigger`; 400 |
| `POST /api/tasks/:id/run` | body `{input?, sessionMode?: "fresh", sourceSessionId?}` → 202 `{runId}`, trigger `manual`; any other `sessionMode` is 400 (a reuse definition would otherwise inject into a live session) |
| `POST /api/tasks/:id/pause` · `/resume` · `/archive` | `enabled` false / true; archived; 400 |
| `GET /api/tasks/:id/runs` | `?limit=` (50) `?offset=`; 404 unknown task |
| `GET /api/task-runs` | `queryRuns` over `?state= ?source= ?taskId=` and the date/probe filters; 400 `{error}` on an unknown state or source |
| `GET /api/task-runs/:id` | the run view (definition, provenance, result, messages summary); 404 |
| `GET /api/task-runs/:id/messages` | steer / follow-up records with delivery state; 404 |
| `POST /api/task-runs/:id/steer` | body `{message, mode?: "followUp", sourceSessionId?}` (default `console`) → 202 the message; 400 on a terminal run |
| `POST /api/task-runs/:id/resume` | body `{message, wait?, sourceSessionId?}`; 202 the new run, or with `wait` 200 its finished view; 400 |
| `POST /api/task-runs/:id/cancel` | 202 the run, descendants included; 404 |
| `GET /api/task-groups/:id` | a batch and its members; 404 |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. A reader that lets 4MB queue up is dropped and reconnects. |
| `GET /api/sessions/:id/events` | SSE. `id:` = `epoch:seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `epoch:lastSeq` from history, including zero) in one write, then live. Missing, foreign or uncovered cursors receive a named `reset` event requiring a fresh snapshot. Text deltas are live-only, not replay gaps: a covered reconnect gets final text from `turn-end` and thinking from replay. A reader that lets 4MB queue up is dropped and reconnects. Heartbeat comment every 15s. |
| `GET /*` | static frontend from `src/web/public/` (`/sw.js` is served `no-cache`: a cached worker is a released fix that never ships) |

- **Unread**: `streaming → idle` marks the session unread when no durable
  conversation row exists (`conversations.channelOf`) and no task run made the
  session for itself. One flag, read by the dot, the badges and Web Push.

Other route owners: `auth.ts` (`/login`, `/logout`, `/api/password`,
`/api/devices*`), `config.ts` (`/api/config*`), `config-sync.ts`
(`/api/config-sync`; `/config-sync/:token` is served before the password, the
token being its guard), `packages.ts` (`/api/packages*`; a file of its
own because the registry is not agent-file editing), `fs.ts` (`/api/fs/{ls,file,mkdir}` and the
containment check; `/api/sessions/:id/files` shares only its size cap and
headers), `explorer.ts` (`/api/explorer/{git,diff}`, read-only), `instance.ts`
(`/api/settings`, `/api/update`, `/api/secrets*`, `/api/client-log`),
`providers.ts` + `provider-flows.ts` (`/api/providers*`, including the probe
that sends one real request), `push.ts` (below), `tasks/routes.ts`,
`channels/routes.ts`, `vault.ts` (`/api/vault*`), `boards/boards.ts` (`/boards/*`, `/p/*`).

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

- Empty: Running (streaming, unread or subagents in flight — everything the
  rail's dot marks), the first seven of the rest as Recent, Actions (New session
  here; New session in… → the rail's directory menu), Console destinations.
- Typed: Actions (matching directories, Console entries) and one Sessions
  list — title/directory/channel matches from the list in hand, then content
  hits from `GET /api/search?q=` (user messages and replies, never steps;
  indexed by `agent/listing.ts`; one hit per session; matched line under the
  name).
- Whitespace splits the query into terms, both locally and on the server:
  every term must be there, in any order, within the one row or message.
  Each term is marked in the snippet.
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
- **Task communication**: runs launched by `pier task run` create Background
  Run rows, updated from `task-status` events; the header's running chip (`activeRuns`
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
- **File references**: an inline code span that is a path with an extension —
  `src/web/ui/chat.ts:481`, and a bare name only when the extension is a
  file-ish one — opens the preview dialog, at the named line when it names one.
  Relative paths resolve against the session's cwd; the files route takes
  absolute paths only. A pointer press leaves no focus ring on one; a keyboard
  focus does.
- **Copy**: a fenced block has a Copy button in its corner; any inline code
  span — a file reference included — copies on a 450 ms press-and-hold that
  stays put, flashing green or red in place and swallowing the click it would
  have been. A press that moves is a selection, and on a touch screen the hold
  is ours (no native callout or selection handles over inline code).
- **Lightbox**: click magnifies about the point, second click fits; drag pans
  (mouse and finger); scrim, ✕, Esc close; ‹ › and ← / → page the gallery the
  image came from (transcript or strip, never across), hidden for one image.
  Controls pin to the viewport edges; ≥ `md` the image leaves them gutters; on
  a phone the arrows overlay the image (darker fill, white rim).

### Console views

- **Activity**: Session table + directed task graph. Invocation edges solid,
  from the launching session (the scheduler when none) to the run's session
  or process — never run to run; callbacks dashed, control messages dotted;
  Session nodes open chat, run edges open Runs. Active and last-24h include every queued or
  running task regardless of age; last-24h adds up to 200 terminal runs,
  excluding successful unmatched watch probes.
- **Automation**: Tasks, Runs, Activity share the head's tabs; New task is a
  head action, its editor guards owned by Tasks. Filter card and list are one
  inset panel each; the list panel scrolls with a sticky table header. Runs
  keeps unmatched probes in its filter group; date fields start collapsed
  unless active; Reset covers all active filters.
- **Settings**: cards or panels on the canvas. Channels: segmented platform
  switch, sticky in the topic's scroller. Vault (`#/settings/vault`): the
  rows `name · level · updated` with Remove (confirms), and the add row —
  name, `auto|approve` segmented with its one-line note, a password field;
  no reveal, filing an existing name replaces it. `?name=X` opens with the
  name filled and the value field focused: the link an agent's `no secret
  named X` error carries. Agent: two panels (what a session is
  made of / what the selected item affords), Scope in the Console's control
  skin. An agent file opens in `code.ts`'s viewer; **Edit**/**View** swap,
  rendering the editor's own text; Save keeps `expected` for the conflict check
  and reports saved / unsaved / failed. A file the index marks `readonly`
  (settings.json, written by Pier) opens in the viewer alone with one line on
  where its keys are set. Models: Default model is the launch picker written on
  change, redrawn from the server's answer; a pinned row's ∧/∨ arrows move it,
  staged like any menu edit until Save, since the stored order is the one every
  picker and `pier task --model ?` list. Instance: Public URL, the browser's
  notification switch, Reload.
- **Files** (`explorer.ts`, an overlay: `#/files/<dir>`, its ✖ returns where it
  was opened from): a directory tree beside a viewer; in a git checkout the
  tree filters to the picked diff's files and unfolds to each change (up to
  `MAX_AUTO_EXPAND` folders); elsewhere only the root's own folders unfold —
  one level down may be `node_modules`. `?select=<relative path>` opens that
  file with its ancestors unfolded, its row marked and the diff filter off; a
  path with no row leaves the viewer on "Select a file."
  Without a repository (`GET /api/explorer/git` answers `branch: null`) the
  branch chip, the compare picker, the changed-only funnel and the diff
  stepper are all absent, the compare block says so, and an empty folder reads
  "Empty." rather than "No changes." — the filter is not in force.

  The Agent nav, drawn from one `GET /api/packages` answer. The management
  unit is the **package** (a source); its resources are the extensions and
  skills it provides; a resource has one switch wherever it is shown.

  | Section | Rows | Actions |
  | ------- | ---- | ------- |
  | Instance | Configuration sync | |
  | Files | the whitelisted agent files; settings.json read-only | |
  | **Packages** (tree) | one row per source: built-in `pier` (Pier's own skills `pier-boards`, `pier-help`, `pier-slack`, `pier-tasks`, `pier-vault`, `pier-web`; version = Pier's), `local` (`<agentDir>/extensions`, `<agentDir>/skills`), then each installed npm/git/path package; `on` when any resource is; `installing…`/`updating…` on the `busy` one; a configured-but-uninstalled source reads dim. A chevron expands the row into its resources grouped `extensions` / `skills`: name, dim when off, the `state` as a second line (never hover-only), a kind badge only when the same name occurs twice in the package; `pier` and `local` start open, the rest closed, and the fold state survives redraws for the session; picking a resource from a pane opens its package | package pane: source, kind, version, install path, the provided resources each with its switch; for an installed npm/git/path package also **Updates** (checked-at, **Check for updates** — a failed check keeps the last answer), **Update** (npm/git), **Remove** (confirms); while `busy` the buttons are disabled; a refused operation shows the server's `error` in the status line; header action **Add package**: spec input, Pi's security note (packages run with full system access; review the source first), **Install** — the row appears as `installing…` at once and the list is refetched on the answer. Resource pane: the same switch (disabled when `locked`, the hint saying where it is), the `state` line, its package, and the file through `GET /api/fs/file` (a bundled extension has none); a flip here redraws the tree row. **Browse files** (package pane beside the install path, resource pane beside the file's path; absent where there is no directory) opens Files on the package directory, a skill's directory (`SKILL.md` selected) or an extension's file |
  | Tools | the managed binaries, `rtk` among them | switch, custom block editor |

  Rules:
  - Install, remove, update and the check are global scope only; project
    scope (`.pi/settings.json`) is view plus enable/disable, the project's
    rows badged `project`.
  - A daily in-process check (`checkForAvailableUpdates`, at boot and every
    24h, the result cached for `GET`) reports updates; installing one is a
    Console click, never automatic for third-party code. Not a Task: the
    check is an SDK call, and the external `pi` CLI is forbidden.
  - The `pier` package's switch state is pier.db settings (`skillsOff`:
    Pier's skills switched off). Every other switch and every package is
    settings.json.
  - settings.json has two writers: `ConfigStore` (the first-boot seed when no
    file exists — docs/deploy.md names its keys — and `writeDefaults`, an
    atomic whole write of the defaults pair) and Pi's `SettingsManager`
    (merge-write of the modified keys under its own lock). Every package operation runs inside
    `ConfigStore`'s write queue with a `SettingsManager` created for that call,
    so Pi reads Pier's latest defaults and touches only `packages`,
    `extensions`, `skills`. The test: write defaults, install a package, read
    both back unchanged.
  - Console-only: no agent tool installs packages; one operation at a time
    (`busy` names the source), 409 for a second.
  - `rtk` is a Tool: its switch installs the binary through the tools task,
    and the `post_install` hook in its ubix block (`rtk init -g --agent pi
    --auto-patch`, run by ubix) writes `<agentDir>/extensions/rtk.ts`. That
    file is a `local` row like any other, `locked` with the state
    `installed by the rtk tool`, so the Console never writes a settings.json
    pattern the tool's next install or uninstall would fight.
  - Shadowing is known at session open, not at list time: `standDownShadowed`
    records what it stood down, `GET` reports the last open's finding, and a
    built-in no session has opened since reads no state.
  - After any package or switch write, idle sessions are recycled as for an
    agent-file save; sessions mid-turn keep what they opened with.
  - One switch, one write: the `pier` package's skills flip through
    `PUT /api/packages/resource` like every other resource; `PUT /api/settings`
    carries no `skill` key.

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
