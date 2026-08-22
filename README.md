# Pier

A self-hosted workspace for coding agents. Pier puts a web workbench and your
IM channels in front of [Pi](https://github.com/earendil-works/pi) sessions:
you talk to the same agent from a browser, from Slack or from Telegram, steer a
running turn, schedule tasks, watch what every session is doing, and publish a
static page when something is worth showing.

One instance, one account, your own machine. The agent runs shell commands in
directories you name, so Pier is meant for a machine you own and a boundary you
control — not for a shared host.

**Status: pre-release.** The version is `0.0.x`, there is no npm package yet,
and the database schema is versioned from `0.0.1` on — earlier databases are
not migrated. Read `docs/deploy.md` before putting it anywhere reachable.

## Requirements

- Node 24 or newer (`node:sqlite` is used unflagged)
- A Pi provider key (Anthropic, OpenAI, …) — Pi's own config, in
  `~/.pi/agent/settings.json`, editable from Console → Configuration
- Optional: the `sqlite3` CLI, for backups and password resets

## Run it

```sh
git clone https://github.com/timqi/pier.git ~/pier
cd ~/pier
npm ci && npm run build
node dist/main.js
```

It listens on `127.0.0.1:3141` (`PORT`, `HOST`) and keeps everything under
`~/.pier` (`PIER_HOME`): one SQLite database and the boards it serves.

**The first start generates a password and prints it once.** Every HTTP surface
is behind it — there is no default password and no unclaimed window. Lost it?
`sqlite3 ~/.pier/pier.db 'DELETE FROM auth'` and restart; a new one is printed.

Open `http://localhost:3141`, sign in, then:

- **Console → Configuration** — provider keys and model defaults (Pi's files)
- **Console → Channels** — Slack (Socket Mode) or Telegram bot tokens; chats
  are discovered when the bot first sees traffic, and stay gated by the
  mention/bind rules you set
- **New session** — pick a directory; that is where the agent's shell runs

## Run it as a service

`docs/deploy.md` is the whole story for Linux: a systemd user unit with
`Restart=always` and linger, memory limits that protect the machine rather than
the service, how updates work (and why the updater is a second unit), how to
read the first-run password out of the journal, and what to back up. macOS has
no recipe — run it in the foreground.

Exposing it needs two things: a reverse proxy or tunnel that terminates TLS
(Pier binds the loopback and expects `X-Forwarded-For`/`-Proto`), and the
understanding that whoever gets past the password gets a shell.

## Develop

```sh
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

`main` is the only development line. `npm version minor` writes the tag, the
tag builds and publishes a GitHub Release, and the version in the web footer is
the one from `package.json` — so the number on screen always names a commit.
Schema upgrades are one-way: a database migrated by a newer Pier is refused by
an older one, so take the backup `docs/deploy.md` describes before upgrading.

## License

[AGPL-3.0-only](LICENSE). Run it, change it, deploy it. If you offer a modified
Pier to other people over a network, they are entitled to your source — the
version in the footer links to this repository for exactly that reason.
