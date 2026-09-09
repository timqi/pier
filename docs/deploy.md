# Running Pier as a service (Linux, systemd)

Pier is one Node process that binds the loopback. Running it in a terminal
(`pier serve`) is a complete installation — nothing below is required to *use* Pier. What systemd
adds is the thing a terminal cannot: scheduled tasks fire and IM channels stay
connected while nobody is logged in.

That is also why this document is Linux-only. A laptop closes its lid; the
machine you want always-on is a server, and on that machine systemd is already
there.

## The short version

```sh
npm install -g @timqi/pier
pier service install
journalctl --user -u pier -e     # the password, printed once
```

That writes the units, enables linger, and starts the service. Each line the
installer writes carries its own comment — `systemctl --user cat pier` is the
reference; this page is what the units do not say.

## Prerequisites

- Node 24 or newer (`node:sqlite` is used unflagged).
- A user-writable global npm prefix. The updater runs as you, so an initial
  install that needed `sudo npm install -g` cannot later update itself.
- The `sqlite3` CLI is optional, for the off-machine backup and password steps
  below. Pier itself and its automatic update backup do not need it.
- Pier installed globally: `npm install -g @timqi/pier`. The unit runs that
  installed entry point, so a deploy is `pier update`. A checkout
  (`git clone` + `npm ci && npm run build`) is the *develop* path; point the
  unit's `ExecStart` at its `dist/main.js` if you run one as the service, and
  update it with the "From a checkout" steps under Updating.

## The unit

A **user** unit, not a system one: Pier runs as you, reads your Pi
configuration, and drives sessions in your own directories. Running it as root
or as a dedicated system user means an agent that cannot touch the files you
wanted it to work on.

`~/.config/systemd/user/pier.service` records the absolute node and entry point
that installed Pier (systemd's PATH would not find a version-managed one), the
`PATH` of the shell that ran the install so commands a turn runs find the same
tools, and a loopback bind. `--pier-home` adds `PIER_HOME`. Installed a new tool
since? Re-run `pier service install --force`, which rewrites both units and
restarts the service; the limits drop-in below is operator-owned and never
overwritten. Without linger every scheduled task stops when your SSH session
ends — the installer enables it and says so if it could not.

## Memory limits

Worth setting: an agent runs whatever a turn decided to run, so the failure to
plan for is a build or a test suite eating the machine, not Pier itself
leaking. A cgroup limit turns "the box OOMs and sshd dies with it" into "the
heaviest process inside this unit is killed".

User units can do this without root as long as the memory controller is
delegated to your user manager, which it is by default on current systemd:

```sh
systemctl show "user@$(id -u).service" -p DelegateControllers
# DelegateControllers=cpu memory pids   ← memory listed means these work
```

The installer writes `~/.config/systemd/user/pier.service.d/limits.conf` once
(`MemoryHigh=60%`, `MemoryMax=75%`, no swap, `TasksMax=512`, `OOMPolicy=continue`,
each line commented) and never touches it again. The limit is on the **whole
unit**: `node`, every Pi subagent, and every command a turn ran, added together
— plus the page cache those processes touched, which is why the soft ceiling
should be the one that bites. So size it as a share of the machine, not as "how
much should Pier need".

On a dedicated 4–8 GB VPS those percentages land around 2.5–6 GB, which is
roughly what one agent doing ordinary work needs. On a big shared box, prefer
absolute values sized to what you are willing to lose to a runaway build —
`MemoryHigh=8G` / `MemoryMax=12G` on 32 GB, say — because 75% of a large
machine is no longer a meaningful ceiling.

Pick the numbers by measuring, not by guessing — Pier idles in the hundreds of
MB, and what varies is what the agent runs:

```sh
systemctl --user show pier -p MemoryCurrent -p MemoryPeak
systemd-cgtop --depth=3 "user.slice/user-$(id -u).slice"
```

A limit that fires during ordinary work is worse than none: the turn dies with
a signal and the cause is a kernel message nobody reads. Set it to protect the
machine, then raise it the first time it kills something legitimate.

## Logs

Pier writes to stdout and stderr and to nothing else — no log file, no
rotation, no log configuration. Under the unit above that *is* the log:
journald stamps the time, keeps the history and rotates it, which is why
nothing in Pier reimplements any of that.

```sh
journalctl --user -u pier -f            # follow
journalctl --user -u pier -p warning    # only what went wrong
journalctl --user -u pier --since -1h | grep 'tasks:'   # one area
```

Every line is `area: message` — `core`, `agent`, `tasks`, `slack`, `telegram`,
`lark`, `channels`, `slack.tool`, `auth`, `boards`, `client`, `db`, `drain`,
`secrets`, `settings`, `credentials`, `update`, `tools`, `push`,
`web`, `web.providers`, `pier` — so an area is a grep
and a level is a `-p`. The level reaches journald as a syslog priority prefix, which Pier
emits only when systemd says the output is a journal (`$JOURNAL_STREAM`); run
in a terminal, the same lines carry a timestamp and a level word instead.

What is logged by default: process start and shutdown, sessions opening,
conversation → session routing, every turn ending, every task run queued and
settled, callback and message delivery failures with their retries, adapters
starting (and failing to start or stop), dropped inbound messages, failed
logins, and any request that threw. A watch probe that matched nothing is the
one routine event kept at `debug` — it fires on every interval.

`client:` is the browser's half, posted back by the workbench (`ui/report.ts`)
and written into this same stream: script errors, unhandled rejections and a
dead SSE stream, each with the view and the user agent. It comes from signed-in
tabs only — the route sits behind the password like the rest of `/api`, so
nobody who cannot already reach Pier can write into this journal. The person sees the
same sentence in the chat pane, so "I clicked and nothing happened" has a line
on both ends:

```sh
journalctl --user -u pier | grep 'client:'
```

```sh
systemctl --user set-environment PIER_LOG=debug   # + per-message tracing
systemctl --user restart pier
```

`PIER_LOG` takes `debug`, `info` (default), `warn`, `error` or `silent`. Prefer
turning `debug` on for a session and back off: it logs one line per inbound
message and per tool call.

## First login

Pier generates a password on an empty database and prints it once, so the
journal is where you read it:

```sh
journalctl --user -u pier | grep -A2 'no password'
```

Only its scrypt hash is stored. If you lose it, drop the row and restart — a
new password is generated and printed:

```sh
sqlite3 ~/.pier/db/pier.db 'DELETE FROM auth'
pier restart
```

Changing the password signs out every browser: the session rows behind the
cookies are deleted. So does the recovery above — a new password does not leave
the old one's browsers signed in. To end one browser without changing the
password, use Settings → Instance → Signed-in devices. A session that is not
used expires 7 days after its last request. However a session ends — signed
out, expired, password changed, password recovered — its push subscription is
deleted with it, so that browser stops being notified as well.

The upgrade that introduced these rows signs everyone out once: a cookie issued
before it names no row. Have the password to hand.

## Restarting and reloading

```sh
pier restart          # finish active work, then restart the service
pier reload           # apply channel config and recycle idle sessions in place
pier tools sync       # install/update the managed CLI tools
```

Both commands signal the installed systemd service; they are not foreground
process controls. `pier restart` refuses new messages and root Task runs, waits
up to five minutes for active work, then exits for `Restart=always` to start the
next process. At the deadline it records every aborted IM turn first, and the
next process posts that note after its adapter starts. Cleanup after the deadline
has one shared 10-second bound regardless of how many sessions are stuck.

`pier tools sync` converges the command-line tools switched on in Console →
Settings — they install into `~/.pier/tools/bin`, which the service puts first
on the PATH every session and task inherits. Normally a switch runs
it for you as a task; typing it is for a machine that was offline when one was
flipped. One sync runs at a time per machine: an overlapping one waits for the
lock (and converges on the switches as they stand when its turn comes) instead
of racing the other's installs.

`pier reload` does not stop active work. It reloads Slack and Telegram adapters
and immediately evicts idle sessions nobody is watching, so their next message
opens with current agent files and configuration. Streaming sessions and
sessions held by an open workbench stay attached until their normal eviction.

Console → Settings → Instance → **Reload** is the same thing from a browser, and
needs no shell on the box. It also takes the session open in the tab that asked
(only a turn in flight is exempt) and answers with how many were recycled and
how many are still mid-turn — the second number is the only reason a change can
still fail to show up.

An ordinary `systemctl --user restart pier` and `pier update` remain fast,
hard-stop paths. Let active work finish first when using either one.

## Updating

```sh
pier update           # installs the latest release, then hard-stops/restarts Pier
pier update --check   # only says whether one exists
```

The workbench footer says the same thing without being asked: the server asks
`registry.npmjs.org` at boot and at most every 30 minutes after that, and the
version turns into `v0.0.1 → 0.0.2` when there is something newer. A failed
check is silent by design — an offline box is not a broken one.

From a checkout instead, stop and back up before replacing the build:

```sh
systemctl --user stop pier
pier backup
cd ~/pier
git fetch --tags && git checkout v0.0.2   # a tag, not a branch
npm ci && npm run build
systemctl --user start pier
```

For a service install, `pier update` hard-stops Pier; it does not use the
graceful `pier restart` path. The Console's **Update now** and the automatic
path do: both drain (new work refused, running turns finished, the rest
ledgered for the next boot to report) before the updater unit is started.

Either way the updater snapshots the database to
`~/.pier/db/backups/pier.db.release-<version>.bak` before npm touches the
package — `<version>` being the Pier that is being replaced, i.e. the release to
reinstall if that copy is ever restored. This happens for every release,
including releases with no schema change.

Backup and install run while Pier is still serving; only the stop and start
are downtime. A backup or install that fails never stops anything — the failure
is in the updater's journal (`journalctl --user -u pier-update`) and the running
Pier keeps serving the version it already loaded.

### Automatic updates

Off by default. Switched on from the version panel, it checks every 15 minutes
and hands over only when all three hold: the switch is on, a newer release
exists, and the instance is idle (nothing streaming, no task run in flight).
systemd only — without the unit there is nothing to hand the install to.

The unit records **absolute** paths to the node and npm that installed Pier,
because systemd's PATH has neither. That pins it to one directory of one version
manager: with fnm or nvm, `fnm uninstall v24` deletes the Node that `ExecStart`
names while the running process survives (Linux keeps a deleted binary mapped).
Pier checks those paths at boot and before every handover, and reports it in the
journal and in the version panel rather than letting the next restart fail:

```
pier service install --force    # re-records the current node and npm
```

A newer Pier brings its own schema up on the next start: the migrations run in
one transaction before the port opens, and the version they leave behind is
stamped in the database. It also snapshots the immediately preceding schema to
`~/.pier/db/backups/pier.db.v<N>.bak` (`N` = the schema it was at). **Upgrades
only.** Start an older Pier on a database a newer one has migrated and it
refuses to run rather than write tables it does not understand — the way back
down is either a release backup or that schema snapshot:

```sh
systemctl --user stop pier
ls -t ~/.pier/db/backups/                       # newest first
cd ~/.pier/db && rm -f pier.db pier.db-wal pier.db-shm
cp backups/pier.db.release-0.0.4.bak pier.db    # the version in the name
# then reinstall that Pier release: npm install -g @timqi/pier@0.0.4
```

Every copy lives in `~/.pier/db/backups/`, written under a temporary name and
renamed into place, so a `.bak` name only ever refers to a finished copy. The
three newest of **each kind** are kept — three release backups and three schema
snapshots, counted separately so a run of releases cannot evict the copies taken
before a migration. Backing up twice at the same version replaces that version's
copy. Each is a full copy of the database, one directory below it, and therefore
protects against a bad upgrade, not against a lost disk — an off-machine copy is
still yours to take.

### Can it update itself?

Yes, with one caveat that decides the shape: **the updater must not be a child
of the service it restarts.** `systemctl --user restart pier` kills everything
in `pier.service`'s cgroup, so an update script spawned by Pier dies halfway
through — sometimes after unpacking and before restarting, which is the one
outcome worse than not updating.

So installation writes a second unit, `pier-update.service` (backup, `npm
install -g`, stop, and `ExecStopPost` start — `systemctl --user cat pier-update`
shows it), and `pier update` starts it after recording the running service's
effective `PIER_HOME` in a runtime drop-in, so the updater cannot back up one
database and migrate another. Starting the unit directly skips that step and is
unsupported.

Not a `systemd.timer`: the only thing that starts an update is Pier itself,
either on request or under the automatic switch above, so it can drain first.

## Remote access

The unit binds the loopback, and that is the intended posture. To reach it from
elsewhere, pick a tunnel rather than a wider bind:

- `ssh -L 3141:localhost:3141 server` — nothing to configure, nothing exposed.
- Tailscale, or Cloudflare Tunnel — no open port, and TLS terminates outside.
- A reverse proxy (Caddy, nginx) if you want a real hostname. Terminate TLS
  there, preserve the external `Host` (or pass `X-Forwarded-Host`), and pass
  `X-Forwarded-For`; Pier uses the external host for write-origin checks and
  counts login failures per forwarded client. Its session cookie is marked
  `Secure` when a loopback proxy reports `X-Forwarded-Proto: https` (the header
  is ignored from anywhere else, where it is a header the client wrote).

## Backups

Three paths hold everything: `~/.pier/db/pier.db` (tasks, channels, the chat →
session map, workbench state, settings, the password hash, and the sealed
provider credentials and channel tokens), `~/.pier/master.key` (the key that
seals them — without it the database's sealed values are unreadable), and
`~/.pier/boards/`. `~/.pier/db/backups/` holds the automatic pre-update and
pre-migration copies, named for the release or schema they came from.
For off-machine backups, use `sqlite3 ... "VACUUM INTO '…'"` rather than `cp`,
which under WAL can miss the most recent commits. Pi's own session history lives
under `~/.pier/pi` (Pier sets `PI_CODING_AGENT_DIR` there unless the environment
already names another directory).

Inbound chat attachments (photos, uploads from any surface) accumulate under
`~/.pier/inbox/<channel>/` and are never deleted by Pier — a transcript may
reference them indefinitely. Prune old files by hand (or a cron) when disk
matters; a pruned file degrades to a broken attachment link, nothing else.
