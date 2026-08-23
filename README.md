# Pier

A self-hosted workspace for coding agents. Pier puts a web workbench and your
IM channels in front of [Pi](https://github.com/earendil-works/pi) sessions:
you talk to the same agent from a browser, from Slack or from Telegram, steer a
running turn, schedule tasks, watch what every session is doing, and publish a
static page when something is worth showing.

One instance, one account, your own machine. The agent runs shell commands in
directories you name, so Pier is meant for a machine you own and a boundary you
control — not for a shared host.

**Status: pre-release.** The version is `0.0.x` and the database schema is
versioned from `0.0.1` on — earlier databases are not migrated. Read
`docs/deploy.md` before putting it anywhere reachable.

## Requirements

- Node 24 or newer (`node:sqlite` is used unflagged)
- A provider account (Anthropic, OpenAI, …) — configure its API key or OAuth
  login from Console → Settings → Providers after signing in
- A user-writable global npm prefix if `pier update` should update a service
- Optional: the `sqlite3` CLI, for backups and password resets

## Run it

```sh
npm install -g @timqi/pier
pier serve
```

It listens on `127.0.0.1:3141` (`PORT`, `HOST`) and keeps everything under
`~/.pier` (`PIER_HOME`): one SQLite database, the boards it serves, the
`master.key` that seals stored credentials, and the Pi runtime with its
session transcripts (`~/.pier/pi`, unless `PI_CODING_AGENT_DIR` says
otherwise).

**The first start generates a password and prints it once.** Every HTTP surface
is behind it — there is no default password and no unclaimed window. Lost it?
`sqlite3 ~/.pier/db/pier.db 'DELETE FROM auth'` and restart; a new one is printed.

Open `http://localhost:3141`, sign in, then:

- **Console → Settings** — everything the instance is configured with, one
  tab per topic: Providers (API-key/OAuth logins), Models (the menu of
  favored models agents are advised with), Channels (Slack Socket-Mode or
  Telegram bot tokens; chats are discovered when the bot first sees traffic,
  gated by the mention/bind rules you set), Agent files (Pi configuration),
  plus the public URL, password and master key
- **New session** — pick a directory; that is where the agent's shell runs

## Configure Pi

Pier gives Pi a dedicated agent directory instead of changing your normal Pi
installation. By default it is `$PIER_HOME/pi` (`~/.pier/pi`). Set
`PI_CODING_AGENT_DIR` before starting Pier to use another directory, including
an existing Pi setup:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/agent" pier serve
```

Console → Settings is the normal setup path:

- **Providers** configures built-in or custom endpoints and API-key/OAuth login.
  Stored credentials are sealed in Pier's SQLite database; they are not written
  back to `models.json`.
- **Agent files** edits `SYSTEM.md`, `AGENTS.md`, `settings.json`, and advanced
  `models.json` structure in the Pi agent directory — globally, or per project
  scope, where it also shows that project's `.pi/skills` and `.pi/extensions`
  resources. Changes apply when a session next opens; saving here recycles the
  idle ones for you, and **Settings → Instance → Reload** does it for files
  something else changed — an agent, or an editor on the box.

On first credential access, Pier imports an existing `auth.json` into its sealed
store and renames the source to `auth.json.imported`. Literal provider keys left
in `models.json` are moved the same way, with the original retained as
`models.json.imported`. Use Providers for new secrets; the advanced editor will
not accept plaintext keys or header values.

Provider environment variables supported by Pi are inherited from the Pier
process. A service installed with `pier service install` does not inherit your
interactive shell, so put non-secret Pi environment settings in a systemd unit
override; for API keys, prefer the sealed Providers UI.

## Run it as a service

```sh
pier service install     # --port, --host, --pier-home, --force
pier service status
pier service uninstall
pier restart             # drain running work, then restart
pier reload              # re-read channel config and recycle idle sessions
pier backup              # snapshot the database before a manual update
pier update              # latest release, then hard-stop/restart the service
```

`pier restart` refuses new work, waits up to five minutes for active turns and
Task runs, then restarts; if its deadline aborts an IM turn, the next process
tells that conversation. `pier reload` stays in-process: adapters re-read their
configuration and idle, unwatched sessions reopen on their next message.
Streaming or watched sessions keep running and pick changes up after eviction.
Both commands target the installed systemd service. `pier update` is still a
hard stop because its separate updater replaces the installed code; let active
work finish before starting it.

Linux only, because it is systemd. It writes `~/.config/systemd/user/pier.service`
with the absolute path of the node you installed with (systemd's PATH would not
find a version-managed one), a memory drop-in it never rewrites afterwards, and
turns on linger so scheduled tasks survive your logout. Install also records the
exact npm executable in a separate updater unit. Re-run `pier service install
--force` after changing the service settings or its Node/npm installation; this
rewrites both units and restarts Pier. On macOS run `pier serve` in a terminal,
or under whatever supervisor you already use — `pier` on its own only prints
the usage.

`docs/deploy.md` is the same thing written out by hand, plus what the memory
limits mean, how updates work (and why the updater is a second unit), how to
read the first-run password out of the journal, and what to back up.

Exposing it needs two things: a reverse proxy or tunnel that terminates TLS
(Pier binds the loopback and expects `X-Forwarded-For`/`-Proto`), and the
understanding that whoever gets past the password gets a shell.

## Develop

```sh
git clone https://github.com/timqi/pier.git ~/pier
cd ~/pier && npm ci && npm run build

just dev          # build the web bundle, then tsx watch on PIER_HOME=~/.pier_test
npm run check     # tsc, server and web
npm run lint      # oxlint
npm test          # vitest
```

- `AGENTS.md` — the principles this codebase is held to, and the budgets that
  say when a change is too big. Read it before writing code here.
- `docs/architecture.md` — the seams, the areas, and what is deliberately absent
- `docs/design/` — one document per subsystem, written before it was built

## Releases

Pier asks `registry.npmjs.org` at boot and every 30 minutes, and the version
beside the title turns into `v0.0.1 → 0.0.2` when a release is out. Clicking it
opens the panel: the source link, **Update now**, and **Update automatically**.

Nothing here installs anything itself — the work is handed to the second
systemd unit written at install time, because an npm running as a child of the
process being restarted would be killed by that restart. Off systemd there is
nothing to hand it to, so the panel says `pier update` instead.

`pier update` typed in a terminal hard-stops the service. The Console and the
automatic path both **drain first** — new work refused, running turns given
time to finish, whatever the deadline still had to cut off written to the chat
it belonged to — and only then hand over. The automatic path additionally waits
for an idle instance: no turn streaming, no task run in flight.

Either way the updater writes `~/.pier/db/backups/pier.db.release-<version>.bak`
before npm touches the package — named for the release being replaced, which is
the one to reinstall beside it; the three newest are kept. Then it updates the
npm installation recorded when the service was installed, and starts Pier again.

`main` is the only development line. `just release [patch|minor|major]` runs the
checks, writes the tag and pushes it; the tag builds and publishes to npm and as
a GitHub Release. The version in the web footer is the one from `package.json`
— so the number on screen always names a commit.
Schema upgrades are one-way: a database migrated by a newer Pier is refused by
an older one. The release backup above is the way back; `docs/deploy.md` has the
restore procedure and the additional snapshots taken before schema migrations.

## License

[AGPL-3.0-only](LICENSE). Run it, change it, deploy it. If you offer a modified
Pier to other people over a network, they are entitled to your source — the
version in the footer links to this repository for exactly that reason.
