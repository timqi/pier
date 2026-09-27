# Changelog

## 0.2.0 — Unreleased

### Highlights

- Pier is one continuous conversation, labelled "Pier": you talk to one head session in `$PIER_HOME/home` that answers, remembers and delegates real work to task runs.
- The head rotates by itself: after an idle hour or past 60K tokens the next message starts a fresh session, seeded with `MEMORY.md`, the open items, recent runs and the last exchanges.
- Open items: the head keeps a list of what is in flight or waiting on you; `/status` shows it with no model call, on the web and in IM.
- Feature leads: `pier task run --role lead` runs a long-lived lead that delegates to workers and reports milestones only; `--design` makes it a design lead the user finalizes.
- One IM DM (Slack or Lark) can be the home chat: the conversation lives in the DM's main flow, with Web Push quiet while it does.
- The web is one bar and an In progress drawer in place of the rail.

### Added

- `$PIER_HOME/home` holds the head's memory: `MEMORY.md` (one-line facts), `memory/YYYY-MM-DD.md` daily notes, and an optional `AGENTS.md`.
- Chat commands on every surface, typed `/word` or `%word` (Slack eats an unregistered `/`): `/status`, `/new`, `/stop`, `/skills`.
- `/skills` lists the session's skills; `/<prefix> <text>` runs the one skill whose name starts with the prefix, and an ambiguous prefix is refused with the candidates.
- `pier task runs`: the runs you launched (across the conversation's sessions), in flight or finished in the last 24h, as JSON.
- `pier task pause|resume|archive --task-id <id>` for saved definitions; `pier task list` now returns `nextRun` and `lastRun` per definition.
- `pier task run --role lead [--design]`: a lead may delegate to workers but never to another lead; a lead's result with a `Design final: <path>` line is reported to the head.
- `pier task run --model <tier>` resolves `hardest`, `balanced` or `cheap` to the first pin with that tier; `--model ?` shows each pin's tier.
- `pier task save --callback-session none` files a definition whose results go nowhere.
- A `--run <id> --after` follow-up is visible while it waits: in the target's queue panel under the run's name, and as `N queued` on the sender's run card.
- Settings → Models: each pin carries a tier (hardest / balanced / cheap / none), one tier may have several pins, and one model may be pinned at several reasoning levels.
- Settings → Channels: a DM row's "This DM is the conversation" switch makes it the home chat; one home across both platforms.
- Settings → Tasks: every scheduled task with trigger, last and next run, a pause/resume switch, and its newest 20 runs with their logs.
- Settings → Boards: every board with its Public switch, Copy link and Delete.
- Web status panel, opened from the bar's status chip: what is running or queued, over the same open-items text `/status` gives.
- Web In progress drawer (⌘⇧P): the live sessions other than the head; a finished lead stays until viewed, and a design lead waiting on you keeps its row.
- Web Files dialog: one modal for Browse files, Settings → Agent's files and file references in chat; Markdown renders by default with a Rendered/Source switch, PDFs show inline.
- Web composer completes `/skill:<name>` from the session's own skills beside the chat commands.
- Earlier sessions of the conversation page in above the head, read-only, with a divider naming why each rotation happened.
- Routes: `GET /api/continuous`, `GET /api/continuous/open`, `GET /api/continuous/status`, `POST /api/continuous/messages`, `POST /api/fs/exists`.
- The speaker header carries `lang=<code>` when the sender switches language, so the model replies in it.

### Changed

- The web opens on `#/conversation`; every other session is reached from the In progress drawer or ⌘K, and Settings is an overlay like Files.
- Each new head starts on Settings' default model and reasoning; set the default to your `balanced` pin.
- Compaction is decided per session: the head at 100K tokens, a lead's or worker's at 150K, any other at the instance setting.
- A session created by a delegated run is a worker for its whole life: it opens without the `pier-tasks` skill and `pier task` refuses it, even after its run ends.
- Callbacks and ownership follow the conversation: a result owed to any of its sessions reaches the current head.
- `pier task save` without `--callback-session` now delivers results to the conversation (was: nowhere); a watch probe that did not match still posts nothing.
- A lead's turn no longer marks its session unread or sends Web Push; the head reports it through its callback instead.
- Seeds, callbacks, delegations and run cards in the transcript fold to one line that opens to the card and names the other session; a failed run keeps its reason on the line.
- File references in a reply resolve against the writing session's cwd (then its callbacks' cwds), and only files that exist become links.
- Settings → Packages shows Tools as one source in the tree.
- IM `/s <text>` (or `%s <text>`) is the only spelling of the configure-first draft; a bare `s <text>` is now prose.
- The IM settings panel shows context used against the compaction point, as the web header does.
- A failed queue promotion now reports the error with the original text to the session, instead of holding the queue for acknowledgement.
- Config sync: a subscriber applies only a document of its own schema version (now 2) and pauses with an error naming both otherwise; while subscribed, the synced fields (model menu, defaults, synced files) refuse local edits with 409 and show as managed; there is no sync at boot.

### Removed

- The rail: its create, rename and reorder of sessions, the working-set ordering, and ⌘⇧[ / ⌘⇧] / ⌘⇧O; new work in a directory is something you ask the head to delegate.
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
- The first message after the upgrade creates the head in `$PIER_HOME/home`; existing sessions stay readable and reachable from ⌘K.
- Set Settings' default model (the head's) and assign the `hardest`, `balanced` and `cheap` tiers in Settings → Models; `--model <tier>` refuses an unassigned tier.
- Config sync: upgrade the source and every subscriber together; a version mismatch pauses the subscription until the older side upgrades.
- Definitions saved before 0.2.0 keep their stored silent callback; `pier task save --task-id <id>` moves one to the conversation default.
- Slack and Lark users who typed `s <text>` now type `/s <text>` or `%s <text>`.
- To use IM as the conversation, turn on "This DM is the conversation" on one DM row in Settings → Channels; thread sessions opened earlier in that DM stay on the web only.
