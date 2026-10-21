# 28 — `pier search`: replay around a time, and `--in main`

Two changes to `pier search` (`core/search.ts`, `agent/listing.ts`), no new
storage: `session_fts` already holds every message's `session_id`, `role`,
`at` and text, so a time window is one more query on it.

## 1. Replay: `--around <time>`

The case: a hit names the moment but not the answer — the 10-19 BTC fork
split (address `1P8hz…`) hit three scattered messages that compose a wrong
intermediate address. The agent needs to read the exchange in order.

```sh
pier search --around "2025-10-19 14:32"                # the conversation
pier search --around "2025-10-19 14:32" --in <sessionId> --limit 30
```

- `--around` takes the time a hit line prints, `YYYY-MM-DD HH:MM` local
  (`YYYY-MM-DD` is its midnight), so the agent copies it verbatim from a hit.
- It replaces the query: words beside `--around`, or `--since`/`--role`, are
  the usage, exit 2.
- Scope is one place: `--in main` (default, every chain member, merged by
  time) or one session id — a run's, taken from `--json`'s `sessionId` or
  `pier task`. Replaying across unrelated sessions is meaningless, so there
  is no "everything" scope.
- Window: `limit` messages in time order, `floor(limit/2)` before the time
  and the rest at or after it; a short side gives its slack to the other.
  `--limit` 1–50, default 10, refused outside as today. Further back or
  forward is another `--around` on the first or last line's time.
- What is replayed is what `session_fts` holds: user messages and final
  replies — no tool calls, results or intermediate text, as a reply that
  calls a tool is a step (`agent/listing.ts` `saidIn`). A step-level replay
  would read the transcript (`readHistory`) and is not in this change.
- Text: whole message, no cut. Measured on this instance: a main-chain reply
  averages 293 chars (max 2022), a run's 761 (max 16.7k, 2.6% past 4000);
  the worst `--limit 50` is under the bash tool's 50KB output cap.
- Output: the hit line format, oldest first; `--json` prints
  `{hits:[{sessionId, at, role, place, pier, text}]}` — the same shape, one
  printer. Nothing in the window is `no hits`, exit 0.
- Wire: `/search` gains `around` (ms); `SearchScope` gains `around?: number`
  and `search()` with an empty query and `around` set is the replay. One
  route, one host, one seam method.

## 2. `--in main`, `pier` kept as an alias

`pier` names both the product and the conversation. The vocabulary in
`docs/design/10-continuous-session.md` has two layers: the series of
sessions is **the continuous conversation** (`main_chain`, `chain()`), and
its current session is the **main session** (`head` in code and docs only;
in the run tree, the supervisor). `--in` scopes the series, not the current
session, so neither `main session` nor `head` names it exactly; `main` reads
as the main chain, which is what the table is called. So:

- `--in main` is the documented value, glossed in the skill as "the
  conversation, every session of it"; `--in pier` still works, undocumented
  in the skill, so an older memory or script does not break.
- The vocabulary table gains one row — `conversation | the continuous
  conversation: the main session and every session before it (`main_chain`)
  | main session, chain` — so the series has a word. No rename of
  `main_chain`, `chain.ts` or doc 10's title: a repo-wide rename is its own
  change.
- Unchanged: `place` prints `Pier` (the conversation is the one with Pier)
  and JSON keeps `pier: true`; renaming them is a wire change for no reader.

Files: `src/core/search.ts` (argv, host), `src/agent/listing.ts` (query),
`src/core/types.ts` (`SearchScope.around`), `skills/pier-search/SKILL.md`,
`docs/design/08-cli-socket.md` (`/search` row), tests in
`src/core/search.test.ts` and the listing's.
