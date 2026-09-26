# Continuous session

The contract for one continuous conversation per instance, in front of a
dispatcher session that routes work to task-run children: a trial behind the
instance switch `continuous` (`settings.ts`, Settings → Instance), default off.
Behaviour not named here is [03](03-web-workbench.md)'s,
[04](04-im-channels.md)'s and [09](09-tasks-cli.md)'s.

- Built: Phase 1 (the web conversation), Phase 2 (the feature lead), §Open
  items with `/status` and the rail's Open block.
- Not built: Phase 3 (§IM), §Not built, the rest of [open
  items](continuous-open-items.md) (`/new`, `/stop`, IM).

## Roles

The **main session** (dispatcher) answers, remembers and launches work, never
edits code; real work, multi-step research included, is a task-run child, one `wt` worktree per feature, and
a follow-up continues that child with the user's words verbatim (`DISPATCHER`,
`agent/roles.ts`). Callbacks stay the only delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| main | the chain head, the instance default model (the operator sets it to the `balanced` pin) at `low` | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life, switch
  on or off (`createdRole`, `TaskStore.roleOf`); the gate is
  [09 §Two levels](09-tasks-cli.md#two-levels-no-tree).
- A worker opens without the `pier-tasks` skill; a lead with `<pier>/lead.md`
  (`LEAD`), never on disk; its session stays in the rail for its life (idle
  dot "lead — waiting for you") and leaves it when the operator closes it
  (Session menu → Close; a message reopens it).
- The user designs with the lead in its session, main not in that path; only
  the user finalizes: the lead asks (a `[Finalize design]` button) and writes
  `Design final: <absolute path>` once they confirm, which has main launch a
  new build lead on that doc, its prompt opening `Build per ` (`BUILD_PROMPT`),
  which launches and integrates workers; main gets milestones only.
- Every run main or a lead launches is `--name`d with a few words that hit its
  intent; the name is the session's title. A lead's rail row carries its phase,
  `design` or `build` (`TaskStore.leadPhaseOf`), in English whatever the title's language.
- Before the first tool call on a message main decides: answer from context,
  or dispatch; one command may answer, a second means a worker.
- A callback writes no note; a note records a decision or a fact the ledger
  does not hold.
- Main's reply to a callback says what it means and what is next, never
  repeats it.
- Models by tier: the dispatcher names `--model hardest|balanced|cheap`, the
  operator assigns the tiers on the menu ([09 §Models](09-tasks-cli.md#models)),
  a lead is `hardest --thinking high`; no model id appears in a prompt or here.
  A tier follows the change's difficulty, not the task's kind: a review takes
  the builder's tier, `hardest` only for a seam diff or a builder-reported risk
  or unverified part; a model the user names overrides both ([pier-tasks §Model
  choice](../../skills/pier-tasks/SKILL.md#model-choice)).
- Every delegated run's preamble (`tasks/agent.ts`) asks for the conclusion and
  the paths it rests on, no process; a deliverable longer than a screen goes
  to a file the result names.

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
- The text: `Open`, one line per item, each run token rendered
  ` · run <id8>… <state> <age>` and a lead's ` · workers: <counts>`, then `Not
  on the list`; `Nothing open.` when both are empty.
- `/status`, trimmed and case-insensitive with nothing else on the message, is
  taken by `MainChain.send` before dispatch: the head (rotated when due) gets the
  text as a `chat-command` system input, mode `append`, no turn, its origin
  carrying `sessions`, run id → session id for every named run that has one; any
  other text, `/tmp is full` included, is a message.
- Surfaces: the web card and the rail's Open block ([03](03-web-workbench.md),
  `GET /api/continuous/open`).

## Run ledger

- `TaskService.ledger` over `TaskStore.ledgerRuns`: runs launched by the given
  sessions, in flight or finished since a time, at most 200; the seed reads it
  since the previous head's start, `pier task runs` over the last 24h
  ([09 §`runs`](09-tasks-cli.md#runs)).
- Callbacks and ownership follow the chain, switch on or off: a result owed to
  any member goes to the head (`MainChain.chainOf` in `TaskService`), and every
  member counts as a run's launcher (`tasks/operations.ts`).

## Storage

- `main_chain` (`db.ts` migration 28): one row per session, `started_at`,
  `reason`; the head is the newest, the transcripts are the record.
- `open_items` (migration 31): `problem` the key, `stage`, `run_ids` a JSON
  array, `updated_at` the order; Pier's store, never MEMORY.md.
- Surfaces reach the conversation through `MainChain`, which dispatches to the
  head's own `web:<id>` key; the router knows nothing of the chain.

## Web

The routes (`/api/continuous*`), the rail and the pane are
[03](03-web-workbench.md)'s. A bare address, `#/conversation` (its one address)
or any chain member opens the conversation at its head; earlier members page in read-only, read off disk
and never opened (`AgentFactory.readHistory`); no paging within a session; the
divider between members names the rotation's reason (`DIVIDER`,
`web/ui/main.ts`). Children show as Background Run rows opening their sessions.
`/status` in the composer answers with §Open items' text as a card, no model
call; the rail shows the same items live.

## IM

Phase 3, not built: a platform-level switch, effective only while the
instance switch is on; group chats never change.

| DM inbound (switch on) | Goes to | Reply posts |
| --- | --- | --- |
| top-level message, or a reply in an unbound thread | main session | the DM's main flow |
| reply in a bound thread (a card's, a handoff's) | that session | the thread |
| `/status` (Slack: `status`) | answered from the ledger: `<name> · <state> · <age> · <thread link>` | the main flow |

- A run reporting its session posts a card (`<task name> · <state>`, cwd, web
  link) as a thread root bound to the child, edited in place on each state
  change; the settled callback is one dispatcher line in the main flow.
- Gaps: a chat-level DM id in both adapters; replies to more than one
  attached chat; the card root and its edit in `handoff.ts`.

## Not built

- A callback to a cold head (>1h) deferred to the next seed.
- A rotation on a callback to a full head.
- A lead keeping the 1h cache TTL while its workers run.
- Chat commands `/new`, `/stop` ([open items](continuous-open-items.md)).
- The seed capped near 8K.
- `pier search <q>` over the CLI socket (the index is `GET /api/search` only).

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
