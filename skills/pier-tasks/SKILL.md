---
name: pier-tasks
description: Delegate work to Pier subagents with the task tool — one-shot, parallel fan-out, chains, mid-run control. Read before delegating to a subagent, coordinating agents, or running long background work.
---

# Orchestrating Pier tasks

## Core model

- Every run executes a persisted task definition. A `run` without `task_id`
  — a bare `prompt`, or a full `task` draft — creates and runs a one-shot
  subagent atomically; it is tagged `kind:"subagent"` and hidden from task
  lists. You never name or file it: the name is the prompt's first line.
- **Nothing blocks.** Every operation returns immediately; results, group
  joins, and decision replies arrive later as system follow-up messages in
  your session. Your only waiting primitive is ending your turn.
- The child session survives the run — `resume` continues it with full
  context intact. Poll state without blocking via `{"operation":"get",
  "run_id":"..."}` (or `group_id`, or `task_id` for that task's recent runs).

## Single delegation (the common case)

```json
{"operation":"run","prompt":"Review src/auth/*.ts for injection risks. Output: file:line + issue + fix."}
```

That is the whole call: a fresh session in **your own directory**. Add `cwd`
to place it elsewhere — absolute, or relative to your directory
(`"cwd":"../pier.feature-x"` for a sibling worktree); it must already exist.
`launch` picks a model/thinking level, `name` overrides the label. The full
`task` draft form (`{"name","action":{"type":"agent","session":{...},"prompt"}}`)
is for what the shorthand cannot say: `reuse` a session, `timeoutSeconds`,
`callback`.

Returns a run summary (`runId`, `state:"queued"`, ids). Finish your turn; the
result arrives as a follow-up. `callback:"none"` silences it.

A summary's `triggerSource` is who fired that run (`agent` when you did, plus
`manual` / `cron` / `watch` / `task`); a definition's `trigger` is only its
schedule policy, where `manual` means on-demand — by a human or by you.

- `fresh`: clean context in a `cwd` (yours when omitted) — how a child
  normally starts.
  `reuse`: sends work to an existing session by id, continuing its history.
  There is no way to copy your context into a child: what the child needs, you
  write down.
- **The handoff is the prompt.** A child cannot see your discussion, so state:
  the goal; the decisions *currently* in force (not the ones you argued out of);
  the constraints the user added late; absolute paths; what "done" means and how
  to verify it. Writing it is also the check — a decision you cannot state in a
  sentence was not settled.
- The child inherits your current model unless `launch.model` is set.
  Unknown models fail with the available list in the error. `launch` applies to
  `fresh` only — a `reuse` session owns its own model and tools.
- The child has the same tools you do.
- Runs time out after 900s by default; set `timeoutSeconds` in the draft for
  longer jobs.

## Parallel fan-out (core-joined)

Pass `tasks[]` (each entry a prompt string, `{"prompt","cwd"?}`, a full
draft, or `{"task_id":"..."}`) and Pier joins the group in core — you never
track run ids across turns:

```json
{"operation":"run","join":"all","tasks":[
  "Review src/ for correctness bugs. Output: file:line + issue.",
  {"prompt":"Review the tests for gaps. Output: missing case + file.","cwd":"packages/web"}]}
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
step 2's prompt. Children share nothing implicitly — every prompt must be
self-contained: paths, acceptance criteria, expected output format. Branching and retries are your own logic between
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

Never write a model id from memory — catalogs move under you.
`{"operation":"models"}` is the authority: it returns the deployment's menu —
operator-pinned models when set (`source:"menu"`), each with an intent note
and often a usual `thinking` level, the curated live catalog otherwise
(`source:"catalog"`). Prefer a pinned entry whose note matches the task and
start from its thinking level. A wrong id still fails with the available
list in the error, so a stale guess costs one call.

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
never spin or poll. The answer is steered into your current turn if your run is
still active; if your run already finished, Pier resumes your session with the
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
- `create` is for definitions that outlive one job: a schedule (`cron` /
  `watch`), or a role you will run by `task_id` again and again. It files a
  task the operator sees and has to archive by hand — never use it for a
  one-off; that is `run` with a prompt.
- Inline drafts must use `action.type:"agent"`; triggers are forced manual;
  do not target another session with `reuse` from an inline draft.
- After launching work, end your turn. The callback starts your next one.
