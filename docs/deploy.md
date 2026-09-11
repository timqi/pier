# Running Pier as a service (Linux, systemd)

`pier serve` in a terminal is a complete installation; systemd keeps tasks
firing and channels connected while nobody is logged in. Linux only.

```sh
npm install -g @timqi/pier
pier service install
journalctl --user -u pier -e     # the password, printed once
```

That writes the units, enables linger, and starts the service. `systemctl
--user cat pier` shows the units with their per-line comments; this page is
what they do not say.

## Prerequisites

- Node 24 or newer (`node:sqlite` is used unflagged).
- A user-writable global npm prefix: the updater runs as you.
- `sqlite3` CLI: optional, for the off-machine backup and password steps below.
- Pier installed globally. A checkout (`git clone` + `npm ci && npm run build`)
  is the *develop* path; point the unit's `ExecStart` at its `dist/main.js` if
  you run one as the service, and update it with the checkout steps under
  Updating.

## The unit

A **user** unit. `~/.config/systemd/user/pier.service` records the absolute
node and entry point, the installing shell's `PATH`, and a loopback bind;
`--pier-home` adds `PIER_HOME`. `pier service install --force` rewrites both
units and restarts (after a new tool, or a moved Node); the limits drop-in is
never overwritten. Linger is enabled by the installer.

## Memory limits

Requires the memory controller delegated to your user manager (default on
current systemd):

```sh
systemctl show "user@$(id -u).service" -p DelegateControllers
# DelegateControllers=cpu memory pids   ← memory listed means these work
```

The installer writes `~/.config/systemd/user/pier.service.d/limits.conf` once
(`MemoryHigh=60%`, `MemoryMax=75%`, no swap, `TasksMax=512`, `OOMPolicy=continue`,
each line commented). The limit covers the **whole unit** — `node`, Pi
subagents, every command a turn ran, their page cache. Dedicated 4–8 GB VPS:
the defaults land around 2.5–6 GB. Big shared box: absolute values
(`MemoryHigh=8G` / `MemoryMax=12G` on 32 GB). Pier idles in the hundreds of MB:

```sh
systemctl --user show pier -p MemoryCurrent -p MemoryPeak
systemd-cgtop --depth=3 "user.slice/user-$(id -u).slice"
```

## Logs

stdout and stderr only; journald stamps, keeps and rotates.

```sh
journalctl --user -u pier -f            # follow
journalctl --user -u pier -p warning    # only what went wrong
journalctl --user -u pier --since -1h | grep 'tasks:'   # one area
journalctl --user -u pier | grep 'client:'              # browser-side errors
```

Every line is `area: message` — `core`, `agent`, `tasks`, `slack`, `telegram`,
`lark`, `channels`, `slack.tool`, `auth`, `boards`, `client`, `db`, `drain`,
`secrets`, `settings`, `credentials`, `update`, `tools`, `push`, `web`,
`web.providers`, `pier`. Level: a syslog priority prefix under
`$JOURNAL_STREAM`, a level word in a terminal. `client:` is posted back by
signed-in workbench tabs (`ui/report.ts`): script errors, unhandled rejections,
a dead SSE stream, with view and user agent.

```sh
systemctl --user set-environment PIER_LOG=debug   # + per-message tracing
systemctl --user restart pier
```

`PIER_LOG`: `debug`, `info` (default), `warn`, `error`, `silent`. `debug` logs
one line per inbound message and per tool call.

## First login

A password is generated on an empty database and printed once:

```sh
journalctl --user -u pier | grep -A2 'no password'
```

Only its scrypt hash is stored. Lost it? Drop the row and restart:

```sh
sqlite3 ~/.pier/db/pier.db 'DELETE FROM auth'
pier restart
```

- Changing or recovering the password signs out every browser.
- One browser: Settings → Instance → Signed-in devices.
- A browser session expires 7 days after its last request, and 90 days after
  it signed in however often it is used.
- However a session ends, its push subscription goes with it.

## Restarting and reloading

```sh
pier restart          # finish active work, then restart the service
pier reload           # apply channel config and recycle idle sessions in place
pier tools sync       # install/update the managed CLI tools
```

All three signal the installed service.

- `pier restart`: refuses new messages and root Task runs, waits up to five
  minutes, exits for `Restart=always`; aborted IM turns at the deadline are
  recorded and posted by the next process; post-deadline cleanup has one shared
  10-second bound.
- `pier reload`: reloads channel adapters, evicts idle unwatched sessions;
  streaming or watched sessions, and sessions still holding queued messages,
  stay until normal eviction. Console → Settings → Instance → **Reload** is
  the same, also takes the asking tab's session (unless mid-turn or holding a
  queue), and answers `recycled` / `busy`.
- `pier tools sync`: converges the tools switched on in Console → Settings into
  `~/.pier/tools/bin` (first on every session's PATH); one sync at a time per
  machine.
- `~/.pier/pi/settings.json` is Pier's: the default model is set in Console →
  Settings → Models, packages in Console → Settings → Agent; any other key is
  edited on disk, then `pier reload`. A first boot with no file writes one:
  - `packages: []` — the list the Console's Add package writes into.
  - `enableInstallTelemetry: false` — Pi's default is on, and the SDK reads it
    to stamp attribution headers on OpenRouter, NVIDIA and Cloudflare requests;
    a server instance is not a person to survey. (`enableAnalytics` is not
    written: nothing on the SDK path reads it, and its default is already off.)
  - `retry: { maxRetries: 5, baseDelayMs: 5000 }` — Pi's default (3 retries,
    2s base) gives up on a provider 503 after ~14s; an unattended instance
    has nobody to re-ask, so the backoff runs ~155s instead.
  - The default model trio is left to Settings → Models; compaction and every
    other key stay at Pi's defaults by omission, on purpose.
  An existing file is never touched, whatever it holds.
- `systemctl --user restart pier` and `pier update` are hard stops.
- One Pier per `$PIER_HOME`: a start whose directory another live Pier holds
  logs `another Pier (pid N) owns …` and exits before opening the database. Kept
  under `Restart=always` on purpose — the service takes the directory back by
  itself once the other process (usually a hand-typed `pier serve`) is gone, at
  one refused start every `RestartSec=2` until then.

## Updating

```sh
pier update           # installs the latest release, then hard-stops/restarts Pier
pier update --check   # only says whether one exists
```

The footer asks `registry.npmjs.org` at boot and at most every 30 minutes and
shows `v0.0.1 → 0.0.2` when newer exists; a failed check is silent.

From a checkout:

```sh
systemctl --user stop pier
pier backup
cd ~/pier
git fetch --tags && git checkout v0.0.2   # a tag, not a branch
npm ci && npm run build
systemctl --user start pier
```

`pier update` hard-stops; the Console's **Update now** and the automatic path
drain first (new work refused, running turns finished, the rest ledgered for
the next boot). Either way the updater snapshots
`~/.pier/db/backups/pier.db.release-<version>.bak` (`<version>` = the Pier being
replaced) before npm runs, every release. Only stop and start are downtime; a
failed backup or install stops nothing (`journalctl --user -u pier-update`).

**Automatic updates**: off by default; switched on from the version panel;
checks every 15 minutes; hands over only when the switch is on, a newer release
exists, and the instance is idle (nothing streaming, no task run in flight).
systemd only.

**Node paths**: `fnm uninstall v24` (or nvm) deletes the Node `ExecStart`
names while the process survives; Pier checks at boot and before every handover
and reports in the journal and the version panel. Fix: `pier service install
--force`.

**Schema**: a newer Pier migrates on start, in one transaction before the port
opens, after snapshotting to `~/.pier/db/backups/pier.db.v<N>.bak` (`N` = the
schema it was at). Upgrades only: an older Pier refuses a newer database. Way
back:

```sh
systemctl --user stop pier
ls -t ~/.pier/db/backups/                       # newest first
cd ~/.pier/db && rm -f pier.db pier.db-wal pier.db-shm
cp backups/pier.db.release-0.0.4.bak pier.db    # the version in the name
# then reinstall that Pier release: npm install -g @timqi/pier@0.0.4
```

Copies are written under a temporary name and renamed into place; the three
newest of **each kind** (release, schema) are kept; a second backup at the same
version replaces it. They protect against a bad upgrade, not a lost disk.

**The updater unit** `pier-update.service` (backup, `npm install -g`, stop,
`ExecStopPost` start) runs outside `pier.service`'s cgroup, which a restart
kills. `pier update` records the service's effective `PIER_HOME` in a runtime
drop-in, then starts it; starting the unit directly is unsupported. No
`systemd.timer`: only Pier starts an update, so it can drain first.

## Secrets for commands

Console → Settings → Vault files a secret by name; an agent's command gets it
with

```sh
pier vault run SLACK_BOT_TOKEN=SLACK_TOKEN -- ./script.py
```

- `auto`: sealed in `pier.db`, resolved for any local process of Pier's user.
  `approve`: a `vt://` record; every use asks through `vt`, which must be on
  the PATH of the machine running the command.
- The CLI reaches the running Pier through `~/.pier/vault.sock` (mode 0600,
  created at start, removed at exit); a failure is one `vault:` line and exit 2.
- `approve` secrets in cron tasks wait on the approval like any other `vt` use.
- Channel tokens are vault rows too (`SLACK_TOKEN`, `TELEGRAM_TOKEN`,
  `LARK_APP_ID`, …): removing one there empties that channel's credential.

## Remote access

Loopback bind; reach it over a tunnel, not a wider bind:

- `ssh -L 3141:localhost:3141 server`
- Tailscale, or Cloudflare Tunnel — no open port, TLS terminates outside.
- A reverse proxy (Caddy, nginx): terminate TLS there, preserve the external
  `Host` (or pass `X-Forwarded-Host`), and **set** `X-Forwarded-For` to the
  client — nginx `proxy_set_header X-Forwarded-For $remote_addr;`, Caddy by
  default. Pier reads the rightmost hop, so appending the peer is safe too
  (`$proxy_add_x_forwarded_for`); the unsafe case is a proxy that passes the
  client's own header through without adding a hop of its own, which lets the
  client name its throttle bucket.
  Pier uses the external host for write-origin checks and counts login
  failures per forwarded client. The cookie is `Secure` when a loopback proxy
  reports `X-Forwarded-Proto: https` (ignored from anywhere else).
- `ssh -L` sends no such header, so every client through the tunnel shares one
  throttle bucket.

## Backups

- `~/.pier/db/pier.db` — tasks, channels, chat → session map, workbench state,
  settings, password hash, sealed credentials and tokens. Off-machine: `sqlite3
  ... "VACUUM INTO '…'"`, not `cp` (WAL can miss the latest commits).
- `~/.pier/master.key` — seals the database's credentials and the vault's `auto` rows.
- `~/.pier/boards/`.
- `~/.pier/db/backups/` — the automatic pre-update and pre-migration copies.
- `~/.pier/pi` — Pi's session history (unless `PI_CODING_AGENT_DIR` names
  another directory).
- `~/.pier/inbox/<channel>/` — inbound chat attachments, never deleted by
  Pier; prune by hand (a pruned file becomes a broken attachment link).
