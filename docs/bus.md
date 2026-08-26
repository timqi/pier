# Bus — shared memory and cross-session events

One append-only table (`bus_events`, migration 7) read two ways: `latest(topic,
key)` is shared state between sessions — memory; `log(topic_glob, after)` is a
message stream. They are the same rows, so there is no second bookkeeping to
drift. P2 adds delivery: a write finds its subscribers and each is owed a
pointer notification (`bus_subs` + `bus_notes`, migration 8). P3 adds search
(FTS5), per-topic read stamps, an archive, and the librarian — a cron task,
not core code (migration 9).

## The model's contract

Four operations on the `bus` tool:

- `publish {topic, key?, payload, file_ptr?, scope?, caused_by?, ttl_seconds?}`
  appends an event and returns `{id, scope}`. With `key` the write is a
  **fact** — it overwrites in `get` and may carry a TTL; without one it is a
  plain event, a moment on the stream. Payload is JSON, 8KB max: large content
  goes to a file, whose absolute path rides in `file_ptr`.
- `get {topic, key?}` returns the newest live fact per `(topic, key)` — with
  `key` one value or `null`, without it every live pair on the topic.
- `log {topic_glob, after?, limit?}` returns events after the cursor in write
  order plus the next cursor. Tombstones appear here — a reader syncing state
  needs the deletions too.
- `subscribe {topic_glob, mode?}` asks to be told about writes the caller can
  see; `unsubscribe` stops it; `ack {topic_glob, cursor}` confirms progress —
  `get` and `log` never move a cursor, only `ack` does.
- `search {query, scope?, limit?}` is full-text over topic and payload,
  visible scopes only (`scope` narrows the fence, never widens it), most
  relevant first with newest as the tie-break. Plain FTS5 syntax; a query FTS5
  would reject as syntax (bare hyphens, stray quotes) is retried with each
  token quoted, so plain text always works. The index is a plain FTS5 table
  with its own copy of the text — `bus_events` has a TEXT primary key, and an
  implicit rowid is not stable across VACUUM, so external-content indexing
  could silently drift — kept consistent by triggers, not application code,
  and backfilled by the migration so pre-upgrade events are as searchable as
  the next one. There is deliberately no LIKE fallback: the plan's probe ran
  at implementation time (official Node builds bundle FTS5), and a permanent
  second search path for a hypothetical custom build is exactly the
  speculative generality the budgets forbid — a Node without FTS5 fails at
  boot, in the migration, loudly.
- `topics {}` is the visible inventory: per **(topic, scope)** — archive
  targets one scope, so an aggregate row spanning scopes could name no usable
  boundary — the event count, newest id, newest timestamp (ISO 8601, for age
  arithmetic), and when anyone last read the topic (epoch ms; null = never).
  `get`/`log` stamp `bus_topic_reads` themselves — topic-grained, coalesced to
  the hour, and a poller whose page came back empty still counts: it is
  monitoring the topic (a page *with* events stamps from the rows in hand; only
  the empty poll pays a DISTINCT walk of the topic index). Maintenance reads
  pass `peek: true` and do not count — the librarian's own daily pass must not
  keep every topic eternally "read".
- `archive {topic_glob, before, scope?}` moves matched events with
  `id <= before`, in one scope (explicit, or the caller's narrowest), into
  `bus_events_archive` — out of `get`, `log` and `search`, never deleted; a
  `log {include_archived: true}` still reads them in order, and identity
  survives the move: `caused_by` hop accounting and `ack` cursor validation
  read the union. One scope on purpose — a librarian summarizing into its own
  scope must not take other scopes' history with it — and `before` must name
  a live event there: an arbitrary ceiling would archive the scope whole, live
  facts included, with no restore tool. One accepted gap: run-scoped events of
  a dead run tree resolve for nobody, so nobody can archive them — they stay
  in the live table, invisible to every read, costing only size.
- `forget {topic, key, caused_by?}` writes a tombstone — into the scope where
  the currently visible winner lives, so forgetting a project fact from inside
  a run does not merely mask it until the run ends. Never a `DELETE`: cursors
  must see it, and a future multi-host merge cannot union an absence. A
  reactive forget carries `caused_by` like any other write and counts against
  the hop ceiling.

Events are immutable; a change is a new event. Ids are monotonic ULIDs —
seeded from the newest stored id at boot, so a restart under a clock that
stepped back still only counts up — and `id > cursor` is therefore a correct
incremental read.

## Scope: default narrow, widen explicitly

Every event carries one scope string: `run:<rootRunId>`, `project:<abs cwd>` or
`instance`. A publish without `scope` lands in the caller's run tree when it is
a subagent, else its project; a caller with neither gets an error, not a silent
widening — a leaked blackboard is harder to clean up than a missing one.

Reads see the run trees the caller stands in — the one it is the target of
*and* the active ones it delegated, so a coordinator's `get` on its children's
blackboard is never a silent null — plus its project and `instance`. A
coordinator may also write `scope:'run'` explicitly while it runs exactly one
tree; with several the write is refused as ambiguous rather than guessed.

Under one key, scopes **shadow**, narrow to wide: a live run fact beats a
project fact beats an instance fact, regardless of write order — so a newer
instance write cannot poison a project's own value. Within one scope the
newest write wins and a tombstoned or expired winner does not resurface older
writes; it only lets a *wider* scope's live value show through, which is what
makes forgetting an override reveal the default.

Two declared limits: run scope is **ephemeral** — when the run tree ends,
nothing resolves to it any more and its events await P3's archive rather than
any reader; and because scope membership is resolved per call while a cursor
is just an id, a reader whose scope set grows mid-stream does not see the
older events of its new scope (`id > cursor` never revisits). That is why a
subscription pins its scope set at subscribe time.

Who the caller is — its root run, its delegated trees, its cwd — is not the
bus's knowledge: the tool takes a `BusCaller` resolver, and `main.ts` wires it
from the task store (run trees) and the agent factory (cwds, cached — a
session's cwd never changes). The bus imports neither area.

## Storm guards

All of these live in the store, under every write path, so no future caller
(P2 delivery, P3 librarian) can publish around them — including shape: kind
must agree with key presence (a keyed write is a fact, a tombstone needs a
key), the payload must parse as JSON (one unparseable row would throw for
every reader of every page containing it), `ttl_seconds` needs a fact,
`file_ptr` must be absolute:

- **Hop ceiling.** A publish reacting to a read event names it in `caused_by`;
  the new event's `hops` is the parent's plus one, and past 4 the write is
  refused as a feedback loop. The rule works only if reactions carry the id —
  the tool description says so, and P2's notifications will repeat it.
- **Rate limit.** More than 30 events per minute from one writer on one topic
  is refused. In memory on purpose: it exists to break a storm inside one
  process's lifetime, and a restart resetting it loses nothing.

## One switch for the whole capability

The bus is optional — memory and cross-session delivery are two reads of the
same table, so one setting (`busEnabled`, Console → Settings → Instance,
**off** by default) covers both. It is a capability switch like the Slack
tool's configuration, not an extension: off, the tool is not offered to new
sessions at all (`AgentCustomTool.enabled`, read at session open — a
present-but-refusing tool would waste the model's attention), a session opened
before the flip gets a refusal with the reason as backstop, and delivery
freezes — owed notes keep their attempts and resume on re-enable, nothing is
deleted. The tables stay in the schema either way; empty tables are not
pollution.

## Delivery: notify-then-pull

A publish never carries its payload to anyone. It matches the subscriptions
(pattern GLOB, scope in the sub's pinned set, never the writer itself — its
own transcript already shows the write) and leaves each matched subscriber a
**note**: at most one open per subscription, which *is* the coalescing — a
reader owed a pointer is not owed two, and the count in the text is computed
against the sub's cursor at delivery time, so it is true when read, not when
queued. The notification names the newest event id so a reactive publish can
carry it as `caused_by`; the hop ceiling closes the notify→publish→notify loop.

One accepted risk, recorded rather than hidden: `caused_by` is voluntary. Two
subscribers reacting to each other's topics *without* passing it ping-pong at
`hops=0`, bounded only by the per-writer rate limit (30/topic/minute) — a
sustained loop the ceiling never trips. It is visible (both sessions burn
turns on every surface) and bounded, but not prevented; a per-session wake
budget is P3 material if it ever happens in practice.

Delivery rides the tasks outbox — the one system-input engine with transcript
proof, backoff and a ceiling — as a third `Deliverable` beside run and group
callbacks (the named sideways edge in docs/architecture.md). A note that can
never land is abandoned out loud on the same three surfaces as a task
callback. A subscriber that caught up on its own (log + ack while the note
waited) is settled without being woken for nothing.

Three modes, differing only against a busy recipient: `queue` (default) and
`wake` deliver at the next turn boundary and start a turn when idle — they are
one implementation, `wake` is the name for "I am usually idle, resume me";
`steer` interrupts the running turn, for subscribers who asked to be
interrupted. A steer already handed to Pi rides an in-memory queue until the
next step boundary, where the transcript cannot prove it yet — the engine
treats it as in-flight, not late, so a long tool call is never "undeliverable".

A subscription's `log` reads its **pinned** scopes (an exact `topic_glob`
match), not the caller's live ones: the pointer's count was computed against
the pinned set, and a run-scoped subscriber must be able to drain its backlog
after its run tree ends — with live scopes it would be woken forever for
events its log could no longer show. `ack` takes a real event id, because a
cursor above every real id would silence the subscription with no error
anywhere. Cursors start at the tip: a subscription hears the future, not a
replay of what it could already have read. Scopes are pinned at subscribe time
(the P1 caveat below is why); re-subscribing re-pins them and keeps the cursor.

## The librarian

Daily maintenance is an agent with the same `bus` tool as everyone, not core
code: it distills stable conclusions into facts, archives topics nobody reads,
and writes promotion proposals to `.librarian/proposals/` — proposals only, it
never edits AGENTS.md or anyone's files. Its prompt lives in
`src/bus/librarian-prompt.md`. It is not auto-seeded; create it once, from any
session, with the task tool:

```json
{"operation": "create", "task": {
  "name": "bus-librarian",
  "description": "Daily bus maintenance: distill, archive, propose (docs/bus.md)",
  "trigger": {"type": "cron", "expression": "0 5 * * *", "timezone": "Asia/Shanghai"},
  "action": {"type": "agent", "session": {"mode": "fresh", "cwd": "<project root>"},
             "prompt": "<contents of src/bus/librarian-prompt.md>"},
  "callback": {"type": "none"}
}}
```

The librarian sees the scopes of the cwd it is given (plus `instance`); an
instance with several active projects runs one librarian per project root, or
one in any cwd for `instance`-scoped topics only. Two rules make its runs
safe: a cron/watch/manual *root* run has no run-scope default — a run scope is
a coordination space, and a run nobody delegated has no one standing in it, so
the librarian's unscoped writes would otherwise vanish with the run (main.ts
resolves this; the prompt still demands explicit scopes) — and its archive
summaries are durable keyed facts (`key: "librarian-summary"`), so a run that
dies between summarizing and archiving is finished by the next one instead of
summarized twice.

## The Console view

Console → Bus is the bus's one visible surface, read-only: per (topic, scope)
the live and archived counts, when it last moved and when anyone last read it,
with the live facts expandable underneath; every subscription with its cursor
**lag as a number** against its pinned scopes; the pointer notifications still
owed — pending, failed with their attempts and next retry, and abandoned ones
listed rather than filtered, because a delivery nobody can complete is a
failure and not an absence (AGENTS.md 5b); and the tail of the stream, newest
first, with payload previews as text. It hosts the `busEnabled` switch: off,
the page is the explanation and the toggle, and nothing else — but the tab
itself is always reachable, because hiding it would hide the switch. The
queries behind it (`BusStore.adminTopics/adminFacts/adminTail`,
`SubStore.adminSubs/adminNotes`) carry no scope fence: the fence answers "what
may this *session* see" and the operator has no session — they are the person
who can already open pier.db with sqlite3, and a hidden row here would only
hide a stuck delivery. They also never stamp a read, so looking at the
inventory cannot keep a dead topic looking alive to the librarian. The page
refetches on a coalesced `bus-changed` workspace event (emitted after any
accepted `bus` tool call and on every note lifecycle change), never on a timer.

## What the bus deliberately does not do

No payload in notifications, no embedding, no CRDTs, no transcript mining, no
multi-host sync, no automatic librarian seeding; those are recorded as
non-goals in the plan, not omissions.
