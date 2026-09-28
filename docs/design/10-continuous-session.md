# Continuous session

The contract for the instance's Pier head, which routes work to task-run
children; every instance has one. Behaviour not named here is
[03](03-web-workbench.md)'s, [04](04-im-channels.md)'s and
[09](09-tasks-cli.md)'s; what is not built is §Not built.

## Roles

The behavioural contract of each role is `agent/roles.ts` (`DISPATCHER`,
`LEAD`); this section holds what code enforces. The **head** answers, remembers
and launches work; real work is a task-run child, and callbacks are the only
delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| head | the newest session, the instance default model (the operator sets it to the `balanced` pin) at `low` | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life
  (`createdRole`, `TaskStore.roleOf`); when its session appears in In progress is
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).
- A worker opens without the `pier-tasks` skill; a lead with `<pier>/lead.md`
  (`LEAD`), never on disk.
- A lead's run whose result carries a `Design final: <absolute path>` line
  owes the head a callback (§Milestones); the head launches a new build lead on
  doc, its prompt opening `Build per `.
- A design lead's turn outside any run (the user confirmed in its session)
  that carries the line is recorded as a finished run of the lead — reuse,
  resumed from its latest run, that run's callback target, the reply its
  result — so it reports and clears the same way (`TaskService.designFinal`,
  on `Router.onTurnEnd`); a failed turn, a run's own turn and a build lead's
  record nothing.
- A run's `--name` is its session's title; a lead's session carries its
  phase (`TaskStore.leads`): `design` when its creating run carries
  `launch.design` (`--design`, set by the head only for a product or architecture
  design the user finalizes), `build` for any other lead.
- Models are the tiers of [pier-tasks §Model
  choice](../../skills/pier-tasks/SKILL.md#model-choice); a lead is `hardest`,
  `--thinking high` to design and `medium` to build.

### Milestones

Every run or group callback owed to a lead session asks `TaskService.milestone`
(the `Deliverable.milestone` hook, `tasks/outbox.ts`):

- another result still owed the lead (a run in flight whose callback, or whose
  unfinished group's, names it): a plain callback, a lead turn outside any run;
- the result that leaves nothing owed: resumes the lead's last run, prompted
  `[Pier: the last result you were waiting on follows; …]`, and that run's
  callback reaches the head once; the resume and the `delivered` marks commit in
  one transaction;
- the lead's last run still running: pending, asked again in 10 s;
- nobody waiting on that run, or a resume that cannot be filed (logged): plain.

A lead's own run owes the head a callback only when it was a milestone resume,
its result carries a `Design final:` line, it is a build lead's and leaves no
result coming to it (`TaskStore.awaitsResults`), or it did not succeed; otherwise it settles as
`--callback none` does, `LEAD_TURN` (`tasks/callbacks.ts`) the reason on its record.

## Home and memory

- `$PIER_HOME/home` (`pierPath("home")`) holds memory only: `MEMORY.md`
  (one-line facts), `memory/YYYY-MM-DD.md` (daily notes, local date), an
  optional `AGENTS.md` Pi loads as the cwd's own.
- `<pier>/dispatcher.md` is injected beside `<pier>/AGENTS.md`
  (`agentsFilesOverride`, `agent/pi.ts`) only for a session whose real cwd is
  the home.
- Repo knowledge goes in that repo's `AGENTS.md`, written by a child. Recall
  is `rg` over `memory/` and `pier search <q>` over the transcripts
  ([08](08-cli-socket.md)); no vector store.

## Head lifecycle

| Event | Rule |
| --- | --- |
| User message, head ≥ 1h (`CHAIN_IDLE_MS`) since its last user message, or its start | rotate first: create the next session, append a chain row, deliver to it; a streaming head never rotates |
| User message, head past `CHAIN_FULL_TOKENS` (60K) | rotate first, reason `full`, the idle seed; `null` usage (right after a compaction) never rotates |
| Head gone from Pi (not live, not on disk) | a new head, reason `lost`; the gone head leaves `main_chain` |
| Rotation | every new head (`first`, rotation, `/new`) starts on the Settings default model and reasoning, read then; an unset one keeps the previous head's (`first`/`lost`: Pi's model at `low`); it gets one `session-seed` system input, mode `append` (no turn) |
| Seed | `MEMORY.md`, `## Open` (§Open items' text, `Nothing open.` included), the run ledger since the previous head started less its `succeeded` and `skipped` runs (`pier task runs` shows those), one line per run `<runId> · <name> · <state> · session <id> · <cwd>`, today's and yesterday's notes, the previous head's last 3 exchanges; an unreadable file says so; each part is cut to its budget: `MEMORY.md` 12K chars from the end (`core/reply.ts` `cut`, the ellipsis its mark), the ledger 4K the same way (newest first, so the oldest go), each day's notes 6K and the exchanges 4K from the front by whole lines, headed by `… <N> lines omitted, the rest in <memory/<date>.md | session <id>>`; `## Open` is bounded by its own rule — about 8K tokens at most; built before the session is created, so a seed that fails creates nothing and fails the send with its reason; opens with `[lang=<code>]` when the previous head's users spoke a detectable language, so a callback landing before anyone speaks to the new head is stamped with it ([04 §Who is speaking](04-im-channels.md#who-is-speaking)) |

- Rotation is lazy, only on a user message, so a head fed by callbacks alone
  grows to its compaction cap, the backstop; no timer. `MainChain.send` runs
  one at a time, so a race rotates once.
- Compaction, decided at open (`agent/pi.ts`): a
  session in the home at 100K, a lead's or worker's at 150K (under the 200K
  price tier; a lead's state is its doc), any other at the instance's
  setting; `reserveTokens = window − cap`, never later than the instance's
  reserve, recomputed on `setModel`. Children never rotate.
- `ContextUsage.compactAt` is that point, and a child's header reads against
  it; the head's bar shows the used tokens, Session info `used/rotateAt` (`CHAIN_FULL_TOKENS`).

### Cache

- The head's system prompt is the same bytes every turn: the clock and the
  sender ride the user message, the ledger the seed.
- A head keeps its model and thinking for its life; the next head starts from Settings, not from it.
- Every system input appends; the head requests the 1h TTL, which is
  `CHAIN_IDLE_MS`.
- Accepted one-time misses: a rotation, a settings change that edits the
  prompt (skills, the home's `AGENTS.md`), the user switching model.

## Open items

- The head keeps the list inside its replies: `<open>problem — stage (run <id>)</open>`
  adds or replaces the item keyed by `problem`, `<done>problem</done>` removes it;
  both are stripped beside `<silent>` and never read inside a fence
  (`openItemMarkers`, `core/reply.ts`); when to write them is `DISPATCHER`'s.
- The head's `turn-end` writes them (`TaskService`'s `Router.onTurnEnd`
  listener, when the session is `members()[0]`) and broadcasts
  `open-items-changed` when a row changed; a marker with no problem is logged
  and dropped.
- `TaskService.openItems()` (`tasks/open-items.ts`) resolves each run token to its session (the ledger,
  else `TaskStore.getRun`) and shows that session's newest run in the ledger's
  last 24h, so a lead woken again stays the same item (none there reads `run <id>
  — not in the ledger`, `NOT_IN_LEDGER`), a lead run's with its workers counted
  by state; `unlisted` is the chain's queued and running runs in no item's
  session; `renderOpenItems` is the one text.
- Each item's `status` is `openStatus` (`tasks/open-items.ts`), the one reading
  of its run tree — each run, its session, a lead's workers (workers never
  delegate, so that is the whole tree) — and its stage; first match wins:

  | status | when |
  | --- | --- |
  | `running` | a run `queued`/`running`, its session streaming, or a lead's worker `queued`/`running` |
  | `waiting on you` | the stage says `waiting on you`, or its session's design awaits Finalize |
  | `pending release` | every run `succeeded` (or it names none) |
  | `stopped` | a run `failed`, `cancelled`, `interrupted`, `skipped` or `not in the ledger` |

- Only `waiting on you` asks anything of the user (`waitsOnYou`,
  `core/reply.ts`): `/status`'s first group, the status panel's, its chip's
  `needs you`; a finished worker's outcome is read from its lead's run, not its own.
- An item is `<problem> — <stage>`: `problem` in the user's words, `stage` in
  the workflow's (`lead designing`, `merged, restart pending`, `waiting on you:
  60K or 80K?`); only work in flight or waiting on the user's decision now, the
  backlog in MEMORY.md.
- A goal is text in the stage, `DISPATCHER`'s convention and nothing the
  parser or a surface reads: `· until <condition>` names the checkable end the
  head rewrites into every stage, `· auto <n>/<cap>` how many times it has
  continued the child (`--run <id> --prompt`) past a result short of it that
  stopped on nothing needing the user; the cap is 3 unless the user set one,
  and a result still short at the cap turns the stage into `waiting on you:
  <blocker>`. No goal, and the head reports and waits.
- Every design lead not closed whose runs have not reported `Design final:`
  (`TaskService.openDesigns` over `TaskStore.leads`) is an item after main's,
  named by its creating run, unless an item or an unlisted run already holds
  its session: a session is in the list once.
- The text: `Waiting on you`, the `waiting on you` items, then `In progress`,
  every other item and each unlisted run as `- <name> — not on the list`; a line
  is `- <problem> — <stage> (<status>)`, an unlisted run's status `queued` until
  it starts, each run rendered ` · run <id8>… <state> <age>` (`openRunText`,
  `core/reply.ts`) and a lead's ` · workers: <counts>`; `Nothing open.` when
  both are empty.
- `/status`, trimmed and case-insensitive with nothing else on the message, is
  taken by `MainChain.send` before dispatch: the head (rotated when due) gets the
  text (`ChainDeps.status`, `openItemsStatus`) as a `chat-command` system input, mode `append`, no turn, its origin
  carrying `sessions`, run id → session id for every run it names that has one; any
  other text, `/tmp is full` included, is a message.
- Surfaces: the `/status` card, and the web's status panel, opened by the bar's
  status chip — the same groups and statuses as rows (`GET /api/continuous/open`),
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn); an unknown `/word` is a message, never an
error: the composer is not a shell.

The commands, their spelling (`/` or `%`) and what each answers on the head
and in a thread are [11 §Chat commands](11-im-conversation.md#chat-commands).
`/new` rotates with reason `new` (the idle seed, the divider names it); a head
the send already rotated for its own reason is not rotated twice; the answer
is the new head's seed card, and a streaming head's refusal is
the send's 409, shown as the composer's error row.

- The word list is `CHAT_COMMANDS` in `core/types.ts` — word → the one line the
  composer's completion shows; `chatCommand` (`core/chain.ts`), the transcript
  rebuild (`agent/events.ts`) and the completion
  ([03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts)) all read it.
- Tests: `core/chain.test.ts` (`/new`, `/stop`), `web/server.test.ts` (the
  409), `web/ui/composer.test.ts` (the completion).

## Run ledger

- `TaskService.ledger` over `TaskStore.ledgerRuns`: runs launched by the given
  sessions, in flight or finished since a time, at most 200; the seed reads it
  since the previous head's start and drops the succeeded and skipped runs, `pier task runs` over the last 24h
  ([09 §`runs`](09-tasks-cli.md#runs)).
- Callbacks and ownership follow the chain: a result owed to
  any member goes to the head (`MainChain.chainOf` in `TaskService`), and every
  member counts as a run's launcher (`tasks/operations.ts`).

## Storage

The tables are `main_chain` and `open_items` in `db.ts`.

- The head is the newest `main_chain` row; the transcripts are the record.
- `open_items` is Pier's store of the open items, never MEMORY.md.
- Surfaces reach the conversation through `MainChain`, which dispatches to the
  head's own `web:<id>` key, or the home chat's key
  ([11](11-im-conversation.md)); the router knows nothing of the chain.

## Web

The routes (`/api/continuous*`), the status panel, the pane and its
composer are [03](03-web-workbench.md)'s. An earlier member is read off disk,
never opened.

- In progress is the live sessions less the sessions making up the head;
  needs you = unread: a finished lead stays while unread and leaves once viewed.
- The head's ⋯ menu is Search, Session info, Browse files, Model & reasoning,
  Settings; no Rename or New session here.

## Not built

- Out of this design: workers nested under their lead in In progress (the
  text's `workers` counts are that), a stage derived from git, a done list.

## Acceptance

- A week of daily use, web and one IM DM, with no manually opened session and
  every rotation, dispatch, callback and failure visible where it came from.
- A follow-up reaches the same child verbatim; the head edits nothing outside
  the home; one feature runs through a lead with the head seeing milestones only.
- The week's largest head is recorded; above ~300K tokens, intra-session
  paging is next.
- From the head's transcript usage: it averages ≤ 2 model calls per user
  message; uncached input stays under 2% of input; no head compacts; `full`
  rotations lose nothing the user has to repeat.
- After a day of use, `/status` names every problem in flight or waiting on
  the user, in their words, with a stage matching the transcript and no
  backlog; a stale stage is fixed in `DISPATCHER`, never in the view.
