# Goal runtime — the review loop leaves the main session

Status: final.

## Problem

`DISPATCHER`'s Goal rules (`agent/roles.ts`) run the worker → review → fix →
re-review → merge chain from the head: every child callback is a head turn,
most of them a `<silent>` that dispatches the next step and rewrites a stage.
A three-round fix costs the head ~8 turns, each carrying the callback text,
for one decision the user reads: merged, or not. The counting (`· auto n/3`)
lives in prompt text the head must copy forward, so it drifts.

## Decisions

- **One goal kind, in code.** A worker run launched `--until reviewed`
  (`--until merged` an alias) is the root of a *goal*: a deterministic loop in
  `tasks/goals.ts`, driven from `TaskService.settled`, no model in the loop.
  There is no goal language — `reviewed` is the only end today, and a second
  kind is a second design.

- **The loop.**

  | step | on | next |
  | --- | --- | --- |
  | `work` (the root run, or a fix resume) | succeeded, no `Needs your decision` | `review` |
  | `review` | `Verdict: clean` | end `done`: the merge and the worktree's removal wait on the user |
  | `review` | `Verdict: findings`, round < cap | `work` again: resume the worker with the findings, round + 1 |
  | `review` | `Verdict: findings`, round = cap | end `cap` |
  | any | `Verdict: blocked — <why>` | end `failed`, reason `blocked — <why>` |
  | any | status line `Needs your decision — …` | end `decision` |
  | any | failed · cancelled · interrupted · timed out · no verdict · several status lines | end `failed` |

  A round is one findings → fix → re-review trip; the first review counts
  nothing. Cap 3, `--rounds <n>` overrides (1–9). No time or
  token budget: the goal is at most `2 + 2·cap` runs, each under its own
  `--timeout`, which bounds it already.

- **The head hears the end only.** The goal's runs settle as `--callback none`
  with `callbackError` `GOAL_STEP` ("a goal's step, not its end"), the way a
  lead's turns do (`LEAD_TURN`). The end delivers one callback to the root
  run's callback target, the head's usual card: the last run's result, headed
  by a line the head reads without parsing —
  `Goal: review clean at <sha7> after 1 review round, waiting on you to merge` · `Goal: needs your decision after 2 review rounds` ·
  `Goal: 3 review rounds, still findings` · `Goal: failed at review — <why>`.
  The runs in between are ordinary ledger rows: the status panel, the run
  chips and `pier task runs` show each as it happens, so nothing that
  happened looks like nothing happening; the chat is quiet until the end.

- **The verdict is a status line.** The review run is a fresh worker Pier
  launches itself (`triggerSource: "goal"`, `invokedBySessionId` the goal's
  supervisor, so ownership and cancel hold), in the worker's worktree, prompt
  rendered by `goals.ts`: review the branch's diff against its base, output
  `file:line · issue · fix`, and end on the status line. Every run result and
  review follows one protocol (`RUN_RESULT`), parsed only by `goals.ts`
  (`statusLine(text)`): the status line is the last non-blank line outside
  fenced code blocks, plain text, English, one of `Verdict: clean` ·
  `Verdict: findings` · `Verdict: blocked — <why>` ·
  `Needs your decision — <the question, one line>`. A second line outside
  fences matching the same pattern → `failed`, `several status lines`; a
  review with none → `failed`, `no verdict`, reported, never guessed; a work
  step with none proceeds to review.

- **The review's model** is named at dispatch, by difficulty: the head sets
  `--review-model <tier|model>` per the skill's rule (the builder's tier;
  `hardest` when the change touches a seam or looks risky), and the loop takes
  the root run's tier (`launch.tier`, else its model) only when none was
  named, thinking from the pin. The loop reads no diffs and keeps no seam
  list: what a change weighs is the dispatcher's judgement of the task, not
  a path match.

- **The prompts** (`goals.ts`, two constants):
  - fix: `[Pier: review round n/cap found issues; fix them in this worktree
    and end your turn without merging.]` then the review text;
  - review: the branch, base and worktree, the output shape, the verdict line.
  The root prompt is still the head's; it names the merge target and stops
  short of merging, as `WORKER` already says. The merge runs only on the
  user's yes, as a finishing run the head launches fresh,
  `--model balanced --cwd <main repo>`, carrying
  `Approved: merge <branch> into <target> at <reviewed sha>` and, only when
  the user said so, `Approved: remove worktree <path>`; no build session is
  resumed to merge.

- **Open items derive the stage from the goal, not from the head.** The head
  writes `<open>problem — <stage> (run <root>)</open>` once, at dispatch, with
  nothing to count. `openItems()` finds the goal by the run's session
  (`TaskStore.goalOf`) and renders it on the run line: ` · until reviewed:
  review round 2/3` while live, `review clean, waiting on you`, `waiting on you`, `3/3 rounds`,
  `failed: <why>` when ended. `openStatus` reads the goal before the stage:
  live → `running`; `decision`, `cap` or `done` → `waiting on you`; `failed` →
  `stopped`; a run queued in the worker's session after the end (the merge)
  drops the goal from its line. The `· until` / `· auto n/cap` stage text
  goes from `DISPATCHER`, and so does the generic auto-continue: a result
  short of a non-code end reports and waits, as before the Goal rules. It was
  the same cost as the code loop — a head turn per continue, the judgement
  and the count in prompt text — and has no machine-checkable end to move
  into code; the user's own words resume the child instead.

- **A waiting item opens where the answer is given.** `OpenItem` gains
  `waitsIn?: string`: the session id when the wait is answered in a child
  session, absent when it is answered in the main chat. It is derived beside
  the status, from the same reason (`openStatus` already knows why an item
  waits), never written by the head: a design awaiting Finalize → the lead's
  session; a stage saying `waiting on you` or a goal ended `decision`/`cap`
  → the chat, because the head relays and the user answers there (09
  §Decisions; a decision ended in a worker's session is still the head's to
  resume). The panel's row follows it: `waitsIn` → `select(waitsIn)`; else
  today's rule (the topic's latest reply, then the first run's session). The
  alternative — a target the head writes into the marker — was not taken:
  the head cannot know a child's session id better than the ledger does, and
  a wrong or stale target would be one more stage to keep current, which
  this design exists to remove.

- **Leads own their loop.** A build lead keeps reviewing its workers' branches
  itself (`LEAD_BUILD` unchanged there) and may launch a worker `--until
  reviewed` like the head can — the goal's end reaches the lead as a callback,
  counted as a result owed for the milestone. Its own branch: `LEAD_BUILD`
  gains one line — before the milestone that declares the build done, launch
  one review worker of the integrated branch and act on its findings. No
  runtime loop for leads: their state is the doc, and their turns are not
  the head's tokens.

- **Control while live.** `pier task run --run <root>` addresses the goal:
  the worker running → steer, as today; a review or a fix resume in flight →
  refused (`task: run <id> is in a goal (review round 2/3); cancel it or wait
  for its end`); ended → resume, out of the goal, or, with `--until reviewed`
  beside it, a new goal on the resumed run (cap and review model the
  original launch's). `pier task cancel --run
  <root>` cancels the goal: its current run and the record, end `failed` with
  reason `cancelled by <session>`. A restart resumes the current agent run on
  its id; on boot `goals.recover()` advances any goal whose current run is
  terminal but unadvanced (the advance is one transaction with the next run's
  prepare, so a crash between never doubles a step).

- **Storage.** Table `goals` (migration 36): `id, root_run_id, current_run_id,
  created_at, finished_at` as columns and the record as `json` (`Goal`:
  supervisorSessionId, cap, round, step, outcome, reason, reviewModel,
  reviewed), the
  store's document pattern. A run of a goal carries `goalId` in its `json`
  (no column) so the ledger links each step; the root
  run's `launch` carries `until: "reviewed"`, `rounds`, `reviewModel` as the
  record of what was asked (`AgentLaunchPolicy`, a seam change).

## Changes

1. `tasks/types.ts`: `AgentLaunchPolicy.until/rounds/reviewModel`, `Goal`,
   `GOAL_STEP`; `TaskRun.goalId`; `OpenRun.goal` (step, round, cap, outcome).
2. `db.ts`: migration 36 (`goals`); `TaskRun.goalId` rides in the run's JSON.
3. `tasks/goals.ts` (new, one reason: the `--until merged` loop): the table,
   the two prompts, `VERDICT`, `advance(run)`, `recover()`, `cancel()`.
   `tasks/` crosses its 3.2k ceiling; the raise's sentence is this loop.
4. `tasks/service.ts`: `settled` → `goals.advance`; `settleCallback` settles a
   goal step as `GOAL_STEP`; the end's callback text gets its `Goal:` head;
   `cancel` walks the goal.
5. `tasks/operations.ts` + `tasks/cli.ts`: `--until merged`, `--rounds`,
   `--review-model` on `run --prompt` (refused beside `--role`, `--bash`,
   `--task-id`, `--session`, a `--member`); the `--run` refusal while a review
   is in flight.
6. `tasks/open-items.ts`: the goal on the run line and in `openStatus`;
   `waitsIn` from the same reading. `web/ui/drawer.ts` `itemRow`: `waitsIn`
   opens that session, the rest as today ([03 §Bar and status
   panel](../design/03-web-workbench.md) gains the sentence).
7. `agent/roles.ts`: `DISPATCHER` — the Goal and code-worker paragraphs
   replaced by two lines: a code worker is `--until merged` unless the user
   named another end; the callback's `Goal:` line is what to say; ask first
   only for a seam or a design, the restart after the merge still theirs.
   `LEAD_BUILD` + one review line.
8. `skills/pier-tasks/SKILL.md`: `--until merged` row in the flags table,
   the `Goal:` line, the cap, control while live.
9. Docs: [09 §`run`](../design/09-tasks-cli.md), [10 §Roles / §Open
   items](../design/10-continuous-session.md); web: the run chip's name
   gains the goal's step (`review 2/3`) from `OpenRun.goal`, nothing else.
10. Tests: `tasks/goals.test.ts` — every row of the loop table, no verdict,
    cancel, recover after a crash between settle and advance; `open-items.test.ts`
    the four statuses from a goal and `waitsIn` for a design, a stage wait
    and a goal's `decision`; `cli.test.ts` the flags; `roles.test.ts` the
    prompt; `drawer.test.ts` the row's target.

## Settled with the user

- No seam-path escalation in the loop: a touched seam file is not a heavy
  change, and the list would be one more thing to maintain.
- The generic auto-continue is dropped (above).
- A user asking for a review of a branch is an ordinary worker; the loop is
  only `--until reviewed`.

## Open

- Flag names: `--until reviewed --rounds 3 --review-model hardest`?
