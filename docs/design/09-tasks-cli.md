# `pier task` (design)

The whole agent-collaboration surface: ten shell commands over the CLI
socket ([08-cli-socket.md](08-cli-socket.md)), served by `handleTask`
(`tasks/operations.ts`). Scheduling, delivery, limits and callbacks are
`tasks/`'s and unchanged by this surface.

## Commands

| Command | Does |
| --- | --- |
| `run` | puts a prompt on a run: a new one, a batch of new ones (`--member`), or an existing one (`--run`) |
| `save` | files or updates a definition the operator sees — cron, watch, or a role run more than once |
| `list` | stored definitions, as JSON, each with `nextRun` and `lastRun` (§`list`) |
| `pause` · `resume` · `archive` | `--task-id <id>`: a definition's schedule off, on, or retired (§Schedule verbs) |
| `runs` | the run ledger, as JSON (§`runs`) |
| `stats` | dispatched runs by launch tier, role and model, as JSON (§`stats`) |
| `cancel` | `--run <id>` or `--group <id>`, descendants included |
| `recover` | `--run`/`--group` + `--reason`: the full result after its callback settled; never a progress check |

Every command returns at once and prints the receipt as compact JSON on
stdout, exit 0; `run`'s is one line instead (`receiptLine`, `tasks/cli.ts`) —
`<state> <runId> · <next>`, a group's `<state> group <groupId>: <runId>, … · <next>`,
a resume `resumed: …`, one in a new session `resumed in a new session (<reason>): …`, a steer or follow-up `<delivery> → run <runId> · <message state>` —
and `--json` prints the answer's object. A refusal is one `task: <reason>` line on stderr, exit 1;
argv errors are the usage line, exit 2, before the socket is touched.
`--prompt -` reads stdin; nothing else reads it. An empty `--prompt` (stdin
or typed) or `--name`, and a `--timeout` outside 1–86400, are argv errors.

The CLI checks argv shape only; the server (`handleTask` → `parseDraft`) is
the one validator of the params object.

## `run`

```
pier task run [--prompt <text|-> --model <tier|model|?> | --bash <script>] [--run <id> [--after | --rounds <n>] [--fresh]] [--task-id <id>] [--session <id>]
        [--thinking <level>] [--role lead [--design]] [--worktree <branch>] [--rounds <n>] [--review-model <tier|model>]
        [--cwd <dir>] --name <text> [--timeout <seconds>]
        [--callback origin|none|steer] [--callback-session <id>] [--join all|first] [--member <flags…>]…
```

- **New run**: `--prompt` (one-shot, fresh session in `--cwd`, default the
  caller's, a main session's `$PIER_HOME/workspace`, which a relative one resolves against too; `--model` required — §Models), or `--bash` (a one-shot script action in the same `--cwd`, no
  session and no model — `--prompt`, `--model`, `--thinking`, `--role`, `--design` and
  `--session` beside it are refused), or `--task-id` (a saved definition, as
  is), or `--session <id>` with `--prompt` (continue an idle session; `--cwd`
  refused). A fresh `--prompt` run, top-level or a `--member`, needs `--name`
  (`task: a new run needs --name: …`); the others keep a name drawn from the text.
- **`--role lead`**: rides as `launch.role` on a fresh `--prompt` run, whose
  session is a feature lead's for its life (§Two levels); any other value, and
  `--role` beside `--session`, is refused by the server; beside `--task-id` or
  `--bash`, by argv. `--worktree` beside it makes the lead's worktree and
  opens no goal; `--rounds` and `--review-model` beside it are refused. `--design` rides as `launch.design: true` and tags the
  lead `design` (the user finalizes it); the server refuses it without
  `--role lead`. A lead run's callback fires only for a milestone resume,
  a result with a `Design final:` line, a build lead's run that leaves no result
  coming to it, or a run that did not succeed; any
  other settles as `--callback none`, `callbackError` "a lead's turn, not a
  milestone".
- **`--rounds <n>`**: rides as `launch.rounds`, the reviews a goal allows
  (0–9); present, the fresh `--prompt` run roots a goal (`tasks/goals.ts`):
  reviewed by a run Pier launches, fixed by resuming the worker, ended on a
  clean review with the merge left to the user; a findings review that is the
  `n`th ends it `cap`, a review ending `Verdict: blocked — <why>` ends it
  `failed`. A review runs the project's checks once (a failing one is a
  P0), installing dependencies without changing a tracked file and leaving
  the tree as it found it, ranks each issue P0–P3 and answers `findings`
  only for a P0 or P1; P2/P3 alone are `clean`, listed between whole lines
  `P2/P3 begin` and `P2/P3 end` under `Minor issues` and
  `Design suggestions`, never fixed by the goal. A clean goal's callback
  carries the review's opening before it (300 chars) and that framed list
  (3000) for the dispatcher to filter, else the review clipped to 1000.
  `--rounds 0` is no goal. A stored `until` reads as `rounds` 3.
  A review's requirement is the first prompt, then every resume and delivered
  message the worker's session was given, in order, each under a steering
  head; Pier's fix prompts are not in it, and an `Approved:` line anywhere in
  it authorizes nothing.
  Refused beside `--bash`, `--task-id`, `--session`, `--role` (argv), in a
  `--member`, on `save` or with `--callback none` (server).
- **`--worktree <branch>`**: rides as `launch.worktree`; the server runs
  `wt switch -c <branch> -b <--cwd's branch> --no-cd -y --format json` in
  `--cwd` (never a shell) and starts the session in the worktree it prints,
  after the server's other checks and before the definition is filed, whose
  own checks argv makes first; `wt`'s failure is the refusal
  (`task: wt: …`). Alone on a worker it means `--rounds 3`; on a lead, no
  goal. Refused beside `--bash`, `--task-id`, `--session`, in a `--member`
  and on `save`.
- **`--run <root> --prompt … --rounds <n>`**, `n` 1–9: accepted only when
  that run is a goal's root whose goal has ended; the resume opens a new goal
  of `n` reviews on the resumed run, on `--review-model` else the ended goal's;
  when a review ended that goal with findings or a decision, its full text
  goes before the prompt, the words after it.
  Beside any other `--run`, `--rounds` 1–9 is refused; `--rounds 0` is no
  `--rounds`, and without it `--run` is a plain resume, out of the goal.
- **`--review-model <tier|model>`**: rides as `launch.reviewModel`, the
  review's model; absent, the root's tier, else its model; refused without
  `--rounds` or `--worktree`.
- **Existing run** `--run <id>`: one `message {run_id, message, after?,
  callback?, callback_session_id?}` request. The server picks by the run's
  state: running → steer; `--after` → follow-up queued behind its current
  turn, shown in the target's queue panel under the run's name and as `1 queued`
  on the sender's Background Run row while pending; terminal → resumed as a new
  run on the same session, or in a new one (§Continuing a run), taking `--callback*` like any new run (`--after`
  has no turn to wait for and changes nothing). Receipt: `{delivery: "steer" | "follow_up",
  message}`, `{delivery: "resume", run}` or `{delivery: "handoff", reason, run}`. `--callback*` on a run that is not
  terminal is refused (`task: run <id> is <state>: callback options apply to a
  resumed run only; drop them to steer or follow up`). `--run` takes nothing
  but `--prompt`, `--after`, `--callback*`, `--fresh` and, on an ended goal's root,
  `--rounds` and `--review-model`.
- **Batch**: the first `--member` switches `run` to a group. Flags before it
  are every member's defaults; each `--member` opens one member whose flags
  override them; a `--task-id` member takes no defaults and refuses its own
  run flags. `--join` (default `all`), `--callback`, `--callback-session`
  belong before the first `--member`. Members are ordinary argv; at most one
  may read `--prompt -`. Admission is all-or-nothing.

## Continuing a run

A terminal run's `--run` continues in a new session when its session
compacted (any run's `compactions` ≥ 1), when any run's `peakTokens` passed 70%
of its `compactAt`, or on `--fresh` (`fresh: true`; refused on a run not
terminal and beside `--after`) — only for a session a fresh run created, every
run of it ended, no result owed to it; `--fresh` on any other is refused, the
automatic case resumes in place (`tasks/handoff.ts`). `--run` on a run whose
session a handoff replaced is refused, naming the replacing run, rechecked in
the transaction that inserts the new run; a handoff run that ended before its
session opened replaces nothing, and `--run` on it names the run it continued.

- The new run is `sessionMode: "fresh"` in the creating run's directory, on
  its definition with `launch.model`/`thinking` the old session's last, its
  role, phase, worktree and rounds kept; `handoff: {fromSessionId, reason,
  prompt}` on its record.
- Its first message, after the run's preamble: the continuation and why, the worktree as the
  truth (read before changing), the creating run's prompt, the session's last
  ended result (4000 chars), `git log --oneline` and `git diff --stat` from the
  merge-base with the target to `HEAD` (60 lines each; a failure is named in
  its place), the session's latest goal review if one ended there (4000), then
  the prompt.
- Its callback says `New session, replacing <session>: <reason>`; a goal's
  re-entry (`--rounds`) on it carries no second copy of the review, and its
  reviews' requirement takes the replaced session's steering first.

Every agent run records `compactions` (its session's `context-compacted`
events), `peakTokens` (the largest of its turn ends' context and a compaction's
`before`) and `compactAt`; its callback, its `runs` row and an open item's run (`context`)
print `peak <n>% of the compaction point, <k> compactions`; a goal's end prints
the worker session's latest run's.

## `save`

```
pier task save [--task-id <id>] --name <text> (--prompt <text|-> --model <tier|model> | --bash <script>)
        [--cron "<expr>" --tz <zone> | --watch <script> --every <seconds> [--repeat]]
        [--cwd <dir>] [--timeout <seconds>] [--thinking <level>] [--callback-session <id|none>]
```

`--task-id` updates, otherwise creates; an archived task or a one-shot's
hidden definition (`kind: subagent`) is refused. No trigger means `manual`.
`--bash` is a script action, `--prompt` an agent action; exactly one. `--cwd`
defaults and resolves as on `run`, so a main session's definition runs in
`$PIER_HOME/workspace`, never its home. `save`
restates the whole definition, callback included:

- no `--callback-session` → `{type: "conversation"}`, also `definitions.create`'s
  default: each run's callback is the head when the
  run is prepared (`callbacks.target`), so a rotated head gets it; before the
  conversation's first message there is no head and no callback;
- `--callback-session none` → `{type: "none"}`, the one silent definition;
- `--callback-session <id>` → that session.

A watch probe that did not match settles with no callback, whatever the target.

## `list`

```
pier task list
```

Every definition but a one-shot's, `nextRunAt` renamed `nextRun`, plus
`lastRun`: `{runId, state, startedAt?, finishedAt?}` of `listRuns(id, 1)[0]`,
or `null`.

## Schedule verbs

```
pier task pause --task-id <id>
pier task resume --task-id <id>
pier task archive --task-id <id>
```

One socket op each (`operation: "pause" | "resume" | "archive"`), calling
`TaskService.setEnabled(id, false | true)` / `archive(id)`; a `subagent`
definition and a Pier-owned one are refused. Receipt: the definition. Run now is `run --task-id`; a paused
definition still runs on demand, an archived one never.

## `runs`

```
pier task runs [--state <state>[,<state>…]] [--since <n>m|h|d] [--limit <n>]
```

Any session, a delegated run's included (§Two levels, no tree). Receipt: a
JSON array of `LedgerRun` (`core/types.ts`), an agent run's with its `context` (§Continuing a run), the runs the caller launched —
every chain member's, for a member of the head; every run, for a delegated
run's — in
flight plus finished within `--since` (default 24h), only the `--state`s given,
in flight first then newest first, at most `--limit` (default 20, max 200); a
full page adds a `task:` line on stderr that there may be more.
Socket params: `states`, `since_ms`, `limit`. A restart resumes an agent run
on the same id; a non-agent run cut by the restart ends `interrupted`.

## `stats`

```
pier task stats [--days <n>]
```

Any session, a delegated run's included, over the whole instance. Receipt: `{ days, rows }`, `days` a positive whole number
(default 30; else an argv error, and the server refuses it again). One row
per (tier, role, provider, id, thinking) over the agent-action runs a
session or the user fired (`triggerSource` agent/manual) that opened a
session and finished in the window: `tier` is `launch.tier` or `named` for a
launch with no tier (a model the caller named, or a run from before
`launch.tier` existed); `role` is lead or worker, a run with no role being
the head's own; `runs` counts succeeded + failed, `cancelled` cancelled +
interrupted; `names` the five most recently finished distinct task names;
`toolCalls` the sum of the runs' own counts — each run records, as it ends,
the tool calls its turn made (`TaskRun.toolCalls`), each call a codemode
script made counted beside the script's own, so runs resuming one session
count apart; `codemodeRuns` the runs that called `codemode`,
`codemodeRunIds` the five newest of them; `uncounted` the runs with no count
(finished before counts were recorded, or resumed after a restart, whose
calls before the stop were never saved), outside the other three. One SQL
statement over the run rows; no transcript is read.
Rows in tier order then lead before worker then `runs` descending. A row is
a question for the reader (five reviews under `hardest`), never a verdict;
the verb prints no duration, tokens or cost.

## Models

`--model <name>` rides as `launch.model`, a string, matched in `expandDraft`
against the operator's menu (`settings.modelMenu`; the live catalog when
none is pinned). A fresh agent session — `run --prompt`, each `--member`,
`save` with a prompt — refuses without it: `task: --model is required — a
tier (hardest | balanced | cheap) or a model on the operator's menu:` then
the menu, exit 1; `--session`, `--run` and `--bash` have their model
settled already; `run --task-id` takes the definition's own, the instance
default where it names none (the Console's task form is not on this path).
Nothing inherits the caller's model.

- a tier (`hardest`, `balanced`, `cheap`) is the first pin on it in menu
  order, `--thinking` defaulting to the pin's, never a substring match; an
  unassigned tier is `task: model "<name>": tier <tier> is unassigned — the
  operator's menu:` then the whole menu, exit 1;
- an exact `provider/id` on the menu is that pin — its first row, where the
  model is pinned at several levels;
- else case-insensitive substring hits over `provider/id` that are all one
  model are its first pin, `--thinking` defaulting to the pin's;
- else no hit and a `provider/id` shape is taken as written, no thinking;
- else `task: model "<name>" matches <n> of the menu:` then one line per pin
  (`tier · provider/id · thinking`, the tier only on a pin that has
  one; the hits when several, the whole menu
  when none), exit 1.

A resolved pin's tier is stored as `launch.tier`, never taken from a caller;
the run's cards show it while the session runs that pin's model.

`--model ?` prints the menu instead of running, exit 0: a line naming its
source (the operator's menu, or the live catalog when none is pinned) then
the same one-line-per-pin shape. It is the one answer that is text, not JSON;
the CLI prints a string result as it came.

## Decisions

A subagent that needs an answer ends its turn with the question as its
result; the supervisor answers with `pier task run --run <id> --prompt
"<answer>"` (a resume). There is no mid-run channel; control messages are
`steer` and `follow_up` only (`tasks/messages.ts`, migration 25).

A goal's step runs settle as `--callback none` with `callbackError` "a
goal's step, not its end", and the goal's end is one callback to the root
run's target, headed by its `Goal:` line; `--run` on a goal's settled run
while the goal is live is refused (`task: run <id> is in a goal (<step>);
cancel it or wait for its end`), and `cancel --run` ends the goal.
The `Goal:` line names the root, `(run <root>)`, with `, <branch> in
<worktree>` inside once a review has pinned the branch; when
a review ended the goal the body is the worker's latest result (1500
characters on a clean goal, else 3000), then `Review:` and the review's (1000).

## Two levels, no tree

Who may call `pier task`, by the caller's session; each refusal exits 1:

- a feature lead's (made by a `--role lead` run): may, but not launch a lead —
  `--role lead`, a saved lead definition, a lead batch member — refused before
  anything is filed (`task: a feature lead cannot launch a lead; …`);
- a worker's (made by any other run launched from a session): never, in its
  run or after it (`task: a worker's session never launches a run, …`);
- any other while a supervised run (a `callbackSessionId`, its own or its
  group's) is `running` on it: refused (`task: a run cannot launch a
  run; …`); a queued run gates nothing;
- otherwise — a top-level session, a cron or watch run's — may.

`runs` and `stats` are read-only and open to a worker's session and a
supervised run too, both over the whole instance: `runs` lists every run,
whoever launched it, cron and watch runs included.

A session's role is fixed by the run that made it, for the session's life
([10 §Roles](10-continuous-session.md#roles)).

Ownership: the session that launched a run controls it, and so does the run's
own session; every session represented in the head's history counts as the one
that launched it ([10 §Run ledger](10-continuous-session.md#run-ledger)).
`parentRunId` links only a `task` action's child, which a cancel walks. The run contract is `RUN_RESULT` (`agent/roles.ts`): the result's shape and the status lines `statusLine` parses (`tasks/goals.ts`); what stops a run, and the `Approved:` line that lifts it for one step, is the baseline's Working style (`agent/pi.ts`). A worker's session carries it in `<pier>/worker.md` for its life, with the refusal of `pier task`; a lead's `<pier>/lead.md` has its own; a role-less session (cron, a user's) hears it on each run's message, after the chat-surface conventions that do not apply. Every run's message opens `[Pier task run <id> — "<name>"]`; a role-less one adds who reads the result (`tasks/agent.ts` `preamble`); a `--run` continuation and a restart resume carry no head.

## Skill

`skills/pier-tasks/SKILL.md` keeps every rule that governs behaviour: end the
turn after launching; callbacks are the only delivery; ownership; the
instance limit; workers do not delegate, a lead delegates to workers only;
`recover` only for lost text; models by name. Its size is measured in the
commit that changes it.

## Tests

`tasks/cli.test.ts`: every command's argv → the exact params object posted,
`--member` defaults/overrides, `--run` receipts, `--callback` refused on a
running run (server answer), `--prompt -` once, usage exit 2 without the
socket. `tasks/operations.test.ts`: the supervised-run gate, ownership,
`message`'s three branches, `recover`'s refusals, model matching (one, none,
many, full id, `?`), the schedule verbs, `list`'s two fields.
`tasks/service.test.ts`: the `--model` refusal on every fresh shape, `stats`
over a seeded ledger.
`tasks/continuous.test.ts`: the chain's callbacks, a saved definition's
default reaching the current head, `none` and a head-less conversation silent, ownership,
`runs`, a delegated run's `runs` and `stats`, the children's cap. `tasks/lead.test.ts`: roles, depth,
the milestone flow.
