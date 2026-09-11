---
name: pier-vault
description: Run a command with a named vault secret via `pier vault run`, never seeing the value. Read before anything needing a token, key or password, or on a `vault:` error.
---

# Pier vault

```
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- ./fetch_weekly.py --out raw/weekly
```

`ENV=NAME` puts the secret `NAME` into the command's environment as `ENV`;
`NAME` alone is `NAME=NAME`; list as many as needed. Everything after `--`
runs as is (same cwd and stdio, its exit code is yours). Use the name a
skill gives you; never invent one.

- **No value is ever printed** — not by `pier vault run`, not by you: no
  `echo`, log line, file or config. The command reads its environment.
- **No workaround for a missing secret**: you cannot obtain the value another
  way; ask the operator with the link from the error.
- **`approve` secrets may pause**: every use asks the operator through `vt`
  and the command waits. Say so when a step may sit waiting; do not retry in
  a loop.

## When it fails

One stderr line, exit 2, the command did not run.

| stderr | Do |
| --- | --- |
| `vault: no secret named X — file it at <link>` | Stop. Give the operator that exact link (it opens the Console with the name filled in); the value goes there, never to you. |
| `vault: locked — <reason>` | The operator unlocks Pier's key store (Console → Settings → Security). Nothing you run helps. |
| `vault: vt is required for X (approve level) and was not found` | `vt` is not on PATH here. Tell the operator; you cannot change the level. |
| `pier: Pier is not running (no …/pier.sock)` | Only Pier's own machine has the socket. Report it. |
| `pier: PIER_SESSION_ID is required` / `pier: … is not a session of this Pier` | You are not inside a Pier session with Pier's `pier` on PATH. Report it. |
| `usage: pier vault run …` | Check `--` is present and each name is `ENV=NAME` or `NAME`. |
