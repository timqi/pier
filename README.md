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
- A provider key (Anthropic, OpenAI, …) — set from Console → Configuration
  (Pi's files, kept under `~/.pier/pi`); stored credentials live sealed in
  Pier's database, and a leftover Pi `auth.json` is imported once
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

- **Console → Configuration** — provider keys and model defaults (Pi's files)
- **Console → Channels** — Slack (Socket Mode) or Telegram bot tokens; chats
  are discovered when the bot first sees traffic, and stay gated by the
  mention/bind rules you set
- **New session** — pick a directory; that is where the agent's shell runs

## Run it as a service

```sh
pier service install     # --port, --host, --pier-home, --force
pier service status
pier service uninstall
pier update              # latest release, then restart the service
```

Linux only, because it is systemd. It writes `~/.config/systemd/user/pier.service`
with the absolute path of the node you installed with (systemd's PATH would not
find a version-managed one), a memory drop-in it never rewrites afterwards, and
turns on linger so scheduled tasks survive your logout. On macOS run `pier` in
a terminal, or under whatever supervisor you already use.

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
was mid-flight. `pier update` is a command someone types.

`main` is the only development line. `npm version minor` writes the tag, the
tag builds and publishes a GitHub Release, and the version in the web footer is
the one from `package.json` — so the number on screen always names a commit.
Schema upgrades are one-way: a database migrated by a newer Pier is refused by
an older one, so take the backup `docs/deploy.md` describes before upgrading.

## License

[AGPL-3.0-only](LICENSE). Run it, change it, deploy it. If you offer a modified
Pier to other people over a network, they are entitled to your source — the
version in the footer links to this repository for exactly that reason.
