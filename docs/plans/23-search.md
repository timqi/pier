# Search — the agent's recall, by message

Status: final (lead branch `design-search`), ready to build.

Source: the continuous conversation made the session an implementation detail
(a head rotates every idle hour or 60K tokens, [10](../design/10-continuous-session.md)),
but search still answers with sessions: one hit per session, a hit opens a
session. The user asks Pier, not a search box, so this round removes the
web's ⌘K palette, makes `pier search` the one search surface and moves its
unit to the message. Owner docs to update when the code lands: 03, 06, 08,
10, `architecture.md`, `skills/pier-search`, `skills/pier-help`, CHANGELOG.

## Current state

**Index** (`agent/listing.ts`, `session_fts` in `db.ts`): one FTS5 trigram row
per user message and per assistant reply without tool calls, for every
transcript on disk — chain members, leads, workers, IM threads alike; filled
incrementally by the same scan that lists sessions; steps and system inputs
never. Terms are ANDed inside one message; ≥3 code points → `MATCH` ranked
`bm25`, else `LIKE` ranked by time. Then **one hit per session**, snippet 64
chars around the first match with the matches marked `\u0001…\u0002` for the
palette to paint.

**Surfaces**

| Surface | Today | Gap |
| --- | --- | --- |
| Web ⌘K palette | Pier, Recent, Settings, sessions by name, then a hit as the reason a session is listed | a hit in an earlier chain member opens Pier at its head and never lands; a worker's session is dropped silently; one conversation may fill the list with N member rows |
| CLI `pier search` | one line per session hit, `sessionId · title · role · time: snippet` | the session id names nothing the user knows; 64 chars is too little to answer from; no scope by place, time or speaker |
| IM | none; the head recalls via `pier search` | — |

## Decisions

### 1. One surface: `pier search`, consumed by the agent

The user asks Pier in words; the head runs `pier search` and answers in
words (`DISPATCHER` already names it as the one fact an answer may fetch). No
deep link, no landing: a hit is text to read, not a place to open.

The ⌘K palette goes whole. What it offered elsewhere: the way back to Pier is
the header's `‹`; Settings is the ⋯ menu; a live or waiting session is a
status-panel row; a finished child is reached from its card in the
conversation (callback, `/status`, seed) or a link the head gives. The web
lists no idle sessions by name any more — a session is seen through the
conversation, which is the product's claim. If that is missed, a Recent tail
on the status panel is the smaller thing to add back, not the palette.

**Removal list** (everything whose only reader was the palette or the web's
message search):

| Where | Goes |
| --- | --- |
| `web/ui/palette.ts`, `palette.test.ts` | the files |
| `web/ui/index.html` | the `#palette` dialog block (input, list, keys, count, its `data-icon="Search"`) |
| `web/ui/style.css` | `#palette`, `#palette .palette-row…`, `#palette kbd, #palette-keys`; `.palette-row` itself is **renamed `.list-row`** — the composer's command list and the Files dialog share the selection vocabulary (lines 439–440, 729–738), and a class named after a deleted component is not clean |
| `web/ui/composer.ts` | `palette-row` → `list-row` on the command rows |
| `web/ui/icons.ts` | the `Search` lucide registration (no other `data-icon="Search"`) |
| `web/ui/session-header.ts` | the ⋯ menu's Search item and its `togglePalette`/`chordLabel("k")` import; `session-header.test.ts`'s palette mock and the Search-item test |
| `web/ui/drawer.ts` | the `refreshPalette` import and call; the two comments naming the palette (`‹` row, `shift+p` stands down); mocks in `drawer.test.ts`, `continuous.test.ts`, `main.test.ts` |
| `web/ui/main.ts` | `initPalette` import and its deps block |
| `web/ui/chat.ts` | `revealTurn` (the palette was its only caller; `revealTopic` and `reveal` stay for the status panel) |
| `web/ui/menu.ts`, `views.ts`, `shortcut.ts` | comments that name the palette as a co-reader (`listStep`, `openConsole`, `modalOpen`); the code stays, the composer and panel use it |
| `web/server.ts` | `GET /api/search`; the test in `server.test.ts`; `WebDeps`/the web's factory needs `search` no more |
| `core/search.ts` | the `\u0001…\u0002` flattening; `agent/listing.ts` `around` stops marking |
| `core/types.ts` | `SearchHit`'s "so a surface can mark them" wording |
| docs | 03 §Search palette, `/api/search` route row, ⋯ menu lines (184, 206), the phone's "palette is the ⋯ menu's first item" (196), `palette.ts` in the module list (148), "Rows are the palette's (`.palette-row`…)" (367), "the search hit's ring" (190); 06 "the search palette" (20, 26); 08 `/search`; CHANGELOG entry |

### 2. Seam

`AgentFactory.search(query, scope)` stays the one seam; `agent/` stays blind
to the chain and to presentation.

```ts
// core/types.ts
interface SearchScope {
  limit: number;              // 1–50, the host clamps
  since?: number;             // ms; messages at or after
  role?: "user" | "assistant";
  sessions?: string[];        // only these…
  exclude?: string[];         // …or all but these
}
interface SearchHit { sessionId: string; role: "user" | "assistant"; at: number; text: string }
search(query: string, scope: SearchScope): Promise<SearchHit[]>;
```

- `agent/listing.ts` runs the SQL: the filters are the `UNINDEXED` columns
  `at`, `role`, `session_id`; `sessions`/`exclude` an `IN` list (a chain is
  hundreds of ids at most, under SQLite's parameter cap). Order `bm25` then
  `at DESC` (`LIKE` path `at DESC`). No dedupe. `text` is the message with
  markup off (`plain`, already injected) cut to 600 chars around the first
  match, `…` at a cut; no marks. No schema change.
- `core/search.ts` owns the product: **`searchMessages(factory, chain)`**,
  `chain: () => string[]` the `main_chain` ids (`MainChain.members()`, wired
  in `main.ts`). It runs the Pier pass (`sessions: chain`) and, for what the
  limit still allows, the rest (`exclude: chain`), names each hit's `place`
  (`Pier`, or the session's title via `factory.find`, its id when gone) and
  sets `pier`. Both passes are one `factory.search` each; the host answers
  `{hits}`. The same module keeps the argv (`runSearchCli`).
- Rename: `searchSessions` → `searchMessages`; the socket's `search`
  operation keeps its name and route.

### 3. What a hit carries

- Order: **Pier's messages first, then every other session's**; inside each,
  `bm25` then newest first. The user's recall is almost always the
  conversation; a worker's prompt and result quote the same words and would
  otherwise outrank it. The limit applies to the whole list.
- A hit's **place** is one of two: `Pier` (any `main_chain` member — the
  member id is never shown) or the session's title as it is now.
- One line per hit:
  `<YYYY-MM-DD HH:MM> · <place> · <role>: <text>` — `text` flattened to one
  line. `--json` prints `{hits: [{sessionId, at, role, place, pier, text}]}`,
  `text` unflattened.
- `no hits` and exit 0 when nothing matches; a refusal is one `search:` line,
  exit 1 (08 §Failure lines). Ten hits at 600 chars are ~6K chars of the
  head's context, which is why the default limit drops to 10.

### 4. Scopes

```sh
pier search 部署 --in pier --since 7d
pier search parser regression --role user --limit 5 --json
```

All optional, ANDed:

| Flag | Values | Means |
| --- | --- | --- |
| `--in` | `pier` \| `<sessionId>` | the conversation (every `main_chain` member), or one session |
| `--since` | `<N>h`, `<N>d`, `YYYY-MM-DD` | messages at or after that moment, a date read in local time |
| `--role` | `user` \| `assistant` | the speaker |
| `--limit` | 1–50 | default 10 |

The CLI parses argv and resolves `--since` to ms (CLI and host share a
machine and clock); the host (`/search` params `{q, limit?, since?, role?,
in?}`) validates types and ranges and refuses with one `search:` line.
`--in pier` with `--in <id>` on the same call is a refusal.

### 5. Skill and prompts

`skills/pier-search` rewrites to the message unit: the line shape, the
scopes, "quote the time and the words, never a session id", `--in pier` for
what the user and Pier said, `--since` for "last week". `pier-help`'s recall
line and 10 §Home and memory name `pier search --in pier`.

### 6. Index

Unchanged. A reply that calls tools stays a step and is not indexed; the
final reply is. `memory/` stays `rg`'s.

## Budget

`web/` loses ~400 lines (palette, dialog, css, route, test); `core/` gains
the scopes' argv and the two-pass join, ~40 lines, which is what a search
the agent can aim at a place and a week could not be without.

## Not in this round

- Any web search surface; deep links to a message; a Recent list.
- Indexing tool steps or system inputs; semantic search.
- An IM `/search` command — the head's answer is the better one.

## Worker split (when final)

1. Seam and index: `core/types.ts` `SearchScope`, `agent/listing.ts`
   filters + text cut, `agent/pi.ts` pass-through; `listing.test.ts`.
2. Product: `core/search.ts` `searchMessages` + argv, `main.ts` wiring,
   `socket.ts` doc comment; new `core/search.test.ts`, `socket.test.ts`,
   `cli.test.ts` line shapes.
3. Removal: §1's table, docs 03/06/08, CHANGELOG.
4. `skills/pier-search`, `skills/pier-help`, doc 10.
