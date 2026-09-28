# Stop and resume

Pier is stoppable at any moment and resumes what the stop cut: systemd owns
the process lifecycle, Pier owns the record and the resumption. No caller can
wait on its own restart.

## Contract

- **systemd is the only restart.** `systemctl --user restart pier`, `stop`,
  the updater's `stop`, a crash, SIGKILL: one path, one outcome. There is no
  in-process drain, no restart signal of Pier's own, no gate that refuses work.
- **A stop waits for nothing.** SIGTERM aborts every streaming session and
  exits in seconds. A tool cut mid-execution is recorded by Pi as
  `Operation aborted`; the resumed model sees that and checks its outcome.
- **Everything cut resumes at boot.** A turn in flight continues in its
  session; an agent run in flight continues on its record — same id, same
  callback; a queued run stays queued. The one who asked for the restart is a
  session like any other: its turn resumes and reads "restart done" in its
  transcript.
- **The stop writes nothing the boot requires.** In-flight state is recorded
  as it happens (turn start, run start), so a SIGKILL or a power loss resumes
  the same way a clean stop does. What only a clean stop can add — the
  in-memory queue, a send cut short — is a bonus, not a dependency.
- **Nothing that happened looks like nothing happening** (AGENTS.md §5): every
  resumed turn names the restart in the transcript the chat sees; every
  resume that fails reaches the chat as a note; every run that cannot continue
  ends `interrupted` and reports upstream as it does today.

## Stop

On SIGTERM or SIGINT, in this order, the whole under the existing 3-second exit
timer in `main.ts`:

1. Inbound closes: adapters disconnect, the HTTP listener stops accepting.
   Outbound clients stay usable until exit. A message that slipped in starts a
   turn, is aborted with the others and resumes at boot — there is no refusal
   path.
2. Per attached session, the queue snapshot is written (§Records), then
   `abort()`; snapshot first, so a hung abort cannot cost it. Idle sessions
   with an empty queue are left alone.
3. Sends in flight are given the remaining budget; the cut ones get today's
   ledger note ("may have arrived incomplete").
4. `process.exit(0)`. The pid claim releases on exit as today.

While stopping, no turn end is delivered as a reply or settled as a run
result, and no `turns_in_flight` row is deleted: the resume owns every turn
that was running when the signal landed. A turn that happened to finish inside
the window is resumed too; the model answers "done" and repeats its answer —
a duplicate, never a loss.

The unit is unchanged: systemd's default `KillMode=control-group` sends
SIGTERM to a tool's child as well, which is the abort Pi would have sent it;
the default `TimeoutStopSec` never matters for a 3-second exit. A tool that
blocks on `systemctl --user restart pier` without `--no-block` is cut like any
other; `pier restart` passes `--no-block` so the issuer's turn ends cleanly.

## Records

Three durable places, two of which exist:

- **`turns_in_flight`** (new) — `session_id PK, channel_id, conversation_id,
  queued JSON NULL`. The router's turn start upserts the row, its turn end
  deletes it — every turn, every day, not only at stop. The stop adds `queued`
  (Pi's steering + follow-up texts, memory-only) to rows it aborts, and inserts
  a row for an idle session whose queue is non-empty. Sessions keyed `task`
  are recorded too: a lead's plain-callback turn outside any run has no other
  record.
- **`task_runs`** — a running or queued run *is* its own in-flight record.
  The stop no longer touches run state.
- **`restart_ledger`** — notes owed to chats, as today: a cut send, a failed
  resume. Delivered when adapters are up; removed on confirmed delivery.

## Boot

Resumption runs once secrets are unlocked and adapters have started — the
moment `tellChats` runs today — so a resumed reply has a route, a failed
resume has a chat to tell, and a run's model has its credentials.

### Turns

For every `turns_in_flight` row whose session is not the target of a running
agent run (those resume through the run):

- session opens (`router.ensure(key)`) → a system input, mode `prompt`,
  origin `{ kind: "restart", at, downMs }`, text:

  > `[Pier restarted at <time> (down <n>s) while this turn was running. Continue where you left off: the transcript above is complete up to the interruption; a tool that was executing then was cut short — check its outcome before relying on it.]`
  > followed, when `queued` is non-empty, by
  > `Messages the user sent before the restart that you had not yet seen:` and one `> text` line each.

  The new turn's start upserts the same row; its end deletes it. A second
  crash before that end resumes again — idempotent by construction.
- session already streaming (a user got there first): the queued texts go in
  as a follow-up under the same origin; the restart line is dropped — the
  running turn has the transcript. Nothing queued: the row is deleted.
- session cannot open (gone, no model, refused): row deleted, ledger note to
  the chat:
  > `Pier restarted while answering and could not pick the answer back up (<why>) — send the message again.`
  > plus `Queued and not delivered:` and the texts, when any.
  For a `web` or `task` key, logged instead, as `recordRestartNote` does today.

The router already forwards a `system-input` event to the chat before the
turn it triggers, so IM sees "Pier restarted … continuing" as a note over the
resumed reply, and the web timeline renders it in place. No UI change.

### Task runs

For every row in `running` at boot:

| action | at boot |
| --- | --- |
| `agent` | re-executed on the same row through `execution.start(run)`; `agent.ts` sends the restart text above as the turn's input when `context.sessionId` is set (origin `restart` carrying the `task-delegation` fields, so the card links the run), the rendered prompt when it is not — nothing had been said to it. `startedAt` is kept; the timeout counts from the resume, downtime is not the run's. Slot cap and per-session tail apply as to any run. |
| `bash`, `system`, `task`, a `watch` probe | ended `interrupted`, `INTERRUPTED` the error, callback fired, as today — a script has no place to continue from; the owner decides to rerun. |

A `queued` row stays queued and is dispatched by the tick. A resume that
cannot open its session ends the run `failed` with `could not resume after a
restart: <why>` — a failure, not an interruption, because Pier tried.

Callbacks, groups, joins, waiters, leads and milestones are untouched: the id
is the same, so `TaskGroups.recover`, `--run <id>`, `findActiveRunForTarget`,
`awaitsResults` and the design-lead states all still hold. `milestone`'s
"or a drain: pending" clause goes with the drain.

`interrupted` narrows to "a run that cannot continue"; `owesNotice`'s "an
interruption always" stays true for those.

## Notices

| what | where |
| --- | --- |
| a turn or run resumed | the restart system input, in the transcript and as the note the chat gets before the reply |
| a turn that could not resume | ledger note to its chat; log for web/task keys |
| a run that could not resume | run `failed`, callback carries the reason; home chat via `owesNotice` as any failure |
| a cut send | ledger note, as today |
| a non-agent run the stop cut | `interrupted`, callback, home chat via `owesNotice`, as today |
| the stop itself | journal: `SIGTERM — N turn(s) aborted, K run(s) left running for the next boot` |

`pier restart` prints: `restarting — Pier is back in a few seconds and
resumes this turn.` A run whose result is only "the service is up" reads
`systemctl --user show pier -p ActiveEnterTimestamp` after its resume.

## Removed

- `drain.ts` → `stop.ts`: the stop sequence, the `turns_in_flight` writer and
  reader, `RestartLedger` and `deliverLedger`. `drainForRestart`, the 5-min
  deadline and the poll loop go.
- The gate: `Router.beginDrain/endDrain/isDraining`, `refuseDraining`,
  `QueueOperationError("draining")`; `TaskService.pause/unpause/refusePaused`
  and `paused`; `TaskExecution.stop` and the `SHUTDOWN` abort reason.
- `main.ts`: the SIGUSR2 handler, `draining`, `handingOver`, `takeWorkAgain`,
  `HANDOVER_GRACE_MS`; `handOverToUpdater` becomes `startUpdate` and nothing
  else — the updater's `systemctl stop` is the stop.
- `cli.ts`: `signalService`'s SIGUSR2 branch; `pier restart` runs
  `systemctl --user restart --no-block pier` and prints the line above.
- `TaskStore.interruptRunning` → the per-kind boot pass.
- Auto-update keeps its idle preference (`idle()`): one line of policy, fewer
  interrupted turns, no protocol.

## Seams

- `Router.onTurnStart(listener)` beside `onTurnEnd`, so `stop.ts` maintains
  `turns_in_flight` and `core/` stays SQLite-blind; `Router.stopping()` closes
  delivery and settlement for the exit.
- `SystemInputOrigin` gains `{ kind: "restart"; at: number; downMs: number }`,
  optionally with the `task-delegation` run fields.
- `AgentSession`: nothing new — `abort()`, `pendingQueue()`, `systemInput()`
  suffice. `core/types.ts` events: nothing new.

## Docs and skills

- `docs/deploy.md` §Restarting and reloading: `pier restart` is
  `systemctl --user restart --no-block pier`; the drain paragraph, the "hard
  stop" distinction under §Updating and "only Pier starts an update, so it
  can drain first" go.
- `docs/architecture.md`: `drain.ts` line → `stop.ts`; the storage note gains
  `turns_in_flight`.
- `AGENTS.md` budgets: `core/` loses "restart gate"; root `src/*.ts` "restart
  ledger" → "the stop and its in-flight ledger".
- `skills/pier-help/SKILL.md` §Service restart: a restart resumes running
  turns and runs; nothing to wait for; never promise "finishes first".
- `skills/pier-tasks/SKILL.md`: "a restart marks them `interrupted`" → "a
  restart resumes agent runs on the same id"; "During a restart drain new
  runs are refused" deleted; `Approved: pier restart` example stays valid.
- `docs/design/09-tasks-cli.md`: run states — `interrupted` narrowed.
- `docs/design/10-continuous-session.md`: milestone's drain clause.
- `docs/design/11-im-conversation.md`: the notices table rows; "a run that
  calls `pier restart` finishes before the drain exits" → "resumes after it".

## Unverified

- `channels.stop()` keeps outbound clients usable after disconnecting inbound
  (Slack socket mode vs. Web API; Lark WS vs. HTTP) — the stop order depends
  on it; if not, sends are flushed before inbound closes.
- Pi's session load after a SIGKILL mid-tool (an assistant `toolUse` with no
  tool result on disk): whether Pi repairs the transcript on load or the next
  request is refused by the provider. If refused, the resume falls to the
  "cannot open" path and the chat is told — no silent loss, but worth a test.
- Slack redelivers unacked Socket Mode envelopes on reconnect; Lark's
  long-connection semantics for the exit window are not confirmed.

## Build plan

Three worker runs, one worktree each, integrated here in order:

1. `stop.ts` + `main.ts` signal path + turn resume: the stop sequence, the
   removals, `turns_in_flight`, router `onTurnStart`/`stopping`, the `restart`
   origin, the boot pass and its notices. Tests against
   `core/session.testkit.ts`: snapshot before abort, no delivery while
   stopping, row lifecycle, resume text, streaming target, failed open → ledger.
2. Run resume: `tasks/` per-kind boot pass, `agent.ts` restart input, removal
   of pause/drain clauses. Tests in `tasks/service.test.ts`.
3. Docs and skills (cheap model).
