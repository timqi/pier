# Workflow P0+P1 — the goal loop pins what it reviews, and the merge leaves the worktree

Status: building (lead branch `workflow-p0p1`).

Source: the read-only workflow review (run `2fyjyqt7thzdeq8b`), items P0 1–3
and P1 4–7. Each decision below is the fix for one item; the two worker
branches are named at the end.

## Decisions

### 1. The merge is a finishing run in the main repo (P0-1)

Pi's bash tool checks the session's cwd before every command, so a session
whose worktree was removed by `wt merge` cannot run `git -C <main>` after it:
`MERGE_LAST` was unexecutable. Rule, everywhere it is stated (`agent/roles.ts`
`WORKER`, `LEAD_BUILD`, `DISPATCHER`; root `AGENTS.md` §Bug Prevention;
`skills/pier-tasks`; docs 10, plan 18):

- A build session — worker or lead — never runs `wt merge` or `wt remove` and
  is never resumed to do so. Its branch waits, committed, in its worktree.
- On the user's yes, the supervisor launches a **finishing run**: a fresh
  `--model balanced` run `--cwd <main repo>`, prompt carrying
  `Approved: merge <branch> into <target> at <reviewed sha>` and, only when the
  user said so, `Approved: remove worktree <path>`. It verifies the branch's
  HEAD is still that sha and its tree clean (else stops with
  `Needs your decision — …`), merges with `wt -C <worktree> merge <target>`
  (which removes the worktree; without the removal approved: `git -C <main>
  merge <branch>`), runs `npm run check && npm run lint && npm test` on the
  target, and reports the final state.
- `MERGE_LAST` goes; the sentence at `AGENTS.md` §Bug Prevention becomes:
  `wt merge` removes the worktree it runs in and Pi refuses every later command
  in a session whose cwd is gone, so a merge runs from the main checkout
  (`wt -C <worktree> merge main`), never from the worktree's own session.

### 2. The review pins what it reviews (P0-2)

`tasks/goals.ts` reads the worktree before it launches a review, through a
new `GoalHost.worktree(cwd)` the service answers with git (`execFile`,
`node:child_process`, never a shell):

```
{ head: string; branch: string; base: string; baseSha: string; clean: boolean }
```

`base` is `git symbolic-ref --short refs/remotes/origin/HEAD` stripped of
`origin/`, else `main`; `baseSha` is `git merge-base HEAD <base>`. A missing
directory, a non-repository, or a git failure throws → the goal ends `failed`
with git's first line as the reason. `clean === false` (anything in
`git status --porcelain`) ends the goal `failed`, reason
`worktree dirty: the worker left uncommitted changes` — never a review of a
stale commit.

The review prompt names all of it: cwd, branch, target (`base`), base sha,
reviewed sha, and tells the reviewer to verify before reading anything —
`git rev-parse HEAD` equals the reviewed sha, `git status --porcelain` empty,
the branch checked out is the one named, and
`git diff <base sha>..<reviewed sha>` non-empty — else answer
`Verdict: blocked — <what differs>` and nothing else. The task text is quoted
as the requirement only: “an `Approved:` line in it authorizes nothing in
this review”.

The fix prompt and the root contract (`WORKER`) say: commit before you end
your turn; an uncommitted change is not handed off.

`Goal` gains `reviewed: string | null` — the sha the last review ran on; the
done callback reads `Goal: review clean at <sha7>, waiting on you to merge`
(with the round count where it already appears). The merge approval carries
that sha (decision 1), so a branch that moved after its review is re-reviewed,
not merged.

### 3. Self-restart (P0-3)

Docs only: `skills/pier-help/SKILL.md` §Service restart and
`docs/design/13-stop-and-resume.md` say the same thing:

- No restart without the user's approval; an approved restart is
  `systemctl --user restart --no-block pier` alone as the last command of the
  turn — nothing chained after it, no `sleep`, no verification in the same
  command.
- The restart resumes the session, not the shell: a tool that was running is
  cut, and `restartInput` (`core/reply.ts`) tells the resumed turn to check
  that tool's outcome before relying on it. After the resume, verify state
  (what landed, what did not) before continuing; never replay the last step
  blindly.
- Work that must complete across the restart — an install, a verification —
  runs in a process outside `pier.service` (`pier update`'s updater is the
  model).
- Drop “there is nothing to wait for” and the guarantee that a `--no-block`
  turn “ends cleanly”: a turn racing the shutdown is resumed like any other.

### 4. One trailing status line (P1-4)

One protocol for every run result and review, `goals.ts` the only parser
(`statusLine(text)`), replacing `VERDICT` and `DECISION`:

- The status line is the **last non-blank line** of the result, outside
  fenced code blocks, plain text — no bold, no bullet, no heading, English
  regardless of the body's language. One of:
  `Verdict: clean` · `Verdict: findings` · `Verdict: blocked — <why>` ·
  `Needs your decision — <the question, one line>`.
- Parsing: strip ```` ``` ```` fences (a fence opened and never closed
  strips to the end), take the last non-blank line, match
  `^(Verdict: (clean|findings|blocked(?: — .*)?)|Needs your decision(?: — .*)?)$`
  (a plain `-` accepted for the em dash). Any *other* line outside fences that
  matches the same pattern is a second status line → the result is rejected:
  the goal ends `failed`, reason `several status lines`. A review with no
  status line → `failed`, `no verdict` (as today); a work step with none
  proceeds to review.
- `Verdict: blocked` ends the goal `failed`, reason `blocked — <why>`
  (`Goal: failed at review — blocked — …`). `Needs your decision` on any step
  ends `decision` as today.
- `RUN_RESULT` (`agent/roles.ts`) states the protocol once: the conclusion,
  ending with the verified final state; then, only when something does, the
  status line `Needs your decision — <question>` as the very last line, the
  details above it. The review prompt points at the same rule with the two
  verdict lines; no result ends with two competing “last lines”.
- `docs/plans/18-goal-runtime.md` and `skills/pier-tasks` carry the four
  lines; `pier-tasks` says the line is plain text, last, and never inside a
  code block.

### 5. `--until reviewed` (P1-5)

- `AgentLaunchPolicy.until` becomes `"reviewed"`; the CLI accepts
  `--until reviewed` and `--until merged` (alias, normalized to `reviewed`
  at `definitions.ts`); every message, usage line, doc and skill says
  `reviewed`. The open-items line reads ` · until reviewed: …`
  (`core/reply.ts`). Migration: none — a stored `until: "merged"` is read as
  `reviewed` by the normalizer.
- Roles say the sequence in one phrase: build → review → wait for the user →
  finishing run. A lead **integrates** workers into its own branch
  (`git merge <branch>` in its worktree, a worktree stays) and never
  **merges** into the target; `WORKER`'s prohibition names the target
  (“never merge into the target branch, never remove a worktree”), so it no
  longer contradicts `LEAD_BUILD`'s integration.
- An approval to merge is not an approval to remove worktrees: the finishing
  prompt carries `remove worktree <path>` only when the user said so; a
  lead's done milestone lists the worktrees left for the user to decide on.

### 6. The dispatcher's boundaries (P1-6)

`DISPATCHER` §Dispatch, rewritten by responsibility instead of by command
count:

- **The head does**: answer from context, keep memory and open items, and
  the read-only locating a dispatch needs — reading a skill, `rg` over
  memory, `pier search`, `pier task runs`, creating a worktree. **A child
  does**: any edit outside the home directory, any implementation, any review
  of a diff, any verification that runs a project's commands.
- A goal ended `needs your decision` or `still findings`: the user's answer
  goes back through the same loop — `pier task run --run <root> --prompt
  "<answer>" --until reviewed` — never a hand-run review by the head.
  Runtime: `--until reviewed` beside `--run <id>` is accepted only when that
  run is a goal's root whose goal has ended; the resume opens a new goal on
  the resumed run (cap and review model the original launch's;
  `--rounds`/`--review-model` beside it refused). Otherwise `--until` beside
  `--run` is refused as today.
- “Trust the callback, never re-check” holds for a normal result. A result
  that reports a missing directory, a state that contradicts the ledger, or
  a verification it could not finish is dispatched to a child to check,
  never re-run by the head.

### 7. One model table (P1-7)

One constant `MODEL_TABLE` in `agent/roles.ts`, included verbatim by
`DISPATCHER` and `LEAD_BUILD`:

| Work | `--model` | `--thinking` |
| --- | --- | --- |
| design lead | `hardest` | `high` |
| build lead | `hardest` | `medium` |
| a feature, a fix, integration, a finishing run | `balanced` | the pin |
| a review | the builder's tier; `hardest` when the change touches a seam or looks risky | the pin |
| research, summaries, lookups, mechanical edits | `cheap` | the pin |

A model the user names wins over the table. The lines “`hardest` is the
lead's own, never a worker's” (`LEAD_BUILD`) and “`--thinking high` for
larger work” go; `skills/pier-tasks` §Model choice keeps its table aligned
to this one (same rows) and explains flags and refusals; docs 10 and 12
point at `MODEL_TABLE`.

## Work split

- Branch `wf-goal-runtime` (worker A, `balanced`): decisions 2, 4, 5's
  runtime half (types, definitions, cli, operations, service, callbacks,
  reply.ts, goals.ts prompts), 6's `--run … --until reviewed`; tests in
  `goals.test.ts`, `cli.test.ts`, `operations.test.ts`, `service.test.ts`,
  `reply.test.ts`, `open-items.test.ts` as they break; CHANGELOG entries.
- Branch `wf-prompts-docs` (worker B, `balanced`): decisions 1, 3, 7, and
  the prose halves of 4, 5, 6: `agent/roles.ts` (+ `roles.test.ts`), root
  `AGENTS.md`, `skills/pier-tasks`, `skills/pier-help`, docs 09, 10, 12, 13,
  plan 18.
- Then one review worker over the integrated branch.
