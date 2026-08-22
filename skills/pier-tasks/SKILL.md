---
name: pier-tasks
description: Delegate work to Pier subagents with the task tool — one-shot delegation, core-joined parallel fan-out, chained steps, and mid-run control (steer/resume/contact). Read before delegating to a subagent, coordinating multiple agents, or running long background work.
---

# Orchestrating Pier tasks

## Core model

- Every run executes a persisted task definition. An inline `task` draft
  (`operation:"run"` without `task_id`) creates and runs a one-shot subagent
  atomically; it is tagged `kind:"subagent"` and hidden from task lists.
- **Nothing blocks.** Every operation returns immediately; results, group
  joins, and decision replies arrive later as system follow-up messages in
  your session. Your only waiting primitive is ending your turn.
- The child session survives the run — `resume` continues it with full
  context intact. Poll state without blocking via `{"operation":"get",
  "run_id":"..."}` (or `group_id`, or `task_id` for that task's recent runs).

## Single delegation (the common case)

```json
{"operation":"run","task":{"name":"review-auth","action":{
  "type":"agent","session":{"mode":"fresh","cwd":"/abs/project"},
  "prompt":"Review src/auth/*.ts for injection risks. Output: file:line + issue + fix."}}}
```

Returns a run summary (`runId`, `state:"queued"`, ids). Finish your turn; the
result arrives as a follow-up. `callback:"none"` silences it.

A summary's `triggerSource` is who fired that run (`agent` when you did, plus
`manual` / `cron` / `watch` / `task`); a definition's `trigger` is only its
schedule policy, where `manual` means on-demand — by a human or by you.

- `fresh`: clean context, requires `cwd`. `fork`: child starts with a copy of
  your conversation — use when the task needs your context. `reuse`: sends
  work to an existing session by id.
- The child inherits your current model unless `launch.model` is set.
  Unknown models fail with the available list in the error. `launch` applies to
  `fresh` and `fork` only — a `reuse` session owns its own model and tools.
- The child has the same tools you do; there is no capability knob to pick.
- Runs time out after 900s by default; set `timeoutSeconds` in the draft for
  longer jobs.

## Parallel fan-out (core-joined)

Pass `tasks[]` (each entry a draft or `{"task_id":"..."}`) and Pier joins the
group in core — you never track run ids across turns:

```json
{"operation":"run","join":"all","tasks":[
  {"name":"review-correctness","action":{...}},
  {"name":"review-tests","action":{...}}]}
```

- `join:"all"` (default): one aggregated follow-up when every member
  finishes, listing each member's name, state, and result.
- `join:"first"`: the first finished run wins; the rest are cancelled but
  their sessions stay resumable (ids are in the callback).
- `get`/`cancel` accept `group_id`: observe or stop the whole group as one
  unit.
- Limits: 4 agents active at once, 16 children per tree, nesting caps at
  you → child → grandchild. Extra members queue rather than fail.

## Chains

Run step 1, end your turn, receive its callback, splice the needed part into
step 2's prompt. Children share nothing implicitly (except fork's copied
history) — every prompt must be self-contained: paths, acceptance criteria,
expected output format. Branching and retries are your own logic between
turns.

## Choosing a model and thinking level

Omit `launch.model` to inherit your own model — the right default. When the
task profile clearly differs, adjust in this order:

- **Harder reasoning → raise `launch.thinking` first**, on the inherited
  model (`off` … `minimal` `low` `medium` `high` `xhigh` `max`). It needs no
  model name and is usually cheaper than switching models.
- **Cheap bulk work** (listings, extraction, simple checks) → the same
  provider's smallest current model, with thinking low or off.
- **Cross-vendor second opinion** → another vendor's flagship.

Never write a model id from memory — catalogs move under you. The live list
is the authority: an unknown id fails with the available models in the error,
so a wrong pick costs one call and self-corrects. Choose current-generation
ids from that list.

## Mid-run control

- `steer` — interrupt a running child with corrected instructions
- `follow_up` — queue a message for after its current turn
- `resume` — continue a finished child in its same session; this expires any
  unanswered decision on that run
- `cancel` — stop a run (or a whole group via `group_id`); cancellation
  cascades to the run's own children

## Supervisor decisions (as a child)

`{"operation":"contact","reason":"decision","message":"..."}` returns a
receipt immediately. State what you are waiting for and **end your turn** —
never spin or poll. The answer arrives as a follow-up if your run is still
active; if your run already finished, Pier resumes your session with the
reply as the prompt. One open decision per run.

As a parent: the question arrives as a system input with a message id, steered
into your current turn at the next step boundary so a blocked child is not
waiting on the end of your turn; answer
with `{"operation":"reply","message_id":"...","message":"..."}`. A run that
finished while awaiting your answer shows `pendingDecisionId` in `get` and
sends no completion callback — the question is the notification.

`reason:"progress"` is fire-and-forget status for the parent.

## Rules

- One concern per child. For fan-out, let core join via `tasks[]` — never
  hand-aggregate run ids across turns.
- Repeating the same role? Create a durable task once (`operation:"create"`)
  and run it by `task_id` — cheaper than re-sending the draft every time.
- Inline drafts must use `action.type:"agent"`; triggers are forced manual;
  do not target another session with `reuse` from an inline draft.
- After launching work, end your turn. The callback starts your next one.
