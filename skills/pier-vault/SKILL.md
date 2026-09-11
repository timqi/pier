---
name: pier-vault
description: Use a named secret from Pier's vault in a shell command with `pier vault run`, without the value ever entering your context. Read before running anything that needs a token, API key or password, or when a command fails with `vault:`.
---

# Pier vault

The operator files secrets by name in the Console (Settings → Vault). You use
one by name; you never see, print, or store its value.

## The one line

```
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- ./fetch_weekly.py --out raw/weekly
```

- `ENV=NAME` puts the secret called `NAME` into the command's environment as
  `ENV`. `NAME` alone means `NAME=NAME`. List as many as the command needs.
- Everything after `--` is the command, run as is: same cwd, same stdin/stdout,
  its exit code is yours. `SIGINT`/`SIGTERM` reach it.
- A skill that needs a secret names it by convention — `SLACK_BOT_TOKEN=SLACK_TOKEN`
  — and shows this line. Use the name it gives; do not invent one.

## What never happens

- **No value is printed**, by `pier vault run` or by you. Do not `echo` the
  variable, log it, write it to a file, or paste it into a config. A command
  that needs the value reads it from its environment.
- **Do not work around a missing secret.** If the vault has no such name, you
  cannot obtain the value some other way; ask the operator (below).

## `approve` secrets may pause

Some secrets are filed at the `approve` level: every use asks the operator for
an approval through `vt`, and the command waits until they answer. Say so in
your reply when a step may sit waiting, and do not retry in a loop.

## When it fails

Every failure is one `vault:` line on stderr and exit code 2 — the command did
not run.

| stderr | What to do |
| --- | --- |
| `vault: no secret named X — file it at <link>` | Stop. Hand the operator that exact link (it opens the Console with the name filled in) and ask them to paste the value there. Never ask them to paste the value to you. |
| `vault: locked — <reason>` | The operator has to unlock Pier's key store (Console → Settings → Security). Tell them; nothing you run will help. |
| `vault: vt is required for X (approve level) and was not found` | `vt` is not on this machine's PATH. Tell the operator; do not switch the secret to another level, you cannot. |
| `vault: Pier is not running (no …/vault.sock)` | Only Pier's own machine has the socket. Report it. |
| `usage: pier vault run …` | Your command line was malformed: check `--` is present and each name is `ENV=NAME` or `NAME`. |
