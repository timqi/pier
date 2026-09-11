# Vault (design)

Named secrets an agent's commands use without the value entering a model's
context: the operator files them in the Console, a skill names them,
`pier vault run` injects them into one child process. Pier is the store and
the injector; `vt` is the approval gate for the secrets that need one.

## Two levels, one column

A secret is `auto` or `approve`, the operator's choice at entry; an agent
cannot ask for a different one.

| Level | Stored `value` | Resolved to | Gate |
| --- | --- | --- | --- |
| `auto` | `v1:<dekId>:…` — `Secrets.encrypt(plaintext)` | plaintext | none: any session, subagent or local process of Pier's user |
| `approve` | `vt://…` — the record `vt create` returned | the record, unchanged | `vt inject` asks for approval per use |

The value's shape is the level: `isSealed()` (`src/secrets.ts`) says `auto`,
the `vt://` prefix says `approve`; no level column. A `vt://` record is a
random handle, stored in the clear like the one in `master.key`. `auto`
sealing protects backups and DB copies, not the running system; the Console
says so beside the toggle.

## Storage

```sql
CREATE TABLE vault (
  name       TEXT PRIMARY KEY,   -- ^[A-Z][A-Z0-9_]{0,63}$, an env-var name
  value      TEXT NOT NULL,      -- sealed blob or vt:// record
  updated_at INTEGER NOT NULL
);
```

Overwrite by name is rotation: commands already running keep the env they
were given; the next `run` gets the new value. A deleted name fails a `run`
with the name, never with an empty string.

## Module: `src/vault.ts`

Root instance leaf beside `secrets.ts`; imports `db.ts`, `secrets.ts`,
`log.ts`, nothing from `core/`, `agent/` or a platform SDK.

```ts
export type VaultLevel = "auto" | "approve";
export interface VaultEntry { name: string; level: VaultLevel; updatedAt: number }
export type Resolved = Record<string, { kind: "plain" | "record"; value: string }>;
export const isVaultName = (name: string): boolean;   // ^[A-Z][A-Z0-9_]{0,63}$
export class UnknownSecret extends Error { readonly secret: string }
export class VaultLocked extends Error {}
export class Vault {
  list(): VaultEntry[];
  put(name: string, level: VaultLevel, plaintext: string): Promise<void>;
  seal(name: string, plaintext: string): void;      // put at auto, synchronous
  remove(name: string): boolean;                    // false when there was no row
  get(name: string): string | undefined;            // one of Pier's own credentials
  resolve(names: string[], by = "unknown"): Resolved;
}
```

- `put` at `auto` seals via `Secrets.encrypt`; at `approve` runs
  `VtClient.create(plaintext)` and stores the record. Plaintext is a parameter
  and a local: not logged, not echoed, not kept.
- `seal` is synchronous because `ChannelStore.save` runs on the message path.
- `resolve` decrypts sealed rows, so a locked store throws `VaultLocked` with
  `Secrets.lockedReason`; `approve` rows resolve while locked. An unknown name
  throws `UnknownSecret` naming it, and nothing partial is returned.
- The one log line is `vault resolve NAME,NAME by session <id>`; values appear
  at no level.

## Socket

`POST /resolve` on Pier's CLI socket, `$PIER_HOME/pier.sock`: the protocol,
the `sessionId` every request carries, the `file` deep link in the `404` and
the failure lines are in [08-cli-socket.md](08-cli-socket.md).

## CLI: `pier vault run`

```
pier vault run [ENV=NAME | NAME]... -- <command> [args...]
```

`NAME` alone is `NAME=NAME`. The command runs with `stdio` and cwd inherited,
exit code passed through (`128 + signal` for a signal death), `SIGINT`/`SIGTERM`
forwarded.

1. `POST /resolve` on `pier.sock` with the names and the session's id.
2. `plain` values go into the child's env under `ENV`.
3. `record` values go into the env too, and the command becomes
   `vt inject --only-env <those ENVs, comma-joined> -- <command> [args...]`;
   variables not listed pass through untouched.
4. No `record` values → the command runs directly, no `vt` in the path.

Every failure is one stderr line and exit `2`; the CLI prints no value. A
socket failure — not running, no or unknown `PIER_SESSION_ID` — is a `pier:`
line ([08-cli-socket.md](08-cli-socket.md)); the vault's own are:

| Condition | stderr |
| --- | --- |
| unknown name | `vault: no secret named X — file it at <publicUrl>/#/settings/vault?name=X` |
| store locked | `vault: locked — unlock() has not run` |
| `vt` not on PATH with `record` values | `vault: vt is required for X (approve level) and was not found` |
| bad syntax | the usage line |

## Console

Settings → **Vault** (`#/settings/vault`) files, replaces and removes a row
and never reveals one; the pane and the three `/api/vault` routes are
[03-web-workbench.md](03-web-workbench.md)'s.

## Channel credentials

`ChannelConfig.token`/`appToken` keep their meaning in memory; `ChannelStore`
fills them from the vault on read and files them on save, and the `channels`
row holds neither. Fixed names (`CREDENTIAL_NAMES`, `channels/config.ts`):

| Platform | `token` | `appToken` |
| --- | --- | --- |
| Telegram | `TELEGRAM_TOKEN` | — |
| Slack | `SLACK_TOKEN` | `SLACK_APP_TOKEN` |
| Lark | `LARK_APP_ID` | `LARK_APP_SECRET` |

Saving an empty field removes the row; a row filed or removed in the Vault
topic reaches the channel when `ChannelStore` next reads it (restart). Only a
changed credential is re-filed, so `updated` is the rotation. An `approve`
row under one of these names is not a token the adapter can use.

## Skills

`skills/pier-vault/SKILL.md` is what an agent reads before touching a secret.
A skill that needs one names it by convention and shows the line:

```
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- ./fetch_weekly.py --out raw/weekly
```

`pier slack` (`skills/pier-slack/SKILL.md`, [04-im-channels.md](04-im-channels.md))
resolves `SLACK_TOKEN` through the same socket client as `vault run` and, for
an `approve` record, re-runs itself under `vt inject` with `SLACK_BOT_TOKEN`
set — the agent types the same line either way.

## Not in scope

- Per-task or per-session scoping of names: `approve` is the scope mechanism,
  `auto` is unscoped by definition.
- An approval policy for `approve` secrets in cron tasks: `vt`'s business.
