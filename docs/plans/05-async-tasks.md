# Async task communication (implements design 04, async slice)

Constraint: all cross-session communication is asynchronous and owned by core.
The model-facing tool has no blocking operation; results, group joins, and
decision replies arrive as persisted callbacks. See design 04 §Concurrency and
fan-out, §Supervisor channel.

## Changes by file

1. `types.ts` — `TaskRun.groupId`; new `TaskGroup` (join mode + own callback
   outbox columns); core seam: `task-callback` origin gains optional
   `runIds` for batched delivery dedupe.
2. `store.ts` — `task_groups` table + group CRUD/recovery queries;
   `listRunsByGroup`; `expirePendingMessages` keeps decisions (design:
   decisions survive restart); drop `suppressCallback` (only user was tool
   `wait`).
3. `runs.ts` — `groupId` in provenance.
4. `groups.ts` (new) — create group, `onSettled` join evaluation
   (`all`: every member terminal; `first`: first terminal wins, cancel rest),
   aggregated callback via outbox semantics (busy defer, transcript dedupe on
   group id, backoff, restart recover). Members flagged with
   `pendingDecisionId` in the aggregate.
5. `callbacks.ts` — batch per target session: one combined system input
   drains every pending run callback for that session; per-section run ids in
   origin for dedupe. Deferring for a busy target reschedules without counting
   a delivery attempt (same in `groups.ts`).
6. `messages.ts` — `contact` returns a receipt immediately (replyWaiters,
   waitForReply, reply timeout, background guard deleted); a decision is
   steered into the supervisor, progress follows up; `reply` routes:
   active run → follow-up injection, terminal run → auto-resume with reply as
   prompt calling back to the replier; `openDecision(runId)` helper.
7. `execution.ts` — drop the wait/callback suppression re-read; suppress the
   completion callback when the run ends with an unanswered decision.
8. `service.ts` — wire groups; `cancel` cascades to non-terminal descendants;
   `cancelGroup`; manual `resume` expires open decisions (superseded);
   `waitForRun(s)` stays core-internal (task chaining + HTTP wait route).
9. `tool.ts` — remove `wait` operation and every `wait` param; `run` accepts
   `tasks[]` (draft or `task_id` entries) + `join`; `get`/`cancel` accept
   `run_id` or `group_id`; summaries gain `groupId` + `pendingDecisionId`; the
   draft schema drops `launch.capabilities` (Console/HTTP field only).
10. `routes.ts` — `GET /api/task-groups/:id`; `GET /api/task-runs/:id` adds
    `pendingDecisionId`.
11. `service.test.ts` — rewrite wait-based tests onto callbacks; add group
    all/first, cascade cancel, async decision (suppressed completion callback,
    reply auto-resume, manual resume expiry), batching.
12. `skills/pier-tasks/SKILL.md` — rewrite to the async model after code
    lands.

## Sizes

`service.ts` lands at 316 lines, 16 over the tripwire. Diagnosis: the async
slice adds exactly the surface the design moved into core — group delegates
(runGroup/getGroup/cancelGroup), cascade cancel with the descendant walk, and
the reply→resume hook. Join/aggregation logic itself lives in `groups.ts`
(188); nothing in service is duplicated bookkeeping.

## Second-round live test fixes

The second live round (task tool self-testing, all 11 planned items) found no
broken state machine, but three surface defects worth the diff:

- Waiting on a busy supervisor counted as a delivery attempt, so
  `callbackAttempts` grew once per second (183 in one run) and the failure
  backoff would start at its 60s ceiling. Fixed in `callbacks.ts` / `groups.ts`.
- A decision delivered as a follow-up waited out the supervisor's whole turn
  (minutes), so the supervisor found the question in SQLite first and the queued
  notification arrived already answered. Decisions now steer.
- A model-chosen `launch.capabilities:"read"` child asked to run a command
  narrated the command instead of reporting the missing tool, and the run still
  recorded `succeeded`. The knob left the model-facing schema, and an inline
  draft that still carries it is rejected instead of silently honoured.

The third round (verification) then surfaced one more: a delivered callback
stayed `pending` for as long as the recipient's turn ran, because the seam's
`systemInput` promise settles with that turn rather than on acceptance — and the
same await made a child's `contact` block on its supervisor's whole answer turn.
Runs, groups, and the message ledger now record delivery on hand-off; message
injection is fire-and-forget with a tick sweep (`retryUndelivered`) that retries
failures with backoff and expires controls whose run finished. The seam comment
in `core/types.ts` spells the promise semantics out.

## Out of scope

Progress-message batching (Pi owns the queued-follow-up path today), session
GC for fresh children, Console group UI beyond the HTTP endpoint.
