---
name: pier-tasks
description: Subagents and schedules with `pier task` beyond your contract — `--member`, `--bash`, cron/watch, `recover`, `stats` and the goal's mechanics.
---

# Pier tasks

`pier task --help` lists the commands and their flags. `run` prints one
line, `<state> <runId> · <where the result goes>` (`--json`: the whole
receipt); the others one line of JSON; exit 0; a refusal is a `task:` line, exit 1; a bad flag is
`task:` plus the usage, exit 2. `--prompt -` reads stdin.

## Launch, then end your turn

```sh
pier task run --name "auth review" --model balanced --prompt "Review src/auth/*.ts. Return file:line, issue, fix."
```

The prompt is the whole handoff (goal, constraints, absolute paths, output
format); the run sees nothing of your conversation. `--cwd` defaults to
yours (from the main session, `~/.pier/workspace`, never your home); `--timeout` (default 3600 s) starts when the run does.

**Callbacks are the only delivery; there is no status query.** The result
arrives as a system message once your turn ends, so **end your turn after
launching** — never poll. Keep the receipt's `runId`; the callback names
`Run:`. `--callback steer` interrupts your running turn instead; `none`
drops the result; `--callback-session <id>` delivers elsewhere.

| Flags | Run |
| --- | --- |
| `--task-id <id>` | a saved definition, as is (run now) |
| `--session <id> --prompt …` | continue an idle session (it keeps its cwd and model) |
| `--run <id> --prompt …` | existing run: running → steer; `--after` → after its turn; finished → resume (`--callback*` apply only then), in a new session Pier briefs when the old one compacted or neared it, or on `--fresh` (stuck, new direction). The receipt says which |
| `--member --prompt … --member …` | batch: flags before the first `--member` are defaults, ≥2 members, `--join all` (default) or `first`; the callback is the group's |
| `--bash <script>` | a command, not an agent: its stdout is the result, and `--prompt`/`--model`/`--thinking`/`--role`/`--design`/`--session` beside it are refused |
| `--worktree <branch> [--rounds <n>] [--review-model <tier|model>]` | a code worker's default: a new `wt` worktree off `--cwd`'s branch, reviewed n times (3; `0` none, 1–9), fixed between, stopped short of the merge, one callback opening `Goal:`; `--rounds <n>` alone is a goal in `--cwd`; on a `--role lead` run `--worktree` makes the worktree and opens no goal (`--rounds` refused); refused beside `--session`, `--bash`, `--task-id`, `--member`, `save` |

`--bash` is for a command whose output needs no model **and** runs too long to
hold your turn; a quick one, where your role runs commands, belongs in your
own shell, where `&` and `wait` already run several at once. Raise `--timeout` past the hour a long one needs,
or it is killed and reported as timed out. A non-zero exit still delivers what
it printed.

A run's result ends on the final state it verified, which you trust; a
status line, only when one is needed, is its last line:
`Needs your decision — <the question>`, or a review's `Verdict: clean` ·
`Verdict: findings` · `Verdict: blocked — <why>`; a goal's callback opens on
`Goal:` instead (below).
Answer with `--run <id> --prompt`; a step the user approved goes in the prompt
as `Approved: <step>`. Core owns the join: never aggregate members by hand.

A goal callback opens with one of four lines, each naming its root `(run <root>)`, with `, <branch> → <target> in <worktree>` inside once a review has pinned the branch: `Goal: review clean at <sha7> …, waiting on you to merge` means ready, unmerged, no P0 or P1 left — its callback may carry a `P2/P3 begin` … `P2/P3 end` list of `Minor issues` and `Design suggestions`, unfixed, for you to filter; `Goal: needs your decision …` asks you to decide; `Goal: … still findings` asks whether to continue; `Goal: failed at <step> — <why>` reports failure, a `Verdict: blocked` review included. While live, `--run <root>` steers the worker, is refused during review or a fix, and resumes it once ended; once ended, `pier task run --run <root> --prompt "<answer>" --rounds <n>` opens a new goal on that root with n reviews (`--rounds` beside `--after` refused), and `--run` without `--rounds`, or with `--rounds 0`, is a plain resume, out of the goal; `pier task cancel --run <root>` cancels the goal. A re-entry on a goal a review ended with findings or a decision carries that review in full ahead of your words, so name the fix, not the findings. A prompt with backticks or `<…>` goes through `--prompt -` on a quoted heredoc (`<<'EOF'`), not a double-quoted argument.

## Model choice

`--model` and `--thinking` (`off/minimal/low/medium/high/xhigh/max`) follow
your launching contract's table. A review's model is `--review-model` on a
goal, `--model` on a review you launch yourself: your judgement of the task,
the goal reads no diffs.

A name that is not a tier (`hardest`, `balanced`, `cheap`) is a substring of
provider or id ("let gpt review it" is `--model gpt`); none or several hits
lists the pins. `--model ?` prints the
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
run in the feature's worktree that builds with workers; `--design` beside it
makes it a design lead, which designs with the user until they finalize. It is
the one run that may launch runs, never a lead; only
its reply to the last result owed to it reaches its supervisor.

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

## Limits

- A worker does not launch runs: `pier task` is refused in a session a run
  created (a lead's aside), in its run and after it, and in any run someone
  waits on — say what needs another agent; your supervisor runs it. Only
  `runs` and `stats` stay open there, both over the whole instance.
- 6 agent runs execute at once instance-wide, `--bash` runs taking none of
  those slots; the rest queue until cancelled. A restart resumes agent runs on
  the same id; a bash run is marked `interrupted` (callbacks still fire).
