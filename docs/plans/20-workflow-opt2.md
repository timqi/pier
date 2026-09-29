# Workflow opt2 — the finish is code, the worktree is a flag, the loop counts reviews

Status: building (lead branch `workflow-opt2`).

Source: the read-only review (run `57nz264vdhystfya`), items 1–13; its #9 is
superseded by the user's decision on #4 (`--until` goes). Each decision below
is one item's fix; the worker branches are named at the end.

## Decisions

### 1. `pier task finish` (item 1, 11)

`pier task finish --run <root> [--remove-worktree]` — operation
`{operation: "finish", run_id, remove_worktree?: true}` (`tasks/cli.ts`,
`tasks/operations.ts`). The server:

- `assertOwns(root)`; the run must be a goal's root whose goal ended `done`
  with `reviewed` set; else refused (`task: run <id> is not a reviewed goal's
  root` / `…'s goal ended <outcome>, nothing to merge`).
- reads the worktree (`GoalHost.worktree(runCwd(root))`, exposed on the
  service as `worktree`) and refuses unless `tree.head === goal.reviewed`
  and `tree.clean`: `task: <branch> moved past the reviewed sha <sha7> (HEAD
  <sha7>); re-review with pier task run --run <root> --prompt "<what changed>"
  --rounds 1` / `task: <worktree> has uncommitted changes; …`.
- the main repo is `dirname(realpath(git rev-parse --git-common-dir))` run in
  the worktree (`service.ts`, beside `worktree`).
- launches a fresh agent run (a normal one-shot, `kind: "subagent"`, worker
  role): name `finish: <root's name>`, `--model cheap` (resolved through
  `resolveModel("cheap", menu)`), cwd the main repo, callback to the caller
  like any `run`, prompt `finishPrompt(...)` — a code constant in `goals.ts`
  beside `reviewPrompt`:

```
[Pier: a goal's finishing run. Merge only what the lines below approve.]

Approved: merge <branch> into <base> at <reviewed sha>
Approved: remove worktree <path>            ← only with --remove-worktree

Worktree: <path>
Main repo: <main>

Verify first, in one call: `git -C <path> rev-parse HEAD && git -C <path> status --porcelain && git -C <path> branch --show-current` — HEAD must be the approved sha, the status empty, the branch <branch>; if any differs, stop with `Needs your decision — <what differs>` and do nothing else.
Then merge: `wt -C <path> merge <base>` when the worktree's removal is approved above, else `git -C <main> merge <branch>`. A conflict stops you the same way, the merge aborted.
Then run the repo's checks on <base> in <main> (AGENTS.md names them; else `npm run check && npm run lint && npm test` where package.json has them) and report the final state: the merge commit on <base>, whether the worktree was removed, what the checks said.
```

  The `Goal` gains `branch` and `base` (both `string | null`, set beside
  `reviewed` when a review is prepared; absent on older rows), so the
  finish reads its target off the record, not off the head's memory.
- A build lead's run is accepted too (its target session a lead, phase
  `build` — `store.leadPhaseOf`): the lead reviewed its own integrated branch,
  so there is no goal to read; the worktree is `runCwd(run)`, the target
  `tree.base`, the approved sha `tree.head`, refused unless `tree.clean` and
  the lead's session is idle (no run of it queued or running). The receipt
  and the finish prompt are the same. A run that is neither is refused:
  `task: run <id> is neither a reviewed goal's root nor a build lead's run`.
- Receipt: the run's receipt like `run`'s. `MODEL_TABLE` drops "a finishing
  run" from the `balanced` row; the finish's tier is code.
- The four prose copies of the recipe go: `WORKER` (the "Only a finishing run
  merges…" sentence — a build run still never merges/removes and is never
  resumed to), `DISPATCHER` (the "On their yes, launch a finishing run …"
  clause → "On their yes, `pier task finish --run <root>`, `--remove-worktree`
  only when they said so"), `skills/pier-tasks` (the merge paragraph → the
  command and its two refusals), `docs/design/10` (the finishing bullet).

### 2. The goal's end callback carries the worker's conclusion (item 2)

`TaskCallbacks.text` (`callbacks.ts`): when the ended run is a goal's end and
its session is not the root's worker session (a review ended it), the body is
the latest worker run's result (`store.latestRunForTarget(root.targetSessionId)`,
`clipResult(…, 3000, id)`), then a blank line, `Review:`, then the review's
text `clipResult(…, 1000, id)`. When the worker's own run ended it (a
`Needs your decision` from the worker, a failed step), the body is that
run's text as today. `Run:` still names the run that ended it.

### 3. The `Goal:` line names the root (item 3)

`goalLine` (`callbacks.ts`) takes the goal and the root run's cwd:
`Goal: review clean at <sha7> (run <root>, <branch> in <worktree>), waiting on you to merge`;
the same parenthesis on `needs your decision`, `still findings` and
`failed` lines — `(run <root>)` alone when branch or worktree are unknown.

### 4. `--worktree`, `--rounds`; `--until` goes (item 4)

- `AgentLaunchPolicy.until` is deleted, with the `merged` alias
  (`definitions.ts`, `operations.ts`, `cli.ts`, `service.ts`, doc 09, plan 18
  references left as history). A stored row carrying `until` is read as
  `rounds: rounds ?? 3` (one line in `parseLaunch`); nothing else survives.
- `AgentLaunchPolicy.worktree?: string`: a branch name. `expandDraft` runs
  `wt switch -c <branch> -b <cwd's branch> --no-cd -y --format json` in the
  resolved `--cwd` (`execFile` beside `git` in `service.ts`, reached from
  `expandDraft` through the `TaskService` it already holds — never a shell)
  and takes `.path` from its stdout's JSON (the first line; `✓ …` goes to
  stderr) as the fresh session's cwd. `wt`'s failure is the refusal
  (`task: wt: <first line>`). Refused beside `--session`, `--bash`,
  `--task-id`, in a `--member`, and on `save`.
- `AgentLaunchPolicy.rounds?: number` — **the number of reviews** (1–9).
  Invariant after `parseLaunch`: `rounds !== undefined` ⇔ the run is a goal's
  root. `--worktree` without `--rounds` → `rounds: 3`; `--rounds 0` → no
  goal (the key deleted); `--rounds n` without `--worktree` → a goal in
  `--cwd`. `--review-model` needs a goal (else refused: "beside --rounds or
  --worktree"). A `--role lead` run takes `--worktree` alone: the worktree is
  made and no goal opens; `--rounds` beside `--role` is refused.
- Cap semantics (`goals.ts`): `Goal.cap` counts reviews. A `findings` review
  ends the goal `cap` when `goal.round + 1 >= goal.cap`; `--rounds 1` is one
  review, no fix. `reviewPrompt`'s head reads `review N of <cap>`; `fixPrompt`
  reads `review N/<cap> found issues`.
- Re-entry: `--run <root> --prompt "<answer>" --rounds <n> [--review-model …]`
  opens a new goal on the ended goal's root with `n` reviews (`n ≥ 1`);
  `--run` without `--rounds` is a plain resume, out of the goal. Argv: `--run`
  takes `--prompt`, `--after`, `--callback*`, `--rounds`, `--review-model`;
  `--rounds` beside `--after` refused. The `message` operation carries
  `rounds` and `review_model` instead of `until`; `service.resume(…, goal)`
  takes `{cap, reviewModel}` instead of a boolean.
- `core/reply.ts` `openRunText`: ` · until reviewed: <text>` → ` · review: <text>`;
  its doc comment loses `--until`.
- Usage line (`cli.ts` `COMMANDS.run`, doc 09):
  `run [--prompt <text|-> --model <tier|model|?> | --bash <script>] [--run <id> [--after | --rounds <n>]] [--task-id <id>] [--session <id>]`
  `[--thinking <level>] [--role lead [--design]] [--worktree <branch>] [--rounds <n>] [--review-model <tier|model>]`
  `[--cwd <dir>] --name <text> [--timeout <seconds>] …`
  and `finish --run <root> [--remove-worktree]` — "merge a reviewed goal's
  branch into its target as a cheap finishing run in the main repo; refused
  unless HEAD is the reviewed sha and the tree clean".

### 5. Memory line (item 5)

`DISPATCHER` §Memory: "`MEMORY.md`: durable facts, decisions, the project
index …, seeded in full at every session open, never re-read."

### 6. The merge question ends with buttons (item 6)

`DISPATCHER`: the reply to a `Goal: review clean` callback ends with
`---` / `[Merge] | [Merge, remove worktree] | [Show the review]`; a click on the
first two is the user's yes (`pier task finish --run <root>`,
`--remove-worktree` on the second). `SURFACE_CHAT`: "Only for short, obvious
next moves; never for anything destructive, except a button that is the
user's decision itself (a merge, a removal) — the click is their yes, and
nothing runs before it."

### 7. One place for each rule (item 7)

- `skills/pier-tasks` description: "Subagents and scheduled tasks with `pier
  task`. Daily `run`, `--run` and `finish` are in your contract; read this
  for `--member`, `--bash`, cron/watch, `recover`, `stats` and the goal's
  mechanics."
- `DISPATCHER`'s parenthetical → "(skills/pier-tasks for `--member`, `--bash`,
  schedules, `recover`, `stats`)".
- The skill's model table is deleted; §Model choice keeps the mechanics
  (tiers, substring, `?`) and says the tier per kind of work is the launching
  contract's table. The skill keeps the goal mechanics (the four `Goal:`
  lines, `--rounds`, control while live, re-entry, `finish`'s refusals);
  `DISPATCHER` keeps the decisions (which run gets `--worktree`, what to say
  on each `Goal:` line, the buttons) and no mechanics.

### 8. One verification command in the review prompt (item 8)

`reviewPrompt`: "Before reading anything, verify in one call:
`git rev-parse HEAD && git status --porcelain && git branch --show-current && git diff --stat <baseSha>..<head>` —
HEAD `<head>`, an empty status, branch `<branch>`, a non-empty diff. If any
differs, answer `Verdict: blocked — <what differs>` and nothing else."

### 10. The topic a callback reply is about (item 10)

`web/ui/topics.ts` `tagReply`: with no `<topic>`/`<open>`/`<done>`, the reply
is tagged by the open item holding a run of the task callback it answers —
the nearest preceding system-input row with a `task-callback` origin
(`appendSystemInput` writes its `runIds` to `data-runs`, comma-joined; a
user row or another reply in between ends the search). `setOpenTopics`
takes the items with their `runs` and keeps `runId → problem`; an item no
longer open tags nothing (the tag is read off the rows and the open list,
never stored — the same limit as today). `DISPATCHER` §Open items: "a reply
carrying the item's marker, or answering a callback of its run, is tagged by
it already; any other reply about an item ends with `<topic>problem</topic>`".
Doc 03's topic paragraph says the same.

### 12. `--name` is required on a fresh `--prompt` run (item 12)

Argv (`cli.ts`): a fresh `--prompt` run — top-level or a `--member` — without
`--name` is refused (`task: a new run needs --name: the session's title, a
few words in the user's language`). `--bash`, `--session`, `--run`,
`--task-id` and `save` keep `nameFrom`. `DISPATCHER`'s sentence stays as the
rule's reason: "the session's title in the user's language, no role word".

### 13. Budgets column (item 13)

`AGENTS.md` §Budgets: each "What the size is" cell is one clause naming what
is in there; the lines-past-N justifications go (they are in `git log`).

## Workers

| Branch | Items | Files |
| --- | --- | --- |
| `opt2-runtime` | 1, 2, 3, 4, 8, 11 (code), 12 | `tasks/{types,definitions,cli,operations,service,goals,callbacks}.ts`, `core/reply.ts`, their tests, `docs/design/09-tasks-cli.md` |
| `opt2-prompts` | 1 (prose), 4 (prose), 5, 6, 7, 11 (table), 13 | `agent/roles.ts` + test, `skills/pier-tasks/SKILL.md`, `AGENTS.md`, `docs/design/10-continuous-session.md` (workflow bullets and its `--until`/`· until reviewed:` lines) |
| `opt2-topic` | 10 (code) | `web/ui/{topics,chat,main}.ts` + tests, `docs/design/03-web-workbench.md` |
