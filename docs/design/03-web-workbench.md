# Web Workbench (living spec)

Browser surface for chat + live observability: a consumer of core over
REST + SSE, no agent logic. Presentation: [06-ui-ux.md](06-ui-ux.md).

## Backend (`src/web/server.ts`, Hono)

`server.ts` is sessions, turns, queue, SSE and the static frontend; every other
surface owns its routes and is mounted beside it.

| Route | Behavior |
| ----- | -------- |
| `GET /api/sessions` | `AgentFactory.list()` joined with live router state and unread flags; `modified` is metadata, not the drawer's ordering key |
| `GET /api/sessions/:id` | one session's row, the list's filters aside — a task run's own session is never in the listing (a feature lead's is, [10](10-continuous-session.md#roles)), and the header that opened it from its run card names it and fills its info panel from here; 404 if unknown |
| `POST /api/sessions/:id/read` | mark the session's last finished turn seen; clears the unread dot on every client |
| `POST /api/sessions/:id/turns/:index/edit` | body `{text}` → rewind to that user turn, dropping every turn after it, and re-dispatch the new text; 409 for an index the transcript no longer holds or while streaming, rechecked after history loads, and 409 on an earlier head session |
| `GET /api/sessions/:id/history` | session **snapshot**: resume/attach on demand via `router.ensure`, returns `{turns, epoch, lastSeq, model, state, context, queue, backgroundRuns, skills}`; 404 if unknown, 503 if events race all three snapshot attempts. Compressed, like the steps route below — a long transcript is the one large answer here. `queue` is Pi's `{steering, followUp}` plus `parked`, the session's pending `--after` task messages as `{messageId, runName, text}`, which the queue panel shows by run name but never recalls or sends (a `task-message` system input drops its row); `turns` is the transcript's current branch, compacted turns included; an earlier head member is read off disk, never opened, as `{turns, backgroundRuns, skills: [], readonly: true}`; `skills` is `AgentSession.skills()`, the `{name, description}` Pi loaded for the session — what `/skill:<name>` expands and the composer lists |
| `GET /api/continuous` | *(the head, [10](10-continuous-session.md))* `{chain: [{sessionId, startedAt, reason: "first"\|"idle"\|"lost"\|"full"\|"new"}], rotateAt}`, newest first; `rotateAt` is `CHAIN_FULL_TOKENS` |
| `GET /api/continuous/open` | `TaskService.openItems()` (`WebDeps.openItems`): `{items: [{problem, stage, runs, status}], unlisted}`, each run a ledger row (`LedgerRun`, a lead's with `workers` counted by state) |
| `POST /api/continuous/messages` | body `{text, mode}` like the session route → the alias send: the head is resolved (and rotated) server-side, then dispatched to; 202 `{sessionId, rotated?, command?}`, `command` naming a chat command answered without a turn (the composer drops its optimistic streaming state), 400 without text, 409 with the refusal when `/new` meets a replying head. A rotation re-lists every surface (`sessions-changed`) |
| `GET /api/sessions/:id/system-prompt` | the system prompt the session's model has, `AgentFactory.readSystemPrompt`: the transcript's system messages replayed, read off disk and never opened, so an earlier head member answers too — `{text, tokens, blocks}`, `tokens` Pi's characters/4 estimate, `blocks` the `{label, path?, text}` sources in order (Pier baseline, SYSTEM.md, each context file — the role prompt is `<pier>/dispatcher.md`, `lead.md` or `worker.md` — Skills, Working directory); a change made on resume shows once a request has carried it. 404 for an unknown session and before any request carried a prompt. Compressed |
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
| `GET /api/sessions/:id/files?path=` | one file by absolute path for the chat's images, attachment thumbnails and downloads; 400 without `path`, 404 when not a file, 413 over the size cap it shares with `fs.ts` |
| `GET /api/search?q=` | content hits for the palette (below): `{hits}`, empty for an empty query |
| `POST /api/reload` | `pier reload` from the Console: re-read channel configuration, then let go of idle sessions (watched included) so the next message opens them with the current agent files, skills and credentials. Returns `{recycled, busy}` — `busy` counts the sessions mid-turn that keep what they opened with. 500 when the adapters could not be re-read. |
| `GET/PUT /api/config/defaults` | *(served by `config.ts`)* the model and reasoning effort a new session starts on — settings.json's `defaultProvider`+`defaultModel` pair and `defaultThinkingLevel`, as `{defaultModel: {provider, id} \| null, defaultThinkingLevel: level \| null}`; PUT takes both fields, writes the pair whole and leaves every other key alone, then answers with the stored state and recycles idle sessions like an agent-file save. 400 for a half body or a settings.json that is not valid JSON |
| `GET /api/packages` | *(served by `packages.ts`, as are the five below)* the whole Settings → Agent registry in one answer: `{packages: [{source, kind: "pier"\|"local"\|"npm"\|"git"\|"path", scope: "global"\|"project", version: string \| null, installedPath: string \| null, updateAvailable: boolean, resources: [{kind: "extension"\|"skill", name, path, enabled, state: string \| null}]}], checkedAt: iso \| null, busy: source \| null}`. `?cwd=` adds the project scope's packages and overrides as rows of their own; `state` is the one line a row shows instead of a plain switch reading (`not loaded — <why>`); `<agentDir>/extensions/rtk.ts` is left out, being the rtk tool's (`PUT` on it is 404); `busy` is the source an install, remove or update is running for, so the UI draws its "installing…" row and refetches. 400 when settings.json is not valid JSON |
| `POST /api/packages` | body `{source}` → `installAndPersist` into the global scope; answers `{package}` (the new row) when the install finishes; Pi's progress steps go to the log. 400 for an empty source or a local path that does not exist, 409 when the source is already configured or another package operation is running, 502 when the install itself fails. Idle sessions are recycled on success, like an agent-file save |
| `POST /api/packages/remove` | body `{source}` → `removeAndPersist` (global scope), returns `{ok}`. 404 for a source not in settings.json, 409 for `pier` and `local` (built in, not removable) or while another operation runs, 502 when the remove itself fails |
| `POST /api/packages/update` | body `{source?}` → `update(source)`; `source` absent updates every unpinned npm/git package (`busy` reads `every package` meanwhile; the Console never sends this form). Answers `{packages}`, the rows it moved, when done. 404 unknown, 409 for a local/path or version-pinned source (nothing to move) or while another operation runs, 502 when the update itself fails. Never called by anything but a Console click |
| `POST /api/packages/check` | `checkForAvailableUpdates` now, returns the `GET` answer with `checkedAt` fresh. 502 with `{error}` when a registry or remote could not be reached; the previous answer stays shown |
| `PUT /api/packages/resource` | body `{source, kind, path, enabled, cwd?}` → one switch. `pier` resources flip the pier.db `skillsOff` list; any other resource writes `+path` / `-path` into that package's filter arrays (or the top-level `extensions`/`skills` arrays for `local`) in the global settings.json, or in `.pi/settings.json` when `cwd` is given. Answers the resource row. 400 bad body, 404 unknown resource |
| `GET /api/vault` | *(served by `web/vault.ts`, as are the two below; [07-vault.md](07-vault.md) owns the store)* `[{name, level: "auto"\|"approve", updatedAt}]` — names and levels, never values |
| `PUT /api/vault/:name` | body `{level, value}` → `Vault.put`; answers the row. 400 for a name that is not `^[A-Z][A-Z0-9_]{0,63}$`, a level that is neither, or an empty value; 423 when `auto` cannot seal because the store is locked; 503 when `approve` could not create its `vt://` record, the error carrying `vt doctor`'s report; 504 when `vt create` is still waiting on an approval after 15s — the put keeps running and a late approval still files the row |
| `DELETE /api/vault/:name` | remove; 204, or 404 `{error: "no secret named X"}` |
| `GET /api/tasks` | *(served by `tasks/routes.ts`, as are the three below)* `TaskRow[]` (`tasks/types.ts`): every non-archived `kind: "task"` definition with `lastRun` |
| `GET /api/tasks/:id/runs` | the task's newest 20 `TaskRun`s; 404 unknown task |
| `POST /api/tasks/:id/pause`, `/resume` | `setEnabled`; answers the definition. 400 unknown, archived-on-resume, or a task Pier owns |
| `GET /api/boards` | *(served by `boards/boards.ts`, as are the two below)* `[{slug, title, description, public, token, updatedAt}]`, freshest `site/` mtime first |
| `PATCH /api/boards/:slug` | body `{public: boolean}`, minting the token on first publish; answers `{public, token}`. 400 bad body, 404 unknown slug |
| `DELETE /api/boards/:slug` | renames the folder `<slug>.deleted-<ts>`; answers `{deleted}`, 404 unknown slug |
| `GET /api/events` | SSE workspace stream: session/task/run change pointers. Pointers only, no content, no replay — a reconnect re-lists. A reader that lets 4MB queue up is dropped and reconnects. |
| `GET /api/sessions/:id/events` | SSE. `id:` = `epoch:seq`; replay from hub ring buffer after `Last-Event-ID` header or `?after=` query (client passes `epoch:lastSeq` from history, including zero) in one write, then live. Missing, foreign or uncovered cursors receive a named `reset` event requiring a fresh snapshot. Text deltas are live-only, not replay gaps: a covered reconnect gets final text from `turn-end` and thinking from replay. A reader that lets 4MB queue up is dropped and reconnects. Heartbeat comment every 15s. |
| `GET /` | 302 to `/app/` |
| `GET /app`, `/app/` | the shell, `PIER_TITLE` patched into the tab title and the accent onto `<html data-accent>`, `no-cache` |
| `GET /app/manifest.webmanifest`, `/app/icon.svg` | the shipped files, rendered per instance and `no-cache`: `name`/`short_name` (≤12) are `PIER_TITLE` (`Pier` when unset), `theme_color` and the icon's plate the accent's 600 step (`ACCENTS` in `settings.ts`). Safari and the iOS Home Screen read only the PNG links, so the shell points `icon-32` and `apple-touch-icon` at the preset's pre-rendered `icon-32-<accent>.png` / `icon-touch-192-<accent>.png`; the Dock and launchers read the manifest's PNGs, so its `icons` are rewritten to `icon-192-<accent>.png` / `icon-512-<accent>.png` / `icon-maskable-512-<accent>.png` the same way (all rendered from `icon.svg` by `just icons` — `scripts/render-icons.ts`, `@resvg/resvg-js` fetched by npx, not a dependency). An installed app keeps the icon it was installed with |
| `GET /app/*` | the rest of `src/web/public/` — hashed bundles (`immutable`), `sw.js` (`no-cache`: a cached worker is a released fix that never ships), the PNG icons. The workbench lives under `/app/` because a manifest `scope` is a path prefix with no exclusions: at `/` an installed Pier would capture `/boards/*`, `/b/*` and `/p/*`. Hash routes are `/app/#/…`; `/api/*`, `/login`, `/boards/*`, `/b/*` and `/p/*` stay where they are, and the cookie's `Path` stays `/` |

- **Unread**: `streaming → idle` marks the session unread when no durable
  conversation row exists (`conversations.keyOf`) and no task run made the
  session for itself, and only for a turn of the head or
  one the operator sent into (a message, an edit, a queue delivery); a lead's
  dispatch or callback turn finishing reports through the head and marks nothing.
  One flag, read by the dot, the badges and Web Push.

Other route owners: `auth.ts` (`/login`, `/login/:token` — the `pier login` link,
[08-cli-socket.md](08-cli-socket.md) — `/logout`, `/api/password`,
`/api/devices*`), `passkeys.ts` (below), `config.ts` (`/api/config*`), `config-sync.ts`
(`/api/config-sync`; `/config-sync/:token` is served before the password, the
token being its guard), `packages.ts` (`/api/packages*`; a file of its
own because the registry is not agent-file editing), `fs.ts` (`/api/fs/{ls,file,exists,mkdir}` and the
containment check; `/api/sessions/:id/files` shares only its size cap and
headers), `explorer.ts` (`/api/explorer/{git,diff}`, read-only), `instance.ts`
(`/api/settings`, `/api/update`, `/api/secrets*`, `/api/client-log`),
`providers.ts` + `provider-flows.ts` (`/api/providers*`, including the probe
that sends one real request), `push.ts` (below),
`channels/routes.ts`, `vault.ts` (`/api/vault*`), `tasks/routes.ts` (`/api/tasks*`), `boards/boards.ts` (`/api/boards*`, `/boards/*`, `/b/*`, `/p/*`).

## Passkeys (`src/web/passkeys.ts`)

WebAuthn on `node:crypto` and a ~60-line CBOR decoder; no dependency, no
attestation check (the operator registers their own authenticator from a page
they are already signed into). The store is read live, no cache: while one
row exists in `passkeys`, `POST /login` and `POST /api/password` answer 403
and `GET /login` renders only **Sign in with a passkey** (inline script, no
bundle; "This browser has no passkey support." without
`window.PublicKeyCredential`). Removing the last passkey re-enables the
password without a restart. Challenges live in memory for 5 minutes, single
use, at most 100 outstanding.

| Route | Behavior |
| ----- | -------- |
| `GET /api/passkeys` | `{enabled, reason?, passkeys: [{id, label, createdAt, lastUsedAt, transports}]}`; never the key. `enabled` is "`publicUrl` starts with `https://`" — RP ID is its hostname, expected origin its origin |
| `POST /api/passkeys/register/options` | `PublicKeyCredentialCreationOptions` with base64url binaries: 32-byte challenge, a 16-byte user handle minted once (`settings.passkeyUserId`), ES256 and RS256, `residentKey`/`userVerification: "preferred"`, `attestation: "none"`, `excludeCredentials` = the stored ids; 409 with `reason` when not enabled |
| `POST /api/passkeys/register/verify` | the credential JSON (`{id, type, response: {clientDataJSON, attestationObject, transports?}, label?}`): `webauthn.create`, challenge, origin, rpIdHash, UP flag, COSE key → JWK; `attStmt` is ignored whatever `fmt` says. `label` ≤80 chars, default "a passkey". 201 with the `GET` shape; 400 names what failed; 409 when already registered |
| `DELETE /api/passkeys/:id` | the `GET` shape; 404 |
| `POST /api/passkeys/login/options` | unauthenticated, on the password's throttle: `{challenge, rpId, allowCredentials, userVerification: "preferred", timeout}`; 409 when disabled or none registered |
| `POST /api/passkeys/login/verify` | unauthenticated, throttled: `{id, response: {clientDataJSON, authenticatorData, signature}, next?}` → `webauthn.get`, challenge, origin, rpIdHash, UP, signature over `authenticatorData ‖ sha256(clientDataJSON)` with the stored JWK; a sign count `≤` stored, unless both are 0 (an authenticator that never counts), is a cloned authenticator: 401 and an error log line. Success updates `sign_count`/`last_used_at`, opens the session exactly as `POST /login` does (same cookie, same device row) and answers `{next}` (`safeNext`); every refusal counts toward the throttle |
| `PUT /api/settings {publicUrl}` | 400 `passkeys are bound to <host>; remove them first` when the hostname would change or https drop while a passkey exists (`instance.ts`) |

Security card **Passkeys**: the rows in the device row (label, `added <ago> ·
last used <ago>|never used · transports`, **Remove**), "No passkey is
registered." when empty, a label input and **Add a passkey**; without an https
public URL one dim line with `reason` and no form. While any passkey exists the
Password card is hidden and this card says why. Failures on the status line.

## Notifications (`src/web/push.ts` + `src/web/webpush.ts`)

Web Push: Chrome and Edge on desktop, iOS/iPadOS 16.4+ once Pier is on the Home
Screen. Composed in `main.ts` as a second consumer of the event stream.

| Route | Behavior |
| ----- | -------- |
| `GET /api/push` | `{publicKey}` — the instance's VAPID public key, what a browser subscribes with |
| `POST /api/push/subscribe` | a `PushSubscription` (`{endpoint, keys:{p256dh, auth}, label}`) → stored; upsert, so a browser re-posting on every load repairs a lost row. 400 on anything that is not one |
| `GET /api/push/subscriptions` | `{devices: [{endpoint, label, createdAt, current}]}` — every subscribed device, `current` on the row the calling session saved; never the keys |
| `POST /api/push/unsubscribe` | body `{endpoint}` → forgotten |
| `POST /api/push/test` | send a test notification to every subscribed device, `{sent, failed}`; 409 when none is subscribed |

- `streaming → idle` starts a 6s settle window; a session *still* unread when
  it closes is notified. Sessions answering an IM conversation
  (`router.conversationOf(id)`) are not.
- `webpush.ts` is the wire format — RFC 8291 `aes128gcm` and RFC 8292 VAPID on
  `node:crypto`, the RFC's worked example as the golden test. No dependency.
- Only 404/410 costs a subscription; every other failure is logged with the
  push service's answer (principle 5).
- `sw.js` is registered with scope `/app/`; it caches nothing, its one `fetch`
  handler is a navigation fallback inside that scope, and a notification only
  ever opens a same-origin URL (anything else opens `/app/`).
- One VAPID key pair per instance, minted on first use, never rotated on its
  own; the private half is sealed by `Secrets` in `push_identity`.
- The Notifications card lists every subscribed device under the switch, in
  the Security card's device row (label, `subscribed <ago>`, **This browser**
  on the caller's own, **Remove**), refetched after every change; removing this
  browser's row also unsubscribes it locally, so the next load does not
  re-register it. Shown even where this browser cannot subscribe.
  "No device is subscribed." when empty.

## Frontend (`src/web/ui/`, Vite + Tailwind, vanilla TS, no framework)

`src/web/ui/` (index.html + main.ts + style.css) builds via Vite to
`src/web/public/` (gitignored). Custom classes live in `style.css` (`.btn`,
`.select`, `.md`, …). `npm run dev:web` gives HMR with an `/api` proxy to
:3141; `tsconfig.web.json` is the typecheck gate.

`main.ts` orchestrates session state, SSE streams, routing and the header; `session-header.ts`, `drawer.ts`, `palette.ts`, `chat.ts`, `composer.ts` and the Console views receive explicit deps and never import main back. No state, router or component library. Unread state lives in `web/session-state.ts`.

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
- A failed turn's reason is an error row live (the `error` event) and after a
  reload (the history turn's `error`); a prompt Pi refuses before its turn
  begins (no model, no key) is written to the transcript as a failed turn, so
  a head the send just created still shows the message and the reason.
- Assistant markdown: `marked` + DOMPurify, `@tailwindcss/typography`.
  Provisional text paints incrementally in the work log; the final bubble
  renders markdown, attachments and next-step controls. User/error rows are
  plain text.
- Auto-scroll sticks to the bottom only when already near it; own sends
  force-scroll.

### Bar and status panel (`session-header.ts`, `drawer.ts`)

- The single column has one bar, the only chrome: the transcript runs the full pane under it. Pier shows its title (opens Session info); a child session shows ‹ (back to `#/conversation`, wearing the head's dot when it is streaming or unread), its title — the run's `--name` — and the lead's `phase` tag.
- The status chip reads `N running · M needs you`, the panel's `running` and `waiting on you` rows counted, and opens the status panel; with rows but neither count (only `pending release`, `stopped` or `queued`) it reads `K open`, the row count; with no rows it is absent and the panel cannot open. The app icon badge counts only a turn to look at — a design not yet reported final and an unread turn (**Unread** above) outside the conversation — plus the conversation's own unread reply.
- Context chip: Pier shows only its used tokens, amber ≥ 70% and red ≥ 90% of `rotateAt` (`GET /api/continuous`), the size past which the next message starts a new session; Session info reads `used/rotateAt`. A child session shows model · reasoning · used tokens, toned against `compactAt`, and they open model selection; below md its context shows only from 70%.
- The ⋯ menu contains Search ⌘K, Session info, System prompt, Browse files, Model & reasoning…, and Settings; Search is shown on Pier only. Session info, System prompt and model actions are disabled before the first reply.
- The status panel is the one place the web shows what is going on: one flat list, no group heads, the rows `waiting on you` first and the rest after in `/status`'s order ([10 §Open items](10-continuous-session.md#open-items)).
- One row per session: the open items (`GET /api/continuous/open`), then its unlisted runs, then the live sessions outside Pier none of them holds. A session is live while streaming, while a run targets it or while runs it launched are in flight, while its last turn is unread, or while its design waits on Finalize. A failed run's callback reaches the head, so a failure is the head's unread, never a row.
- Every row reads the same: a dot, the name (an item's problem, a run's or session's title) and one second line with where it stands, then a status tag on the right unless the row is `running`: `waiting on you` (white on amber-700, the one solid tag, the one that asks something), `pending release`, `stopped` or `queued`. A row sorts first only with `waiting on you` (`waitsOnYou`, a session's by its mark), and the chip and badge count by the same predicate. An item's status is the server's (`openStatus`, [10 §Open items](10-continuous-session.md#open-items)).
- An item's dot is its topic's colour and an unlisted run's grey, pulsing while one of its runs is `running`; its second line is its stage, or its runs (`run <id8>… <state> <age>`) when it names none; the runs, who works them and their cwd are the row's tooltip. A session's dot is its mark (`stateDot`), its who (`lead · <phase>`, an IM session's channel) a tag, its second line `working`, `N subagents running`, `run queued`, `turn finished — not viewed yet` or `design — finalize when it is ready` with `active <age>`.
- Re-read on `sessions-changed`, `task-run-changed`, `open-items-changed`, and a state change of a session an item holds.
- An item row opens the conversation, waits for a load already on its way, and reveals its topic's latest reply on screen (`revealTopic`, the search hit's ring); with none on screen the row opens its first run's session, or with none the pane scrolls to its tail. A reader who opened another session meanwhile is left there. Any other row opens its session in the column (`#/session/<id>`), an unlisted run with no session the conversation. Either closes the panel; viewing marks it read, so an amber row leaves. Reload lands where the hash says; a bare or unknown hash is the conversation. A child session takes messages on `POST /api/sessions/:id/messages` like any session.
- The panel is a 32rem popover under the status chip at widths of 640px and above, and a bottom sheet below 640px, with `menu.ts` focus, inertness and backdrop behavior. The chip or ⌘⇧P opens it; ↑↓ walk, ↵ opens, Esc closes and returns focus to the chip.
- Counts and rows share `drawer.ts` state; session and open-item changes refresh the panel and the palette's dots.

### Search palette (`palette.ts`, ⌘K)

- Empty query: Pier, Recent and Actions; what is running is the status panel's, not the palette's. Pier is always first, with the head's dot — the one way back from anywhere. Recent is the sessions not live (finished leads, IM sessions, earlier chain members); Actions is Settings and its topics. On a phone the palette is the ⋯ menu's first item.
- Typed query: Pier when "pier" or "conversation" matches, Settings actions, named sessions, then content hits from `GET /api/search?q=`. Content hits search user messages and replies, not steps.
- Whitespace splits the query into terms; every term must match. Local rows render immediately and content search starts after 80ms.
- A content hit opens the session at the matched turn when it remains in the transcript.
- Keys: ↑↓ / ⌃N ⌃P / ⌃J ⌃K move; ↵ opens; Esc or backdrop closes.

### Menus (`menu.ts`, `model-picker.ts`)

- One menu primitive allows one open panel at a time. Outside pointerdown, wheel or focus, Esc, and a scroll that moves its anchor close it; the page's own scrolling (the transcript pinning a reply) does not. Below 640px it is a bottom sheet with a title, close control and dismissing backdrop.
- Menus support arrow keys, ⌃N ⌃P, ⌃J ⌃K, Home and End; focus returns to the trigger on dismissal. An open menu owns list navigation keys.
- The bar menu provides Search, Session info, System prompt, Browse files, Model & reasoning… and Settings. The model picker groups options by provider and supports reasoning selection.
- Session info shows directory, ID, model, reasoning, context and times, with copy controls for directory and ID.
- System prompt (`system-prompt.ts`) is a read-only modal dialog: the estimated total, one block per source with its label, path and share, and a Copy of the whole text; it opens before the read lands and says in place why it has nothing to show. ✕ or Esc closes it.

### Chat pane (`chat.ts`, `composer.ts`)

- Transcript: text streams into the turn's bubble under its chip row; a
  tool/reasoning boundary moves it into the steps log as a progress row;
  `turn-end` fills the bubble with the final answer without duplicating it.
  Snapshot reconstruction folds intermediate assistant messages, preserving
  user/system boundaries. Gap/day separators carry an age refreshed every
  minute; exact timestamps on hover.
- **Turn bubble**: every agent turn is one reply bubble (`chat.ts`
  `chipInto`, `data-pending` until its body lands). At its top, one **chip
  row** (`.chip-row`) — the topic tag first, then one chip per thing the turn
  did, in arrival order, no summary, no cap: a cause (a callback, delegation,
  task message — `data-cause`, never a user message), a steps group
  (`N steps · <secs>`, one per stretch of work, a steered input between two;
  live `⟳ N steps · <secs> · writing…`; `failed · …` red, `interrupted · …`
  amber), a launched run. Under the row the body: the reply, `Stayed silent
  — <reason>`, an error on its own material, or nothing for a turn cut short
  before it spoke. The bubble opens at the tail with its first chip or delta;
  the body fills it; a run launched after the reply joins the row's end; a
  user bubble in between leaves a chip-row-only bubble where it was. An
  error is the body only once nothing is in flight — no text streaming, no
  steps group open; a turn's own failure arrives as `turn-end` with `error`
  and then the `error` event, in that order, so the turn-end closes the
  group and the row that follows is the result. One reported mid-flight (a
  notify failure, a title fetch) is a bare row above the bubble, which
  stays pending, its group untouched. Replay builds the same bubbles
  unanimated; a failed turn's steps chip is red live and replayed alike,
  a tool it cut short included. A reply with no chips has no row; a
  chat command's answer is its own open card, never a turn's.
- **Chips** (`turn-activity.ts` `chip`): each is the button (`aria-expanded`)
  over its own detail, laid under the row in chip order — the cause's card,
  the steps log, the run's head and prompt. Every chip starts closed and
  opens only by its click, closing the row's other open chip (one detail
  per bubble; other bubbles keep theirs); opened details persist across a
  run's status updates. Cause chips: `↩ callback · <state> ·
  <run name>`, `↗ delegation · <run name>` (the glyphs are `ui/icons.ts`
  icons), a failed callback red, an interrupted one amber. Run chips: `run ·
  <state> · <run name>`, live across states. Mode, duration, `N queued`
  (`queuedMessages`), the `tier · model id · reasoning` badge (each part only
  when recorded; below md a tiered badge without its id, its tooltip has it)
  and `<id8>` — the other session's id, a link to it, else the run id as
  text — are the opened head's, never the chip's. The steps log: thinking,
  progress, tool rows; tool rows reveal args/output, thinking rows
  tail-capped text; an opened log scrolls independently and follows its
  tail; simple replies leave no empty log; interrupted work stays visible. A
  replayed log whose detail is still on the server (`data-lazy`) fetches it
  on its first open, once. A compaction (Pi's automatic one) leaves one
  system line, `context-compacted`, the only trace it leaves anywhere (§5).
- **Task communication**: runs launched by `pier task run` are run chips of
  the bubble that launched them, updated from `task-status` events; the
  status panel lists the runs still in flight. The message's
  creation, delivery and expiry each emit `task-status`. Delegation and
  callback inputs are cause chips with a Session link in the head, never
  user messages.
- **Next steps**: a reply's trailing `[label]` line is a row of buttons at
  the bubble's bottom, the only row that sends; a click sends the label as
  a Reply to that bubble (`withQuote`), the composer's own staged quote
  untouched, and the picked row goes away. The last reply of an idle
  session has the live row (indigo). Any other reply's row is muted
  (neutral, `aria-description` "option from an earlier reply") and shown
  only while it is its topic's (`replyTopic`) newest reply on screen and
  that topic is an open item; a reply with no topic shows none. Re-checked
  when the items change and on every reply; a running snapshot's last reply
  is an earlier one.
- **Topics**: a reply whose `<topic>`/`<open>`/`<done>` names an item
  (`replyTopic`) is tagged with its problem — a label in a stable hash of the
  problem's colour (`topics.ts` `topicHue`), the only place the colour is on
  the row; the user message above it inherits; untagged rows carry nothing.
  The tag is the problem alone; the stage is the status panel's. While the
  item's status (`GET /api/continuous/open`) is `waiting on you` its tags
  carry an amber-700 dot (the panel's `waiting on you`, not the unread
  dot), until the user answers: a user message after the topic's newest
  reply on screen that comes before any other reply, or Replies to a row of
  it (a next-step pick included), a session divider between them or not. A
  later reply of the topic dots it again only once the items read after it
  still say `waiting on you` (every `<open>` emits `open-items-changed`, and
  a head's turn end re-reads them). An item waiting on a child session's
  design is answered there, yet a message in the main chat clears its dot.
  Repainted when the items change and on every message. The tag truncates,
  its title the full text. A click
  reveals the topic's previous reply on screen; the earliest one lights
  itself. On a coarse pointer the tag's hit area is 44px tall, like a chip's,
  without growing the tag.
- **Edit**: any user message; sending rewinds the transcript to it and the
  editor says how many messages that drops. Esc cancels, Enter submits,
  Shift+Enter newline; new input cancels a stale editor; the API rejects a busy
  session and an index the transcript no longer holds.
- **Reply**: every user and assistant row has a Reply control in its gutter
  (`.message-tools`, beside the pencil); pressing it stages that row over the
  composer (`#quote-strip`, per session like the attachment strip, `×` drops
  it) and the send wraps the text with `withQuote` (`core/identity.ts`): a
  `[re <role> <yyyy-mm-dd hh:mm>]` line and a `>` block of the source's first
  240 raw characters, under the speaker header and above the words — text,
  so it survives reload, edit and rotation with no field, and reaches the
  model as its own convention (`agent/roles.ts`). A next-step button never
  takes it. A user bubble renders the quote as a block above its words — role
  and minute, the excerpt clamped to two lines, a neutral grey bar — and a click reveals the source
  (`quoteSource`: same role and minute, then the row whose text opens with
  the excerpt); a source not on screen leaves the block inert with a title
  saying so. Only user messages carry quotes.
- **Pier**: the head's snapshot under earlier sessions
  paged in read-only (no pencil, no next-step buttons), each closed by a
  divider naming the rotation. **Earlier session**, or scrolling to the top,
  pages one more in whole, keeping the reader's position, the pane as it is until
  the head's snapshot is back, and keyboard focus on the pager; the trim cap
  stands down meanwhile. Sends take the alias route; a send whose 202 names
  another head, or a rotation seen on `sessions-changed`, moves the pane to
  the new head, the session just left paged in above. A seed is a system input card linking the previous session,
  folded into the divider above it (`folds.ts` `foldSeed`; `new session · <reason>` where there is none);
  a `/status` answer is a card of the same material whose every `run <id8>…`
  links that run's session, from the run → session map the answer carries in
  its origin (`sessions`), so a reloaded transcript links the same;
  an empty chain's pane says the first message starts it.
- **Composer**: **Send** = `mode:"auto"`, **Send now** = `mode:"steer"`
  (streaming only), **Stop** = abort (streaming only). Enter sends, never during
  IME composition (`isComposing`/229).
- **Completion**: a draft
  that is `/` followed by a prefix with no whitespace lists, above the input,
  one flat list — the chain commands (each line from `CHAT_COMMANDS`; the
  table is [11 §Chat commands](11-im-conversation.md#chat-commands)) only in
  the head, then
  `/skill:<name>` for every skill on the snapshot's `skills`, its
  `description` as the line. A row matches on a prefix of its word or of the
  skill name alone (`/pier-t` → `/skill:pier-tasks`). The exact word of a chain
  command hides the list and Enter sends it; a skill word is never exact. A
  chain row fills `/word`; a skill row fills `/skill:<name> `, whose trailing
  space closes the list for the ask. No skills and no chain commands, no list.
  The skills are the snapshot's — the set Pi will expand for this session, so
  a skill switched on appears when the session is next opened, and
  `disable-model-invocation` skills are listed; the composer reads no
  `GET /api/packages`.
  The textarea keeps the caret: ↑/↓ (and ⌃N/⌃P) walk, Enter or Tab fills, a
  tap on a row does the same without blurring the textarea (a finger that
  moved is a scroll, not a pick), Esc closes the
  list until the draft changes. Rows are the palette's (`.palette-row`, the
  `bg-indigo-50` selection), word in mono, line truncated, `role=listbox`/
  `option` with `aria-selected`, 44px on touch; past eight rows the list
  scrolls inside itself.
- **Queue panel**: `queue-state` snapshots with mode chips; **Send now**
  (steer), **Abort & send** (abort, fresh prompt), **Recall all** (append to the
  composer draft). Queued messages join with newlines.
- **Attachments**: paste, drag-drop, `+` → pending strip; each file goes to
  `POST /api/inbox` as it is attached, and on send its `[name](file:///…)`
  marker joins the text, so sent, optimistic and echoed text are identical and
  Enter does not wait on the upload. A file removed before sending stays in
  the inbox. The strip is per session, in memory only. User bubbles strip
  markers and render them via `web/ui/attachments.ts`; images open in the
  lightbox.
- **Speaker caption**: a user bubble whose text opens with the speaker header
  (`core/identity.ts`) shows the name above the message and, when the session
  answers an IM, the channel beside it in muted uppercase (`qiqi` `LARK`); the
  header itself is stripped from the bubble. The operator's own web messages
  carry no caption.
- **File references**: an inline code span that is a path with an extension —
  `src/web/ui/chat.ts:481`, and a bare name only when the extension is a
  file-ish one — opens the Files dialog on it, at the named line when it names
  one (the line tinted and centred; in a diff, the new side's number).
  Under a filesystem root (`~`, `/home`, `/tmp`, `/etc`, …) the extension is not
  required, so `~/.pier/boards` is a reference too; `~` expands to the home the
  listing route reports. Relative paths resolve against the cwd of the session
  that wrote them: a reply's against its session's, a one-run callback card's
  (whose plain-text body links its `` `path` `` spans too) against the run's,
  carried as the origin's `cwd`; a batch callback has none, so its relative
  paths stay plain. A reply relays its children's paths as they were written,
  so one with nothing under the session's cwd tries the cwds the
  conversation's earlier callback cards carried, most recent first, and the
  first that exists wins; the chat forgets them with the transcript. A
  reference is drawn only once `POST /api/fs/exists` (`{paths}` →
  `{exists: boolean[]}`, one request per render batch, every candidate in
  it) says something is there — no dead links; a failed check leaves them
  plain and is reported in the chat. A path under the cwd it resolved from
  opens with that cwd as the tree's root, anything else with
  its own folder as the root; a folder lands there, a path with no row reads
  "No such file: <name>". An attachment card's eye opens its file the same way.
  A pointer press leaves no focus ring on one; a keyboard focus does.
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

Settings is an overlay route: it opens over its origin, and ✕ or Esc returns to it. It is a full-column view whose header carries `#version` and `#theme-toggle`; `views.ts` owns the route. Files is a modal `<dialog>`, not a route: it stacks over the chat or Settings, and ✕ or Esc leaves what is under it as it was.

- **Settings**: cards or panels on the canvas. Channels: segmented platform
  switch, sticky in the topic's scroller; the chats card names the current bot
  and lists one row per chat under a first row for the platform default. A row
  folds to one line — chevron, name, kind badge, `<cwd> · <model> <thinking>`
  resolved (a value followed from the default grey, one set on the row ink),
  and a chat's enable switch; on a phone the summary takes a second line. The
  chevron opens it in place to its switches (the default's are the seeds),
  directory, model & reasoning, `Reset to default` while anything is set, and a
  chat's id and Remove (confirms); folding it shows the result. The default's
  directory and model are read-only — the GET's `defaults`, resolved
  server-side on every load — with "Change in Settings" to
  `#/settings/models`. A chat field left empty reads `Default (<resolved value>)`. A row whose owner differs wears an amber badge and, open, a
  one-line stale reason; while any row but the home DM is stale the card ends
  in `Clear stale (N)` (confirms). A DM row carries "This DM is the conversation"
  ([11](11-im-conversation.md)); on, the row's summary, directory and model
  give way to one line pointing at the conversation's ⋯ menu. Vault (`#/settings/vault`): the
  rows `name · level · updated` with Remove (confirms), and the add row —
  name, `auto|approve` segmented with its one-line note, a password field;
  no reveal, filing an existing name replaces it. `?name=X` opens with the
  name filled and the value field focused: the link an agent's `no secret
  named X` error carries. Tasks (`#/settings/tasks`): one row per task —
  name, last run's state and age, trigger and next run — with the pause switch
  (not on manual tasks) and Runs, which opens the newest 20 as rows (state,
  time, source, duration) whose log (error, result, probe, a link to the run's
  session) unfolds in place; defining a task stays `pier task`'s. Boards
  (`#/settings/boards`): one row per board — title linking where it is
  readable, slug, age — with a Public switch, Copy link and Delete (a rename,
  no confirm). A refused switch redraws from the server and says why. Agent: two panels (what a session is
  made of / what the selected item affords), Scope in the Console's control
  skin. An agent file opens in `code.ts`'s viewer; **Edit**/**View** swap,
  rendering the editor's own text; Save keeps `expected` for the conflict check
  and reports saved / unsaved / failed. A file the index marks `readonly`
  (settings.json, written by Pier) opens in the viewer alone with one line on
  where its keys are set. Models: Default model is the launch picker written on
  change, redrawn from the server's answer; a pinned row's ∧/∨ arrows move it,
  staged like any menu edit until Save, since the stored order is the one every
  picker and `pier task --model ?` list; a row's tier select (none /
  hardest / balanced / cheap) puts it on that tier: the first row on a
  tier is what `--model <tier>` takes; Pin model offers
  the whole catalog, so one model may be pinned at several levels (each row its
  own tier), and only the same model at the same level twice is refused; a refused save
  shows the server's error, which names the row and field. Instance: Public URL, Accent (a
  swatch radio group over `GET /api/settings`' `accents`; a pick sets
  `<html data-accent>` at once and `PUT {accent}` behind it, reverting on a
  refusal), the browser's notification switch, Reload.
- **Files** (`explorer.ts`, `#files-dialog`; ⋯ Browse files and its chord,
  Agent → Browse files, and a chat file reference all open it, on the current
  session): a directory tree beside a viewer; in a git checkout the
  tree filters to the picked diff's files and unfolds to each change (up to
  `MAX_AUTO_EXPAND` folders); elsewhere only the root's own folders unfold —
  one level down may be `node_modules`. A selected path opens with its
  ancestors unfolded, its row marked and the diff filter off. Without a
  repository (`GET /api/explorer/git` answers `branch: null`) the branch chip,
  the whole compare band, the changed-only funnel and the diff stepper are
  absent, and an empty folder reads "Empty." rather than "No changes." — the
  filter is not in force. A `.md`/`.markdown` file shows rendered through the
  chat's markdown (sanitized, highlighted, code copy) with a Rendered/Source
  switch in the viewer band; Source — the numbered lines, or the toned diff for
  a changed file — holds for the dialog's life, and a reference naming a line
  opens on it. A changed file renders the diff's head side (the old side when
  deleted); relative images load through `GET /api/fs/file` from the file's
  folder (a leading `/` is the project root), relative links open in Files,
  `#anchors` scroll to the heading, URLs open a new tab. A PDF shows inline in the viewer's frame:
  `GET /api/fs/file` answers `X-Frame-Options: SAMEORIGIN`, every other
  response `DENY`. On a phone the dialog is full-screen, inside the
  safe-area insets, tree above viewer.

  The Agent nav, drawn from one `GET /api/packages` answer. The management
  unit is the **package** (a source); its resources are the extensions and
  skills it provides; a resource has one switch wherever it is shown. The
  managed binaries are one more source, `tools`, drawn from `GET
  /api/settings` and installed by ubix, not Pi.

  | Section | Rows | Actions |
  | ------- | ---- | ------- |
  | Instance | Configuration sync | |
  | Files | the whitelisted agent files; settings.json read-only | |
  | **Packages** (tree) | one row per source: built-in `pier` (Pier's own skills `pier-boards`, `pier-help`, `pier-search`, `pier-slack`, `pier-tasks`, `pier-vault`, `pier-web`; version = Pier's), `local` (`<agentDir>/extensions`, `<agentDir>/skills`), then each installed npm/git/path package; `on` when any resource is; `installing…`/`updating…` on the `busy` one; a configured-but-uninstalled source reads dim. A chevron expands the row into its resources grouped `extensions` / `skills`: name, dim when off, the `state` as a second line (never hover-only), a kind badge only when the same name occurs twice in the package; `pier` and `local` start open, the rest closed, and the fold state survives redraws for the session; picking a resource from a pane opens its package | package pane: source, kind, version, install path, the provided resources each with its switch; for an installed npm/git/path package also **Updates** (checked-at, **Check for updates** — a failed check keeps the last answer), **Update** (npm/git), **Remove** (confirms); while `busy` the buttons are disabled; a refused operation shows the server's `error` in the status line; header action **Add package**: spec input, Pi's security note (packages run with full system access; review the source first), **Install** — the row appears as `installing…` at once and the list is refetched on the answer. Resource pane: the same switch, the `state` line, its package, and the file through `GET /api/fs/file` (a bundled extension has none); a flip here redraws the tree row. **Browse files** (package pane beside the install path, resource pane beside the file's path; absent where there is no directory) opens Files on the package directory, a skill's directory (`SKILL.md` selected) or an extension's file |
  | **Packages** › `tools` (global scope only) | after the packages, open by default: one row per managed binary, `rtk` among them — dim when off, the install error as a second line, `yours` on an operator's block; `on` when any tool is | tools pane, from the source row or a tool (that tool's row marked and scrolled into view): each tool with its switch and binary line, **Remove** on the operator's own, the custom block editor |

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

  Configuration sync (`src/config-sync.ts`; Agent › Instance › Configuration
  sync): one instance publishes, another follows.
  - The document, `GET /config-sync/:token` (no password; the 64-hex token is
    the capability, rotated by Publish, dropped by Revoke): `{schemaVersion,
    instanceId, agent: {files: {SYSTEM.md, AGENTS.md}, providers, defaults},
    modelMenu}` — `providers` without `apiKey`, `headers`, `baseUrl`;
    `defaults` the settings.json pair. `SNAPSHOT_FILES` (`agent/types.ts`)
    is the file list. Publish and subscribe are exclusive per instance.
  - `POST /api/config-sync {action: publish|revoke|subscribe|pause|sync}`
    (`url` with `subscribe`; HTTPS only, not this instance's own link);
    `GET` the `ConfigSyncStatus` (`web/types.ts`). The subscription is the
    hourly task "Configuration sync" (`config-sync-task.ts`), on while
    `enabled`; no sync at boot.
  - The source is the authority. Every sync downloads the whole document and
    replaces every field it carries — the three files, the defaults, the
    menu; a local edit made between two syncs is put back. Each file is
    replaced atomically (temp file, rename); the files are replaced one by one,
    then the menu and the sync record commit in one database transaction. A
    failure the process catches rolls the files already replaced back to their
    previous content (a rollback that itself fails refuses every further write
    until the operator repairs the files and restarts). A process that dies
    between two renames, or after the last one and before the commit, is not
    rolled back: the files it replaced are new, the rest and the menu are old,
    and `lastApplied` does not move. Nothing detects that at boot (no sync at
    boot); the next hourly sync, or Sync now, re-applies the whole document,
    which is the repair. While `enabled`, the Console shows those
    fields as stored and takes no edit: `PUT /api/settings {modelMenu}`,
    `PUT /api/config/defaults` and `PUT /api/config/files/<synced>` (global
    scope) answer 409 `Managed by the configuration subscription…`; the
    `/api/config` index marks such a file `managed`, and the Models cards
    and the file viewer carry the one note. Pause to edit. The title model,
    the public URL and project files are the machine's, never synced.
  - Version gate: `schemaVersion` is `CONFIG_SCHEMA_VERSION`, bumped by any
    change to the document's shape (a menu row's fields included). A
    subscriber applies only its own version; any other pauses the
    subscription (`enabled: false`) with an `error` naming both versions,
    shown in red on the panel until the operator upgrades the older instance
    and resumes. No field-level compatibility, no merge.
  - `rtk` is a tool, shown once: its ubix hooks write and remove
    `<agentDir>/extensions/rtk.ts`, so that file is no `local` row and its
    one switch is the tool's.
  - An enabled skill Pi will not load — frontmatter that does not parse, a
    name another skill already took — reads `not loaded — <Pi's diagnostic>`
    beside a switch that stays on. The verdict is Pi's own `loadSkills` in
    Pi's order, where a package's skill shadows Pier's own of that name.
  - After any package or switch write, idle sessions are recycled as for an
    agent-file save; sessions mid-turn keep what they opened with.
  - One switch, one write: the `pier` package's skills flip through
    `PUT /api/packages/resource` like every other resource; `PUT /api/settings`
    carries no `skill` key.

## Tests

- Backend: vitest + a fake `AgentFactory`/`AgentSession` (the shared one:
  `src/core/session.testkit.ts`). Cover: message → router → session call; SSE replay from
  `Last-Event-ID`; abort route.
- Frontend: Vitest in `src/web/ui/*.test.ts` on the shared fake DOM
  `src/web/ui/dom.testkit.ts`, plus browser interaction checks
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
- A turn that says nothing still renders `Stayed silent — <reason>`, its
  bubble (`data-silent`) and the silent ones right after it folded under one
  `· N background updates` line (`folds.ts` `foldSilence`, recomputed from the
  rows), closed until clicked; missing
  replies and failures never look like blank content or deliberate silence
  (principle 5).
- `overflow-hidden` on a card clips any popover inside it. The document never
  scrolls; every scrollable region is an inner pane with sticky headers.
