# Tasks (product design)

Pier Tasks is a durable execution abstraction, not a cron-only feature. A
client creates a task definition through the Console or HTTP API, starts it
directly or leaves a trigger enabled, and later reads immutable run records.
The same abstraction is exposed to agents as Pier's sub-agent surface.

## Product model

A task definition has two independent parts:

```
Task = Trigger + Action
```

### Trigger

- **Manual**: never starts automatically. It can be run from Console, HTTP, or
  an agent tool. This is also the model for one-off work; the definition
  remains available for audit or another run.
- **Schedule**: a five-field cron expression plus an explicit IANA timezone.
  Console also offers common presets, but stores cron as the source of truth.
- **Watch**: runs a Bash probe in an explicit working directory at a fixed
  interval. Exit `0` means matched and starts the action, exit `1` means not
  matched, and any other exit means the probe failed. It can stop after the
  first match or continue watching.

A watch is a durable polling task, not a resident shell process: Pier starts a
fresh probe for each check and records it. This covers workflows such as
checking `gh` once a minute for a new PR review without turning Pier into a
general process supervisor. A Bash action may itself be long-running, subject
to its timeout, but daemon supervision is outside v1.

### Action

- **Agent**: sends a prompt to a persisted Pi session and records the final
  assistant response. The initial implementation selects an existing session
  or creates a dedicated session in a chosen project, then reuses it on every
  run. The Subagent slice below adds fresh and forked child sessions without
  changing the Task/Run execution path.
- **Bash**: executes a script using `bash -lc` in a configured working
  directory and records exit code, stdout, and stderr. Per-run input is passed
  as JSON on stdin and in `PIER_TASK_INPUT`; it is never interpolated into the
  script by Pier.
- **Task**: starts another task and waits for its result. The child run stores
  `parentRunId`, giving simple composition without adding multi-step DAGs or a
  workflow language. Cycles are rejected when definitions are saved.

An Agent action stores a base prompt. Per-run input is appended as a clearly
delimited JSON input block, and the exact rendered prompt is saved on the run.

## Definition and run records

Definitions are mutable and runs are immutable snapshots. Editing a task
increments its revision; an old run always points to the exact revision and
configuration it used.

A definition contains:

- id, name, optional description, enabled/archived state, and revision
- trigger configuration and computed next check/run time
- action configuration, timeout, callback policy, and working directory or session id
- created/updated timestamps and explicit creator session id when agent-created

Every trigger attempt creates a run record containing:

- run id, task id/revision, trigger source, parent run id, and timestamps
- invoking, target, and callback session ids plus foreground/background mode
- callback delivery state, attempts, next retry, and last delivery error
- state: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`,
  or `skipped`
- exact input and execution context: definition snapshot, cwd, timeout, and,
  for Agent actions, session id, model, and rendered prompt
- result: Agent response and session id; Bash exit code/stdout/stderr; or child
  run id/result for Task actions
- watch probe command, exit code, stdout/stderr, and matched state
- structured error and truncation flags

Stdout and stderr are capped independently; the record says when either was
truncated. Environment variable values are not copied into run context. Runs
survive task archival. Execution fields stop changing at a terminal state;
callback delivery metadata may continue through retry attempts.

Only one run of a definition may be active at once. A due trigger while it is
active creates a `skipped` record with reason `overlap`; Pier does not build an
unbounded backlog. Agent runs wait while their target session is busy and are
marked running only when their prompt starts. A dedicated session avoids
contention; a shared session deliberately shares its existing context.

After a Pier restart, previously `running` records become `interrupted`.
Schedules continue from the next future occurrence (no backfill), and enabled
watches resume at their next interval.

## Console

Add **Tasks** as a top-level item under **Console**, before Configuration. The
name is Tasks, not Scheduled Tasks, because manual and watch tasks are peers.

### Task list

The first screen is a dense table with filters for All, Manual, Scheduled,
Watching, and Archived. It shows:

- name and enabled/running state
- action type
- trigger summary
- next run/check
- last result and duration
- Agent session, when present, as an **Open session** link/action

Primary actions are **New task** and **Run now**. Row actions are pause/resume,
edit, run now, and archive. Archival replaces destructive deletion so execution
history remains reachable.

### Create/edit

Use one form with three sections: Basics, Trigger, and Action. Trigger and
Action are segmented controls; only fields for the selected variants appear.
The Agent session picker includes existing sessions and **Create dedicated
session**. The form shows the next cron occurrence or next watch check before
saving. Saving can optionally start the first run.

### Task detail

The header contains status, next run, Run now, pause/resume, and edit. The body
has Definition and Runs tabs. Runs are newest first and show trigger, start,
duration, outcome, and parent/child relation. Selecting a run opens its input,
context snapshot, output, error, and stdout/stderr without leaving the task.
Agent runs always include **Open session**. Running entries expose Cancel.

Task and run changes arrive as pointer events on the existing workspace SSE;
the client refetches the affected list/detail. Command output need not stream in
v1: status is live, and the complete bounded output appears when the run ends.

## HTTP contract

The Console is a client of the same API:

| Route | Behavior |
| ----- | -------- |
| `GET /api/tasks` | List definitions; filter by trigger/state |
| `POST /api/tasks` | Create a validated definition; optional `runNow` |
| `GET /api/tasks/:id` | Definition plus computed state |
| `PATCH /api/tasks/:id` | Update definition and increment revision |
| `POST /api/tasks/:id/run` | Queue a run with optional JSON `input`; return `202 {runId}` |
| `POST /api/tasks/:id/pause` | Disable future automatic triggers |
| `POST /api/tasks/:id/resume` | Re-enable automatic triggers |
| `POST /api/tasks/:id/archive` | Disable and hide without deleting runs |
| `GET /api/tasks/:id/runs` | Paginated run history |
| `GET /api/task-runs/:id` | Full input/context/result record |
| `POST /api/task-runs/:id/cancel` | Cancel queued/running work |

Clients obtain results from the run resource. They may follow workspace SSE for
the terminal-state pointer or fetch the run later; task execution does not
depend on the client remaining connected. HTTP is the v1 programmatic surface;
a future CLI should remain a thin HTTP client rather than a second execution
path.

## Agent collaboration

Pier registers one `task` tool with operations `list`, `create`, `update`,
`run`, `get`, and `cancel`. It calls the same task service as HTTP. `run` can
return a run id immediately or wait for a terminal result, allowing an agent to
delegate to an Agent task and consume the other session's response as a
sub-agent result. Creator session id and parent run id are propagated for an
auditable collaboration chain.

The tool does not expose raw SQLite or a separate scheduler API. Agent-created
tasks appear immediately in Console and obey the same validation, concurrency,
history, and cancellation rules.

### Session communication

An asynchronous `task.run` records the caller as `invokedBySessionId`, appears
as a live Background Run row in that session, and defaults its callback to the
caller. A waiting call (`wait:true`) returns through the tool result and does
not also callback. Detached calls may override with `callback:none` or
`callback_session_id`. Definition-level callback policies (`none`, `origin`, or a
specific session) cover scheduled and HTTP-started work.

Agent delegation and callbacks use Pi persisted custom messages rather than
pretending to be user input. Their metadata contains task/run/source session
ids; the session stream emits `system-input`, and transcript replay rebuilds the
same System input row. Callback acceptance is a durable outbox state on the run:
failed delivery retries with backoff, while a busy target accepts it as a Pi
follow-up. Full results remain on the run; callback content is bounded and links
to the run id.

### Activity console

Console adds **Activity** before Tasks. **Active sessions** lists streaming or
active-run-linked sessions. **Dependencies** renders directed invocation edges
and dashed callback edges between Session, Scheduler, Task, and Bash Process
nodes; it switches between active runs and the last hour. Session nodes open
chat and edges open their task.

## Subagent slice

Subagent is a mode of running an Agent Task, not another scheduler, tool, or
run store. A manual Agent Task already supplies the useful parts of an agent
profile: a stable name and description for discovery, a base prompt, a project,
and execution policy. A Task Run already supplies ownership, parentage,
cancellation, callbacks, restart recovery, and audit history.

The model-facing verb remains `task.run`. Pier does not add `spawn_agent` or a
second execution service. In product language, running an Agent Task in a new
or forked session is "starting a subagent".

### Goals

- Start an isolated child from a reusable Agent Task, either with fresh context
  or a fork of the invoking session.
- Run several isolated children concurrently, then inspect, steer, stop, wait
  for, or continue them through stable run ids.
- Let a detached child send progress or request a decision from its immediate
  supervisor, with durable provenance and an explicit reply.
- Keep every child as a normal persisted Pi session with one existing event
  stream, so chat, Activity, run history, and callbacks agree.
- Bound recursive delegation and parallel fan-out without introducing a team
  coordinator or workflow language.

### Non-goals

- A shared team chat room, peer discovery, or arbitrary child-to-child mail.
- A shared task board in addition to Pier Tasks.
- Automatic planning, task claiming, consensus, or reviewer loops in runtime.
- Resuming an operating-system process after Pier restarts. Persisted child
  sessions can be continued by a new run; interrupted processes are not.
- Automatic worktree merge. Parallel writers remain an explicit later feature.
- A second Agent Profile store or compatibility loader for community agent
  Markdown. A manual Agent Task is the Pier profile.

### Agent session policy

Agent actions gain an explicit session policy:

```ts
type AgentSessionPolicy =
  | { mode: "reuse"; sessionId: string }
  | { mode: "fresh"; cwd: string }
  | { mode: "fork"; cwd?: string };

type AgentAction = {
  type: "agent";
  prompt: string;
  session: AgentSessionPolicy;
  launch?: {
    model?: ModelRef;
    thinking?: ThinkingLevel;
    capabilities?: "read" | "write";
  };
};
```

- **reuse** is current behavior. It is right for scheduled agents and durable
  specialists that intentionally accumulate memory. Runs serialize naturally
  on the target session.
- **fresh** creates one persisted Pi session per run in `cwd`. It is the default
  classic Subagent behavior: isolated context, independent transcript, and a
  result returned to the invoker.
- **fork** creates a persisted child copied from the invoking session's active
  Pi branch, then appends the delegation input. Parent and child diverge after
  the fork. Pi's compaction entry is copied, so the child sees the same compacted
  context the parent model sees, not the full pre-compaction transcript.

`fork` requires `invokedBySessionId`. A schedule or HTTP run without an explicit
source session fails before a run is started; cron and watch definitions may not
use fork mode. By default the child keeps the source cwd. A different configured
cwd is an explicit cross-project context transfer and is shown as such in
Console.

Existing `{type:"agent", sessionId, prompt}` definitions decode as `reuse`.
Their stored historical run snapshots are not rewritten.

For an Agent Task, `task.run` may override the configured mode with
`session_mode:"fresh"|"fork"`. This lets a stable `Reviewer` task act as a
reused reviewer for a schedule and as an isolated reviewer for delegation. A
fresh override of `reuse` uses the configured session's cwd; a fork override
uses the invoking session's cwd. It may not otherwise override cwd, model,
tools, or the base prompt; those remain trusted definition fields. The effective
policy is copied into the run snapshot.

Optional launch policy applies only to fresh/fork sessions. Model and thinking
inherit Pi defaults when omitted. `capabilities:"read"` enables only read,
grep, find, ls, and the authority-reduced `task` tool; it cannot launch nested
work. `capabilities:"write"` keeps Pi's normal project tools and constrained
Task delegation. Reused sessions own their model and tools, so a definition with
`mode:"reuse"` rejects launch policy rather than mutating a shared session.
These controls reduce accidental authority; they are not an OS sandbox.

Pier does not add a separate system-prompt format in this slice. The Task's base
prompt and delimited per-run input remain the child brief. Project instructions,
skills, extensions, and model defaults continue to come from Pi for the target
cwd.

### Run identity and lineage

Agent runs add these immutable execution fields:

```ts
interface AgentRunLineage {
  rootRunId: string;
  depth: number;
  resumedFromRunId: string | null;
  sessionMode: "reuse" | "fresh" | "fork";
  sourceSessionId: string | null;
  targetSessionId: string | null;
}
```

`parentRunId` remains composition ownership: the run that directly started this
run. For model-facing calls, the service resolves the caller session's active
run and assigns parent/root/depth itself; tool parameters cannot forge lineage.
`rootRunId` and `depth` make fan-out limits cheap to enforce. A continuation uses
`resumedFromRunId`, because it is a later attempt in the same child session, not
a nested unit of work.

For fresh and forked runs, `targetSessionId` is null while queued and is saved as
soon as `AgentFactory` creates the session. The router attaches that child under
the existing `task` conversation key and the Hub subscribes to its normal event
stream. The run stores the final assistant turn; it does not copy the transcript
or tool events into SQLite.

Continuing a terminal run creates a new run from the prior run's immutable
definition snapshot and reuses its `targetSessionId`. It does not silently pick
up edits made to the current Task definition. The new prompt is recorded as a
follow-up brief and the new run links back with `resumedFromRunId`.

### Concurrency and waiting

Automatic triggers preserve the existing overlap rule: when a definition is
already active, cron and watch produce a `skipped` run. Interactive delegation
has different semantics:

- `reuse` runs queue behind their target session.
- `fresh` and `fork` runs may execute concurrently.
- Pier permits at most 4 active Agent runs globally, 4 active children under
  one root run, 16 cumulative children under one root run, and depth 2.
- Limits count logical Task Runs, not model turns. Rejected fan-out returns a
  clear tool error and does not create a half-initialized session.

These are fixed initial limits, not user-facing configuration. Raise them only
after usage shows a real need. Task timeout and output caps continue to apply to
every child independently.

`wait:true` keeps current foreground semantics: the tool result returns the
terminal run. Detached runs return immediately and callback exactly once.
`task.wait` accepts one or more run ids plus `mode:"all"|"first"`, allowing a
parent to launch several detached children and join them without polling. Runs
intended for a join use `callback:"none"`; waiting does not silently consume or
cancel an already configured callback.

Waiting for a run targeting the caller's own session remains invalid. A child
cannot ask a blocking supervisor question when its supervisor invoked it with
`wait:true`, because the supervisor model is blocked in the tool call. Such a
request fails immediately with guidance to return `needs_decision` in the child
result. Interactive supervisor communication is available only to detached
runs.

### Runtime control

The existing run id is the control handle. New operations are:

| Operation | Behavior |
| --------- | -------- |
| `steer` | Persist a control message and deliver it as a Pi steering custom message to a running child |
| `follow_up` | Persist and queue guidance for the child's next turn boundary |
| `wait` | Wait for the first or all selected runs to become terminal |
| `resume` | Create a linked continuation in the same persisted child session |
| `cancel` | Existing behavior; queued work is cancelled and a running child is aborted |

Steer/follow-up delivery has a stable message id and reports `queued`,
`delivered`, `failed`, or `expired`. "Delivered" means Pi accepted the message,
not that the model obeyed it. Reusing a message id with different content is an
error. Pier never retries an authored steer automatically; the caller may issue
a new message linked with `retryOf`.

Queued runs retain guidance in the mailbox and receive it immediately after
their delegation brief. Terminal runs reject steer/follow-up; use `resume`.

### Supervisor channel

Pier extends the existing `task` tool instead of registering `intercom` or
`contact_supervisor`. A session that is currently the target of one Agent Run
may call:

```ts
task({ operation: "contact", reason: "progress", message: "..." })
task({ operation: "contact", reason: "decision", message: "...", wait: true })
```

The service derives the active run and immediate supervisor from the caller
session id. The model cannot choose an arbitrary recipient or forge run
provenance.

- **progress** is fire-and-forget and should only report information that
  changes the supervisor's plan.
- **decision** creates one pending question and may block the child tool call
  until the supervisor replies or the run timeout expires.

The supervisor receives a persisted `pier.system-input` containing task, run,
child, message, and reason metadata. It replies with:

```ts
task({ operation: "reply", message_id: "...", message: "..." })
```

The reply resolves the waiting child tool call. There may be only one unresolved
decision per run. A reply is accepted once; duplicates with the same content are
idempotent, and different content for the same message id is rejected.

Routine completion never uses this channel. The run result and existing callback
outbox remain the only completion path, preventing duplicate completion turns.

### Durable message ledger

Interactive control needs more than the callback columns on `task_runs`, so add
one `task_messages` table:

```ts
interface TaskMessage {
  id: string;
  runId: string;
  kind: "steer" | "follow_up" | "progress" | "decision" | "reply";
  fromSessionId: string;
  toSessionId: string;
  replyTo: string | null;
  retryOf: string | null;
  state: "pending" | "delivered" | "answered" | "failed" | "expired";
  content: string;
  createdAt: number;
  deliveredAt: number | null;
  answeredAt: number | null;
  error: string | null;
}
```

Messages are append-only except for delivery state. Content is bounded to 16
KiB. Delivery checks the target transcript for the same message id before
injecting, using the same idempotency principle as callbacks. Callback storage
is not migrated into this table in this slice; that would be unrelated churn.

After restart, queued/running runs are interrupted as today. Pending authored
messages become `expired`; terminal callbacks still retry through their existing
outbox. A later `resume` starts a new run and new messages rather than pretending
an old blocked tool call survived the process.

### Tool authority

HTTP and Console remain fully trusted on loopback. Model-facing operations are
scoped by caller session:

- A top-level Pier session may create/update tasks and invoke any visible task.
- A child may list/get tasks and runs, contact its immediate supervisor, and
  control only runs in its own descendant tree.
- A child may start another Agent Task only while root depth and fan-out limits
  permit it. It may not create/update definitions or choose an arbitrary callback
  session; the immediate caller is the callback target.
- A child may not invoke a Bash Task indirectly in this slice. It already has
  its own Pi tools when mutation is intended, while a saved Bash Task would
  bypass future child capability restrictions.

Authority is derived server-side from active Task Run lineage. It is not a
model-visible boolean and cannot be widened by tool parameters. These are
application controls, not an operating-system sandbox.

### Agent seam changes

No Pi SDK type leaves `agent/`. The backend-neutral seam gains only launch and
delivery primitives:

```ts
interface AgentLaunchOptions {
  cwd: string;
  name?: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  capabilities?: "read" | "write";
}

interface AgentFactory {
  create(options: AgentLaunchOptions): Promise<AgentSession>;
  fork(sourceSessionId: string, options: AgentLaunchOptions): Promise<AgentSession>;
  resume(sessionId: string): Promise<AgentSession>;
}
```

`AgentSession.systemInput` accepts `"steer"` in addition to `"prompt"` and
`"followUp"`. The Pi adapter creates a branched `SessionManager` and maps the
three delivery modes to `sendCustomMessage`. The Task service never imports Pi.

Fork keeps Pi's active, compaction-aware branch and completed Task history. When
the source leaf is the assistant message currently invoking `task`, its tool
result cannot exist yet; Pier branches from that message's parent so the child
never receives an invalid dangling tool call. The explicit delegation System
input is then the child's first new entry. Broader historical artifact filtering
is added only if real transcripts show confusion.

### HTTP and tool contract

The existing `POST /api/tasks/:id/run` body gains optional `sessionMode` and
`sourceSessionId`. `sourceSessionId` is required for an HTTP/Console fork and is
validated against known sessions; the model-facing tool never accepts it and
derives the source from its caller.

The HTTP additions mirror Task service operations:

| Route | Behavior |
| ----- | -------- |
| `POST /api/task-runs/:id/steer` | Body `{message, mode:"steer"|"followUp"}`; return message receipt |
| `POST /api/task-runs/wait` | Body `{runIds, mode:"all"|"first"}`; wait for terminal runs |
| `POST /api/task-runs/:id/resume` | Body `{message, wait?}`; create linked continuation |
| `GET /api/task-runs/:id/messages` | Ordered control/supervisor message ledger |
| `POST /api/task-messages/:id/reply` | Reply once to a pending decision |

The typed `task` tool adds `wait`, `steer`, `follow_up`, `resume`, `contact`, and
`reply`. `run` adds optional `session_mode`. It does not add parallel arrays or
a workflow script; models can launch multiple detached runs and join them with
`wait`.

### Console behavior

The Tasks view labels Agent definitions with their session policy: Reused,
Fresh, or Fork caller. A fresh/fork run always exposes **Open child session**.

The caller chat's Background Run row adds Open, Steer, and Stop actions while
active, and Continue after completion. A pending child decision appears as a
System input row with Reply; it never looks like a user message.

Activity evolves into Pier's Fleet view without another page:

- Active Sessions shows child role, root run, depth, project, current state,
  duration, model, and context usage.
- Dependencies keeps solid invocation and dashed callback edges; dotted edges
  represent supervisor messages. Selecting an edge opens the run or message.
- Selecting a child opens its normal chat transcript. Control buttons call the
  same HTTP operations as the Task detail view.
- Task Run detail adds a Messages tab beside input/context/output.

The event model stays pointer-only at workspace scope. `task-run-changed` and a
new `task-message-changed` pointer cause clients to refetch; child transcript
content remains on that session's event stream.

### Implementation placement

`TaskService` remains the public execution owner, but the existing module is
already over its size tripwire. The Subagent slice should move Agent action
launch/turn capture into `tasks/agent.ts` and durable message delivery into
`tasks/messages.ts`. This is a size-driven split of one service, not a new seam:
both depend only on `TaskStore`, `Router`, `Hub`, and `AgentSession` contracts.

Implementation order:

1. Add session policies, lineage fields, `AgentFactory.fork`, and fresh/fork
   execution. Verify migration of existing reused Agent Tasks.
2. Add concurrency bounds, `wait`, steer/follow-up, resume, and ownership tests.
3. Add `task_messages`, detached supervisor contact/reply, transcript
   idempotency, and restart expiry.
4. Add chat controls, Run Messages, and Activity/Fleet projections.

Worktree isolation is reconsidered after this slice. Until then, parallel
children should inspect/review concurrently; mutation work should use one child
at a time or explicitly separate project checkouts.

### Subagent acceptance

- A parent can run the same Reviewer Task three times in fresh mode, observe
  three child sessions, wait for all results, and retain complete run lineage.
- A forked child sees the parent's active compacted context, writes only to its
  own future transcript, and links back to the source session and run.
- A detached child can request one decision; the parent receives a persisted
  System input, replies once, and the waiting child continues with that reply.
- A parent can steer or stop only its descendants. Duplicate message delivery
  never produces duplicate System inputs.
- Restart interrupts live children, expires interactive messages, preserves
  sessions and run history, and still delivers any pending terminal callback.
- Console chat, Task detail, and Activity show the same state from Task Runs,
  Task Messages, and each child's single session event stream.

## Storage and boundaries

Use one SQLite database under `PIER_HOME`, accessed directly without an ORM.
`tasks` stores the current definition; `task_runs` stores immutable snapshots
and results. Scheduling, claiming, and terminal updates are transactions so a
trigger cannot be claimed twice.

The task service lives in `tasks/` and depends on core seams, never on the Pi
SDK. Agent execution goes through `AgentSession`; task-originated Agent events
remain on that session's existing event stream. SQLite run records reference
the session stream rather than duplicating its transcript.

Bash execution is intentional local code execution. In v1, task mutation and
execution endpoints are available only on Pier's loopback-bound Console server.
They must not be exposed remotely until authentication and authorization exist.

## Acceptance

- A manual Bash task can be created over HTTP, run after the client disconnects,
  and later returns its input, context, stdout/stderr, exit code, and timestamps.
- A cron Agent task appears in Console with its next run and an action that opens
  the reused session; every run links to the exact assistant result.
- A watch can check a PR once a minute, record every probe, and on match run an
  Agent task or another task, with parent/child history visible.
- An agent can create and invoke an Agent task, wait for its result, or detach it
  and receive one persisted callback without bypassing the common task service.
- Chat shows live background state and persisted system inputs; Activity shows
  active sessions and invocation/callback dependencies.
- Restarting Pier leaves no run stuck in `running` and does not replay missed
  cron occurrences.
