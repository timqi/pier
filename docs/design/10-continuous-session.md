# Continuous session

The contract for one continuous conversation per instance, in front of a
dispatcher session that routes work to task-run children: a trial behind the
instance switch `continuous` (`settings.ts`, Settings → Instance), default off.
Behaviour not named here is [03](03-web-workbench.md)'s,
[04](04-im-channels.md)'s and [09](09-tasks-cli.md)'s.

- Built: Phase 1 (the web conversation), Phase 2 (the feature lead).
- Not built: Phase 3 (§IM), §Not built.

## Roles

The **main session** (dispatcher) answers, remembers and launches work, never
edits code; real work is a task-run child, one `wt` worktree per feature, and
a follow-up continues that child with the user's words verbatim (`DISPATCHER`,
`agent/roles.ts`). Callbacks stay the only delivery.

| Role | Session | Delegates |
| --- | --- | --- |
| main | the chain head, instance default model at `low` | leads and workers |
| lead | a `--role lead` run's, cwd the feature's worktree, long-lived | workers only |
| worker | any other run's launched from a session | never |

- The run that made a session fixes its role for the session's life, switch
  on or off (`createdRole`, `TaskStore.roleOf`); the gate is
  [09 §Two levels](09-tasks-cli.md#two-levels-no-tree).
- A worker opens without the `pier-tasks` skill; a lead with `<pier>/lead.md`
  (`LEAD`), never on disk, and its session is listed in the rail like the user's.
- The user designs with the lead in its session, main not in that path; the
  lead's `Design final: <absolute path>` has main launch a new build lead on
  that doc, which launches and integrates workers; main gets milestones only.

### Milestones

Every run or group callback owed to a lead session asks `TaskService.milestone`
(the `Deliverable.milestone` hook, `tasks/outbox.ts`):

- another result still owed the lead (a run in flight whose callback, or whose
  unfinished group's, names it): a plain callback, a lead turn outside any run;
- the result that leaves nothing owed: resumes the lead's last run, prompted
  `[Pier: the last result you were waiting on follows; …]`, and that run's
  callback reaches main once; the resume and the `delivered` marks commit in
  one transaction;
- the lead's last run still running, or a drain: pending for the next sweep;
- nobody waiting on that run, or a resume that cannot be filed (logged): plain.

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
| Head gone from Pi (not live, not on disk) | a new head, reason `lost` |
| Rotation | the new head keeps the previous head's model and thinking (`first`/`lost`: default at `low`) and gets one `session-seed` system input, mode `append` (no turn) |
| Seed | `MEMORY.md`, the ledger since the previous head started, today's and yesterday's notes, the previous head's last 3 exchanges; an unreadable part says so |

- Rotation is lazy, on the next user message; no timer. `MainChain.send` runs
  one at a time, so a race rotates once.
- Compaction: Pi compacts past `contextWindow − reserveTokens`, so
  `setCompactionCap` sets `reserveTokens = window − cap`, never later than the
  instance's reserve, recomputed on `setModel`. While the switch is on a chain
  member opens at 100K (`MAIN_COMPACTION_CAP`) and a session a fresh run made
  at 150K (`CHILD_COMPACTION_CAP`): at a run's start and on every reopen
  (`MainChain.opened`, `TaskService.opened`). Children never rotate.

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
- Surfaces reach the conversation through `MainChain`, which dispatches to the
  head's own `web:<id>` key; the router knows nothing of the chain.

## Web

The routes (`/api/continuous*`), the rail and the pane are
[03](03-web-workbench.md)'s. A bare address or any chain member opens the
conversation at its head; earlier members page in read-only, read off disk
and never opened (`AgentFactory.readHistory`); no paging within a session. Children show as Background Run rows opening their sessions.

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
- A lead keeping `"long"` cache retention during runs.
- The seed capped near 8K.
- `pier search <q>` over the CLI socket (the index is `GET /api/search` only).

## Acceptance

- A week of daily use, web and one IM DM, with no manually opened session and
  every rotation, dispatch, callback and failure visible where it came from.
- A follow-up reaches the same child verbatim; main edits nothing outside the
  home; one feature runs through a lead with main seeing milestones only.
- The week's largest head is recorded; above ~300K tokens, intra-session
  paging is next.
