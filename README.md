# Pier

A self-hosted workspace for coding agents. Pier puts a web workbench and your
IM channels in front of [Pi](https://github.com/earendil-works/pi) sessions:
talk to the same agent from a browser, Slack or Lark, steer a running
turn, schedule tasks, watch every session, and publish a static page when
something is worth showing.

One instance, one account, your own machine. The agent runs shell commands in
directories you name — meant for a machine you own, not a shared host.

**Status: pre-release.** Releases may still change behaviour and the
database schema between versions; schema upgrades are one-way. Read
`docs/deploy.md` before putting it anywhere reachable.

## Requirements

- Node 24 or newer (`node:sqlite` is used unflagged)
- A provider account (Anthropic, OpenAI, …) — configure its API key or OAuth
  login from Console → Settings → Models after signing in
- A user-writable global npm prefix if `pier update` should update a service
- Optional: the `sqlite3` CLI, for backups and password resets

## Run it

```sh
npm install -g @timqi/pier
pier serve
```

It listens on `127.0.0.1:3141` (`PORT`, `HOST`) and keeps everything under
`~/.pier` (`PIER_HOME`): one SQLite database, the boards it serves, the
`master.key` that seals stored credentials, the conversation's memory
(`~/.pier/home`), and the Pi runtime with its session transcripts
(`~/.pier/pi`, unless `PI_CODING_AGENT_DIR` says otherwise).

**The first start generates a password and prints it once.** Lost it?
`sqlite3 ~/.pier/db/pier.db 'DELETE FROM auth'` and restart. Open
`http://localhost:3141`, sign in; **Console → Settings** has Models, Agent,
Channels, Vault, Tasks, Boards, Instance (public URL, accent, notifications,
reload) and Security (master key, password, passkeys, signed-in devices).

## How the conversation works

The web chat is one conversation, named Pier. Its current session — the head —
answers, remembers and dispatches; it runs in `~/.pier/home`, which holds
memory only: `MEMORY.md` (one-line facts) and daily notes in
`memory/YYYY-MM-DD.md`.

- Real work is delegated with `pier task run`: a worker for a small task, a
  lead for a feature, which designs with you or builds with its own workers.
  Each is its own session; its result comes back to the head as a callback.
- After an idle hour, or past 60K tokens, the next message starts a fresh
  head, seeded with the memory, the open items, recent runs and the last
  exchanges. The old transcripts stay readable.
- `/status` lists what is open, `/new` starts a fresh head now, `/stop` stops
  the reply in progress, `/skills` lists the skills. `%` works in place of
  `/` (`%status`), because Slack's client eats an unregistered `/`.
- One IM DM, on Lark or Slack, can be the conversation: Console → Settings →
  Channels, the DM's row, "This DM is the conversation". The head then
  answers there, from the phone; other chats keep one session per thread.

## Configure Pi

Pier gives Pi its own agent directory, `$PIER_HOME/pi` by default; set
`PI_CODING_AGENT_DIR` to use another, including an existing Pi setup:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/agent" pier serve
```

Pier exports that variable, so anything it starts inherits it. A second Pier
launched from there with its own `PIER_HOME` derives its own agent directory
unless `PI_CODING_AGENT_DIR` is set again on that command line.

Console → Settings:

- **Models** — endpoints, API-key/OAuth login, pinned models. Credentials are
  sealed in Pier's SQLite database, never written back to `models.json`.
  **Test** sends one real request and shows the body as sent and the reply.
- **Agent** — edits `SYSTEM.md`, `AGENTS.md` and the `models.json`
  structure, globally or per project scope (with that project's
  `.pi/skills` and `.pi/extensions` listed); `settings.json` is Pier's and
  shown read-only. Changes apply when a session next opens; saving recycles
  idle sessions; **Settings → Instance → Reload** does the same for files
  changed elsewhere. Also here: packages (Pi's registry, **Add package**),
  Pier's own skills as the built-in `pier` package (`pier web search|fetch`
  reaches the web through the provider's hosted tools — Anthropic or OpenAI,
  no key of your own), **Browse files**, and the managed CLI tools (`rtk`, `rg`, `fd`, `wt`, `jq`, or your own as a
  [ubix](https://github.com/timqi/ubix) block), installed into
  `~/.pier/tools/bin`, first on every session's PATH beside the `pier` shim
  Pier writes there at start.
- **Vault** — named secrets an agent's commands receive through `pier vault
  run` without the value entering its context (`docs/design/07-vault.md`);
  `pier slack` and `pier task` reach the running Pier the same way
  (`docs/design/08-cli-socket.md`).

On first credential access an existing `auth.json` is imported into the sealed
store and renamed `auth.json.imported`; literal keys in `models.json` likewise
(`models.json.imported`). The editor rejects plaintext keys or header values.
Pi's provider environment variables are inherited from the Pier process; a
systemd service does not inherit your shell, so put non-secret settings in a
unit override and API keys in Settings → Models.

## Run it as a service

```sh
pier service install     # --port, --host, --pier-home, --force
pier service status
pier service uninstall
pier restart             # drain running work, then restart
pier reload              # re-read channel config and recycle idle sessions
pier backup              # snapshot the database before a manual update
pier update              # latest release, then hard-stop/restart the service
pier tools sync          # install/update the managed CLI tools by hand
```

Linux only (systemd); on macOS run `pier serve` under your own supervisor.
`docs/deploy.md` is the runbook: units, memory limits, updates and rollback,
the first-run password, remote access, backups. Expose it only behind a
TLS-terminating proxy or tunnel (`X-Forwarded-For`/`-Proto`) — whoever gets
past the password gets a shell.

## Develop

```sh
git clone https://github.com/timqi/pier.git ~/pier
cd ~/pier && npm ci && npm run build

just dev          # build the web bundle, then tsx watch on PIER_HOME=~/.pier_test
npm run check     # tsc, server and web
npm run lint      # oxlint
npm test          # vitest
```

- `AGENTS.md` — the principles and budgets this codebase is held to
- `docs/architecture.md` — the seams, the areas, and what is deliberately absent
- `docs/design/` — one document per subsystem

## Releases

Pier asks `registry.npmjs.org` at boot and every 30 minutes; the version in
the Settings header turns into a badge when a release is out (`Pier <version>
is out`) and opens a panel: source link,
**Update now**, **Update automatically** (idle instance only). Both drain first
and hand the install to the updater unit; off systemd the panel says `pier
update`. The updater writes `~/.pier/db/backups/pier.db.release-<version>.bak`
(the release being replaced; three kept) first. Schema upgrades are one-way;
`docs/deploy.md` has the rollback.

`main` is the only development line. `just release [patch|minor|major]` checks,
tags and pushes; the tag builds and publishes to npm and a GitHub Release. The
version shown is `package.json`'s.

## License

[AGPL-3.0-only](LICENSE). Run it, change it, deploy it. If you offer a modified
Pier to other people over a network, they are entitled to your source — the
version in the Settings header links to this repository for exactly that reason.
