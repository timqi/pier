# `pier task` (design)

The whole agent-collaboration surface: five shell commands over the CLI
socket ([08-cli-socket.md](08-cli-socket.md)), served by `handleTask`
(`tasks/operations.ts`). There is no task tool call. Scheduling, delivery,
limits and callbacks are `tasks/`'s and unchanged by this surface.

## Commands

| Command | Does |
| --- | --- |
| `run` | puts a prompt on a run: a new one, a batch of new ones (`--member`), or an existing one (`--run`) |
| `save` | files or updates a definition the operator sees — cron, watch, or a role run more than once |
| `list` | stored definitions, as JSON |
| `cancel` | `--run <id>` or `--group <id>`, descendants included |
| `recover` | `--run`/`--group` + `--reason`: the full result after its callback settled; never a progress check |

Every command returns at once and prints the receipt as compact JSON on
stdout, exit 0. A refusal is one `task: <reason>` line on stderr, exit 1;
argv errors are the usage line, exit 2, before the socket is touched.
`--prompt -` reads stdin; nothing else does.

The CLI checks argv shape only; the server (`handleTask` → `parseDraft`) is
the one validator of the params object.

## `run`

```
pier task run [--prompt <text|->] [--run <id> [--after]] [--task-id <id>] [--session <id>]
        [--model <name|?>] [--thinking <level>] [--cwd <dir>] [--name <text>] [--timeout <seconds>]
        [--callback origin|none|steer] [--callback-session <id>] [--join all|first] [--member <flags…>]…
```

- **New run**: `--prompt` (one-shot, fresh session in `--cwd`, default the
  caller's), or `--task-id` (a saved definition, as is), or `--session <id>`
  with `--prompt` (continue an idle session; `--cwd` refused).
- **Existing run** `--run <id>`: one `message {run_id, message, after?,
  callback?, callback_session_id?}` request. The server picks by the run's
  state: running → steer; `--after` → follow-up queued behind its current
  turn; terminal → resumed as a new run on the same session, taking
  `--callback*` like any new run. Receipt: `{delivery: "steer" | "follow_up",
  message}` or `{delivery: "resume", run}`. `--callback*` on a run that is not
  terminal is refused (`task: run <id> is <state>: callback options apply to a
  resumed run only …`). `--run` takes nothing but `--prompt`, `--after` and
  `--callback*`.
- **Batch**: the first `--member` switches `run` to a group. Flags before it
  are every member's defaults; each `--member` opens one member whose flags
  override them; a `--task-id` member takes no defaults and refuses its own
  run flags. `--join` (default `all`), `--callback`, `--callback-session`
  belong before the first `--member`. Members are ordinary argv; at most one
  may read `--prompt -`. Admission is all-or-nothing.

## `save`

```
pier task save [--task-id <id>] --name <text> (--prompt <text|-> | --bash <script>)
        [--cron "<expr>" --tz <zone> | --watch <script> --every <seconds> [--repeat]]
        [--cwd <dir>] [--timeout <seconds>] [--model <name>] [--thinking <level>] [--callback-session <id>]
```

`--task-id` updates, otherwise creates. No trigger means `manual`. `--bash`
is a script action, `--prompt` an agent action; exactly one. A saved task's
callback is a session (`--callback-session`) or nothing. Archiving is the
Console's.

## Models

`--model <name>` rides as `launch.model`, a string, matched in `expandDraft`
against the operator's menu (`settings.modelMenu`; the live catalog when
none is pinned):

- an exact `provider/id` on the menu is that pin;
- else one case-insensitive substring hit over `provider/id` and `note` is
  that pin, `--thinking` defaulting to the pin's;
- else no hit and a `provider/id` shape is taken as written, no thinking;
- else `task: model "<name>" matches <n> of the menu:` then one line per pin
  (`provider/id · thinking — note`; the hits when several, the whole menu
  when none), exit 1.

`--model ?` prints the menu instead of running, exit 0.

## Decisions

A subagent that needs an answer ends its turn with the question as its
result; the supervisor answers with `pier task run --run <id> --prompt
"<answer>"` (a resume). There is no mid-run channel; control messages are
`steer` and `follow_up` only (`tasks/messages.ts`, migration 25).

## Two levels, no tree

A run with a supervisor (a `callbackSessionId` — its own, or its group's) may
not call `pier task` while it is `running` on the caller's session: `task: a
delegated run cannot delegate; ask in your result and let your supervisor run
it`, exit 1. A queued run gates nothing. A top-level session, and a run nobody
waits on (cron, watch, manual from the Console, `--callback none`), may.

Ownership: the session that launched a run controls it, and so does the run's
own session. `parentRunId` links only a `task` action's child, which a cancel
walks. The run preamble (`tasks/agent.ts`) tells a supervised run in one
sentence that `pier task` is refused.

## Skill

`skills/pier-tasks/SKILL.md` keeps every rule that governs behaviour: end the
turn after launching; callbacks are the only delivery; ownership; the
instance limit; delegated runs do not delegate; `recover` only for lost text;
models by name. Its size is measured in the commit that changes it.

## Tests

`tasks/cli.test.ts`: every command's argv → the exact params object posted,
`--member` defaults/overrides, `--run` receipts, `--callback` refused on a
running run (server answer), `--prompt -` once, usage exit 2 without the
socket. `tasks/operations.test.ts`: the supervised-run gate, ownership,
`message`'s three branches, `recover`'s refusals, model matching (one, none,
many, full id, `?`).
