# Running Pier as a service (Linux, systemd)

Pier is one Node process that binds the loopback. Running it in a terminal is
a complete installation — nothing below is required to *use* Pier. What systemd
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

That writes the unit below, enables linger, and starts the service. The rest of
this page is what it wrote and why — read it before widening the bind, and when
you want the unit to say something different.

## Prerequisites

- Node 24 or newer (`node:sqlite` is used unflagged).
- The `sqlite3` CLI, for the off-machine backup and password steps below. Pier
  itself does not need it.
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

`~/.config/systemd/user/pier.service` — what `pier service install` generates,
with your node and your entry point filled in:

```ini
[Unit]
Description=Pier — agent workspace
Documentation=https://github.com/timqi/pier
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
# Absolute paths on purpose: systemd starts with a minimal PATH, so a node
# installed by nvm/fnm/asdf is not on it — the installer fills in the node
# that installed Pier and the globally installed entry point.
ExecStart=/usr/bin/node /usr/lib/node_modules/@timqi/pier/dist/main.js
Environment=NODE_ENV=production
# Loopback by default. Put a reverse proxy in front before widening this —
# whoever reaches this port can drive an agent that runs a shell.
Environment=HOST=127.0.0.1
Environment=PORT=3141
# Where the database, the boards and the generated password hash live.
Environment=PIER_HOME=%h/.pier
Restart=always
RestartSec=2
# The journal is where the first-run password is printed, so keep it readable.
StandardOutput=journal
StandardError=journal
# Otherwise every line is tagged "node"; this makes `journalctl -t pier` work.
SyslogIdentifier=pier

[Install]
WantedBy=default.target
```

Enable it, and tell logind to keep your user manager alive after you log out —
without lingering, every scheduled task stops when your SSH session ends:

```sh
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now pier
```

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

`~/.config/systemd/user/pier.service.d/limits.conf` — a drop-in, so the unit
above stays about what Pier is and this file is about what it may consume:

The limit is on the **whole unit**: `node`, every Pi subagent, and every
command a turn ran, added together — plus the page cache those processes
touched, which is why the soft ceiling should be the one that bites. So size it
as a share of the machine, not as "how much should Pier need". Percentages are
relative to installed physical memory, which also keeps this file portable:

```ini
[Service]
# Soft ceiling: past this the kernel reclaims hard and lets the unit crawl
# instead of killing anything. This is the one that should bite first.
MemoryHigh=60%
# Hard ceiling: the kernel OOM-kills *inside this cgroup*. The number exists to
# protect everything outside it — the OS, sshd, your other services — so what
# it should leave behind is a few GB for them, not a small share for Pier.
MemoryMax=75%
# Swapping an agent is worse than failing it — the machine stops responding
# long before the limit is reached.
MemorySwapMax=0
# A runaway command an agent ran can fork as well as allocate.
TasksMax=512
# The unit's own processes are the preferred victims if the *machine* still
# runs out, e.g. before these limits are tuned. Works with no cgroup limit at
# all, which makes it the cheapest half of this file.
OOMScoreAdjust=200
# A child being OOM-killed must not take the service with it: the turn that
# ran it fails, Pier keeps serving. (Delegated units default to this; set
# explicitly because the default depends on system configuration.)
OOMPolicy=continue
```

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
`channels`, `web`, `auth`, `boards`, `client`, `pier` — so an area is a grep
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
systemctl --user restart pier
```

Changing the password invalidates every session cookie: the cookies are signed
with the stored hash.

## Updating

```sh
pier update           # installs the latest release and restarts the service
pier update --check   # only says whether one exists
```

The workbench footer says the same thing without being asked: the server checks
`registry.npmjs.org` every six hours in the background, and the version turns
into `v0.0.1 → 0.0.2` when there is something newer. A failed check is silent
by design — an offline box is not a broken one.

From a checkout instead:

```sh
cd ~/pier
git fetch --tags && git checkout v0.2.0   # a tag, not a branch
npm ci && npm run build
systemctl --user restart pier
```

A newer Pier brings its own schema up on the next start: the migrations run in
one transaction before the port opens, and the version they leave behind is
stamped in the database. Before touching an existing database it snapshots it
to `~/.pier/db/pier.db.v<N>.bak` (`N` = the schema it was at), so the step you
cannot forget is the one you never take. **Upgrades only.** Start an older Pier
on a database a newer one has migrated and it refuses to run rather than write
tables it does not understand — the way back down is that `.bak`:

```sh
systemctl --user stop pier
cd ~/.pier/db && rm -f pier.db pier.db-wal pier.db-shm && cp pier.db.v1.bak pier.db
# then check out the Pier that speaks schema 1 again
```

The three newest snapshots are kept and older ones removed as later upgrades
supersede them; each is a full copy of the database, so size grows with the
database, not with the number of releases. They sit next to the database and
therefore protect against a bad upgrade, not against a lost disk — an
off-machine copy is still yours to take.

### Can it update itself?

Yes, with one caveat that decides the shape: **the updater must not be a child
of the service it restarts.** `systemctl --user restart pier` kills everything
in `pier.service`'s cgroup, so an update script spawned by Pier dies halfway
through — sometimes after unpacking and before restarting, which is the one
outcome worse than not updating.

So the update runs as its own unit, which is what `pier update` writes and
starts — `~/.config/systemd/user/pier-update.service`:

```ini
[Unit]
Description=Update Pier to the latest published version

[Service]
Type=oneshot
ExecStart=/path/to/npm install -g @timqi/pier@latest
ExecStartPost=systemctl --user restart pier.service
```

Pier can then trigger an update with a single call that survives its own
restart, because the work happens in a different cgroup:

```sh
systemctl --user start pier-update.service
```

Deliberately **not** a `systemd.timer`. An unattended update is a machine that
rewrites its own code from the network while holding your API keys, and it
interrupts whatever session was mid-turn to do it. Pier notices a newer
release and says so in the workbench footer; starting the update stays a
decision someone makes. `Restart=always` above is what makes
that decision cheap — the service comes back on its own.

## Remote access

The unit binds the loopback, and that is the intended posture. To reach it from
elsewhere, pick a tunnel rather than a wider bind:

- `ssh -L 3141:localhost:3141 server` — nothing to configure, nothing exposed.
- Tailscale, or Cloudflare Tunnel — no open port, and TLS terminates outside.
- A reverse proxy (Caddy, nginx) if you want a real hostname. Terminate TLS
  there and pass `X-Forwarded-For`; Pier's login throttle counts per forwarded
  client, and its session cookie is marked `Secure` when the proxy reports
  `X-Forwarded-Proto: https`.

## Backups

Three paths hold everything: `~/.pier/db/pier.db` (tasks, channels, the chat →
session map, workbench state, settings, the password hash, and the sealed
provider credentials and channel tokens), `~/.pier/master.key` (the key that
seals them — without it the database's sealed values are unreadable), and
`~/.pier/boards/`. Copy the database with `sqlite3 ... "VACUUM INTO '…'"`
rather than `cp`, which under WAL can miss the most recent commits. Pi's own
session history lives under `~/.pier/pi` (Pier sets `PI_CODING_AGENT_DIR`
there unless the environment already names another directory).
