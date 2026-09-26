# Product shape under the continuous conversation

What the product is once the conversation is continuous
([10](10-continuous-session.md)): which surfaces remain, how the composer
completes what can be typed, and what is deleted. [03](03-web-workbench.md)
keeps the wire contract of what stays; this doc names the decisions and moves
there when final. A native (Swift) client is not designed here: it waits on
the web experience settling, and nothing below is shaped for it.

## Frame

- The product is one conversation. Everything else answers two questions:
  **what is running now** and **what needs me**. A surface that answers
  neither is Console (operator, rare) or gone.
- One list, one row shape, one dot. No section per kind of attention, no
  per-decision rows: a decision reaches the user as a message in the
  conversation, never as a row.
- The browser is thin: REST snapshots, two SSE streams, markdown. Nothing it
  shows is computed only in the browser.

## Surface map

| Surface | Under continuous | Change |
| --- | --- | --- |
| Conversation | the head, earlier members paged in; `/status`, `/new`, `/stop`; everything else asked of main | none |
| Rail · Conversation row | the head's dot: streaming or unread | none |
| Rail · In progress | rows for work in flight, §In progress | needs-you rule below |
| Rail · New session / Search | ⌘K stays; New session is Phase B's deletion | see §Phases |
| ⋯ on the conversation | Session info · Model & reasoning · Browse files | Rename hidden (the head is not a session the user manages) |
| ⌘K palette | Running = In progress; Recent = everything else (finished leads, IM sessions); content search | none |
| Console | Settings only | Automation and Boards deleted; the rail's Console section is one row |
| Files | unchanged overlay | none |
| Phone | the same list in the drawer; the same rules | none |

## In progress

The one place to look. A row is a session or a run; its dot is the only
state it carries.

| Row | In the group while | Dot |
| --- | --- | --- |
| session (lead, IM, any) | streaming, or a run targets it (queued/running), or it launched runs still in flight | green (live) |
| session | its last turn finished and no client has viewed it | amber (unread) |
| run with no session yet | queued or running | grey |

- **Needs you = unread.** A finished lead that asked the user a question
  stays in the group, dot amber, until viewed; then it leaves. Nothing else
  marks attention: a failed run's callback reaches main, so a failure is the
  Conversation row's unread dot, never a row of its own; a decision main is
  waiting on is a message in the conversation and a `/status` line.
- Order: rail order (creation). A lead's phase tag stays.
- Empty → the group is absent. `/status` remains the full list, the only
  place stages and waiting-on-user items are spelled out.
- What this reverts: "a lead leaves In progress once its runs are finished"
  (unread alone kept nothing). The palette's Running set is again exactly the
  group, so the rail and ⌘K never disagree.

## Scheduled tasks

Cron is a thing the conversation does, not a Console the user edits.

- Create and change: the user says it; main runs `pier task save` (exists).
  No editor form. Pause, resume, run now, archive: the user says it; main
  runs the CLI, which gains `pause`, `resume` and `archive` (`--task-id`, the
  Console's three routes behind one socket op each) beside `run --task-id`
  for run now. The routes go with the page.
- A saved task's callback defaults to the conversation while the switch is
  on (it follows the chain to the head, [10 §Run ledger](10-continuous-session.md#run-ledger)),
  so every cron result and failure is a card in the conversation with its
  Run link; a task saved with `--callback-session none` is the one exception.
- The schedule: the user asks; main runs `pier task list` and answers one
  line per cron or watch definition — name, trigger, next run, last run's
  state and age (`list` gains `lastRun` and `nextRun`, what the Console's row
  showed). One-shots and manual tasks are runs, not schedule.
- Runs: in flight they are In progress and `/status`; finished they are the
  callback card in the conversation (its Run link opens the session); older
  or filtered, the user asks main (`pier task runs`, `recover`). No Runs
  list, no filter card.

## Boards

A board was never bound to a session: its lifetime is the directory, and
`sessions` in `board.json` is provenance ([05 §2](05-boards.md#product-decisions)).
Under continuous that provenance is noise — a rotated head's or a worker's id
names nothing the user can open with meaning — so the field goes, from the
manifest, the skill, the list row and the API.

- The index is the scan (`05 §1`): one directory per board, `board.json`
  read by whoever lists it. No table, no memory entry. What a board *is for*
  is the dispatcher's to remember (`MEMORY.md`, one line), like any other fact;
  Pier keeps no second copy.
- The list: the user asks; main reads the folder (the skill says how) and
  answers public boards first with their `/p/<slug>-<token>/` URL, then
  private with `/boards/<slug>/`; title, updated age. `GET /api/boards` goes
  with the page: the folder is the API.
- Publish, unpublish, delete: the user says it; main edits `board.json`
  (`public`, the token rule the skill states) or renames the directory
  `<slug>.deleted-<ts>` as the route did, and answers with the URL. The
  skill's rule stands: `public: true` only when this request asks for it, and
  the skill gains the "anyone with the link" warning line main repeats when
  it publishes. The link is the row's URL, copied like any text.
  `PATCH`/`DELETE /api/boards/:slug` go with the page.

## Chat commands

Unchanged: [10 §Chat commands](10-continuous-session.md#chat-commands) —
`/status`, `/new`, `/stop`, the three that act on the chain itself and must
work without the agent (`/stop` while it streams, `/new` before it answers,
`/status` exact and instant, from Pier's own store). Nothing joins the table.
Everything else the user wants to know or change goes through main: one
mechanism, the agent, on every surface. Cost: a glance at the schedule is a
turn — seconds and a small tool output in context.

- **A skill is the command.** Pi already expands `/skill:<name> <ask>` into
  the skill's body plus the ask as the user's prompt
  (`AgentSession._expandSkillCommand`; the Agent Skills frontmatter is
  `name`, `description`, `disable-model-invocation`, no more), so
  `/skill:pier-tasks what's scheduled?` reaches main today through the
  ordinary send — an unknown `/word` is a message, [10 §Chat
  commands](10-continuous-session.md#chat-commands). Pier generates nothing per
  skill; it only lists them: the composer's completion shows the three chain
  commands, then `skill:<name>` for every skill on (`GET /api/packages`'
  enabled skills, the switch that already exists), each with its
  `description`. A skill off is not listed and not expanded. The same on a
  native client; on IM the user types it.
- **Not on Slack**: `/` opens Slack's own command box and an unknown one
  never posts; when [10 §Not built](10-continuous-session.md#not-built)'s IM
  DM comes, the adapter takes bare `skill:<name> …` like `status`.
- **The skill carries the answer shape.** What the schedule reads like (one
  line per task: name, trigger, next, last), what the board list reads like
  (URL per row, public first), what publishing says ("anyone with the link"):
  a section in `pier-tasks` and `pier-boards`, beside the CLI and file
  operations they already document. `DISPATCHER` says nothing about either.

## Completion

The composer's one list, `composer.ts`'s command menu extended; the shape
of [03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts) stands
(rows above the input, `.palette-row`, `role=listbox`/`option`, ↑↓ ⌃N ⌃P walk,
Enter/Tab fill, pointer fills without blurring, Esc closes until the draft
changes, 44px on touch).

- **Rows.** Two kinds in one flat list, no headers: the chain commands
  (`/status`, `/new`, `/stop`, their line from `CHAT_COMMANDS`), then
  `/skill:<name>` for every skill the session has, its `description` as the
  line. Word in mono, line truncated; more than eight rows scroll inside the
  list.
- **Where.** Chain commands only in the continuous conversation (they are
  taken only there); skill rows in every session (Pi expands `/skill:`
  anywhere). A session with no skills and no commands opens no list.
- **Opens** when the draft is `/` plus a prefix with no whitespace, as today.
  A row matches when the draft's prefix is a prefix of its word, or of the
  skill's name alone (`/pier-t` finds `/skill:pier-tasks`). The exact word
  of a chain command hides the list; a skill row's word is never "exact":
  the draft still needs the ask.
- **Fill.** A chain command fills `/word`; a skill row fills
  `/skill:<name> ` — the trailing space closes the list and the caret waits
  for the ask. Enter on `/skill:<name>` alone sends it; Pi answers with the
  skill read, which is what was asked.
- **Source.** The session's own skills, as Pi loaded them for it:
  `AgentSession.skills(): {name, description}[]` (seam addition,
  `core/types.ts`; `agent/pi.ts` reads `resourceLoader.getSkills()`), carried
  on the history snapshot as `skills` and refreshed with it. That is exactly
  the set `/skill:` will expand — `skillsOff`, project scope and shadowing
  already applied — so the list and Pi cannot disagree; a skill switched on
  in Settings appears when the session is next opened, which is also when Pi
  would first expand it. `disable-model-invocation` skills are listed: the
  flag hides them from the model, not from the user. No `GET /api/packages`
  read from the composer, no second list.
- **Tests.** `composer.test.ts`: rows and order, the name-only match, the
  skill fill's trailing space, no list outside continuous without skills;
  `web/server.test.ts`: `skills` on the snapshot.

## Console

- **Automation is deleted** whole: Tasks, its editor, Runs, Activity, the
  graph, `/api/activity`, `activityRuns`. Under continuous the dispatcher's
  transcript is the picture Activity drew — every delegation and callback is a
  system-input card linking its session and run — and In progress + `/status`
  are the live view.
- **Boards is deleted**: the folder and the skill are the surface.
- The Console is Settings, with Files as its overlay. `/api/tasks*` and
  `/api/task-runs*` stay only as far as the CLI socket and tests use them; a
  route with no caller goes with the view.

## Wire contract

Nothing new for a client: the routes and streams of [03](03-web-workbench.md)
less the deleted ones, plus `skills` on the history snapshot. A native client,
when it comes, reads that table and the four browser-safe `core/` modules
(`AGENTS.md` §Architecture); it is not designed here.

## Deletions

| What | Where | Why |
| --- | --- | --- |
| Automation: Tasks, editor, Runs, Activity, graph, their routes | `web/ui/tasks.ts` (270), `task-editor.ts` (196), `runs.ts` (174), `task-runs.ts` (251), `activity.ts` (355), `tasks/routes.ts` (what the CLI does not call), `views.ts`/`index.html` | §Scheduled tasks, §Console |
| Rename on the conversation | `session-header.ts` | not a managed session |
| "finished lead leaves In progress" special case | `sidebar.ts`, `palette.ts` | §In progress; one set again |
| Boards page, `/api/boards*`, `sessions` on a board | `web/ui/boards.ts` (118), `boards/boards.ts` (the static routes stay), `skills/pier-boards/SKILL.md`, `05-boards.md` | §Boards |

Phase B (the switch goes, after [10 §Acceptance](10-continuous-session.md#acceptance)):

| What | Where |
| --- | --- |
| the `continuous` switch, both branches of every rail/pane rule | `settings.ts`, `sidebar.ts`, `views.ts`, `main.ts`, `chat.ts`, `composer.ts` |
| New session menu, Browse…, recent directories | `dir-picker.ts` (166), `index.html`, `sidebar.ts` |
| Load more, "Sessions" label | `sidebar.ts` |
| `POST /api/sessions` (create), `/rename` from the UI | `server.ts` — routes stay for `pier task`/tests until nothing calls them |

## Phases

- **A — now.** In progress's needs-you rule; the completion (§Completion,
  the `skills()` seam); the CLI's three verbs and `list`'s two fields, the
  callback default, the skills' answer sections; Automation and Boards deleted; the ⋯ menu trimmed;
  Switch stays. Net negative lines in `web/` and `tasks/`.
- **B — after acceptance.** The switch and the non-continuous rail go.

## Open

Taken as built (Phase A): needs-you is unread — a finished lead stays in In
progress until viewed, and `/status` alone spells out what waits on the user;
a design lead waiting on Finalize (`designOpen`) still holds its row. Design
docs stay English. Definitions saved before the `conversation` default keep
their stored `none`; no migration — a `save --task-id` moves one.
