---
name: pier-tasks
description: Delegate work to Pier subagents with the task tool — one-shot, parallel fan-out, chains, mid-run control. Read before delegating to a subagent, coordinating agents, or running long background work.
---

# Orchestrating Pier tasks

## Core model

- Every run executes a persisted task definition. A `run` without `task_id`
  — a bare `prompt`, or a full `task` draft — creates and runs a one-shot
  subagent atomically: `kind:"subagent"`, hidden from `list`, named by the
  prompt's first line. You never file it.
- **Nothing blocks.** Every operation returns immediately; results, group
  joins and decision replies arrive as system follow-up messages once your
  turn ends (batched when several are due). Ending your turn is the only wait
  — never poll `get` in a loop to find out whether a run finished: a long turn
  of yours delays the callback by exactly its own length, and polling burns a
  round trip per guess and reads the result twice. If it must reach you
  mid-turn, delegate it with `callback:"steer"`.
- The child session survives the run — `resume` continues it with context
  intact. `get` polls: `run_id` (full result), `group_id`, or `task_id` (10
  most recent runs). Lists truncate results at 2000 chars, callbacks at 8000,
  both saying so; `get run_id` is whole.
- Limits: a tree is ≤3 runs deep below the session that started it (depth
  0–2; the fourth `run` errors) and holds ≤16 runs below its root (depth ≥ 1,
  resumes included) — your direct children are each a root, uncounted. 4
  agent runs execute at once instance-wide; the rest wait for a slot without
  error, but the timeout clock starts at queue time, so a run queued behind
  long ones can time out unstarted.
- Timeout: 900s default → `failed` / `task timed out`; `timeoutSeconds`
  1–86400, draft form only. A Pier restart ends queued/running runs as
  `interrupted` (callback still arrives) and refuses new root runs while
  draining — retry after.

## Single delegation (the common case)

```json
{"operation":"run","prompt":"Review src/auth/*.ts for injection risks. Output: file:line + issue + fix."}
```

That is the whole call: a fresh session in **your own directory**. `cwd`
places it elsewhere — absolute, or relative to yours (`"cwd":"../pier.x"` for
a sibling worktree); it must exist. `launch` picks model/thinking, `name`
overrides the label, `input` (any JSON) is appended to the prompt as
`<task_input>`. The `task` draft form is for what the shorthand cannot say —
`timeoutSeconds`, or `reuse` of an existing session:

```json
{"operation":"run","task":{"name":"long build","timeoutSeconds":3600,"action":{"type":"agent","session":{"mode":"fresh","cwd":"/abs/path"},"prompt":"..."}}}
```

Omit `trigger` in a draft (anything but `manual` errors); a draft's `callback`
is ignored on runs you fire — the result comes to you — and matters only for
`create`d schedules. Returns a run summary (`runId`, `taskId`,
`state:"queued"`, …); `callback:"none"` silences the result,
`callback:"steer"` makes it interrupt your running turn at the next step
boundary instead of waiting for the turn to end (echoed back as
`callbackMode`; use it for a result you would otherwise sit and wait for, not
for work you launch and forget), `callback_session_id` routes it to another
existing session. A summary's
`triggerSource` is who fired the run (`agent` / `manual` / `cron` / `watch` /
`task`); a definition's `trigger` is only its schedule, `manual` meaning
on-demand — by a human or by you.

- `fresh`: clean context in a `cwd` (yours when omitted) — the normal start.
  `reuse`: an existing session by id, continuing its history; the run waits
  for it to go idle. Nothing copies your context into a child: what the child
  needs, you write down.
- **The handoff is the prompt.** A child cannot see your discussion, so state
  the goal, the decisions *currently* in force (not the ones argued out of),
  late constraints, absolute paths, what "done" means and how to verify it.
  Writing it is the check — a decision you cannot state in a sentence was not
  settled.
- The child inherits your current model unless `launch.model` is set, and has
  the same tools you do, `task` included. An unknown model id fails the *run*,
  not the call — the error, with the first available ids, arrives in the
  callback; an unknown `launch.thinking` fails the call. `launch` applies to
  `fresh` only — a `reuse` session owns its own model and tools.
- Stored roles: `run` with `task_id` (+ optional `input`);
  `session_mode:"fresh"` runs a `reuse`-mode role in a fresh session instead.
  Archived tasks refuse to run.

## Parallel fan-out (core-joined)

`tasks[]` — 2+ entries, each a prompt string, `{"prompt","cwd"?,"launch"?,
"name"?}`, a full draft, or `{"task_id":"..."}`; never with `task`, `task_id`
or `session_mode` — and Pier joins the group in core; you never track run ids:

```json
{"operation":"run","join":"all","tasks":[
  "Review src/ for correctness bugs. Output: file:line + issue.",
  {"prompt":"Review the tests for gaps. Output: missing case + file.","cwd":"packages/web"}]}
```

- `join:"all"` (default): one aggregated follow-up when every member is
  terminal — each member's name, state, result.
- `join:"first"`: the first member to reach *any* terminal state wins, a
  failure included; the rest are cancelled, their sessions resumable (run ids
  in the callback).
- Members send no individual callbacks; `callback:"none"` silences the
  group's and `callback:"steer"` interrupts your turn with it. `get`/`cancel` take `group_id` for the whole group. A member that
  cannot enqueue (limit, missing `cwd`) rolls the group back — nothing runs.

## Chains

Run step 1, end your turn, receive its callback, splice the needed part into
step 2's prompt. Children share nothing implicitly — every prompt is
self-contained: paths, acceptance criteria, output format. Branching and
retries are your own logic between turns.

## Choosing a model and thinking level

Omit `launch.model` to inherit your own model — the right default. When the
task profile clearly differs, adjust in this order:

- **Harder reasoning → raise `launch.thinking` first**, on the inherited
  model (`off` … `minimal` `low` `medium` `high` `xhigh` `max`): no model
  name needed, usually cheaper than switching models.
- **Cheap bulk work** (listings, extraction, simple checks) → the same
  provider's smallest current model, thinking low or off.
- **Cross-vendor second opinion** → another vendor's flagship.

Never write a model id from memory — catalogs move under you.
`{"operation":"models"}` is the authority: operator-pinned models when set
(`source:"menu"`, each with an intent note and often a usual `thinking`
level), else the curated live catalog (`source:"catalog"`). Prefer a pinned
entry whose note matches the task and start from its thinking level.

## Mid-run control

- `steer` — interrupt a running child with corrected instructions
- `follow_up` — queue a message for after its current turn
- `resume` — continue a finished child in its same session, `message` as the
  prompt: a new run (new `runId`, own callback, same depth); expires any
  unanswered decision on that run
- `cancel` — stop a run, or a whole group via `group_id`; cascades to the
  run's children; a terminal run is returned unchanged

`steer`/`follow_up` need a non-terminal run (else `resume`); one undelivered
when the run ends expires. `resume` needs a terminal run. All four accept only
runs you own — trees you started, or, inside a run, your own descendants.
`message`: non-empty, <16 KiB.

## Supervisor decisions (as a child)

`{"operation":"contact","reason":"decision","message":"..."}` returns a
receipt immediately. State what you await and **end your turn** — never spin
or poll. The answer is steered into your current turn if your run is still
active; if it finished, Pier resumes your session with the reply as the
prompt. One open decision per run. `contact` works only inside a run a session
delegated — a cron/watch run has no supervisor. `reason:"progress"` is
fire-and-forget status for the parent.

As a parent: the question arrives as a system input with a message id, steered
into your current turn at the next step boundary so the child does not wait
out your turn. Answer with `{"operation":"reply","message_id":"...",
"message":"..."}` — only the addressed supervisor may; same text twice is a
no-op, different text an error. A run that finished while awaiting your answer
shows `pendingDecisionId` in `get` and sends no completion callback — the
question is the notification; your reply resumes it, and that continuation's
callback comes to you.

## Rules

- One concern per child. For fan-out, let core join via `tasks[]` — never
  hand-aggregate run ids across turns.
- **A change to work a child already did → `resume` that run**, not a new
  child: its session still holds the files it read and the decisions it made,
  so the message can be a delta ("same file, also handle the empty input").
  Go `fresh` when the new work shares nothing with the old — different area,
  different goal — or when that session is long and mostly dead ends: clean
  context plus a self-contained prompt beats a child sifting its own noise.
  Lost the `run_id`? `get` with the summary's `task_id` lists that task's
  recent runs — a one-shot subagent has one too.
- `create` is for definitions that outlive one job: a schedule (`cron` /
  `watch`), or a role run by `task_id` again and again. It files a task the
  operator sees and must archive by hand — never for a one-off; that is `run`
  with a prompt. `update` takes the whole draft again, `trigger` included. A
  schedule reports to nobody unless its `callback` is
  `{"type":"session","sessionId":"..."}` — `origin` is the invoker, which a
  cron run lacks.
- Inside a run: Agent tasks only (stored or inline), no `reuse`, no
  `create`/`update`.
- After launching work, end your turn. The callback starts your next one.
