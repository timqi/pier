---
name: pier-tasks
description: Subagents and scheduled tasks with `pier task`. Daily `run`, `--run` and `finish` are in your contract; read this for `--member`, `--bash`, cron/watch, `recover`, `stats` and the goal's mechanics.
---

# Pier tasks

`pier task --help` lists the commands and their flags. `run` prints one
line, `<state> <runId> · <where the result goes>` (`--json`: the whole
receipt); the others one line of JSON; exit 0; a refusal is a `task:` line, exit 1; a bad flag is
`task:` plus the usage, exit 2. `--prompt -` reads stdin.

## Delegate, then end your turn

```sh
pier task run --name "auth review" --model balanced --prompt "Review src/auth/*.ts. Return file:line, issue, fix."
```

The prompt is the whole handoff (goal, constraints, absolute paths, output
format); the child sees nothing of your conversation. `--cwd` defaults to
yours; `--timeout` (default 3600 s) starts when the run does.

**Callbacks are the only delivery; there is no status query.** The result
arrives as a system message once your turn ends, so **end your turn after
launching** — never poll. Keep the receipt's `runId`; the callback names
`Run:`. `--callback steer` interrupts your running turn instead; `none`
drops the result; `--callback-session <id>` delivers elsewhere.

| Flags | Run |
| --- | --- |
| `--task-id <id>` | a saved definition, as is (run now) |
| `--session <id> --prompt …` | continue an idle session (it keeps its cwd and model) |
| `--run <id> --prompt …` | existing run: running → steer; `--after` → after its turn; finished → resume (`--callback*` apply only then). The receipt says which |
| `--member --prompt … --member …` | batch: flags before the first `--member` are defaults, ≥2 members, `--join all` (default) or `first`; the callback is the group's |
| `--bash <script>` | a command, not an agent: its stdout is the result, and `--prompt`/`--model`/`--thinking`/`--role`/`--design`/`--session` beside it are refused |
| `--worktree <branch> [--rounds <n>] [--review-model <tier|model>]` | a code worker's default: a new `wt` worktree off `--cwd`'s branch, reviewed n times (3; `0` none, 1–9), fixed between, stopped short of the merge, one callback opening `Goal:`; `--rounds <n>` alone is a goal in `--cwd`; refused beside `--session`, `--bash`, `--task-id`, `--member`, `save` |

`--bash` is for a command whose output needs no model **and** runs too long to
hold your turn; a quick one belongs in your own shell, where `&` and `wait`
already run several at once. Raise `--timeout` past the hour a long one needs,
or it is killed and reported as timed out. A non-zero exit still delivers what
it printed.

A child's result follows the worker contract — conclusion (paths, risks,
unverified points, ending with the final state it verified, which you trust),
then a status line only when something needs one; it stops only on a
destructive step or a question only you can answer — answer with
`--run <id> --prompt`; a step the user approved goes in the prompt as
`Approved: <step>`. Core owns the join: never aggregate members by hand.

A result's status line is its last non-blank line, plain text (no bold,
bullet or heading), never inside a code block, in English, at most one per
result; one of `Verdict: clean` · `Verdict: findings` ·
`Verdict: blocked — <why>` (a review's) · `Needs your decision — <the question, one line>`.

A goal callback opens with one of four lines, each naming its root `(run <root>, <branch> in <worktree>)`: `Goal: review clean at <sha7> …, waiting on you to merge` means ready, unmerged; `Goal: needs your decision …` asks you to decide; `Goal: … still findings` asks whether to continue; `Goal: failed at <step> — <why>` reports failure, a `Verdict: blocked` review included. While live, `--run <root>` steers the worker, is refused during review or a fix, and resumes it once ended; once ended, `pier task run --run <root> --prompt "<answer>" --rounds <n>` opens a new goal on that root with n reviews (`--rounds` beside `--after` refused), and `--run` without `--rounds` is a plain resume, out of the goal; `pier task cancel --run <root>` cancels the goal.

`pier task finish --run <root> [--remove-worktree]` merges a reviewed goal's branch into its target: a `cheap` run in the main repo, its callback like `run`'s, the worktree removed only with the flag. Refused unless the root's goal ended review clean and the worktree's HEAD is the reviewed sha with a clean tree; a moved branch is re-reviewed first with `--run <root> --prompt "<what changed>" --rounds 1`.

## Model choice

`--model` is required on a fresh run: a tier, or a model the user named.
`--model hardest | balanced | cheap` are tiers the
operator pinned on the menu; thinking follows the pin, `--thinking`
overrides (`off/minimal/low/medium/high/xhigh/max`). The tier per kind of
work is your launching contract's table. A review's model is
`--review-model` on a goal, `--model` on a review you launch yourself; it is
your judgement of the task, the loop reads no diffs.

Any other name is a substring of provider or id ("let gpt review it" is
`--model gpt`); none or several hits lists the pins. `--model ?` prints the
menu, the tier in front of each pinned line; an unassigned tier refuses with
the menu. Never name a model id from memory.

## Cancel · recover

`pier task cancel --run <id> | --group <id>` — the runs you launched.

`pier task recover (--run <id> | --group <id>) --reason <text>` — the full
result after its callback settled, for text the callback clipped (8 000
chars per run, a group's members included; a clipped result keeps its head
and tail and drops the middle) or lost to compaction. `--group` clips each
member at 2 000 the same way, so a long member is recovered with `--run`.
**Never to check progress**: the refusal reveals no state.

`pier task runs [--state failed,interrupted] [--since 7d] [--limit 50]` — the
runs you launched: in flight first, then finished within `--since` (24h),
newest first, at most `--limit` (20; 200 max). A full page says so on stderr:
narrow with `--state` or widen `--limit`. For orientation, never to wait
on a result.

`pier task stats [--days 30]` — finished agent runs by launch tier, role and
model, with each row's recent task names: `named` is a run launched by model
name (or from before tiers were recorded). A row is a question, not a fault:
a lead off `hardest`, or names under a tier that read like another tier's
work, is what to read back to the user.

`--role lead` on a fresh `--prompt` run launches a feature lead: a long-lived
child in the feature's worktree that builds with workers; `--design` beside it
makes it a design lead, which designs with the user until they finalize. It is
the one delegated run that may delegate, never to a lead; only
its reply to the last result owed it reaches its supervisor.

## Saved definitions

```sh
pier task save --name nightly --bash "make check" --cwd /repo --cron "0 3 * * *" --tz UTC
```

Only for schedules or roles run more than once; `--task-id` updates, restating
every flag. Results reach Pier;
`--callback-session <id>` pins a session, `--callback-session none` silences.
`pier task list` shows definitions with `nextRun` and `lastRun`, never runs.

```sh
pier task save --name deploy-done --watch "test -f /repo/DONE" --every 60 --model cheap --prompt "Summarize /repo/DONE."
```

`--watch <script> --every <s>` (≥ 5, in `--cwd`) runs the script each interval:
exit 0 matched → the action runs; exit 1 → nothing, no callback; any other exit
fails the run. The action does not see the script's output. Without
`--repeat` the first match pauses the definition; with it, every match runs.
`--watch` and `--cron` are exclusive.

| Command | Does |
| --- | --- |
| `pier task pause --task-id <id>` | schedule off; still runs on demand |
| `pier task resume --task-id <id>` | schedule on |
| `pier task run --task-id <id>` | run now |
| `pier task archive --task-id <id>` | retired for good |

## Answering the user about the schedule

- Run `pier task list`; the schedule is its cron and watch definitions.
- One line each: name, trigger (cron + zone, or watch every N s), next run,
  last run's state and age. Paused: say so in place of next run.
- One-shots and manual tasks are runs, not schedule.
- Older runs: `pier task runs`; a finished result's full text: `recover`.

## Limits

- A worker does not delegate: `pier task` is refused in a session a delegated
  run created (a lead's aside), in its run and after it, and in any run someone
  waits on — say what needs another agent; the supervisor runs it.
- 6 agent runs execute at once instance-wide, `--bash` runs taking none of
  those slots; the rest queue until cancelled. A restart resumes agent runs on
  the same id; a bash run is marked `interrupted` (callbacks still fire).
