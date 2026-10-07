# Continuous session

The contract for the instance's Pier head, which routes work to task-run
children; every instance has one. Behaviour not named here is
[03](03-web-workbench.md)'s, [04](04-im-channels.md)'s and
[09](09-tasks-cli.md)'s; what is not built is §Not built.

## Roles

The behavioural contract of each role is `agent/roles.ts` (`DISPATCHER`,
`lead(phase)`, `WORKER`); this section holds what code enforces. The **head** answers, remembers
and launches work; real work is a task-run child, and callbacks are the only
delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| head | the newest session, the instance default model (the operator sets it to the `balanced` pin) at `low` | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life
  (`createdRole`, `TaskStore.roleOf`); when its session appears in the status panel is
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).
- A worker opens without the `pier-tasks` skill and with `<pier>/worker.md`
  (`WORKER`), its chat surface without buttons and attachments; a lead with
  `<pier>/lead.md` (`lead(phase)`: the Design or the Build section, its phase
  passed on `AgentLaunchOptions.phase`); neither on disk.
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
- A code change runs build → review → wait for the user → merge.
- A worker launched `--worktree <branch>` (or `--rounds <n>`, n ≥ 1) is the root of a goal (`tasks/goals.ts`, [09 §run](09-tasks-cli.md#run)); a lead's review of its integrated branch is such a goal in its own worktree (`--rounds <n> --cwd <its tree>`); its done milestone names the sha that goal ended clean on.
- The head's code worker is reviewed up to 3 times, a small or follow-up fix once (`--rounds 1`) (`DISPATCHER`).
- A lead integrates workers into its own branch (`git merge <branch>` in its worktree, their worktrees kept) and never merges into the target; its done milestone ends on the branch ready and names the worktrees left.
- The merge into the target and every worktree's removal are the user's decision; no build session runs `wt merge`/`wt remove` or is resumed to. On the user's yes the head merges itself (`DISPATCHER`): HEAD the clean review's sha, or past it only by a wording fix the user named, and the tree clean, then `wt -C <worktree> merge --no-squash <target>`, removing the worktree unless they keep it, then the project's checks on the target if HEAD was past the reviewed sha or the merge printed `Rebased onto` (the review ran them on the reviewed sha only).
- The branch's commits land as they are, rebased onto the target: a worker squashes its WIP and fixups and writes each message per the project's conventions before its run ends (`WORKER`), a fix round folds into the commit it corrects (`fixPrompt`), and a goal's review reads `git log` and finds a WIP or fixup commit or a message off the project's conventions, a P1 (`reviewPrompt`); `wt merge` takes no message and its squash writes its own, so nothing squashes at the merge.
- Models are `MODEL_TABLE` (`agent/roles.ts`), carried by `DISPATCHER` and `lead("build")`.
- A rule has one owner, the lowest layer every reader of it loads: the reply language is `surfacePrompt`'s, what stops a run and the `Approved:` line lifting it the baseline's Working style (`agent/pi.ts`), the result's shape `RUN_RESULT`'s, the merge being the user's `DISPATCHER`'s — `WORKER` and `lead("build")` carry it as one clause.

### Prompt vocabulary

The role contracts, `reviewPrompt`, `fixPrompt` and Pier's `[Pier: …]` notes use one word per concept; a sentence holds one rule, names who acts, and stays within ~25 words.

| Word | Means | Not |
| --- | --- | --- |
| user | the human in the conversation | them, the requester |
| main session | the continuous conversation's current session, "you" in `DISPATCHER` | head (code and docs only), dispatcher |
| supervisor | the session that launched a run and reads its result: the main session or a build lead | the agent that delegated it, parent |
| run | one `pier task run` and the agent working it; `worker` or `lead` when the role matters | child, job |
| launch | start a run; the main session's launch is a dispatch | delegate, spawn |
| result | a run's final reply, read verbatim | report |
| reader | whoever reads a result: the supervisor, else the session it is delivered to or the operator | — |
| owed | a result is owed to a session while a run whose callback names it is in flight | due, pending |
| milestone | a lead's reply to the last result owed to it, which its supervisor reads | — |
| goal | a worker run reviewed and fixed until clean, from its root run | loop |
| item | one `<open>` entry: its problem is the key, its stage where it stands | task, topic |
| phase | a lead's: `design` or `build` | stage |
| default | `MODEL_TABLE`'s missing `--thinking`: the tier's own level | the pin |

### Milestones

Every run or group callback owed to a lead session asks `TaskService.milestone`
(the `Deliverable.milestone` hook, `tasks/outbox.ts`):

- another result still owed the lead (a run in flight whose callback, or whose
  unfinished group's, names it): a plain callback, a lead turn outside any run;
- the result that leaves nothing owed: resumes the lead's last run, prompted
  `[Pier: the last result owed to you follows; …]` (`MILESTONE`), and that run's
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
- A head reply's `<note>line</note>` is stripped like the open-item markers
  and appended as `- line` to today's `memory/YYYY-MM-DD.md` on its `turn-end`
  (`MainChain`'s `Router.onTurnEnd` listener, `core/chain.ts`); a failed write
  is reported to the head's conversation with the lost lines.
- A note keeps a decision and its why, a user preference, an external fact or
  live check, a step the user owes; research is its conclusion and run id. It
  never records merge, push or restart state or a run's tool counts (git, run
  records and `pier task stats` hold them); an overturned line is replaced,
  not appended (`DISPATCHER`).
- `<pier>/dispatcher.md` is injected beside `<pier>/AGENTS.md`
  (`agentsFilesOverride`, `agent/pi.ts`) only for a session whose real cwd is
  the home.
- Repo knowledge goes in that repo's `AGENTS.md`, written by a child. Recall
  is `rg` over `memory/` and `pier search --in pier <q>` over what the user
  and Pier said; `--since` narrows a time such as last week
  ([08](08-cli-socket.md)); no vector store.

## Head lifecycle

| Event | Rule |
| --- | --- |
| User message, head ≥ 1h (`CHAIN_IDLE_MS`) since its last user message, or its start | rotate first: create the next session, append a chain row, deliver to it; a streaming head never rotates |
| User message, head past `CHAIN_FULL_TOKENS` (60K) | rotate first, reason `full`, the idle seed; `null` usage (right after a compaction) never rotates |
| Head gone from Pi (not live, not on disk) | a new head, reason `lost`; the gone head leaves `main_chain` |
| Rotation | every new head (`first`, rotation, `/new`) starts on the Settings default model and reasoning, read then; an unset one keeps the previous head's (`first`/`lost`: Pi's model at `low`); it gets one `session-seed` system input, mode `append` (no turn) |
| Seed | `MEMORY.md`, `## Open` (§Open items' complete seed projection, `Nothing open.` included), the run ledger since the previous head started less its `succeeded` and `skipped` runs (`pier task runs` shows those), one line per run `<runId> · <name> · <state> · session <id> · <cwd>`, today's and yesterday's notes, the previous head's last 3 exchanges; an unreadable file says so; each part is cut to its budget: `MEMORY.md` 12K chars from the end (`core/reply.ts` `cut`, the ellipsis its mark), the ledger 4K the same way (newest first, so the oldest go), each day's notes 6K and the exchanges 4K from the front by whole lines, headed by `… <N> lines omitted, the rest in <memory/<date>.md | session <id>>`; `## Open` is bounded by its own rule — about 8K tokens at most; built before the session is created, so a seed that fails creates nothing and fails the send with its reason; opens with `[lang=<code>]` when the previous head's users spoke a detectable language, so a callback landing before anyone speaks to the new head is stamped with it ([04 §Who is speaking](04-im-channels.md#who-is-speaking)) |

- Rotation is lazy, only on a user message, so a head fed by callbacks alone
  grows to its compaction cap, the backstop; no timer. `MainChain.send` runs
  one at a time, so a race rotates once.
- Compaction, decided at open (`agent/pi.ts`): a
  session in the home at 100K, a worker's at 180K, a lead's at 200K (the
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
- A reply about an item names it: `<open>`/`<done>` does, any other reply ends
  with `<topic>problem</topic>`, the same key — one written like an `<open>`
  line still keys on the problem, its stage and run tokens dropped; stripped like
  the rest, never painted mid-stream (`streamTail`), read by `replyTopic` (`core/reply.ts`) — the tag the web chat labels rows with
  ([03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts)); IM shows
  nothing of it.
- The head's `turn-end` writes them (`TaskService`'s `Router.onTurnEnd`
  listener, when the session is `members()[0]`) and broadcasts
  `open-items-changed` when a row changed; a marker with no problem is logged
  and dropped, and a `<done>` naming no open item is logged as a warning.
- Items list in creation order (`TaskStore.openItems`); an `<open>` that
  replaces an item keeps its place.
- A run is behind one item: an `<open>` takes its run tokens off every other
  item (`TaskStore.markOpenItems`); the first one left with no run is renamed to
  the new problem in its place, the rest are deleted, and one that still has
  other runs keeps them.
- `TaskService.openItems()` (`tasks/open-items.ts`) resolves each run token to its session
  (`TaskStore.getRun`) and shows that session's newest run (`latestRunForTarget`),
  however old, so a lead woken again stays the same item; a token naming no run
  reads `run <id> — not in the ledger` (`NOT_IN_LEDGER`); a lead run's carries all
  its launches counted by state (`workerCounts`); `unlisted` is the chain's queued
  and running runs in no item's session; no listing window or cap applies.
- Optional `title` comes from the session's creation run, independent of the newest run's name: reuse the existing lead read and batch other involved sessions through `TaskStore.creationTitles`; absent creation records fall back to a valid run name, then problem, on every surface.
- A design lead is an item only through the head's `<open>` naming its run; `<done>` is its end.
- Optional `designSessionId` is the first associated run target whose design lead has not reported `Design final:` (`TaskStore.leads` `designOpen`), independent of status or `waitsIn`; it changes navigation only.
- Each item's `status` is `openStatus` (`tasks/open-items.ts`), the one reading
  of its run tree — each run, its session, a lead's workers (workers never
  delegate, so that is the whole tree) — and its stage; first match wins:

  | status | when |
  | --- | --- |
  | `running` | a run's goal live; else a run `queued`/`running`, its session streaming, or a lead's worker `queued`/`running` |
  | `waiting on you` | a run's goal ended `decision`, `cap` or `done` (clean, the merge the user's); else the stage says `waiting on you`, or a run's session is a design lead not reported final whose newest run `succeeded` |
  | `pending release` | every run `succeeded`, none a goal's root still carrying its goal, unless a legacy `merge` step ended it `done` |
  | `stopped` | a goal ended `failed`; else a run `failed`, `cancelled`, `interrupted` or `skipped`, or a token naming no run (`not in the ledger`) |

- A `waiting on you` item's `waitsIn` is the child session the answer is given
  in, from the same reason: a design lead not reported final → its session; a
  stage's `waiting on you` or a goal's `decision`/`cap`/`done` → absent, the chat.
- Only `waiting on you` asks anything of the user (`waitsOnYou`,
  `core/reply.ts`): `/status`'s first group, the status panel's, its chip's
  `needs you`; a finished worker's outcome is read from its lead's run, not its own.
- An item is keyed by `problem` in the user's words; `stage` holds concrete phase, question and valid authorization, omitting ledger-derived run state, time and review rounds; only work in flight or waiting on the user's decision now belongs here, with backlog in MEMORY.md.
- A goal root's goal is read from the ledger (`TaskStore.goalOf`,
  by the run's session), never from the stage; a run queued in that session
  after the goal ended (the user's answer, the merge) carries it no more.
- `core/open-items.ts` builds the shared browser-safe presentation: title, status label, second line, metadata and run/session targets, runs newest first.
- The second line says what the user is needed for:

  | status | second line |
  | --- | --- |
  | waiting, answered in the chat (the stage says `waiting on you`) | `Needs you · <question>`, the prefix dropped |
  | waiting on an ended goal, stage without `waiting on you` | `Needs you · merge?` (clean review), `Needs you · decision: <reason>`, `Needs you · review cap reached · findings remain`; the goal wording leaves the metadata |
  | waiting, answered in the design session (`waitsIn`) | `Needs you in the design session`, then ` · <stage>` when there is one |
  | running / queued | the stage; queued as `Queued · <stage>` |
  | pending release / stopped | `Pending release · <stage>` / `Stopped · <stage>` |

  Grouped cards and IM's `Waiting on you` group omit `Needs you`, keeping `in the design session`.
- A single queued/running run reads `elapsed <age>` from queuedAt; an ended run reads `<state> <age> ago`, omitted from every overview while its goal is live; multiple runs read `N runs · <newest run's time>`.
- Goal wording names review/fix progress, clean review, findings at the cap, decisions, failure and legacy merge; nonempty decision/failure reasons wrap, initial work adds no redundant review label, and worker metadata names only running, failed and interrupted workers.
- `openItemsStatus` returns compact `text`, a `seed` and a version-1 presentation `snapshot`, all from one read; no items yields `Nothing open.`.
- The seed is one line per item, the full problem kept as the `<done>` key: `- <problem> — <stage> (run <id> · session <id>, run …) · <status>`; an empty stage drops ` — <stage>`, a run with no session drops `· session`.
- Compact text and command cards group waiting rows under `Waiting on you`, running/queued under `In progress`, and pending release/stopped under `Other open`, with counts and no empty groups; IM separates title/status, stage and metadata by lines, with no non-clickable run IDs.
- `/status`, trimmed and case-insensitive with nothing else on the message, is
  taken by `MainChain.send` before dispatch: the head (rotated when due) gets the
  text (`ChainDeps.status`, `openItemsStatus`) as a `chat-command` system input, mode `append`, no turn, kept out of the model's context (`agent/pi.ts`), its origin
  carrying `sessions`, run id → session id, and optional `statusSnapshot` with fixed display text and targets; replay validates the snapshot, ignoring keys it does not read, and logs a malformed one, retaining original text and a visible fallback notice. Old commands keep their text and uniquely resolvable run links; any
  other text, `/tmp is full` included, is a message.
- Surfaces: the `/status` card, and the web's status panel, opened by the bar's
  status chip — the same statuses as rows, `waiting on you` first in one list (`GET /api/continuous/open`),
  [03 §Bar and status panel](03-web-workbench.md#bar-and-status-panel-session-headerts-drawerts).

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn, shown at once even while the head replies and
recorded after that turn); an unknown `/word` is a message, never an
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

- The status panel's sessions are the live ones less the sessions making up the head;
  needs you = unread: a finished lead stays while unread and leaves once viewed.
- The head's ⋯ menu is Session info, Browse files, Model & reasoning,
  Settings; search is `pier search`, not a web surface.

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
