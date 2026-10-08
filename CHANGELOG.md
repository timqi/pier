# Changelog

## Unreleased

### Upgrade notes

- Public boards move to Cloudflare Pages: `/p/<slug>-<token>/` no longer serves anything — an old link meets the login form — and the `token` field is retired. Install `wrangler` with Cloudflare credentials in the shell agents run in, enter the Pages project name in Console → Boards, repoint every board's stylesheet link (`sed -i 's#/p/_assets/pier.css#/b/_assets/pier.css#g' ~/.pier/boards/*/site/*.html`), then have any session run `pier boards publish`; it creates the project, pushes every `public: true` board and writes each manifest's `url`. Links already sent out must be replaced with the new ones.

### Changed

- Boards: `pier boards publish` pushes every public board as one snapshot to the instance's Pages project, prunes older deployments, and writes `url`/`publishedAt` into the manifests; Pier itself serves no board without the password. The Console's public switch and `PATCH /api/boards/:slug` are gone; Console → Boards holds the Pages project and address and names each board's state, a deleted board that is still live included. The stylesheet is at `/b/_assets/pier.css`, the same path inside the snapshot. A withdrawn board's paths are redirected away for 7 days (`withdrawnAt`), because Pages' edge keeps serving a removed path's cached copy that long ([05-boards.md](docs/design/05-boards.md)).
- Boards: Console → Boards → Publish runs `pier boards publish`'s flow in the service with the `wrangler` on its PATH, streams wrangler's output and the published URLs, removed slugs and deployment into the card, and refuses a second publish while one runs; Pier never handles a Cloudflare token. `pier boards publish` no longer needs `PIER_SESSION_ID`, so it runs from any shell.

## 0.4.13 — 2026-10-07

### Upgrade notes

- The database migrates to schema 38, one-way: it drops `item_receipts`; 0.4.12 refuses the upgraded database, so keep the backup Pier takes if you may roll back.

### Changed

- Upgrade the Pi coding agent dependency to 1.0.4.
- Workers run with Pi's `codemode` tool and its tool-call guidance, unless the `workerCodemode` setting reads `"0"` ([deploy.md](docs/deploy.md)); `pier task stats` counts each run's tool calls, a codemode script's included.
- A worker compacts at 180K and a lead at 200K; the role prompts share one vocabulary, a worker gets one step with one deliverable, and the head's notes keep decisions, preferences, external facts and owed steps.
- Tasks: a `--run` continuation of a compacted or near-full session, or one with `--fresh`, opens a new session briefed with the task, last report, branch and latest review; a concurrent `--run` is refused.
- Tasks: a review ranks a change not as simple as it can be P1 and code harder to read than it needs P2; the head sends a clean review's behaviour and readability P2s back to the branch before asking the merge.
- IM home chat: no reactions — the open items card is only edited, a design final re-posts it once after its root was edited, and a silent turn that settled a message says so; the startup sweep clears a leftover 👀 from a quiet chat; open items carry no web links.

## 0.4.12 — 2026-10-06

### Changed

- Tasks: review severity follows the reviewed repository's stated threat model; a clean review's P2/P3 list is filtered by the head instead of relayed verbatim.
- Tasks: the review runs the project's checks and installs without touching a tracked file, leaving the tree as found; a small or follow-up fix gets one review round, and `--rounds 0` on `--run` resumes plainly.
- Tasks: the head reruns the checks before merging past the reviewed sha or after `wt merge` reports `Rebased onto`.

## 0.4.11 — 2026-10-06

### Changed

- Tasks: only P0/P1 review findings earn another goal-loop round; P2/P3 are returned to the user as review findings and design suggestions.

## 0.4.9 — 2026-10-04

### Changed

- Code changes: a branch merges with `--no-squash`, its commits landing as they are; workers squash WIP and fixups before their run ends, a fix round folds into the commit it corrects, and a review flags a WIP or fixup commit.

## 0.4.8 — 2026-10-04

### Changed

- `/status` answers mid-turn instead of waiting for the turn to end; a retried model request is told once.
- IM status: `/status` posts the new card first and deletes the old one off the reply's path, about one platform write faster.

## 0.4.7 — 2026-10-03

### Changed

- Tasks: an `<open>` claims only runs from other items, so each run belongs to one open item.

## 0.4.6 — 2026-10-03

### Changed

- Open items: a design lead is an item only through the head's `<open>` naming its run, and `<done>` ends it; a design whose newest run did not succeed reads `stopped`, and the session list no longer marks designs as waiting to finalize.
- Open items: an item's second line says what you are needed for — `Needs you · <question>`, `Needs you · merge?`, `Needs you · decision: <reason>`, `Needs you · review cap reached · findings remain`, or `Needs you in the design session`; `Finalize design` is gone.
- Open items: rows have no Details; a row is one control that opens where its item happened (design session, the session it waits in, the head's topic, or its newest run's session).
- Open items keep creation order; an `<open>` that replaces an item keeps its place. `<done>` takes its key as `<open>` does, and a `<done>` naming no open item is logged.
- Web: from 80rem the session bar spans the full width, with the open items column below it.

## 0.4.5 — 2026-10-02

### Changed

- Upgrade the Pi coding agent dependency to 1.0.0.

## 0.4.0 — 2026-09-28

### Upgrade notes

- The database migrates to schema 34, one-way: it adds `turns_in_flight`; 0.3.1 refuses the upgraded database, so keep the backup Pier takes if you may roll back.
- `pier restart` is `systemctl --user restart --no-block pier`: no drain, no `SIGUSR2`. Off systemd, stop and start the process yourself.

### Changed

- Stop and resume: systemd owns every restart — `pier restart`, `systemctl --user restart|stop pier`, the updater, a crash or SIGKILL. A stop aborts running turns and exits in seconds; at boot each cut turn continues in its session and each agent run on its own row (same id, same callback), both opening with a restart note, and a queued run stays queued. What cannot resume is told in its chat, or ends `interrupted` ([13-stop-and-resume.md](docs/design/13-stop-and-resume.md)).
- The head continues a child whose result falls short of the stage's goal (`· until <condition>`), up to three times unless the user sets another cap, counting `· auto n/3` in the stage; at the cap it waits on the user.
- Dispatch and callback cards name the run's tier, model and reasoning; on the phone the badge is quiet text under the label.
- `pier task run --prompt`, each `--member` and `pier task save` with a prompt require `--model` — a tier (`hardest | balanced | cheap`) or a model on the operator's menu; the refusal prints the menu. A child no longer inherits the caller's live model. `--session`, `--run`, `--bash` and `--task-id` are unchanged.

### Added

- A run a session launched that ends interrupted, failed, or cancelled without the user asking is told in the home chat (`"<name>" ended <state> — <error>`), delivered through the restart ledger so an interruption reaches the chat once it reconnects; a failure or cancel whose result the head's callback note already shows posts nothing more ([11-im-conversation.md](docs/design/11-im-conversation.md#notifications)).
- A delegation prompt may carry `Approved: <step>` for a destructive step the user already approved (`Approved: pier restart`); the run takes it instead of stopping to ask, and the head and leads write that line when handing an approval down.
- A run's result ends with the final state it verified — the commit and the branch it is merged into, the ref pushed, the service's active-since — which the head trusts instead of re-checking; a lead's milestone does the same.
- `pier task runs --state <state>[,…] --since <n>m|h|d --limit <n>`: the ledger answers in-flight runs first, then the newest finished, at most 20 by default (was up to 200) within the last 24h unless `--since` says otherwise; a full page says so on stderr.
- `pier task stats [--days <n>]`: finished agent runs by launch tier, role and model, with each row's recent task names, so the operator can read whether dispatch follows the tier rule ([12-model-tiers.md](docs/design/12-model-tiers.md)).

### Fixed

- An open item's status reads the run store, not `pier task runs`' 24h window: a succeeded-but-unreleased item no longer turns `stopped` by age, and only `waiting on you` counts as needing the user.
- The status chip opens the panel whenever it has rows; a panel of only `pending release`, `stopped` or queued rows reads `K open`.
- A clipped run result keeps its head and its tail, so the verified final state and `Needs your decision` survive the cut; the omission line names `pier task recover` for the full text.
- Requests that arrive before the boot's vault unlock wait for it instead of failing with `secrets locked`.
- A lead's milestone and every restart resume carry the user's `lang=` stamp too.

- The head no longer drifts into English after an English callback: every callback and run message it receives opens with `[lang=<code>]`, the language its user last wrote in, read off the transcript so it survives a restart and carried on the seed across a rotation, and the contracts say the reply language is the most recent `lang=`, never the surrounding context's. Every user message carries `lang=<code>` in its header, not only a change of language, so a stamp said once is not outvoted by English context; `ok`, an emoji or a link carries the last one. The chat and the web do not show the stamp.

### Removed

- The in-process drain: `SIGUSR2`, its 5-minute deadline and the gates that refused work while draining.

## 0.3.1 — 2026-09-28

### Changed

- A task run takes reversible choices itself and stops only for a destructive or irreversible step — deleting what it did not create, force push, a migration, a deploy, a restart — or a question only its caller can answer; its result is the conclusion, then `Needs your decision` when something does.
- The head's seed lists only the previous head's runs that still need it — not succeeded or skipped ones, which `pier task runs` lists — under a heading that names what it shows and hides.

### Fixed

- `npm test` passes on a tree vite has not built: the shell cache test writes its own `index.html` when none exists.

## 0.3.0 — 2026-09-27

### Upgrade notes

- The database migrates to schema 33, one-way: it drops five columns nothing read (`session_state.cwd`, `session_state.project_sort`, `conversations.updated_at`, `restart_ledger.created_at`, `push_identity.created_at`); 0.2.0 refuses the upgraded database, so keep the backup Pier takes if you may roll back.

### Added

- Child threads: a design lead's question opens a thread in the home DM (Slack or Lark) bound to its session; replies there reach the lead, and the root is edited on final or failed.
- `pier search <q…> [--limit N] [--json]`: earlier sessions by what was said in them, over the CLI socket's `/search`; `skills/pier-search` documents it.

### Changed

- `pier search` cuts each hit's title to 30 characters, and its snippets (the palette's too) from the message with `<open>`, `<done>`, `<silent>` and the next-step buttons taken off, centered on the match.
- The head's seed cuts each part to its budget: `MEMORY.md` 12K chars, each day's notes 6K, the ledger 4K, the last exchanges 4K; notes and exchanges keep their end, headed by how many lines went and where they still are.
- Web status panel: one row per session, Waiting on you over In progress, each with a server-derived status tag (`waiting on you`, `pending release`, `running`, `queued`); `/status` groups its lines the same way. `GET /api/continuous/open` answers `{items: [{problem, stage, runs, status}], unlisted}`; design leads awaiting Finalize are items, not a `designs` list.

### Fixed

- A custom tool whose install failed shows the failure on its row instead of `error: null`.
- Reloading the web after a failed turn keeps the previous answer's next-step buttons.
- A message with more than 1000 path references checks them in slices instead of rendering every one plain.
- The open-items list reads the run ledger once for all leads, not once per lead.

### Removed

- `GET /api/continuous/status`: the panel draws rows from `/api/continuous/open`; `/status` in chat is unchanged.

## 0.2.0 — 2026-09-27

### Highlights

- Pier is one conversation: its current session, in `$PIER_HOME/home`, answers, remembers and delegates real work to task runs.
- Pier rotates its session by itself: after an idle hour or past 60K tokens the next message starts a fresh session, seeded with `MEMORY.md`, the open items, recent runs and the last exchanges.
- Open items: Pier keeps a list of what is in flight or waiting on you; `/status` shows it with no model call, on the web and in IM.
- Feature leads: `pier task run --role lead` runs a long-lived lead that delegates to workers and reports milestones only; `--design` makes it a design lead the user finalizes.
- One IM DM (Slack or Lark) can be the home chat: the conversation lives in the DM's main flow, with Web Push quiet while it does.
- The web is one bar and an In progress drawer in place of the rail.

### Added

- `$PIER_HOME/home` holds Pier's memory: `MEMORY.md` (one-line facts), `memory/YYYY-MM-DD.md` daily notes, and an optional `AGENTS.md`.
- Chat commands on every surface, typed `/word` or `%word` (Slack eats an unregistered `/`): `/status`, `/new`, `/stop`, `/skills`.
- `/skills` lists the session's skills; `/<prefix> <text>` runs the one skill whose name starts with the prefix, and an ambiguous prefix is refused with the candidates.
- `pier task runs`: the runs you launched (across the conversation's sessions), in flight or finished in the last 24h, as JSON.
- `pier task pause|resume|archive --task-id <id>` for saved definitions; `pier task list` now returns `nextRun` and `lastRun` per definition.
- `pier task run --role lead [--design]`: a lead may delegate to workers but never to another lead; a lead's result with a `Design final: <path>` line is reported to Pier.
- `pier task run --model <tier>` resolves `hardest`, `balanced` or `cheap` to the first pin with that tier; `--model ?` shows each pin's tier.
- `pier task save --callback-session none` files a definition whose results go nowhere.
- A `--run <id> --after` follow-up is visible while it waits: in the target's queue panel under the run's name, and as `N queued` on the sender's run card.
- Settings → Models: each pin carries a tier (hardest / balanced / cheap / none), one tier may have several pins, and one model may be pinned at several reasoning levels.
- Settings → Channels: a DM row's "This DM is the conversation" switch makes it the home chat; one home across both platforms.
- Settings → Tasks: every scheduled task with trigger, last and next run, a pause/resume switch, and its newest 20 runs with their logs.
- Settings → Boards: every board with its Public switch, Copy link and Delete.
- Web status panel, opened from the bar's status chip: what is running or queued, over the same open-items text `/status` gives.
- Web In progress drawer (⌘⇧P): the live sessions other than Pier's; a finished lead stays until viewed, and a design lead waiting on you keeps its row.
- Web Files dialog: one modal for Browse files, Settings → Agent's files and file references in chat; Markdown renders by default with a Rendered/Source switch, PDFs show inline.
- Web composer completes `/skill:<name>` from the session's own skills beside the chat commands.
- Earlier sessions of the conversation page in above the current one, read-only, with a divider naming why each rotation happened.
- Routes: `GET /api/continuous`, `GET /api/continuous/open`, `GET /api/continuous/status`, `POST /api/continuous/messages`, `POST /api/fs/exists`.
- The speaker header carries `lang=<code>` when the sender switches language, so the model replies in it.

### Changed

- The web opens on `#/conversation`; every other session is reached from the In progress drawer or ⌘K, and Settings is an overlay like Files.
- Each new session of Pier starts on Settings' default model and reasoning; set the default to your `balanced` pin.
- Compaction is decided per session: Pier's at 100K tokens, a lead's or worker's at 150K, any other at the instance setting.
- A session created by a delegated run is a worker for its whole life: it opens without the `pier-tasks` skill and `pier task` refuses it, even after its run ends.
- Callbacks and ownership follow the conversation: a result owed to any of its sessions reaches Pier's current session.
- `pier task save` without `--callback-session` now delivers results to the conversation (was: nowhere); a watch probe that did not match still posts nothing.
- A lead's turn no longer marks its session unread or sends Web Push; Pier reports it through its callback instead.
- Seeds, callbacks, delegations and run cards in the transcript fold to one line that opens to the card and names the other session; a failed run keeps its reason on the line.
- File references in a reply resolve against the writing session's cwd (then its callbacks' cwds), and only files that exist become links.
- Settings → Packages shows Tools as one source in the tree.
- IM `/s <text>` (or `%s <text>`) is the only spelling of the configure-first draft; a bare `s <text>` is now prose.
- The IM settings panel shows context used against the compaction point, as the web header does.
- A failed queue promotion now reports the error with the original text to the session, instead of holding the queue for acknowledgement.
- Config sync: a subscriber applies only a document of its own schema version (now 2) and pauses with an error naming both otherwise; while subscribed, the synced fields (model menu, defaults, synced files) refuse local edits with 409 and show as managed; there is no sync at boot.

### Removed

- The rail: its create, rename and reorder of sessions, the working-set ordering, and ⌘⇧[ / ⌘⇧] / ⌘⇧O; new work in a directory is something you ask Pier to delegate.
- The web ↔ IM handoff: the web's "Continue in…" and the IM panel's "Continue web session…" picker.
- The Automation and Boards Console views (task editor, global Runs, Activity), replaced by the lean Settings → Tasks and Settings → Boards tabs.
- Model pin notes; the tier field replaces them.
- The queue recovery panel and its acknowledgement flow.
- Routes: `POST /api/sessions` (create), `POST /api/sessions/:id/rename`, `POST /api/sessions/:id/compact`, `POST /api/sessions/:id/queue/recovery/:batchId/ack`, `POST /api/handoff`, `GET /api/handoff/targets`, `GET /api/activity`, `/api/task-runs*`, `GET /api/task-groups/:id`, `POST /api/tasks`, `GET|PATCH /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/:id/archive`.
- The `sessions` field of a board's `board.json`.

### Fixed

- A session's web pane no longer loses the turns a compaction summarized away.
- A prompt refused for want of a provider key stays in the conversation as one error row.
- An open-item marker whose text holds a code span is no longer dropped.
- The Files tree resolves paths rooted at `/`, and a malformed anchor escape no longer throws.
- Attachment PDFs open in their own tab again.
- On the phone, a long session title shrinks instead of pushing ⋯ onto its own line.
- A completion row is picked on pointer-up, so scrolling the list with a finger no longer fills it.
- An error takes back only the current tab's optimistic streaming state.

### Upgrade notes

- The database migrates to schema 32, one-way: it adds the `main_chain` and `open_items` tables and drops `session_state.sort`; 0.1.x refuses the upgraded database, so keep the backup Pier takes if you may roll back.
- The first message after the upgrade creates Pier's session in `$PIER_HOME/home`; existing sessions stay readable and reachable from ⌘K.
- Set Settings' default model (Pier's) and assign the `hardest`, `balanced` and `cheap` tiers in Settings → Models; `--model <tier>` refuses an unassigned tier.
- Config sync: upgrade the source and every subscriber together; a version mismatch pauses the subscription until the older side upgrades.
- Definitions saved before 0.2.0 keep their stored silent callback; `pier task save --task-id <id>` moves one to the conversation default.
- Slack and Lark users who typed `s <text>` now type `/s <text>` or `%s <text>`.
- To use IM as the conversation, turn on "This DM is the conversation" on one DM row in Settings → Channels; thread sessions opened earlier in that DM stay on the web only.
