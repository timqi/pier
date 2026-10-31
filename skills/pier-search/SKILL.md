---
name: pier-search
description: Finding what the user and Pier said, or a message in another session, with `pier search`.
---

# Recall from the shell

Use `pier search` when a decision, error or name is not in memory. `--in main`
searches what the user and Pier said — every chain, every session of each;
`--since` narrows a time such as last week. `memory/` and `chains/*/memory/`
stay `rg`'s. Another chain's matter: `--in chain:<name>` first.

```sh
pier search parser regression --in main --since 7d
pier search 部署 --json
pier search release plan --in chain:design
```

All flags are optional and ANDed:

| Flag | Values |
| --- | --- |
| `--in` | `main`, `chain:<name>` (a unique prefix, any case) or `<sessionId>` |
| `--since` | `<N>h`, `<N>d`, `YYYY-MM-DD` |
| `--role` | `user` or `assistant` |
| `--limit` | 1–50, default 10 |

Your chain's messages come first, then other chains', then other sessions'.
One line per message: `<YYYY-MM-DD HH:MM> · <place> · <role>: <text>`. Place
is the chain's name for a chain's message or a session's title. `--json`
prints `{hits:[{sessionId, at, role, place, pier, chain?: {id, name}, text}]}`.
Nothing found is `no hits`, exit 0. A `--limit` outside 1–50, or a
`chain:<name>` naming no chain or more than one, is refused, never guessed:
one `search:` line, exit 1. A `--since` or `--role` value off the table, or a second `--in`,
prints the usage, exit 2.

## Replay around a hit

When a hit names the moment but not the answer, read the exchange in order:
`--around` takes the time a hit line prints (`YYYY-MM-DD HH:MM`; `YYYY-MM-DD`
is its midnight) and replaces the words — words, `--since` or `--role` beside
it print the usage, exit 2.

```sh
pier search --around "2025-10-19 14:32"
pier search --around "2025-10-19 14:32" --in <sessionId> --limit 30
```

One place only: your chain (default), `--in main` for every chain,
`--in chain:<name>` or one session id, a run's from
`--json`'s `sessionId` or `pier task`. `--limit` messages in time order, half
before the time and the rest at or after it, a short side giving its slack to
the other; each message whole, oldest first, the same line and `--json` shape.
Only what was said is replayed — user messages and final replies, no tool
calls. Further back or forward is another `--around` on the first or last
line's time.

Quote the time and the words, never a session id.
