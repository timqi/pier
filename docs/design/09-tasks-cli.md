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
- **Existing run** `--run <id>`: running → steer; `--after` → follow-up
  queued behind its current turn; terminal → resumed as a new run on the
  same session, which takes `--callback*` like any new run. The receipt
  says which of the three happened. `--callback*` with steer/follow-up is
  an argv error, not silently ignored.
- **Batch**: the first `--member` switches `run` to a group. Flags before it
  are every member's defaults; each `--member` opens one member whose flags
  override them. `--join` (default `all`) is the group's. Members are
  ordinary argv — no quoting inside quoting — and at most one may read
  `--prompt -`. Admission is all-or-nothing, as today.

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

`--model <name>` is matched by Pier against the operator's menu
(`settings.modelMenu`): case-insensitive substring over `provider`, `id` and
`note`. One hit → that pin, `--thinking` defaulting to the pin's. No hit or
several → `task: model "<name>" matches <n> of the menu: <one line per pin>`,
exit 1, and the agent picks. A full `provider/id` is always accepted as
written. `--model ?` prints the menu and exits 0. No standing prompt cost,
no lookup call in the common case; "let gpt review it" is `--model gpt`.

## Decisions

A subagent that needs an answer ends its turn with the question as its
result; the supervisor reads it in the ordinary callback and answers with
`pier task run --run <id> --prompt "<answer>"` (a resume). No mid-run
channel: `contact`, `reply`, the `decision`/`progress` message kinds, the
suppressed-completion rule and the open-question state are deleted from
`tasks/messages.ts`, `tasks/types.ts`, the callback wording, the web
timeline labels (`originLabel`), the Runs filter and 03-web-workbench.md.
Pier adds no turn for one workflow's sake.

## Skill

`skills/pier-tasks/SKILL.md` describes these five commands and keeps every
rule that governs behaviour: end the turn after launching; callbacks are the
only delivery; ownership (your trees; descendants only when you are a
subagent); depth and instance limits; `recover` only for lost text; models
by name. Target under 1 500 tokens (o200k); measured in the commit.

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
