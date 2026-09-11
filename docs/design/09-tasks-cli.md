# `pier task` (design)

The whole agent-collaboration surface as five shell commands over the CLI
socket ([08-cli-socket.md](08-cli-socket.md)); the `task` tool call is
deleted once these run. Scheduling, delivery, limits and callbacks are
unchanged and stay in `tasks/`.

## Commands

| Command | Does | Replaces |
| --- | --- | --- |
| `run` | puts a prompt on a run: a new one, a batch of new ones (`--member`), or an existing one (`--run`) | run · steer · follow_up · resume |
| `save` | files or updates an operator-visible definition — cron, watch, or a role run more than once | create · update |

`handleTaskTool` speaks the same six words — `run`, `message`, `save`, `list`,
`cancel`, `recover` — so the tool, while it lasts, and the CLI are one
vocabulary. `save` with `task_id` updates. `message` is the one operation
that did not exist: see below.
| `list` | definitions, one line each | list |
| `cancel` | `--run <id>` or `--group <id>`, cascades to descendants | cancel |
| `recover` | `--run`/`--group` + `--reason`: the full result after its callback settled; never a progress check | recover |

Deleted with no replacement: `models` (see Models), `contact`, `reply` (see
Decisions).

Every command returns at once and prints the receipt as compact JSON on
stdout, exit 0. A refusal is one `task: <reason>` line on stderr, exit 1;
argv errors are the usage line, exit 2, before the socket is touched.
`--prompt -` reads stdin; nothing else does.

## `run`

```
pier task run [--prompt <text|->] [--run <id> [--after]] [--task-id <id>]
              [--session <id>] [--model <name>] [--thinking <level>]
              [--cwd <dir>] [--name <text>] [--timeout <seconds>]
              [--callback origin|none|steer] [--callback-session <id>]
              [--join all|first] [--member <flags…>]…
```

- **New run**: `--prompt` (one-shot, fresh session in `--cwd`, default the
  caller's), or `--task-id` (a saved definition), or `--session <id>`
  (continue an idle session with `--prompt`).
- **Existing run** `--run <id>`: one request, `message {run_id, message,
  after?, callback?, callback_session_id?}`. The server picks by
  `isTerminal(run.state)`: running → steer; `--after` → follow-up queued
  behind its current turn; terminal → resumed as a new run on the same
  session, which takes `--callback*` like any new run. The receipt is
  `{delivery: "steer" | "follow_up", message}` or `{delivery: "resume",
  run}`. `--callback*` on a run that is not terminal is refused by the
  server (`task: run <id> is running: callback options apply to a resumed
  run only …`, exit 1), never silently dropped — the CLI cannot know the
  state, and asking would be the status query this surface refuses.
  `--run` takes nothing but `--prompt`, `--after` and `--callback*`.
- **Batch**: the first `--member` switches `run` to a group. Flags before it
  are every member's defaults; each `--member` opens one member whose flags
  override them; a `--task-id` member runs its definition as is, taking no
  defaults. `--join`, `--callback`, `--callback-session` (default `all`) are
  the group's and belong before the first `--member`. Members are ordinary
  argv — no quoting inside quoting — and at most one may read `--prompt -`.
  Admission is all-or-nothing, as today.

`run` never reads a JSON draft: the flags cover what `parseDraft` accepts
for an agent action, and `parseDraft` stays the one validator on the server.

## `save`

```
pier task save [--task-id <id>] --name <text>
               (--prompt <text|-> | --bash <script>)
               [--cron "<expr>" --tz <zone> | --watch <script> --every <s> [--repeat]]
               [--cwd <dir>] [--timeout <seconds>] [--model] [--thinking]
               [--callback-session <id>]
```

`--task-id` updates, otherwise creates. No trigger means `manual`. `--bash`
is a script action; `--prompt` an agent action; exactly one. A saved task's
callback can only be a session (`--callback-session`) — scheduled runs have
no invoker to return to. Archiving stays in the Console.

## Models

`--model <name>` rides as `launch.model`, a string, and is matched by Pier
in `expandDraft` — the one door every draft passes — against the operator's
menu (`settings.modelMenu`; the live catalog when no pin exists):
case-insensitive substring over `provider/id` and `note`. An exact
`provider/id` on the menu is its pin even where the substring is ambiguous.
One hit → that pin, `--thinking` defaulting to the pin's. No hit or several →
`task: model "<name>" matches <n> of the menu:` then one line per pin
(`provider/id · thinking — note`; the hits when several, the whole menu when
none), exit 1, and the agent picks. A `provider/id` nobody pinned is
accepted as written, no thinking implied. `--model ?` posts `run` with
`launch.model: "?"` and prints the menu the server answers with, exit 0. No
standing prompt cost, no lookup call in the common case; "let gpt review it"
is `--model gpt`.

## Decisions

A subagent that needs an answer ends its turn with the question as its
result; the supervisor reads it in the ordinary callback and answers with
`pier task run --run <id> --prompt "<answer>"` (a resume). No mid-run
channel: `contact`, `reply`, the `decision`/`progress` message kinds, the
suppressed-completion rule and the open-question state are deleted from
`tasks/messages.ts`, `tasks/types.ts`, the callback wording, the web
timeline labels (`originLabel`), the Runs filter and 03-web-workbench.md.
Pier adds no turn for one workflow's sake.

## Two levels, no tree

A run that has a supervisor (a `callbackSessionId`) may not call `pier task`
at all: `task: a delegated run cannot delegate; ask in your result and let
your supervisor run it`, exit 1. A top-level session, and a run nobody is
waiting on (cron, watch, manual from the Console), may. So delegation is at
most session → run, and a scheduled task can still fan out.

The reason is the run boundary: a run is one turn of its session, so a child
that launched work and ended its turn is finished; its children's callbacks
would land in a session no run owns and no supervisor hears. With the tree
gone, so is the machinery for it: depth (0–2) and the 16-descendant limit in
`runs.ts`, descendant ownership in `assertOwns`, the subagent callback
redirect rule, every `active`-run branch in `handleTaskTool`, and the skill's
nesting section. Ownership becomes: the session that launched a run controls
it. A human turn in a run's session after it finished is that human's
business and reports to nobody.

## Skill

`skills/pier-tasks/SKILL.md` describes these five commands and keeps every
rule that governs behaviour: end the turn after launching; callbacks are the
only delivery; ownership (the runs you launched); the instance limit;
delegated runs do not delegate; `recover` only for lost text; models by name. Target under 1 500 tokens (o200k); measured in the commit.

## Deleting the tool call

After `pier task` has run end to end on the dev instance: `taskToolSpec`,
`agentTaskTools`, `settings.taskTool` and its Console card, the `extraTools`
plumbing in `agent/pi.ts`, and `AgentCustomTool` in `core/types.ts` go —
each with zero remaining consumers. `handleTaskTool` stays as the socket's
handler; the CLI maps five commands onto its operations, so the service
layer does not change shape.

## Tests

`tasks/cli.test.ts`: every command's argv → the exact params object posted,
`--member` defaults/overrides, `--run` on running/terminal (server answers
drive the branch), `--callback` with steer refused, `--prompt -` once,
usage exit 2 without the socket. `tasks/tool.test.ts`: model matching (one,
none, many, full id, `?`). Deletion commits keep every remaining test green
and remove only the tests of what left.
