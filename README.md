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
pier
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
PI_CODING_AGENT_DIR="$HOME/.pi/agent" pier
```

Console → Settings is the normal setup path:

- **Providers** configures built-in or custom endpoints and API-key/OAuth login.
  Stored credentials are sealed in Pier's SQLite database; they are not written
  back to `models.json`.
- **Agent files** edits `SYSTEM.md`, `AGENTS.md`, `settings.json`, and advanced
  `models.json` structure in the Pi agent directory — globally, or per project
  scope, where it also shows that project's `.pi/skills` and `.pi/extensions`
  resources. Changes apply to new sessions.

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
pier backup              # snapshot the database before a manual update
pier update              # latest release, then restart the service
```

Linux only, because it is systemd. It writes `~/.config/systemd/user/pier.service`
with the absolute path of the node you installed with (systemd's PATH would not
find a version-managed one), a memory drop-in it never rewrites afterwards, and
turns on linger so scheduled tasks survive your logout. Install also records the
exact npm executable in a separate updater unit. Re-run `pier service install
--force` after changing the service settings or its Node/npm installation; this
rewrites both units and restarts Pier. On macOS run `pier` in a terminal, or
under whatever supervisor you already use.

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

Pier checks `registry.npmjs.org` in the background and shows `v0.0.1 → 0.0.2`
in the footer when a release is out. It never updates itself: this process
holds provider keys and can run a shell, so rewriting its own code on a timer
would be a supply-chain surface — and an unattended restart kills whatever turn
was mid-flight. `pier update` is a command someone types. It stops the service,
writes `~/.pier/db/pier.db.release.bak`, updates the npm installation recorded
when the service was installed, and starts Pier again.

`main` is the only development line. `npm version minor` writes the tag, the
tag builds and publishes a GitHub Release, and the version in the web footer is
the one from `package.json` — so the number on screen always names a commit.
Schema upgrades are one-way: a database migrated by a newer Pier is refused by
an older one. The release backup above is the way back; `docs/deploy.md` has the
restore procedure and the additional snapshots taken before schema migrations.

## License

[AGPL-3.0-only](LICENSE). Run it, change it, deploy it. If you offer a modified
Pier to other people over a network, they are entitled to your source — the
version in the footer links to this repository for exactly that reason.
