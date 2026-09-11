---
name: pier-tasks
description: Delegate work to Pier subagents with `pier task` — one-shot, parallel batches, chains, mid-run control. Read before delegating to a subagent, coordinating agents, or running long background work.
---

# Pier tasks

Five shell commands (`pier task --help`). Each returns at once with one JSON
line, exit 0; a refusal is one `task:` line, exit 1; bad flags print the
usage line, exit 2. `--prompt -` reads stdin.

## Delegate, then end your turn

```sh
pier task run --prompt "Review src/auth/*.ts. Return file:line, issue, fix."
```

One concern per child; the prompt is the whole handoff (goal, decisions,
constraints, absolute paths, acceptance criteria, output format) — nothing of
your discussion is copied. Name defaults to the prompt's first line
(`--name` overrides); `--cwd` defaults to yours, absolute or relative, must
exist; `--timeout <s>` (default 3600, 1–86400) starts when the run does.

**Callbacks are the only delivery; there is no status query.** Keep the
receipt's `runId`; the callback names `Run:`. Results arrive as system
follow-ups once your turn ends, batched when several are due — so **end your
turn after launching**. `--callback steer` interrupts your running turn
instead, for work needed mid-turn; `--callback none` means you do not want
the result; `--callback-session <id>` delivers to another existing session
(top-level only, never inside a run or with `none`/a batch).

- `--task-id <id>`: run a saved definition as is (archived ones refuse).
- `--session <id> --prompt …`: continue an idle session with its history;
  `--model`/`--thinking`/`--cwd` do not apply, it owns those.

## Existing run: `--run <id> --prompt …`

Running → steers it now; `--after` → queued after its current turn;
finished → resumed on the same session as a new run (same depth, own
callback: `--callback*` is accepted only here). The receipt says which
(`delivery`). Undelivered guidance expires when the run ends. A child that
needs your answer ends its turn with the question as its result — answer it
with this command. Never spin or poll.

## Batch: `--member`

```sh
pier task run --cwd /repo --join all \
  --member --prompt "Review correctness" \
  --member --prompt "Review test gaps" --model gpt
```

Flags before the first `--member` are every member's defaults; a member's
own override them; ≥2 members; at most one `--prompt -`. `--join all`
(default) is one callback when every member is terminal; `--join first`
takes the first terminal state (failure included), cancels the rest and
names their resumable sessions. `--callback` is the group's; members have
none. Admission is all-or-nothing. Core owns the join — never aggregate
members by hand. Chains: launch → end turn → callback → next self-contained
prompt.

## Model choice

Default: your model. Harder reasoning: `--thinking` first
(`off/minimal/low/medium/high/xhigh/max`). `--model <name>` is matched
against the operator's menu — substring of provider, id or note, so "let gpt
review it" is `--model gpt`; one hit runs with that pin's thinking unless you
set one. None or several: the refusal lists the pins, pick one. A full
`provider/id` is taken as written. `--model ?` prints the menu. Never name a
model id from memory.

## Cancel · recover

`pier task cancel --run <id> | --group <id>`: descendants included; finished
runs unchanged. You control your own trees; inside a run, only your
descendants.

`pier task recover (--run <id> | --group <id>) --reason <text>`: the full
result after its callback settled (delivered, abandoned or `none`), for text
truncated in a callback (8000 chars; 2000 per member in a group) or lost to
compaction. **Never to check progress** — the refusal reveals no state.

## Saved definitions

```sh
pier task save --name nightly --bash "make check" --cwd /repo --cron "0 3 * * *" --tz UTC
pier task save --name watcher --prompt "Triage" --watch "test -f new" --every 60 --repeat --cwd /repo
```

Only for schedules or roles run more than once; the operator sees and
archives them. `--task-id <id>` updates (whole definition again). `--prompt`
xor `--bash`; one trigger group or none (manual). Notification only via
`--callback-session <id>` — scheduled runs have no invoker. Not inside a run.
`pier task list` shows them.

## Limits

- Inside a run: agent actions only, fresh sessions only, no `save`.
- Depth 0–2 below the invoking session; 16 descendant runs per root
  (resumes count). Your direct children are separate roots.
- 6 agent runs execute instance-wide; the rest queue, unbounded, until
  cancelled or a restart marks them `interrupted` (callbacks still apply).
- While Pier drains for a restart, new roots are refused: retry after.
