---
name: pier-tasks
description: Delegate work to Pier subagents with the task tool — one-shot, parallel fan-out, chains, mid-run control. Read before delegating to a subagent, coordinating agents, or running long background work.
---

# Pier tasks

## Delegate, then wait

```json
{"operation":"run","prompt":"Review src/auth/*.ts. Return file:line, issue, fix."}
```

One concern per child. `run` with `prompt` or a full `task` draft atomically
creates a persisted one-shot (`kind:"subagent"`, hidden from `list`); do not
`create` it. Name defaults to the prompt's first line; `name` overrides it.

All operations return immediately. Results and decision replies arrive by
callback; **end your turn after launching work**. Default callbacks are system
follow-ups, batched when several are due. A long turn delays them; there is no
status query. The receipt's `next` tells you where/how delivery happens:

- `callback:"origin"` (default): result returns to you after your turn.
- `callback:"steer"`: interrupts at a step boundary; use when needed mid-turn,
  not for work you launch and forget. Receipt echoes `callbackMode`.
- `callback:"none"`: no delivery; means you do not want the result, not pull later.
- Single-run `callback_session_id`: deliver to another existing session.

Receipts include `runId`, `taskId`, state. Keep IDs: the callback also names
`Run:`, and there is no lookup by task. `triggerSource` names the actual invoker
(`agent/manual/cron/watch/task`); the definition's `trigger` is scheduling
policy (`manual` means on demand).

## Sessions and prompts

- Default `fresh`: clean context. `cwd` defaults to your directory, accepts an
  absolute path or one relative to yours, and must exist.
- `reuse`: existing session by `sessionId`; continues its history after it is
  idle. `launch` applies only to fresh sessions; reused sessions own their
  model/tools. Children otherwise have your tools, including `task`.
- **The prompt is the handoff**: no implicit copy of your discussion. Include
  the goal, current decisions, latest constraints, absolute paths, acceptance
  criteria, verification and output format. `input` accepts any JSON, appended
  in `<task_input>`.
- For more work on an existing result, `resume` that run with a delta prompt;
  its session/context survives. Start fresh for unrelated work or stale context.
- Stored role: `run` with `task_id` and optional `input`;
  `session_mode:"fresh"` overrides a stored reuse policy. Archived tasks refuse.

Use a `task` draft for `timeoutSeconds` or reuse:

```json
{"operation":"run","task":{"timeoutSeconds":3600,"action":{"type":"agent","session":{"mode":"reuse","sessionId":"..."},"prompt":"Check the result"}}}
```

Inline drafts may omit `trigger`; only `manual` is allowed. Their nested
`callback` is ignored: use top-level delivery options above. Nested callbacks
matter for saved schedules (below).

## Groups and chains

`tasks[]` needs 2+ entries: prompt strings, `{prompt,cwd?,launch?,name?}`, full
drafts, or `{task_id}`. Do not combine it with `task`, `task_id` or `session_mode`.

```json
{"operation":"run","tasks":["Review correctness","Review test gaps"],"join":"all"}
```

- `join:"all"` (default): one callback with every member's name, state and result
  when all are terminal.
- `join:"first"`: first **any terminal state**, including failure/overlap skip,
  wins. Others are cancelled; their sessions remain resumable, IDs in callback.
- Core owns the join; never hand-aggregate member IDs across turns. Members have
  no individual callbacks; `none`/`steer` applies to the group. `cancel` and
  `recover` accept `group_id`. Admission failure (e.g. limit or missing cwd)
  rolls back the group: nothing runs.

For a chain: launch step 1 → end turn → receive callback → put needed results
in step 2's self-contained prompt. Branching and retries are your responsibility.

## Model choice

Default: inherit your current model. For harder reasoning, raise
`launch.thinking` first (`off/minimal/low/medium/high/xhigh/max`). For cheap bulk
work, choose the same provider's smallest current model with low/off thinking;
for an independent vendor's opinion, choose its flagship.

Before naming a model, call `{"operation":"models"}`; never use IDs from memory.
It returns operator pins (`source:"menu"`, intent notes/usual thinking) or the
live catalog (`source:"catalog"`). Prefer a matching pin and its thinking level.
`launch.model` overrides inheritance. Unknown model IDs fail the run and report
available IDs by callback; invalid `launch.thinking` fails the call.

## Control and decisions

`message` must be non-empty, <16 KiB. Controls require ownership: your delegated
trees, or only descendants when you are a subagent.

- `steer`: interrupt a child with corrections.
- `follow_up`: queue guidance after its current turn.
- `resume`: terminal run only; same session, new run ID/callback, same depth,
  message as prompt. Expires its unanswered decision.
- `cancel`: run or group; cascades to descendants, terminal runs unchanged.

`steer`/`follow_up` require a non-terminal run; undelivered guidance expires when
it ends. For finished work use `resume`.

Child → supervisor:

```json
{"operation":"contact","reason":"decision","message":"Use API A or B?"}
```

Requires an active delegated Agent run with a supervisor (scheduled cron/watch
runs have none). `progress` is fire-and-forget; `decision` steers the supervisor
and permits one open question per run. State what you await and **end your
turn**, never spin/poll. A finished run with an open question suppresses its
completion callback: the question is the notification.

Supervisor → child:

```json
{"operation":"reply","message_id":"...","message":"Use API A"}
```

Only the addressed supervisor may reply. Same text twice is a no-op; different
text errors. The answer steers an active child or auto-resumes a terminal one
with the reply as prompt; the continuation's callback returns to the replier.

## Recover lost information only

`recover` requires `run_id` or `group_id` plus `reason` (e.g. text truncated,
context lost to compaction). **Never use it to check progress.**

- Run must be terminal and its callback settled: delivered, abandoned, or none.
  Group members wait for their group callback; a terminal race winner is
  readable while losers are still cancelling.
- Whole-group recovery additionally requires every member terminal. An open
  decision directs you to `reply`. Other premature requests get a refusal
  that reveals no state.
- Callbacks truncate each result at 8000 characters; recovered groups truncate
  member results at 2000. Notes point to `recover run_id`, which returns full
  text. `none` remains a no-result preference, not a polling workflow.

## Persistence and limits

`create` files an operator-visible definition only for recurring roles or
cron/watch schedules; the operator must archive it. `update` takes the entire
draft, including `trigger`. Schedules notify only with nested
`callback:{"type":"session","sessionId":"..."}`; `origin` needs an invoker,
which scheduled runs lack.

- Inside a run: Agent actions only (stored/inline), no reuse or create/update.
- Depth 0–2: at most 3 runs below the invoking session; a fourth errors. Each
  root allows 16 descendant runs (depth ≥1, resumes included). Your direct
  children are separate roots and do not count toward that limit.
- 4 Agent runs execute instance-wide; others queue without error. Timeout
  starts **at enqueue**, so a run can time out before starting.
- Default timeout 900s; `timeoutSeconds:1–86400` in draft form only. Timeout
  reports `failed / task timed out`.
- Restart marks queued/running runs `interrupted`; callbacks still apply.
  During drain, new roots are refused: retry after restart.
