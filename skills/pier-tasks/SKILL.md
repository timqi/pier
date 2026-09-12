---
name: pier-tasks
description: Subagents and scheduled tasks with `pier task`. Read before delegating work, coordinating agents, or scheduling anything.
---

# Pier tasks

`pier task --help` lists the five commands and their flags. Each prints one
JSON receipt, exit 0; a refusal is a `task:` line, exit 1 (`--model` with no
or several hits lists the menu under it); a bad flag is `task:` plus the
usage, exit 2. `--prompt -` reads stdin.

## Delegate, then end your turn

```sh
pier task run --prompt "Review src/auth/*.ts. Return file:line, issue, fix."
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
| `--task-id <id>` | a saved definition, as is |
| `--session <id> --prompt …` | continue an idle session (it keeps its cwd and model) |
| `--run <id> --prompt …` | existing run: running → steer; `--after` → after its turn; finished → resume (`--callback*` apply only then). The receipt's `delivery` says which |
| `--member --prompt … --member …` | batch: flags before the first `--member` are defaults, ≥2 members, `--join all` (default) or `first`; the callback is the group's |
| `--bash <script>` | a command, not an agent: its stdout is the result, and `--prompt`/`--model`/`--thinking`/`--session` beside it are refused |

`--bash` is for a command whose output needs no model **and** runs too long to
hold your turn; a quick one belongs in your own shell, where `&` and `wait`
already run several at once. Raise `--timeout` past the hour a long one needs,
or it is killed and reported as timed out. A non-zero exit still delivers what
it printed.

A child that needs your answer ends its turn with the question as its result;
answer it with `--run <id> --prompt`. Core owns the join: never aggregate
members by hand.

## Model choice

Default: your model. Harder reasoning: `--thinking` first
(`off/minimal/low/medium/high/xhigh/max`). `--model <name>` is matched
against the operator's menu (substring of provider, id or note — "let gpt
review it" is `--model gpt`); none or several hits lists the pins, pick one.
`--model ?` prints the menu. Never name a model id from memory.

## Cancel · recover

`pier task cancel --run <id> | --group <id>` — the runs you launched.

`pier task recover (--run <id> | --group <id>) --reason <text>` — the full
result after its callback settled, for text the callback truncated (8 000
chars per run, a group's members included) or lost to compaction. `--group`
caps each member at 2 000, so a long member is recovered with `--run`.
**Never to check progress**: the refusal reveals no state.

## Saved definitions

```sh
pier task save --name nightly --bash "make check" --cwd /repo --cron "0 3 * * *" --tz UTC
```

Only for schedules or roles run more than once; `--task-id` updates. A
schedule's results reach nobody unless `--callback-session <id>` names a
session; `pier task list` shows definitions, never runs.

## Limits

- A delegated run does not delegate: `pier task` is refused inside a run
  someone waits on — ask in your result; your supervisor runs it.
- 6 agent runs execute at once instance-wide, `--bash` runs taking none of
  those slots; the rest queue until cancelled
  or a restart marks them `interrupted` (callbacks still fire).
- During a restart drain new runs are refused: retry after.
