# Model tiers: the definition and whether dispatch follows it

The operator defines the tiers — which model at which level sits on
`hardest`, `balanced`, `cheap` (`settings.modelMenu`, Console › Agent ›
Models). Pier's part is two things: say what a tier means in one place, and
show whether runs were dispatched the way that meaning intends. No
benchmarks, no suggestions, no menu write.

## The definition

A tier is a work class the dispatcher names instead of a model
(`core/types.ts` `MODEL_TIERS`). The definition is `MODEL_TABLE`
(`agent/roles.ts`) — which tier and thinking level each kind of run takes, a
model the user names winning — carried verbatim by `DISPATCHER` and
`lead("build")`; `skills/pier-tasks/SKILL.md` §Model choice and this file
point, never copy.

Unspecified `--model`: today the caller's live model (`tasks/agent.ts:164`, a
rule from before tiers existed, when naming a model meant knowing its id). A
lead is on `hardest`, so every worker it launches without `--model` runs on
`hardest` — 152 of 426 agent-launched runs on this instance. A tier is one
of three words; there is no longer a reason to leave it off.

**Change 1**: a fresh agent action needs `--model` — a tier or a model name.
`pier task run --prompt` (and each `--member`) and `pier task save` with a
fresh session refuse without it, exit 1: `task: --model is required — a tier
(hardest | balanced | cheap) or a model on the operator's menu:` then the
menu. Not required where the model is already settled: `--session` (reuse),
`--run` (resume), `--bash`, `--task-id` (the definition's own). The inherit
rule in `tasks/agent.ts` becomes unreachable and goes; the Console's task
form is not on this path and keeps the instance default. The one behaviour
change here.

## The measurement

What the ledger records per run once `run-model-badge` lands: the model and
level the session settled on, the launch tier (`tier` on `RunModel`, absent
when a model was named), the role. After Change 1 that is the whole
question — every fresh launch is a tier or a name — so nothing new is
recorded.

**Change 2**: `pier task stats [--days 30]`, one verb on the CLI socket,
JSON:

```
{ days, rows: [{ tier: ModelTier | "named", role: "lead" | "worker",
                 provider, id, thinking, runs, cancelled,
                 names: [<up to 5 most recent task names>] }] }
```

- Agent-action runs, `triggerSource` agent/manual, finished in the window;
  `runs` is `succeeded` + `failed`, `cancelled` with `interrupted` apart.
- One row per (tier, role, provider, id, thinking): a tier whose model is
  not the menu's pin for it shows as its own row — the menu changed
  mid-window, or the tier was named and then a model overrode it. The menu
  itself is `pier task run --model ?`, not repeated here.
- `named` is a run with no `tier`; runs from before the badge land there
  too, and age out of the window within a month. The skill says so.
- `names` lets the reader judge the kind against the tier without opening
  runs: five reviews under `hardest` is the question the table exists to
  raise. The judging is the operator's; the verb prints no verdict.
- No duration, tokens or cost: none of them says whether a tier was
  chosen; cost is the operator's own evaluation, outside this.

`tasks/operations.ts` parses (`stats` beside `runs`); the host answers from
`tasks/service.ts` with one query over `task_runs`. ~50 lines plus the
test, on the fixtures `service.test.ts` already seeds runs with; `tasks/`
is at 3039 of 3.2k.

## Reading it

The operator asks in chat ("分档用得对吗"); the head runs the verb and
answers from the JSON — the share per tier, the `named` rows, any lead not
on `hardest`, and any row whose `names` read like another tier's work. No
worker, no board, no skill of its own: `skills/pier-tasks/SKILL.md` gains
the verb's line and the one reading rule (a row is a question, not a fault).

## Telling agents

The requirement is taught before it is enforced, in the two texts a
dispatcher already reads — the third copy is this file pointing at them:

- `skills/pier-tasks/SKILL.md` §Model choice: "Default: your model" becomes
  "`--model` is required on a fresh run: a tier, or a model the user named";
  the tier table stays as is.
- `agent/roles.ts` lead/worker preamble: the `--model` clause reads as
  required, same words.
- `tasks/cli.ts` `COMMANDS.run.usage`: `--model <tier|model>` outside the
  brackets, so `pier task --help` agrees.
- The refusal reuses the unassigned-tier error's shape (`menuLines`), one
  format for "which model, then".

## Work list

0. Merge `run-model-badge`.
1. Change 1 (`--model` required; the inherit rule deleted) with the three
   texts above — own commit.
2. Change 2 (`stats`) with a hermetic test over a seeded ledger.
3. Docs: `09-tasks-cli.md` (verb row, JSON, the requirement),
   `08-cli-socket.md` if the verb list is spelled there, `CHANGELOG.md`.
4. Run `pier task stats` on this instance and read it back in chat.

This build is the workflow's first run: from the lead's launch on, every
`pier task run` names a tier (`hardest` for the build lead, `balanced` for
code, `cheap` for mechanical work) before Change 1 refuses one that does
not, and the build's own runs are the first rows step 4 reads.

## Out of scope

Benchmarks, prices, tokens, suggestions, any menu write; a human "wrong
tier" verdict; judging result quality. `named` cannot tell the user's
override ("用 luna 跑") from the agent's own pick; the `names` column is the
reader's tell. A review's builder is not linked to it; same tell.
