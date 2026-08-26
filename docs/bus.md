# Bus — shared memory and cross-session events

One append-only table (`bus_events`, migration 7) read two ways: `latest(topic,
key)` is shared state between sessions — memory; `log(topic_glob, after)` is a
message stream. They are the same rows, so there is no second bookkeeping to
drift. Delivery (write-triggers-notify) is P2; search and the librarian are P3.
This page covers P1: the table, the store, and the `bus` tool.

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
older events of its new scope (`id > cursor` never revisits). P2 must pin a
subscription's scope set at subscribe time or keep one cursor per scope.

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

## What P1 deliberately does not do

No delivery — a session learns of new events by reading, until P2 adds
subscriptions over the tasks outbox. No search, no distillation — P3. No
embedding, no CRDTs, no transcript mining, no multi-host sync; those are
recorded as non-goals in the plan, not omissions.
