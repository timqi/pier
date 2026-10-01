---
name: pier-search
description: Finding what the user and Pier said, or a message in another session, with `pier search`.
---

# Recall from the shell

Use `pier search` when a decision, error or name is not in memory. `--in pier`
searches what the user and Pier said; `--since` narrows a time such as last
week. `memory/` stays `rg`'s.

```sh
pier search parser regression --in pier --since 7d
pier search 部署 --json
```

All flags are optional and ANDed:

| Flag | Values |
| --- | --- |
| `--in` | `pier` or `<sessionId>` |
| `--since` | `<N>h`, `<N>d`, `YYYY-MM-DD` |
| `--role` | `user` or `assistant` |
| `--limit` | 1–50, default 10 |

Pier's messages come first, then other sessions'. One line per message:
`<YYYY-MM-DD HH:MM> · <place> · <role>: <text>`. Place is `Pier` for the
conversation or a session's title. `--json` prints
`{hits:[{sessionId, at, role, place, pier, text}]}`. Nothing found is `no hits`,
exit 0. A `--limit` outside 1–50 is refused, never clamped: one `search:`
line, exit 1. A `--since` or `--role` value off the table, or a second `--in`,
prints the usage, exit 2.

Quote the time and the words, never a session id.
