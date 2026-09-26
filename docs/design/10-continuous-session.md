# Continuous session

The contract for one continuous conversation per instance, in front of a
dispatcher session that routes work to task-run children: a trial behind the
instance switch `continuous` (`settings.ts`, Settings → Instance), default off.
Behaviour not named here is [03](03-web-workbench.md)'s,
[04](04-im-channels.md)'s and [09](09-tasks-cli.md)'s; what is not built is
§Not built.

## Roles

The behavioural contract of each role is `agent/roles.ts` (`DISPATCHER`,
`LEAD`); this section holds what code enforces. The **main session**
(dispatcher) answers, remembers and launches work; real work is a task-run
child, and callbacks are the only delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| main | the chain head, the instance default model (the operator sets it to the `balanced` pin) at `low` | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life, switch
  on or off (`createdRole`, `TaskStore.roleOf`); the gate is
  [09 §Two levels](09-tasks-cli.md#two-levels-no-tree).
- A worker opens without the `pier-tasks` skill; a lead with `<pier>/lead.md`
  (`LEAD`), never on disk; when its session shows in the rail is
  [03 §Sessions rail](03-web-workbench.md#sessions-rail-sidebarts).
- A lead's run whose result carries a `Design final: <absolute path>` line
  owes main a callback (§Milestones); main launches a new build lead on that
  doc, its prompt opening `Build per `.
- A design lead's turn outside any run (the user confirmed in its session)
  that carries the line is recorded as a finished run of the lead — reuse,
  resumed from its latest run, that run's callback target, the reply its
  result — so it reports and clears the same way (`TaskService.designFinal`,
  on `Router.onTurnEnd`); a failed turn, a run's own turn and a build lead's
  record nothing.
- A run's `--name` is its session's title; a lead's rail row carries its
  phase (`TaskStore.leads`): `design` when its creating run carries
  `launch.design` (`--design`, set by main only for a product or architecture
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
  callback reaches main once; the resume and the `delivered` marks commit in
  one transaction;
- the lead's last run still running, or a drain: pending, asked again in 10 s;
- nobody waiting on that run, or a resume that cannot be filed (logged): plain.

A lead's own run owes main a callback only when it was a milestone resume,
its result carries a `Design final:` line, it is a build lead's and leaves no
result coming to it (`TaskStore.awaitsResults`), or it did not succeed; otherwise it settles as
`--callback none` does, `LEAD_TURN` (`tasks/callbacks.ts`) the reason on its record.

## Home and memory

- `$PIER_HOME/home` (`pierPath("home")`) holds memory only: `MEMORY.md`
  (one-line facts), `memory/YYYY-MM-DD.md` (daily notes, local date), an
  optional `AGENTS.md` Pi loads as the cwd's own.
- `<pier>/dispatcher.md` is injected beside `<pier>/AGENTS.md`
  (`agentsFilesOverride`, `agent/pi.ts`) only while the switch is on and only
  for a session whose real cwd is the home; flipping the switch recycles idle
  sessions.
- Repo knowledge goes in that repo's `AGENTS.md`, written by a child. Recall
  is `rg` over `memory/` and the Pi session directory; no vector store.

## Main session lifecycle

| Event | Rule |
| --- | --- |
| User message, head ≥ 1h (`CHAIN_IDLE_MS`) since its last user message, or its start | rotate first: create the next session, append a chain row, deliver to it; a streaming head never rotates |
| User message, head past `CHAIN_FULL_TOKENS` (60K) | rotate first, reason `full`, the idle seed; `null` usage (right after a compaction) never rotates |
| Head gone from Pi (not live, not on disk) | a new head, reason `lost` |
| Rotation | the new head keeps the previous head's model and thinking (`first`/`lost`: default at `low`) and gets one `session-seed` system input, mode `append` (no turn) |
| Seed | `MEMORY.md`, `## Open` (§Open items' text, `Nothing open.` included), the run ledger since the previous head started, one line per run `<runId> · <name> · <state> · session <id> · <cwd>`, today's and yesterday's notes, the previous head's last 3 exchanges; an unreadable file says so; built before the session is created, so a seed that fails creates nothing and fails the send with its reason |

- Rotation is lazy, only on a user message, so a head fed by callbacks alone
  grows to its compaction cap, the backstop; no timer. `MainChain.send` runs
  one at a time, so a race rotates once.
- Compaction, decided at open (`agent/pi.ts`) while the switch is on: a
  session in the home at 100K, a lead's or worker's at 150K (under the 200K
  price tier; a lead's state is its doc), any other at the instance's
  setting; `reserveTokens = window − cap`, never later than the instance's
  reserve, recomputed on `setModel`. Children never rotate.
- `ContextUsage.compactAt` is that point, and the session header shows
  `used/compactAt`.

### Cache

- The head's system prompt is the same bytes every turn: the clock and the
  sender ride the user message, the ledger the seed.
- A head keeps its model and thinking for its life; a rotation carries them.
- Every system input appends; the head requests the 1h TTL, which is
  `CHAIN_IDLE_MS`.
- Accepted one-time misses: a rotation, a settings change that edits the
  prompt (skills, the home's `AGENTS.md`), the user switching model.

## Open items

- Main keeps the list inside its replies: `<open>problem — stage (run <id>)</open>`
  adds or replaces the item keyed by `problem`, `<done>problem</done>` removes it;
  both are stripped beside `<silent>` and never read inside a fence
  (`openItemMarkers`, `core/reply.ts`); when to write them is `DISPATCHER`'s.
- The head's `turn-end` writes them (`MainChain`, subscribed to the head) and
  broadcasts `open-items-changed` when a row changed; a marker with no problem
  is logged and dropped.
- `MainChain.openItems()` joins each run token through the ledger's last 24h (a
  run it no longer holds reads `run <id> — not in the ledger`, `NOT_IN_LEDGER`), a
  lead run's with its workers counted by state, and adds the chain's runs no item
  names that are in flight or did not succeed; `renderOpenItems` is the one text.
- An item is `<problem> — <stage>`: `problem` in the user's words, `stage` in
  the workflow's (`lead designing`, `merged, restart pending`, `waiting on you:
  60K or 80K?`); only work in flight or waiting on the user's decision now, the
  backlog in MEMORY.md.
- `designs`: every design lead not closed whose runs have not reported
  `Design final:` (`TaskService.openDesigns` over `TaskStore.leads`), by its
  creating run — the user's to finalize.
- The text: `Open`, one line per item, each run token rendered
  ` · run <id8>… <state> <age>` and a lead's ` · workers: <counts>`, then `Not
  on the list`, then `Designs for you to finalize`, `- <name> · run <id8>… …`;
  `Nothing open.` when all are empty.
- `/status`, trimmed and case-insensitive with nothing else on the message, is
  taken by `MainChain.send` before dispatch: the head (rotated when due) gets the
  text as a `chat-command` system input, mode `append`, no turn, its origin
  carrying `sessions`, run id → session id for every named run and listed design that has one; any
  other text, `/tmp is full` included, is a message.
- Surfaces: the `/status` card and the rail's In progress rows
  (`GET /api/continuous/open`), [03 §Sessions rail](03-web-workbench.md#sessions-rail-sidebarts).

## Chat commands

The seam is `/status`'s (`MainChain.send`, exact word, `chat-command` system
input, mode `append`, no turn); an unknown `/word` is a message, never an
error: the composer is not a shell.

| Command | Does | Card |
| --- | --- | --- |
| `/new` | rotates now, reason `new` (the idle seed, the divider names it); a head the send already rotated for its own reason is not rotated twice | the new head's seed card is the answer; a streaming head refuses with the send's 409, `the conversation is replying — /stop first`, shown as the composer's error row |
| `/stop` | aborts the head's running turn (`AgentSession.abort`), children untouched | `stopped` · `nothing running` |

- The table is `CHAT_COMMANDS` in `core/types.ts` — word → the one line the
  composer's completion shows; `chatCommand` (`core/chain.ts`), the transcript
  rebuild (`agent/events.ts`) and the completion
  ([03 §Chat pane](03-web-workbench.md#chat-pane-chatts-composerts)) all read it.
- Tests: `core/chain.test.ts` (`/new`, `/stop`), `web/server.test.ts` (the
  409), `web/ui/composer.test.ts` (the completion).

## Run ledger

- `TaskService.ledger` over `TaskStore.ledgerRuns`: runs launched by the given
  sessions, in flight or finished since a time, at most 200; the seed reads it
  since the previous head's start, `pier task runs` over the last 24h
  ([09 §`runs`](09-tasks-cli.md#runs)).
- Callbacks and ownership follow the chain, switch on or off: a result owed to
  any member goes to the head (`MainChain.chainOf` in `TaskService`), and every
  member counts as a run's launcher (`tasks/operations.ts`).

## Storage

The tables are `main_chain` and `open_items` in `db.ts`.

- The head is the newest `main_chain` row; the transcripts are the record.
- `open_items` is Pier's store of the open items, never MEMORY.md.
- Surfaces reach the conversation through `MainChain`, which dispatches to the
  head's own `web:<id>` key; the router knows nothing of the chain.

## Web

The routes (`/api/continuous*`), the rail, the pane and its composer are
[03](03-web-workbench.md)'s. An earlier member is read off disk, never opened.

- In progress is the palette's Running set less the conversation's sessions;
  needs you = unread: a finished lead stays while unread and leaves once viewed.
- The conversation's ⋯ menu is Session info, New session here, Browse files,
  Model & reasoning; no Rename, Close or Continue in….

## Not built

- Phase 3, the IM DM: a platform-level switch, effective only while the
  instance switch is on, sends a DM's top-level messages and unbound-thread
  replies to the main session (answers in the DM's main flow), a bound
  thread's replies to its session, and the chat commands bare on Slack
  (`status`, as `stop` and `settings` are) to one message in the main flow;
  group chats never change.
- With it, a run reporting its session posts a card (`<task name> · <state>`,
  cwd, web link) as a thread root bound to the child, edited in place; it
  needs a chat-level DM id in both adapters, replies to more than one attached
  chat, and the card root and its edit in `handoff.ts`.
- A callback to a cold head (>1h) deferred to the next seed; a rotation on a
  callback to a full head.
- A lead keeping the 1h cache TTL while its workers run.
- The seed capped near 8K.
- `pier search <q>` over the CLI socket (the index is `GET /api/search` only).
- Out of this design: workers nested under their lead in In progress (the
  text's `workers` counts are that), a stage derived from git, a done list.

## Acceptance

- A week of daily use, web and one IM DM, with no manually opened session and
  every rotation, dispatch, callback and failure visible where it came from.
- A follow-up reaches the same child verbatim; main edits nothing outside the
  home; one feature runs through a lead with main seeing milestones only.
- The week's largest head is recorded; above ~300K tokens, intra-session
  paging is next.
- From the heads' transcript usage: main averages ≤ 2 model calls per user
  message; uncached input stays under 2% of input; no head compacts; `full`
  rotations lose nothing the user has to repeat.
- After a day of use, `/status` names every problem in flight or waiting on
  the user, in their words, with a stage matching the transcript and no
  backlog; a stale stage is fixed in `DISPATCHER`, never in the view.
