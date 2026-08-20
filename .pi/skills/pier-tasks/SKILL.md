---
name: pier-tasks
description: Delegate work to Pier subagents with the task tool — one-shot delegation, parallel fan-out, chained steps, background runs with callbacks, and mid-run control (steer/resume/contact). Read before delegating to a subagent, coordinating multiple agents, or running long background work.
---

# Orchestrating Pier tasks

## Core model

- Every run executes a persisted task definition. An inline `task` draft
  (`operation:"run"` without `task_id`) creates and runs a one-shot subagent
  atomically; it is tagged `kind:"subagent"` and hidden from task lists.
- Results come back as a compact summary: `runId`, `state`, `result.text`,
  `error`. The child session survives the run — `resume` continues it with
  full context intact.

## Single delegation (the common case)

```json
{"operation":"run","wait":true,"task":{"name":"review-auth","action":{
  "type":"agent","session":{"mode":"fresh","cwd":"/abs/project"},
  "prompt":"Review src/auth/*.ts for injection risks. Output: file:line + issue + fix.",
  "launch":{"capabilities":"read"}}}}
```

- `fresh`: clean context, requires `cwd`. `fork`: child starts with a copy of
  your conversation — use when the task needs your context. `reuse`: sends
  work to an existing session by id.
- The child inherits your current model unless `launch.model` is set.
  Unknown models fail with the available list in the error.
- `launch.capabilities:"read"` for review/analysis — the child cannot write
  or delegate further.

## Background + callback

`wait:false` returns immediately with `runId`; the result is delivered to you
as a follow-up message when the run finishes (`callback:"none"` to silence).
Use it for work you do not need before your next step. Poll without blocking
via `{"operation":"get","run_id":"..."}`.

Runs time out after 900s by default; set `timeoutSeconds` in the draft for
longer jobs.

## Parallel fan-out

1. Launch each angle as its own `run` with `wait:false` and a fresh session.
2. Collect: `{"operation":"wait","run_ids":["..."],"wait_mode":"all"}` —
   or `"first"` to race.

Limits: 4 agents active at once (globally and per delegation tree), 16
children per tree, nesting caps at you → child → grandchild. Extra runs
queue rather than fail.

## Chains

Run step 1 with `wait:true`, then splice the needed part of `result.text`
into step 2's prompt. Children share nothing implicitly (except fork's copied
history) — every prompt must be self-contained: paths, acceptance criteria,
expected output format. Branching and retries are your own logic between
calls.

## Mid-run control

- `steer` — interrupt a running child with corrected instructions
- `follow_up` — queue a message for after its current turn
- `resume` — continue a finished child in its same session
- `cancel` — stop a run
- As a child: `contact` with `reason:"decision"` and `wait:true` asks your
  parent and blocks until answered. The question arrives at the parent with a
  message id; the parent answers with
  `{"operation":"reply","message_id":"...","message":"..."}`.

## Rules

- One concern per child; aggregate results yourself.
- Repeating the same role? Create a durable task once (`operation:"create"`)
  and run it by `task_id` — cheaper than re-sending the draft every time.
- Inline drafts must use `action.type:"agent"`; triggers are forced manual;
  do not target another session with `reuse` from an inline draft.
- Prefer `wait:true` unless you have parallel work — a forgotten background
  run still costs its callback.
