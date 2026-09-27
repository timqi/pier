---
name: pier-search
description: Earlier sessions by what was said in them with `pier search` — every user message and reply Pier has, across all sessions. Read before looking for something said in an earlier session that memory does not hold.
---

# Earlier sessions from the shell

For something said in an earlier session — a decision, an error, a name —
that `MEMORY.md` and the daily notes do not hold. `memory/` is `rg`'s, not
this; tool steps are never indexed, only messages and replies.

```sh
pier search the parser regression --limit 5
pier search 部署 --json
```

- The words are the query: every one must appear in the same message, in
  any order. `--limit` 1–50, default 20; at most one hit per session, best
  first.
- One line per hit:
  `<sessionId> · <title> · <role> · <YYYY-MM-DD HH:MM>: <snippet>`;
  `--json` prints `{hits}` instead. Nothing found is `no hits`, exit 0; a
  refusal is one `search:` line, exit 1.
- A hit names a session: the web opens it at `/app/#/session/<id>`; link
  that for the user rather than pasting the transcript.
