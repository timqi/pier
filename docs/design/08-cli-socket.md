# CLI socket (design)

`$PIER_HOME/pier.sock` is how the `pier` CLI reaches the running instance:
`pier vault run`, `pier slack` (a vault resolve) and `pier task`. `node:http`
on a Unix socket, mode `0600`, unlinked on start and on exit; the permission
bits are the whole auth (`src/socket.ts`). Not a workbench route: plaintext
crosses this socket into a local process of Pier's user and nowhere else.

## Identity

Every request body carries `sessionId`, the calling session. It is identity,
not authentication — the `0600` bits are the boundary; the id is the audit
key (`vault resolve NAME by session <id>`) and the caller `pier task`
operates as (ownership, the supervised-run refusal, callback target).

- The CLI reads `PIER_SESSION_ID` and nothing else. The shim Pier writes to
  `~/.pier/tools/bin/pier` (`writePierShim`, `src/tools.ts`) is the one line
  that names the harness: `export PIER_SESSION_ID="${PIER_SESSION_ID:-$PI_SESSION_ID}"`,
  so an explicit `PIER_SESSION_ID` wins.
- Missing or empty → `400 {error: "PIER_SESSION_ID is required"}`; an id Pier
  cannot locate (live in the router, or a transcript on disk) →
  `403 {error: "<id> is not a session of this Pier"}`. The CLI prints either
  as one `pier: <error>` line, exit 2, before any route's answer is read.
  A terminal outside a session has no id and gets the 400.

## Protocol

`POST <route>`, body a JSON object, ≤64 KiB (past that the connection is
dropped unread). Any other method or path is `404`; a body that is not a JSON
object is `400`.

| Route | Body | Answers |
| --- | --- | --- |
| `/resolve` | `{sessionId, names: string[]}` | `200 {values}` — `{NAME: {kind: "plain" \| "record", value}}`; `404 {error: "no secret named X", file}` where `file` is `<publicUrl>/#/settings/vault?name=X` (loopback when no public URL is set); `423 {error: "locked — <reason>"}`; `400` for names that are not a non-empty list of vault names; `500 {error}` for anything else ([07-vault.md](07-vault.md)) |
| `/task` | `{sessionId, params}` — `params.operation` is `run`, `message`, `save`, `list`, `cancel` or `recover` ([09-tasks-cli.md](09-tasks-cli.md)) | `200 {result}`; `422 {error}` with the operation's own message for anything it refused — `handleTask` (`tasks/operations.ts`) is the one validator, and the CLI does none |

## Failure lines

| stderr | exit | When |
| --- | --- | --- |
| `pier: Pier is not running (no $PIER_HOME/pier.sock)` | 2 | no socket, or nobody behind it |
| `pier: PIER_SESSION_ID is required` | 2 | the env has no session |
| `pier: <id> is not a session of this Pier` | 2 | a foreign or stale id |
| `vault: …` | 2 | a `/resolve` route answer ([07-vault.md](07-vault.md)) |
| `task: …` | 1 | a `/task` route answer (`skills/pier-tasks/SKILL.md`) |
