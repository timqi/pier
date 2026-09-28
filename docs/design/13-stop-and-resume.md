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
4. `process.exit(0)`. The pid claim releases on exit.

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

Three durable places:

- **`turns_in_flight`** — `session_id PK, channel_id, conversation_id,
  queued JSON NULL, at`. The router's turn start upserts the row; the session
  going idle deletes it — not the turn end, since a run that drains a queued
  follow-up is one streaming stretch — every turn, every day, not only at
  stop; nothing is deleted while stopping. The stop adds `queued` (Pi's
  steering + follow-up texts, memory-only) to rows it aborts, and inserts a
  row for an idle session whose queue is non-empty; a turn's start never
  overwrites a `queued` the stop wrote. Sessions keyed `task` are recorded
  too: a lead's plain-callback turn outside any run has no other record.
- **`task_runs`** — a running or queued run *is* its own in-flight record.
  The stop does not touch run state.
- **`restart_ledger`** — notes owed to chats: a cut send, a failed resume.
  Delivered when adapters are up; removed on confirmed delivery.

## Boot

One order, in `main.ts`:

1. `TaskService` is constructed and reads the runs in flight — the last
   process's, since nothing in this one has launched any yet.
2. Secrets unlock and adapters start.
3. The pass: runs first (§Task runs), then turns (§Turns), then the ledger
   notes — so a resumed reply has a route, a failed resume has a chat to
   tell, a run's model has its credentials, and a run's target is still
   `running` when the turns are read.
4. The scheduler's tick and its sweeps start. A refused unlock starts them at
   once; the Console's later unlock runs the pass then, and a run the tick
   launched meanwhile is not in the leftover set. A run already executing in
   this process is never entered a second time, whatever asks.

The HTTP listener opens before the unlock settles (a vt approval can take a
human); a request arriving in that window waits for it, and a refused unlock
lets it through to the Console that repairs the key.

Each session's saved `queued` has one owner: the run's resume when the session
is a running agent run's target, the turn's resume otherwise.

### Turns

For every `turns_in_flight` row whose session is not the target of a running
agent run (those resume through the run):

- session opens by its recorded id (`router.ensure(web:<session_id>)`, never
  by the chat key: a chat's lookup creates a session for a chat that maps to
  none, and the home chat maps to none) — the router hands it its chat as the
  delivery key while the adapter is up, its own stream otherwise — then a
  system input, mode `prompt`, origin `{ kind: "restart", at, downMs }`, text:

  > `[Pier restarted at <time> (down <n>s) while this turn was running. Continue where you left off: the transcript above is complete up to the interruption; a tool that was executing then was cut short — check its outcome before relying on it.]`
  > followed, when `queued` is non-empty, by
  > `Messages the user sent before the restart that you had not yet seen:` and one `> text` line each.

  The new turn's start upserts the same row; the session going idle deletes
  it. A second crash before that resumes again — idempotent by construction.
- session already streaming (a user got there first): the queued texts go in
  as a follow-up under the same origin; the restart line is dropped — the
  running turn has the transcript. Nothing queued: nothing is sent, and the
  running turn's idle retires the row.
- session cannot open (gone, no model, refused): row deleted, ledger note to
  the chat:
  > `Pier restarted while answering and could not pick the answer back up (<why>) — send the message again.`
  > plus `Queued and not delivered:` and the texts, when any.
  For a `web` or `task` key, logged instead.

The router already forwards a `system-input` event to the chat before the
turn it triggers, so IM sees "Pier restarted … continuing" as a note over the
resumed reply, and the web timeline renders it in place. No UI change.

### Task runs

For every row in `running` at boot:

| action | at boot |
| --- | --- |
| `agent` | re-executed on the same row through `execution.start(run)`; `agent.ts` sends the restart text above as the turn's input when `context.sessionId` is set — its session's saved `queued` included, as the turn's would be — (origin `restart` carrying the `task-delegation` fields, so the card links the run), the rendered prompt when it is not — nothing had been said to it. `startedAt` is kept; the timeout counts from the resume, downtime is not the run's. Slot cap and per-session tail apply as to any run. |
| `bash`, `system`, `task`, a `watch` probe | ended `interrupted`, `INTERRUPTED` the error, callback fired — a script has no place to continue from; the owner decides to rerun. |

A `queued` row is started by the same pass, oldest first, on its own id. A resume that
cannot open its session ends the run `failed` with `could not resume after a
restart: <why>` — a failure, not an interruption, because Pier tried.

Control messages (`task_messages`) the stop left `pending` are not expired at
boot: the resumed run re-sends them after its restart input, and the tick's
sweep retries the rest — the outbox's transcript proof keeps one that landed
from going twice; one aimed at a run that ended expires in the sweep, as any.

Callbacks, groups, joins, waiters, leads and milestones are untouched: the id
is the same, so `TaskGroups.recover`, `--run <id>`, `findActiveRunForTarget`,
`awaitsResults` and the design-lead states all still hold.

`interrupted` is "a run that cannot continue"; `owesNotice`'s "an
interruption always" holds for those.

## Notices

| what | where |
| --- | --- |
| a turn or run resumed | the restart system input, in the transcript and as the note the chat gets before the reply |
| a turn that could not resume | ledger note to its chat; log for web/task keys |
| a run that could not resume | run `failed`, callback carries the reason; home chat via `owesNotice` as any failure |
| a cut send | ledger note |
| a non-agent run the stop cut | `interrupted`, callback, home chat via `owesNotice` |
| the stop itself | journal: `SIGTERM — N turn(s) aborted, K run(s) left running for the next boot` |

`pier restart` prints: `restarting — Pier is back in a few seconds and
resumes this turn.` A run whose result is only "the service is up" reads
`systemctl --user show pier -p ActiveEnterTimestamp` after its resume.

## Seams

- `Router.onTurnStart(listener)` beside `onTurnEnd`, so `stop.ts` maintains
  `turns_in_flight` and `core/` stays SQLite-blind; `Router.stopping()` closes
  delivery and settlement for the exit.
- `SystemInputOrigin` `{ kind: "restart"; at: number; downMs: number }`,
  optionally with the `task-delegation` run fields.
- `AgentSession`: `abort()`, `pendingQueue()`, `systemInput()` suffice.
- `TaskService.resumeAfterRestart({ at, downMs, queuedFor })`: `queuedFor`
  answers from `turns_in_flight` for a run's session, so `tasks/` stays blind
  to the table.

## Verified

- `channels.stop()` closes only the inbound socket (`slack-api.ts` `connect`,
  `lark-api.ts` `connect`); sends go over `fetch` and `Lark.Client`, which no
  stop disposes, so a send in flight completes after the adapter stopped.
  The adapter's own `stop()` also waits up to 5s for its inbound chains, so
  the stop snapshots sessions beside it, not after it.
- A `toolCall` with no result on disk: pi-ai's `transformMessages` inserts a
  synthetic `No result provided` error result before every request and skips
  assistant messages whose `stopReason` is `aborted`/`error`, so the resumed
  turn is accepted by the provider. Read in the SDK, not exercised against a
  provider.
- Both adapters ack an envelope before the handler runs (`slack-api.ts`,
  `lark-api.ts`), so a message that reached Pier is never redelivered; one
  Slack had not acked is redelivered on reconnect (Slack's documented Socket
  Mode behaviour), and Lark's is not confirmed — either way the turn it starts
  resumes at boot.
