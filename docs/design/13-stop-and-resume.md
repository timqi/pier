# Stop and resume

Pier is stoppable at any moment and resumes what the stop cut: systemd owns
the process lifecycle, Pier owns the safe point and the resumption. No caller
can wait on its own restart.

## Contract

- **systemd is the only restart.** `systemctl --user restart pier`, `stop`,
  the updater's `stop`, a crash, SIGKILL: one path, one outcome. There is no
  in-process drain, no restart signal of Pier's own, no gate that refuses work.
- **A stop waits for nothing but the safe point.** SIGTERM finds a session
  either idle, streaming a model response, or executing a tool. The first two
  are aborted at once; the third is given a bound to finish its tool, then
  aborted. The process is gone in under the unit's `TimeoutStopSec`.
- **Everything cut resumes at boot.** A turn in flight continues in its
  session; a task run in flight continues on its record, same id, same
  callback; a queued run stays queued. The one who asked for the restart is a
  session like any other: its turn resumes and reads "restart done" in its
  transcript.
- **The stop writes nothing the boot requires.** In-flight state is recorded
  as it happens (turn start, run start), so a SIGKILL or a power loss resumes
  the same way a clean stop does. What only a clean stop can add — the
  in-memory queue, a send cut short — is a bonus, not a dependency.
- **Nothing that happened looks like nothing happening** (AGENTS.md §5): every
  resumed turn names the restart in the transcript the chat sees; every
  resume that fails reaches the chat as a note; every run the bound cut ends
  `interrupted` and reports upstream as it does today.

## Safe point

Per attached session, from the event stream the router already consumes
(`tool-start`/`tool-end`):

| the session is | on SIGTERM |
| --- | --- |
| idle | left alone; an idle session with a non-empty steer/follow-up queue has the texts recorded (see §Records) |
| streaming (model response, no tool running) | aborted now — a partial answer is re-done on resume; the model call costs, the transcript stays consistent (`stopReason: aborted`) |
| executing a tool | waited on until `tool-end`, bound `TOOL_BOUND_MS = 20_000`; then aborted anyway — Pi records the tool result as `Operation aborted`, so the resumed model sees that its command was cut |
| sending a reply (turn ended, adapter mid-post) | waited on until delivered, sharing the remaining budget; cut, it gets today's ledger note ("may have arrived incomplete") |

A tool that starts between the check and the abort is aborted by Pi like any
other; its result says so. A tool that blocks on `systemctl --user restart
pier` without `--no-block` waits on its own stop and costs the bound, nothing
worse — `pier restart` passes `--no-block` for this reason.

Order of the stop, all bounded so the whole takes ≤ 28 s:

1. Inbound closes: adapters disconnect, the HTTP listener stops accepting.
   Outbound clients stay usable until exit. A message that slipped in starts a
   turn, is aborted with the others and resumes at boot — there is no refusal
   path.
2. Sessions to the safe point, in parallel, then `abort()`; per session the
   queue snapshot is written (§Records) before the abort, so a hung abort
   cannot cost it.
3. Sends in flight, remaining budget; the cut ones ledgered.
4. `process.exit(0)`. The pid claim releases on exit as today.

While stopping, an aborted turn's end is neither delivered as a reply nor
settled as a run result: the resume owns it. A turn that ends *naturally* in
the window is delivered and settled as always. The two are told apart by
`turn-end.aborted` (§Seams).

## Records

Three durable places, two of which exist:

- **`turns_in_flight`** (new) — `session_id PK, channel_id, conversation_id,
  started_at, queued JSON NULL`. The router's turn start upserts the row, its
  turn end deletes it — every turn, every day, not only at stop. The stop adds
  `queued` (Pi's steering + follow-up texts, memory-only) to rows it aborts,
  and inserts a row with `started_at NULL` for an idle session whose queue is
  non-empty. Sessions keyed `task` are recorded too: a lead's plain-callback
  turn outside any run has no other record.
- **`task_runs`** — a running or queued run *is* its own in-flight record.
  The stop no longer touches run state. `context.interruptions: number[]`
  (new) appends the boot time of each resume, so `pier task show` and the run
  card can say "interrupted and resumed at …" (`restarts = interruptions.length`).
- **`restart_ledger`** — notes owed to chats, as today: a cut send, a failed
  resume, a run the bound cut. Delivered when adapters are up; removed on
  confirmed delivery.

## Boot

Resumption runs once secrets are unlocked and adapters have started — the
same moment `tellChats` runs today — so a resumed reply has a route and a
failed resume has a chat to tell. Task-run resumes follow the same trigger, not
`tasks.start()`: a run's model needs the credential store unlocked.

### Turns

For every `turns_in_flight` row whose session is not the target of a running
run (those resume through the run):

- session opens (`router.ensure(key)`) → a system input, mode `prompt`,
  origin `{ kind: "restart", at, downMs, queued }`, text:

  > `[Pier restarted at <time> (down <n>s) while this turn was running. Continue where you left off: the transcript above is complete up to the interruption; a tool that was executing then may have been cut short — check its outcome before relying on it.]`
  > followed, when `queued` is non-empty, by
  > `Messages the user sent before the restart that you had not yet seen:` and one `> text` line each.

  The new turn's start upserts the same row; its end deletes it. A second
  crash before that end resumes again — idempotent by construction.
- session already streaming (a user got there first): the queued texts go in
  as a follow-up under the same origin; the restart line is dropped — the
  running turn has the transcript.
- `started_at NULL` (idle with a queue): the texts are delivered as one prompt
  with the origin, no restart line.
- session cannot open (gone, no model, refused): row deleted, ledger note to
  the chat:
  > `Pier restarted while answering and could not pick the answer back up (<why>) — send the message again.`
  > plus `Queued and not delivered:` and the texts, when any.
  For a `web` or `task` key, logged instead, as `recordRestartNote` does today.

The router already forwards a `system-input` event to the chat before the
turn it triggers, so IM sees "Pier restarted … continuing" as a note over the
resumed reply, and the web timeline renders it in place. No UI change.

### Task runs

By action kind, for every row in `running` at boot:

| action | at boot |
| --- | --- |
| `agent`, target session known (`context.sessionId`) | re-executed on the same row: `execution.execute(run)` with the restart text above as the turn's input instead of the rendered prompt (origin `restart`, run fields as a `task-delegation` origin carries them); `interruptions` appended; `startedAt` kept; the timeout budget counts from the resume — downtime is not the run's. The slot cap and the per-session tail apply as to any run. |
| `agent`, no session yet (the stop landed while opening) | re-executed from the start: fresh prompt, same row — nothing has been said to it. |
| `task` (a parent waiting on a child) | re-attaches to its child by `parentRunId` and waits; no second child is launched. |
| `bash`, `system`, a `watch` probe | ended `interrupted`, `INTERRUPTED` the error, callback fired — a script has no place to continue from; the owner decides to rerun. Cron's next occurrence comes regardless. |

A `queued` row stays queued and is dispatched by the tick as any queued run.
A resume that cannot open its session ends the run `failed` with
`could not resume after a restart: <why>` — a failure, not an interruption,
because Pier tried.

Callbacks, groups, joins, waiters, leads and milestones are untouched: the id
is the same, so `TaskGroups.recover`, `--run <id>`, `findActiveRunForTarget`,
`awaitsResults` and the design-lead states all still hold. `milestone`'s
"or a drain: pending" clause goes with the drain.

`interrupted` narrows to "the stop cut a run that cannot continue" (bash,
system, watch). `owesNotice`'s "an interruption always" stays true for those.

## Notices

| what | where |
| --- | --- |
| a turn resumed | the restart system input, in the transcript and as the note the chat gets before the reply |
| a run resumed | the same input in the run's session; `interruptions` on the record |
| a turn that could not resume | ledger note to its chat; log for web/task keys |
| a run that could not resume | run `failed`, callback carries the reason; home chat via `owesNotice` as any failure |
| a cut send | ledger note, as today |
| a bash/system run the bound cut | `interrupted`, callback, home chat via `owesNotice`, as today |
| the stop itself | journal: `SIGTERM — N turn(s), M tool(s) waited on, K run(s) in flight`, then per session what was done and why |

`pier restart` prints: `restarting — Pier is back in a few seconds and
resumes this turn.` A run whose result is only "the service is up" reads
`systemctl --user show pier -p ActiveEnterTimestamp` after its resume.

## Unit

`renderUnit` (`service.ts`) adds to `[Service]`:

```ini
# SIGTERM to Pier alone; a tool's child gets to finish or is SIGKILLed with
# the group at the timeout. The default (control-group) would SIGTERM every
# running command at once.
KillMode=mixed
# Pier is out by 28 s: 20 s for a running tool, the rest for aborts and sends.
TimeoutStopSec=30
```

`KillSignal` stays the default SIGTERM. An installed unit without
`KillMode=mixed` is reported at boot beside the Node-path check
(`updaterProblem` → renamed to cover both): journal `the unit predates
stop-and-resume — run: pier service install --force`, and the version panel's
problem line. Without the reinstall the behaviour is today's `systemctl
restart`: tools die on SIGTERM with Pier, and resume still works — the
difference is a cut tool, not a lost turn.

## Removed

- `drain.ts` → `stop.ts`: the safe-point stop, the `turns_in_flight` writer
  and reader, `RestartLedger` and `deliverLedger`. `drainForRestart`, the 5-min
  deadline, the poll loop go.
- The gate: `Router.beginDrain/endDrain/isDraining`, `refuseDraining`,
  `QueueOperationError("draining")`; `TaskService.pause/unpause/refusePaused`
  and `paused`; `TaskExecution.stop` and the `SHUTDOWN` abort reason.
- `main.ts`: the SIGUSR2 handler, `draining`, `handingOver`, `takeWorkAgain`,
  `HANDOVER_GRACE_MS`; `handOverToUpdater` becomes `startUpdate` and nothing
  else — the updater's `systemctl stop` is the stop.
- `cli.ts`: `signalService`'s SIGUSR2 branch; `pier restart` runs
  `systemctl --user restart --no-block pier` and prints the line above.
- `TaskStore.interruptRunning` → `resumable()` / the per-kind boot pass.
- Auto-update keeps its idle preference (`idle()`): one line of policy, fewer
  interrupted turns, no protocol. Drop it if the user prefers one less branch.

## Seams

- `core/types.ts` `SessionEventPayload` `turn-end` gains `aborted?: true`
  (from `final.stopReason === "aborted"`, `agent/events.ts`). Read by the
  router (no delivery while stopping) and `AgentTaskRunner` (no settle while
  stopping).
- `Router.busy()` entries gain `tool?: string` — the tool executing, for the
  safe-point wait and the journal line. `attachedSessions()` stays for the
  idle-queue snapshot.
- `Router.onTurnStart(listener)` beside `onTurnEnd`, so `stop.ts` maintains
  `turns_in_flight` and `core/` stays SQLite-blind.
- `SystemInputOrigin` gains `{ kind: "restart"; at: number; downMs: number; queued: string[] }`;
  the run case carries the `task-delegation` fields too so the card links
  the run.
- `TaskRunContext.interruptions?: number[]`.
- `AgentSession`: nothing new — `abort()`, `pendingQueue()`, `systemInput()`
  suffice.

## Docs and skills

- `docs/deploy.md` §Restarting and reloading: `pier restart` is
  `systemctl --user restart --no-block pier`; the drain paragraph, the "hard
  stop" distinction under §Updating, and "only Pier starts an update, so it
  can drain first" go; the two unit lines and the reinstall step arrive.
- `docs/architecture.md`: `drain.ts` line → `stop.ts`; the storage note gains
  `turns_in_flight`.
- `AGENTS.md` budgets: `core/` loses "restart gate"; root `src/*.ts` "restart
  ledger" → "the stop and its in-flight ledger".
- `skills/pier-help/SKILL.md` §Service restart: a restart resumes running
  turns and runs; nothing to wait for; never promise "finishes first".
- `skills/pier-tasks/SKILL.md`: "a restart marks them `interrupted`" → "a
  restart resumes them on the same id"; "During a restart drain new runs are
  refused" deleted; `Approved: pier restart` example stays valid.
- `docs/design/09-tasks-cli.md`: run states — `interrupted` narrowed;
  `interruptions` on `pier task show`.
- `docs/design/10-continuous-session.md`: milestone's drain clause.
- `docs/design/11-im-conversation.md`: the notices table rows; "a run that
  calls `pier restart` finishes before the drain exits" → "resumes after it".

## Unverified

- `channels.stop()` keeps outbound clients usable after disconnecting inbound
  (Slack socket mode vs. Web API; Lark WS vs. HTTP) — the stop order in §Safe
  point depends on it; if not, sends are flushed before inbound closes.
- Pi's session load after a SIGKILL mid-tool (an assistant `toolUse` with no
  tool result on disk): whether Pi repairs the transcript on load or the next
  request is refused by the provider. If refused, the resume falls to the
  "cannot open" path and the chat is told — no silent loss, but worth a test.
- Slack redelivers unacked Socket Mode envelopes on reconnect; Lark's
  long-connection semantics for the ≤ 28 s window are not confirmed.

## Build plan

Four worker runs, one worktree each, integrated here in order:

1. `stop.ts` + unit + `main.ts` signal path: safe point, `turns_in_flight`,
   the removals, `KillMode`/`TimeoutStopSec`, the boot check. Tests: the stop
   sequence against `core/session.testkit.ts` (tool wait, bound, snapshot
   before abort, aborted turn-end not delivered).
2. Turn resume: `stop.ts` boot pass, `restart` origin, router `onTurnStart`,
   `turn-end.aborted`, chat notices. Tests: row lifecycle, resume text,
   streaming-target follow-up, failed open → ledger.
3. Run resume: `tasks/` per-kind boot pass, `interruptions`, `task` parent
   re-attach, removal of pause/drain clauses, `pier task show`. Tests in
   `tasks/service.test.ts`.
4. Docs and skills (cheap model).
