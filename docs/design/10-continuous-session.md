# Continuous session

The contract for one continuous conversation per instance, in front of a
dispatcher session that routes work to task-run children: a trial behind an
instance switch, default off. Behaviour not named here is owned by
[03](03-web-workbench.md), [04](04-im-channels.md) and [09](09-tasks-cli.md).

- Built: Phase 1 (the web conversation) and Phase 2 (the feature lead).
- Not built: Phase 3 (§IM), §Not built, and each "Gap".

## Model

- The user talks to Pier as **one conversation per instance**, the same one on
  web, Slack DM and Lark DM.
- Behind it the **main session** (dispatcher) is a top-level Pi session: it
  answers, remembers, and launches work; it does not edit code itself.
- Real work is a child: `pier task run --prompt … --cwd <dir> --model <name>
  --thinking <level> [--timeout <s>]`, one `wt` worktree per feature
  (`wt switch -c <branch> --no-cd -y --format json` in the repo, its `.path` as
  `--cwd`).
- A follow-up on an existing feature continues that child (`--run <id>`, or
  `--session <id>` once idle), never a new one; the user's words go through
  verbatim, the dispatcher's additions after them, never a re-summary.
- Children are ordinary supervised runs: a worker does not delegate, a
  feature lead does (below); both count against the 6-run instance limit and
  never rotate.
- Callbacks stay the only delivery (`skills/pier-tasks`); the ledger below is
  for orientation, never for waiting.

## Feature lead

Three roles, not three mandatory tiers: main (dispatcher) → feature lead
(optional) → workers. A small task is a worker main launches directly.

| Role | Session | Model | Delegates |
| --- | --- | --- | --- |
| main | the chain head, cwd `$PIER_HOME/home` | instance default, `low` | leads and workers |
| lead | an ordinary child, cwd = the feature's own worktree, long-lived | strong (`--model`); `high` to design, `medium` to build | workers only |
| worker | any session a run launched from a session (`invokedBySessionId`) created, unless a lead; one worktree each | as launched | never |

- A role is the session's for its life, switch on or off; who may delegate is
  [09 §Two levels](09-tasks-cli.md#two-levels-no-tree). A worker's session
  opens without the `pier-tasks` skill; switch off, a lead is an ordinary rail
  session at the instance's compaction.
- A lead never rotates; while the switch is on it compacts at the children's
  cap (§Main session lifecycle), its state being the design doc on disk.
- "I want X" → main launches a lead (`pier task run --role lead`). On the web
  the lead is its own session, in the rail's In progress group while live,
  and the Background Run row in the launching session; IM cards are Phase 3.
- Design phase: the user talks to the lead directly in its session; the
  dispatcher is never in that path.
- Build phase: when the design is final the lead ends its reply with `Design
  final: <absolute path>`; on that milestone, or the user's word, main launches
  a new lead with plain `pier task run --role lead --thinking medium --cwd
  <worktree> --model <the lead's model> --prompt "Build per <path> …"`, the doc
  on disk being the whole state.
- The build lead decomposes the work, launches workers (one `wt` worktree
  each), reviews and integrates their results.
- Main receives milestones only, never one wake per worker result. Workers get
  no card of their own; their callbacks are system notes and Background Run
  rows in the lead's session.
- The lead contract is injected from code as `<pier>/lead.md` for a session
  created or reopened with the role; it is never written to disk. Both role
  contracts are string constants in `src/agent/roles.ts`, read by
  `agent/pi.ts`'s `agentsFilesOverride`.

Mechanics:

- Role marking: `launch.role: "lead"` (`AgentLaunchPolicy`,
  `tasks/types.ts`) becomes `AgentLaunchOptions.role` (`core/types.ts`,
  `lead` | `worker`, `createdRole`) at creation; a reopen asks `roleOf`,
  injected into the factory. `agent/pi.ts` drops `pier-tasks` from a worker;
  `tasks/operations.ts` is the gate.
- A lead's session is not one of the runs' own (`taskOwnedSessionIds`,
  `tasks/store.ts`): the web lists it and marks it unread like a workbench
  session.
- Milestones: every run and group callback to a lead session asks
  `TaskService.milestone` (`tasks/callbacks.ts`, `tasks/groups.ts`):
  - while another result is owed the lead (a run in flight whose own callback,
    or whose unfinished group's, names it), the result is a plain callback: a
    lead turn outside any run, so nothing reaches main; a user message in the
    lead's session is the same;
  - the result that leaves nothing owed resumes the lead's last run, prompted
    `[Pier: the last result you were waiting on follows; …]` with the results,
    and that run's own callback reaches main once; the resume and the
    callbacks' `delivered` marks commit in one transaction, so a crash cannot
    resume twice;
  - the lead's last run not yet finished, or a drain under way: the result
    stays pending and the tick's sweep asks again;
  - nobody waiting on the lead's last run, or a resume that cannot be filed
    (logged): a plain callback.

## Home and memory

- The main session's cwd is `$PIER_HOME/home` (`pierPath("home")`,
  `paths.ts`), created at first use.
- The dispatcher contract is injected from code, beside `<pier>/AGENTS.md`
  (`agent/pi.ts` `agentsFilesOverride`, text in `agent/roles.ts`), as
  `<pier>/dispatcher.md`, only while the switch is on and only for a session
  whose real cwd is the home; it is never written to disk.
  Flipping the switch recycles idle sessions, as a Console save does.
- The home holds memory only:
  - `MEMORY.md` — durable facts, decisions, the project index (repo → path,
    worktree convention); injected once at session open, in the seed.
  - `memory/YYYY-MM-DD.md` — daily notes, instance-local date.
  - `AGENTS.md` — optional user additions, loaded by Pi as the cwd's own file.
- The dispatcher writes a note when a callback settles or a decision is made;
  no Pi hook, no pre-compaction flush.
- Repo knowledge is written by children into that repo's own `AGENTS.md`,
  never into the home.
- Recall is files plus transcripts: `rg` over `memory/` and the Pi session
  directory. Gap: the `agent/listing.ts` index is reachable only as `GET
  /api/search`; no `pier search <q>` over the CLI socket.
- No vector store or memory service is a dependency.

## Main session lifecycle

| Event | Rule |
| --- | --- |
| User message to the main session, head ≥ 1h since its last user message (its start, before it has one) | rotate before delivering: create the next session, append a chain row, deliver to it; a head mid-turn never rotates |
| Callback to the main session | delivered to the head, whatever its idle time; never rotates |
| Rotation | the new session opens with the previous head's model and thinking level (`lost` and `first`: the instance default at `low`), then gets one seed system input, appended without a turn so the user's message is the turn that reads it |
| Seed (every chain session, the first included) | `MEMORY.md`, the run ledger (in flight, and finished since the previous head started), today's and yesterday's daily notes, the previous head's last 3 exchanges verbatim |
| Surface | on the web, the chain divider (`new session — idle 1h`); Gap: the IM line (Phase 3) |
| Within a stretch | Pi auto-compaction on, triggered near 100K context, the last ~20K kept |
| Task-run children (workers, leads) | never rotate; auto-compaction triggered near 150K context |
| Head missing from Pi (not live, not on disk) | a new head with reason `lost`; on the web its divider reads `new session — the previous one was lost` and the lost session's place an error row |

- 1h matches the `"long"` cache retention Pier requests for interactive
  sessions (`CacheRetentionBox`, `agent/pi.ts`); past it the cache is cold
  anyway.
- Rotation is lazy, on the next user message; no timer.
- Launch: the instance default model (`GET /api/config/defaults`) at `low`
  thinking; the operator's header pick sticks to the head and is inherited on
  rotation.
- Compaction mapping: Pi compacts when `contextTokens > contextWindow −
  reserveTokens` and keeps `keepRecentTokens` (default 20000,
  `DEFAULT_COMPACTION_SETTINGS`), so the target is `reserveTokens =
  contextWindow − cap`, per model: main 100K, children 150K. No session grows
  past 200K input, where 1M-context models price higher.
  `AgentSession.setCompactionCap` applies it in memory
  (`settingsManager.applyOverrides({compaction})`, the session's own manager),
  never later than the instance's reserve, and recomputes it on `setModel`.
  While the switch is on, a chain member gets main's cap and a task-run child
  (a session a fresh run made) the children's on every open — a run's start
  (`tasks/agent.ts`) or any reopen (`MainChain.opened`, `TaskService.opened`
  in the router's resolver).
- The seed is the `SystemInputOrigin` kind `session-seed` (`core/types.ts`),
  sent with `systemInput` mode `append`; it renders as a system input card.
  A part that cannot be read says so in the seed.

## Run ledger

- Source: `task_runs` via `TaskStore.ledgerRuns`: runs whose
  `invokedBySessionId` is in the chain, in flight or finished in the window,
  at most 200 (`TaskService.ledger`).
- Surface: `pier task runs`, the last 24h ([09 §`runs`](09-tasks-cli.md#runs));
  in a lead session, the lead's own runs.
- The same read feeds the rotation seed (and IM `/status`, Phase 3).
- Callbacks and ownership follow the chain, switch on or off: a run or group launched by an
  earlier head calls back to the current head (`MainChain.headOf` in
  `tasks/callbacks.ts`, `tasks/groups.ts`), and every chain member counts as
  its launcher for `--run` and `cancel` (`tasks/operations.ts`; `recover`
  checks no ownership).

## Storage (chain)

- No copy of any message: the continuous conversation is an ordered chain of
  Pi sessions, and their transcripts are the record.
- Its only state is the `main_chain` table (`db.ts` migration 28): one row
  per session, `started_at` and `reason` (`first` | `idle` | `lost`).
- The head is the row with the greatest `started_at` (`core/chain.ts`).
- Every surface addresses the conversation through the chain, never by a
  session id: `MainChain.send` resolves the head — rotating first when due,
  one send at a time — and dispatches to the head's own `web:<id>` key; the
  router knows nothing of the chain.

## Web

- The instance switch lives in Settings → Instance (`settings.ts`
  `continuous`, default off); off, the workbench is 03's.
- On: a fixed first rail row, **Conversation**, opens it; the rail below
  it lists only the palette's Running set as **In progress**, and the group
  collapses when empty. Every other session is reached through ⌘K. The phone
  drawer shows the same two parts.
- Opening it (the row, a bare address, or any chain member from ⌘K) shows
  the head; the first message of an empty chain starts it. Scrolling to the
  top, or **Earlier session** at the top, pages back one chain session at a
  time, with a divider naming the rotation after it (`new session — idle 1h ·
  <time>`); a session that cannot be read pages in as an error row.
- No paging within a session: a day without a 1h gap is one `/history`; a
  page re-reads the head, and the pane stays as it is until that answer is in.
- Only the head's turns are editable or rewindable; older sessions render
  read-only (no edit, no next-step buttons), and the composer always sends to
  the head.
- A send this tab expects to rotate (the head's last user message ≥ 1h old,
  or no head) resolves the head first, so the pane is on the new head's
  stream before its message — and any failure of it — lands there; a send the
  server rotates anyway is followed after.
- Children show as Background Run rows (`task-status`), never their
  content; a row opens the child session, which takes messages directly.
- Routes: `GET`/`POST /api/continuous` (the chain; the head a send now would
  reach) and `POST /api/continuous/messages` (the alias send, so a rotation
  between snapshot and send cannot land on an old head), all 404 while the
  switch is off; wire rows in [03](03-web-workbench.md).
- A chain member's `/history`, steps and edit index read its branch
  (`history({branch: true})`), so compacted turns stay in view; an earlier
  member is read off disk, never opened (`AgentFactory.readHistory`).

## IM

Phase 3, not built. The switch is platform-level in the Console's Channels
tab ("DMs use the continuous session"), default off, effective only while the
instance switch is on. Off: every top-level DM message opens its own thread
and session. Group chats never change.

| Inbound (switch on) | Goes to | Reply posts |
| --- | --- | --- |
| DM, top-level message | main session | the DM's main flow, no thread |
| DM, reply in a bound card thread | that child session, bypassing the dispatcher | the thread |
| DM, reply in another bound thread (web handoff, or a thread from before the switch) | its session; the binding is kept | the thread |
| DM, reply in an unbound thread | main session | the DM's main flow |
| DM, `/status` (Slack: `status`) | not a prompt; Pier answers from the ledger | the main flow |
| Group chat | unchanged | unchanged |

- The main-flow reply is the single exception to "Pier never posts into the
  main flow but the handoff root" ([04 Slack facts](04-im-channels.md#slack-facts)).
  Gap: Slack's send refuses an empty `thread_ts` and Lark always replies in
  thread; both adapters gain a chat-level conversation id for the DM.
- Gap: the router delivers a session's replies to one attached chat; the main
  session answers only the surface each user message came from, and a callback
  turn only the surface the run was launched from; no other IM surface mirrors
  it.
- `/status` lists in-flight runs one line each: `<name> · <state> · <age> ·
  <thread link>`; nothing in flight says so.

### Card lifecycle

| Step | Who | What |
| --- | --- | --- |
| Run launched from an IM turn | dispatcher | its reply says what was dispatched |
| Run reports its session (`task-status` with `targetSessionId`) | Pier | posts the card as a thread root (`openThread`) and binds the thread to the child through the handoff binding (`conversations.set` → attach) |
| Child turns | child | post in the card's thread |
| State change (`running` → `succeeded` / `failed` / `cancelled` / `interrupted`) | Pier, from the event stream | edits the card in place |
| Callback settles | dispatcher | one line in the main flow with the thread link; a decision it needs is next-step buttons |

- The card is `<task name> · <state>`, the cwd, and the web link
  (`<publicUrl>/#/session/<id>`); the model never writes it.
- The card needs no store: its message is the thread root, found through
  `conversations.keyOf(targetSessionId)`.
- A queued run has no card yet; it is visible in the dispatcher's reply and in
  `/status`.
- The callback's system note is not posted in the main flow; the card's final
  state and the dispatcher's line are its trace. A failure the dispatcher never
  gets to speak about still reaches the main flow as an error note (§5).
- Gap: `handoff.ts` gains the card root and its edit (Slack `chat.update`,
  Lark `message.patch`), and a consumer of the chain's `task-status` events
  drives it.

## Not built

- A callback to a cold head (>1h) is deferred: card and ledger carry it, the
  next seed reports it.
- A lead keeps `"long"` cache retention during runs (runs switch to `"short"`,
  `tasks/agent.ts`).
- The seed is capped near 8K: `MEMORY.md` capped, the ledger as compact lines,
  the last 3 exchanges as text only, no tool output.

## Acceptance

- A week of daily use from web and one IM DM with no manually opened session.
- Every rotation, dispatch, card state change, callback and failure is visible
  on the surface it came from.
- A follow-up on a feature reaches the same child (same session id in the
  ledger) and the user's words appear verbatim in the child's transcript.
- After a restart mid-run: the card still updates, the callback reaches the
  head, `/status` is right.
- The main session writes no code: its transcript shows no edits outside
  `$PIER_HOME/home`.
- At least one feature runs through a lead: the design conversation never
  passes through main's transcript, workers each have their own worktree, and
  main's flow shows only the lead's milestone lines.
- No worker ever delegates, and no lead launches a lead.
- The largest head of the week is recorded; above ~300K transcript tokens,
  intra-session paging is next work.
