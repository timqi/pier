---
name: pier-tasks
description: Subagents and scheduled tasks with `pier task`. Read before delegating work, coordinating agents, or scheduling anything.
---

# Pier tasks

`pier task --help` lists the five commands and their flags. Each prints one
JSON receipt, exit 0; a refusal is one `task:` line, exit 1. `--prompt -`
reads stdin.

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
result after its callback settled, for text truncated (8000 chars; 2000 per
member) or lost to compaction. **Never to check progress**: the refusal
reveals no state.

## Saved definitions

```sh
pier task save --name nightly --bash "make check" --cwd /repo --cron "0 3 * * *" --tz UTC
```

Only for schedules or roles run more than once; `--task-id` updates; results
reach a session only via `--callback-session`. `pier task list` shows them.

## Limits

- A delegated run does not delegate: `pier task` is refused inside a run
  someone waits on — ask in your result; your supervisor runs it.
- 6 agent runs execute at once instance-wide; the rest queue until cancelled
  or a restart marks them `interrupted` (callbacks still fire).
- During a restart drain new runs are refused: retry after.
