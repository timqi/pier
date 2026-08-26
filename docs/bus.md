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
- `forget {topic, key}` writes a tombstone. Never a `DELETE`: cursors must see
  it, and a future multi-host merge cannot union an absence.

Events are immutable; a change is a new event. Ids are monotonic ULIDs, so
lexicographic order is time order and `id > cursor` is a correct incremental
read.

## Scope: default narrow, widen explicitly

Every event carries one scope string: `run:<rootRunId>`, `project:<abs cwd>` or
`instance`. A publish without `scope` lands in the caller's run tree when it is
a subagent, else its project; a caller with neither gets an error, not a silent
widening — a leaked blackboard is harder to clean up than a missing one. Reads
see exactly the caller's three: its run tree, its project, `instance`.

Who the caller is — its root run, its cwd — is not the bus's knowledge: the
tool takes a `BusCaller` resolver, and `main.ts` wires it from the task store
(run trees) and the agent factory (cwds). The bus imports neither area.

## Storm guards

Both live in the store, under every write path, so no future caller (P2
delivery, P3 librarian) can publish around them:

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
