# Vault (design)

Named secrets an agent's commands can use without the value ever entering a
model's context: the operator files them in the Console, a skill names them,
`pier vault run` injects them into one child process. Pier is the store and
the injector; `vt` stays the approval gate for the secrets that need one.

## Why

Before the vault a token reached a command one of two ways. Either Pier held
it and a tool call spent it (the former `slack` tool), which meant one
operation per turn and every result in context; or a task repo carried a
`vt://` record in a file and wrapped its scripts by hand
(`SLACK_BOT_TOKEN="$(cat slack-token.vt)" vt inject --only-env …`), which
worked and leaked nothing, but every task reinvented the line, the record
lived in git, and rotation was a hunt through repos. The vault keeps the
second shape and takes the bookkeeping off the task.

## Two levels, one column

A secret is `auto` or `approve`. The level is the operator's choice at entry
time; an agent cannot ask for a different one.

| Level | Stored `value` | Resolved to | Gate |
| --- | --- | --- | --- |
| `auto` | `v1:<dekId>:…` — `Secrets.encrypt(plaintext)` | plaintext | none: any session, any subagent, any local process of Pier's user |
| `approve` | `vt://…` — the record `vt create` returned | the record, unchanged | `vt inject` asks for approval per use |

The value's shape *is* the level: `isSealed()` (`src/secrets.ts`) says
`auto`, the `vt://` prefix says `approve`. No enum column, nothing that can
disagree with the value beside it. A `vt://` record is stored in the clear
— it is a random handle, not derived from the secret, and `master.key`
already stores one that way.

`auto` means "the agent may use this freely"; the sealing protects backups
and DB copies, not the running system. The Console says so beside the toggle.

## Storage

```sql
CREATE TABLE vault (
  name       TEXT PRIMARY KEY,   -- ^[A-Z][A-Z0-9_]{0,63}$, an env-var name
  value      TEXT NOT NULL,      -- sealed blob or vt:// record
  updated_at INTEGER NOT NULL
);
```

Names are env-var shaped so the common case needs no mapping. Overwrite by
name is rotation: commands already running keep the env they were given;
the next `run` gets the new value. Delete is a row delete; a skill naming a
deleted secret fails with the name, never with an empty string.

## Module: `src/vault.ts`

Root instance leaf beside `secrets.ts`, one reason: the vault table and its
resolution. Imports `db.ts`, `secrets.ts`, `log.ts`; nothing from `core/`,
`agent/` or a platform SDK.

```ts
interface Vault {
  list(): { name: string; level: "auto" | "approve"; updatedAt: number }[];
  put(name: string, level: "auto" | "approve", plaintext: string): Promise<void>;
  seal(name: string, plaintext: string): void;
  remove(name: string): void;
  resolve(names: string[]): Record<string, { kind: "plain" | "record"; value: string }>;
  get(name: string): string | undefined;
}
```

- `put` with `auto` seals via `Secrets.encrypt`; with `approve` runs
  `VtClient.create(plaintext)` and stores the record. Plaintext is a parameter
  and a local; it is not logged, not echoed, not kept.
- `seal` is `put` at `auto`, synchronous: `ChannelStore.save` runs on the
  message path and cannot await.
- `get` is one name for Pier's own reads, `undefined` when unfiled; a sealed
  row still needs the key.
- `resolve` for a sealed row calls `Secrets.decrypt`, so a locked store
  refuses with `assertUnlocked`'s reason — `approve` rows still resolve while
  locked, they need no key. An unknown name is an error naming it. Nothing
  partial: one missing name fails the whole call.
- Values are never logged at any level; the log line is
  `vault resolve NAME,NAME by <pid>`.

## Socket: `$PIER_HOME/vault.sock`

A second listener, `node:http` on a Unix socket, mode `0600`, unlinked on
start and on exit, serving one route:

`POST /resolve` body `{ names: string[] }` → `200 {values}` or
`404 {error:"no secret named X", file:"<url>"}` /
`423 {error:"locked — <reason>"}`.

`file` is the Console deep link for filing that name,
`<publicUrl>/#/settings/vault?name=X` — `publicUrl` from settings, falling back
to `http://127.0.0.1:<port>`. The route already carries a query
(`src/web/ui/views.ts`); the Vault topic reads `name` and opens the add
row with `name` filled and the value field focused, so the operator's path
from the agent's error to a filed secret is one click and one paste.

Not a route on the workbench server: that one sits behind a reverse proxy at
a public hostname, and "loopback only" is a claim about the proxy, not
Pier. The socket's permission bits are the whole auth — the same boundary
the SQLite file already has. Plaintext crosses this socket into the calling
process and nowhere else. No dependency: `node:http` with `socketPath` on
both ends.

## CLI: `pier vault run`

```
pier vault run [ENV=NAME | NAME]... -- <command> [args...]
```

`NAME` alone means `NAME=NAME`. Everything after `--` runs with `stdio`
inherited, cwd inherited, exit code passed through, `SIGINT`/`SIGTERM`
forwarded.

1. Connect to `vault.sock`; `POST /resolve` with the names.
2. `plain` values go straight into the child's env under `ENV`.
3. `record` values go into the env under `ENV` too, and the command becomes
   `vt inject --only-env <those ENVs, comma-joined> -- <command> [args...]`.
   `vt` swaps the records for plaintext after approval; env vars not listed
   pass through untouched.
4. No `record` values → the command runs directly, no `vt` in the path.

Failures are one line on stderr and exit `2`, so they land in the agent's
tool output as words, not as an empty variable:

| Condition | stderr |
| --- | --- |
| socket missing | `vault: Pier is not running (no $PIER_HOME/vault.sock)` |
| unknown name | `vault: no secret named X — file it at <publicUrl>/#/settings/vault?name=X` |
| store locked | `vault: locked — unlock() has not run` |
| `vt` not on PATH with `record` values | `vault: vt is required for X (approve level) and was not found` |
| bad syntax | usage line |

The CLI prints no value, ever. Lives in `src/cli.ts` beside
`install|uninstall|status`; the subcommand is ~60 lines and shares nothing
with them but the argv switch.

## Console

Settings gains a **Vault** topic (`#/settings/vault`, beside Channels and
Models — configuration entered rarely, no live state, so not a top-level
view): a table of `name · level · updated`,
an add row (`name`, `auto|approve` toggle, a password field), delete per row.
Routes mounted beside the settings routes, behind the Console password:

| Route | Behavior |
| --- | --- |
| `GET /api/vault` | `Vault.list()` — names and levels, never values |
| `PUT /api/vault/:name` | body `{level, value}` → `put`; 400 on a bad name or empty value; `approve` while `vt` is unavailable is 503 with `vt doctor`'s line; `vt create` still waiting on an approval after 15s is 504 (approve and retry, or file as `auto`) — the put keeps running and a late approval still files the row |
| `DELETE /api/vault/:name` | remove; 404 if unknown |

No reveal, no edit-in-place: a secret is replaced, not read back.

## Channel credentials

The vault is the one place a channel credential is stored and rotated.
`ChannelConfig.token`/`appToken` keep their meaning in memory; `ChannelStore`
fills them from the vault on read and files them on save, and the `channels`
row holds neither. Fixed names, `CREDENTIAL_NAMES` in `channels/config.ts`:

| Platform | `token` | `appToken` |
| --- | --- | --- |
| Telegram | `TELEGRAM_TOKEN` | — |
| Slack | `SLACK_TOKEN` | `SLACK_APP_TOKEN` |
| Lark | `LARK_APP_ID` | `LARK_APP_SECRET` |

The Console's Channels form and the Vault topic are two views of the same
row: saving an empty field removes the row; removing or filing the row in the
Vault topic reaches the channel when `ChannelStore` next reads it (restart) —
the store caches what it read. Only a changed credential is re-filed, so
`updated` is the rotation. An `approve` row under one of these names is not a
token the adapter can use. Migration 24 moved the sealed blobs over verbatim.

## Skill: `skills/pier-vault/SKILL.md`

What an agent reads before touching a secret: the `run` syntax, that
values never print, that `approve` may pause for an operator, and that a
missing name is a stop — hand the operator the link from the error, never
paste a token into a file. Skills that need a secret name it by convention
(`SLACK_BOT_TOKEN=SLACK_TOKEN`) and show the one line:

```
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- ./fetch_weekly.py --out raw/weekly
```

## First consumer: Slack

There is no `slack` tool. Every operation — reads, `post`, `edit`, `delete`,
`file` — is a subcommand of `pier slack` (`channels/slack-cli.ts`), which
resolves the token itself: `$SLACK_BOT_TOKEN` when set, otherwise
`SLACK_TOKEN` over the vault socket through the same `resolveSecrets` as
`vault run`. An `approve` record cannot be swapped in-process, so the command
prints the exact `pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- pier slack …`
line and exits 2 rather than spawning `vt` itself. A task fetches a week of
history in one process and writes it to disk (`--out`) instead of paging it
through context one call per turn. The one thing a shell cannot know — which
conversation the session is in — arrives as the `place` token of the speaker
header (`slack:<channel>/<thread_ts>`, core/identity.ts). The "Pier's own
messages only" guard and the Console's agent-access switch went with the
tool: with the token in the vault both were bypassable, so the vault level of
`SLACK_TOKEN` is the switch, and Slack's own `cant_update_message` /
`cant_delete_message` are the guard.

## Not in scope

- Per-task or per-session scoping of names. `approve` is the scope
  mechanism; `auto` is by definition unscoped. Revisit when a second
  consumer asks.
- Unattended approval policy for `approve` secrets in cron tasks: `vt`'s
  business; whatever `rd-weekly` does today continues to work.
- A tool call that returns a secret. There is none; that is the point.

## Budget

Root `src/*.ts`: `vault.ts` (~150) and the CLI subcommand (~60) — the
store, the socket and the injector could not exist without them, and each
removes a hand-written `vt inject` line from every task that uses a secret.
`web/`: three routes and one settings section, the only place a secret is
ever entered. Tests: `vault.test.ts` with an injected `VtClient` and a
temp `PIER_HOME`; CLI tests against a socket the test opens; route tests
behind the auth guard. Hermetic, no `vt` spawned.
