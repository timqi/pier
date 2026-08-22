# Running Pier as a service (Linux, systemd)

Pier is one Node process that binds the loopback. Running it in a terminal is
a complete installation — nothing below is required to *use* Pier. What systemd
adds is the thing a terminal cannot: scheduled tasks fire and IM channels stay
connected while nobody is logged in.

That is also why this document is Linux-only. A laptop closes its lid; the
machine you want always-on is a server, and on that machine systemd is already
there.

## Prerequisites

- Node 24 or newer (`node:sqlite` is used unflagged).
- A checkout, built once:

```sh
git clone git@github.com:timqi/pier.git ~/pier
cd ~/pier && npm ci && npm run build
```

The unit below runs the build output, so a deploy is always "update the
checkout, rebuild, restart" — never "run from source".

## The unit

A **user** unit, not a system one: Pier runs as you, reads your Pi
configuration, and drives sessions in your own directories. Running it as root
or as a dedicated system user means an agent that cannot touch the files you
wanted it to work on.

`~/.config/systemd/user/pier.service`:

```ini
[Unit]
Description=Pier — agent workspace
Documentation=https://github.com/timqi/pier
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/pier
# An absolute path on purpose: systemd starts with a minimal PATH, so a node
# installed by nvm/fnm/asdf is not on it. `command -v node` gives you this.
ExecStart=/usr/bin/node dist/main.js
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

## First login

Pier generates a password on an empty database and prints it once, so the
journal is where you read it:

```sh
journalctl --user -u pier | grep -A2 'no password'
```

Only its scrypt hash is stored. If you lose it, drop the row and restart — a
new password is generated and printed:

```sh
sqlite3 ~/.pier/pier.db 'DELETE FROM auth'
systemctl --user restart pier
```

Changing the password invalidates every session cookie: the cookies are signed
with the stored hash.

## Updating

Manually, which is also exactly what an automated update has to do:

```sh
cd ~/pier
git fetch --tags && git checkout v0.2.0   # a tag, not a branch
npm ci && npm run build
cp ~/.pier/pier.db ~/.pier/pier.db.bak    # before any schema change
systemctl --user restart pier
```

### Can it update itself?

Yes, with one caveat that decides the shape: **the updater must not be a child
of the service it restarts.** `systemctl --user restart pier` kills everything
in `pier.service`'s cgroup, so an update script spawned by Pier dies halfway
through — sometimes after unpacking and before restarting, which is the one
outcome worse than not updating.

So the update runs as its own unit. `~/.config/systemd/user/pier-update.service`:

```ini
[Unit]
Description=Update Pier to the latest tag

[Service]
Type=oneshot
WorkingDirectory=%h/pier
ExecStart=/bin/sh -lc 'git fetch --tags && git checkout "$(git describe --tags --abbrev=0 origin/main)" && npm ci && npm run build && cp %h/.pier/pier.db %h/.pier/pier.db.bak'
ExecStartPost=/bin/sh -lc 'systemctl --user restart pier'
```

Pier can then trigger an update with a single call that survives its own
restart, because the work happens in a different cgroup:

```sh
systemctl --user start pier-update.service
```

Deliberately **not** a `systemd.timer`. An unattended update is a machine that
rewrites its own code from the network while holding your API keys, and it
interrupts whatever session was mid-turn to do it. The intended shape is that
Pier notices a newer release and says so (not built yet), while starting the
update stays a decision someone makes. `Restart=always` above is what makes
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

Two paths hold everything: `~/.pier/pier.db` (sessions, tasks, channels, the
password hash) and `~/.pier/boards/`. Pi's own session history lives under its
config directory (`PI_CODING_AGENT_DIR`, `~/.pi/agent` by default).
