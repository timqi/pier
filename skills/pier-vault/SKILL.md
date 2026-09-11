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
  `ENV`; `NAME` alone means `NAME=NAME`. List as many as the command needs.
- Everything after `--` is the command, run as is: same cwd, same stdio, its
  exit code is yours, `SIGINT`/`SIGTERM` reach it.
- A skill that needs a secret names it (`SLACK_BOT_TOKEN=SLACK_TOKEN`); use
  that name, do not invent one.

## What never happens

- **No value is printed**, by `pier vault run` or by you: no `echo`, no log
  line, no file, no config. A command that needs the value reads its
  environment.
- **No working around a missing secret.** If the vault has no such name you
  cannot obtain the value another way; ask the operator (below).

## `approve` secrets may pause

An `approve`-level secret asks the operator through `vt` on every use, and the
command waits for the answer. Say so in your reply when a step may sit
waiting; do not retry in a loop.

## When it fails

Every failure is one line on stderr and exit code 2 — the command did not run.

| stderr | What to do |
| --- | --- |
| `vault: no secret named X — file it at <link>` | Stop. Hand the operator that exact link (it opens the Console with the name filled in) and ask them to paste the value there — never to you. |
| `vault: locked — <reason>` | The operator has to unlock Pier's key store (Console → Settings → Security). Tell them; nothing you run will help. |
| `vault: vt is required for X (approve level) and was not found` | `vt` is not on this machine's PATH. Tell the operator; you cannot change the level. |
| `pier: Pier is not running (no …/pier.sock)` | Only Pier's own machine has the socket. Report it. |
| `pier: PIER_SESSION_ID is required` / `pier: … is not a session of this Pier` | You are not running inside a Pier session, or through Pier's own `pier` on PATH. Report it. |
| `usage: pier vault run …` | Malformed command line: check `--` is present and each name is `ENV=NAME` or `NAME`. |
