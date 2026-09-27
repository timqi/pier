# Planned leftovers (this change only; delete this file when merged)

What 0.2.0 and the child-threads merge (b5f4f5c) planned and did not build,
plus the small defects found since, as one build: scope, the approach per
item, the order, what is dropped, and how the three unverified surfaces get
verified. Contracts land in the docs that own them
([08](08-cli-socket.md), [10](10-continuous-session.md),
[11](11-im-conversation.md)); this file holds only the plan.

## Scope

| # | Item | Kind | Where |
| --- | --- | --- | --- |
| 1 | Seed cuts | planned, 11 §Build plan | `core/chain.ts` `seed` |
| 2 | `pier search` | planned, 11 §Build plan; 08 already documents the route | `src/socket.ts`, `src/cli.ts`, `skills/pier-search/SKILL.md`, `agent/roles.ts`, `skills/pier-help` |
| 3 | Doc reconcile | planned | 10 §Not built, 11 §Build plan, CHANGELOG |
| 4 | `slack.ts` over the 450 ceiling (458) | defect (Budgets 5) | `channels/slack.ts` → `channels/slack-thread.ts` |
| 5 | Failed custom-tool install shows `binary.error: null` | defect (§5) | `src/tools.ts` `status` |
| 6 | Reload after a failed turn hides the prior answer's buttons | defect | `web/ui/chat.ts` `renderSnapshot` |
| 7 | >1000 path candidates → `400`, every ref goes plain | defect (§5) | `web/ui/attachments.ts` `checkAsked` |
| 8 | `openItems` reads the ledger once per lead | defect (perf) | `tasks/open-items.ts` |
| 9 | Live verification: Slack home + child threads, Lark child threads, iOS web | unverified | a checklist, run by the user |

Found by the audit, added: the CHANGELOG has no Unreleased line for child
threads (folded into 3); `agent/roles.ts` `DISPATCHER` says recall is `rg`
over the session directory, which `pier search` replaces (folded into 2);
`AgentFactory.search` takes no `limit`, which the route needs (folded into 2).
Nothing else in `docs/design` is planned and unbuilt: 04 §Deliberately not
features and 07 §Not in scope are decisions, not gaps.

## Approach per item

### 1. Seed cuts

`seed` runs each part through `cut` (`core/reply.ts`) at 10 §Head lifecycle's
budgets: `MEMORY.md` 12K, each day's notes 6K, the exchanges 4K, the ledger 4K
after joining newest-first (so the oldest lines go; the ellipsis is the mark).
`## Open` is untouched — its own rule bounds it. The budgets are constants
beside `EXCHANGES`, not options.

Test (`core/chain.test.ts`): a 100K `MEMORY.md` seeds under 13K chars ending
in `…`; a 300-line ledger keeps its newest lines.

### 2. `pier search`

- `AgentFactory.search(query, limit?)` passes `limit` through to
  `listings.search` (which already takes one; `core/types.ts` seam change,
  additive).
- `src/socket.ts`: route `/search` via `operation("search")` — `q` trimmed,
  empty → `422`; `limit` an integer clamped to 1–50, default 20; each hit
  joined to `find(hit.sessionId)?.title` at answer time, `sessionId` when the
  session is gone. `SocketHosts.search` is the host.
- `src/cli.ts`: verb `search <q…> [--limit N] [--json]`, one line per hit
  `<sessionId> · <title> · <role> · <YYYY-MM-DD HH:MM>: <snippet>`, `no
  hits` exit 0, `search: …` exit 1 per 08 §Failure lines.
- `skills/pier-search/SKILL.md`, `pier-web`'s shape, under 30 lines: when
  (something said in an earlier session, not in memory), the argv, the line
  format, that a hit names a session the web opens at `/app/#/session/<id>`,
  and that `memory/` is `rg`'s, not this. `main.ts` registers it beside the
  other built-in skills.
- `agent/roles.ts` `DISPATCHER` recall line names `pier search` for the
  transcripts; `skills/pier-help/SKILL.md` puts `pier search` beside `rg`
  under recall.

Tests: `socket.test.ts` (empty `q` 422, `limit` clamped, title joined),
`cli.test.ts` (one line per hit, `no hits`, `--json`).

### 3. Doc reconcile

- 10 §Not built: the run-card thread item goes; what remains of it is already
  11 §Not built's first bullet (a thread for any other child). The "Out of
  this design" bullet stays.
- 11 §Build plan: deleted.
- CHANGELOG Unreleased › Added: child threads — a design lead's question
  opens a thread in the home DM bound to its session, the root edited on
  final/failed; and `pier search`.

### 4. `slack.ts` under the ceiling

`sharedBlock` and `sharedThread` (~75 lines) render a forwarded message into
prompt text — the reason `slack-thread.ts`'s header already names. They move
there as exported functions taking `directory`, `api` and a `log`; `slack.ts`
keeps the call. No new file, no behaviour change; `slack.ts` lands near 385,
`slack-thread.ts` near 120. Existing `slack.test.ts` share cases cover it.

### 5. Custom-tool install failure surfaces

`ManagedTools.status` answers `binary.error: null` for a tool `ubix list
--json` never mentions — which is what a tool that failed to install looks
like. The sync report has the reason; the catalog does not. Fix: `sync`
retains its last `ToolSyncReport` on the instance; `status` fills `error` for
a row with no ubix state from the last sync's entry of that name (`missing`
→ that entry's `error`, else `not installed — the last sync did not reach
it`). No new store: the tools task's run history remains the record; this is
the row saying why.

Test (`tools.test.ts`): a sync whose ubix JSON marks a tool `failed` leaves
`status()` reporting that error on the row.

### 6. Buttons survive a failed turn on reload

`renderSnapshot` picks `lastAssistant` as the last assistant turn; a failed
turn is an assistant turn with `error` and no text (`agent/events.ts`), so it
wins and the prior answer loses its row — while the live view kept it. Fix:
`lastAssistant` is the last assistant turn with text and no `error`. Live
and reload then agree.

Test (`web/ui/chat.test.ts` or the snapshot test that exists): an
`[assistant with buttons, user, assistant{error}]` snapshot renders the
buttons on the first.

### 7. Path checks in slices

`checkAsked` posts every pending path in one request; past 1000 the route
answers `400` and the whole batch goes plain. Fix: the client slices the
batch into requests of ≤1000 (the route's bound, a constant in
`attachments.ts` whose comment names `fs.ts`; `web/types.ts` carries no
values), awaited together; a slice that fails leaves its own paths plain and reports
once. The route is unchanged.

Test (`web/ui/attachments.test.ts`): 1500 paths → two requests; the second
failing plains only its half.

### 8. One ledger read for every lead

`withWorkers` calls `tasks.ledger([lead])` per lead run, and `roleOf` per
run. Fix: `openItems` reads the lead set once (`TaskStore.leads`, already
there) and one `ledgerRuns` over every lead session in the item set, grouped
by `invokedBySessionId`; `withWorkers` looks up the group. `OpenItemReads`
gains `store.ledgerRuns` and `store.leads`, loses `roleOf`. Same output.

Test (`tasks/open-items.test.ts`): a spy counts one `ledgerRuns` call for
three leads.

### 9. Verification plan (the user runs it; the lead writes the checklist)

Chromium emulation counts for none of these. Each line is one observable;
a miss is a defect item filed in this doc, not fixed silently.

Slack, home DM (conversation mode):
- A top-level message gets 👀, the head's reply lands in the main flow with
  its footer; the web timeline shows the same turn, no push, no unread mark.
- `/status` and `%status` answer as a `/status` note; `/settings` is prose.
- Next-step buttons on a main-flow reply: a tap echoes `▸ <label>`
  top-level and retires the row.
- Ask the head to launch a design lead (`--design`): its first question
  appears as a thread under `▷ <name> · design — waiting for you`; replies
  in the thread reach the lead; `[Finalize design]` from the thread edits the
  root to `✓ … design final`, and the head's callback note appears in the
  main flow; the web lists the lead's session with `channel: slack`.
- Disable Slack in the Console: the next head reply pushes to the web.

Lark, child threads: the design-lead line above, on Lark (root is a card,
`root_id` binds the topic), plus a lead whose run fails edits the root to
`⚠ … — <error>`.

iOS Safari, web (as an installed Home Screen app and in the browser):
- The bar, drawer and status panel open and close by touch; the composer
  keeps the keyboard's safe-area inset; `/` completion is tappable.
- A next-step button tap sends; a failed turn shows its error row and the
  prior buttons stay after reload (item 6).
- Web Push arrives once the app is on the Home Screen and stops while the
  home DM is live.
- A `file://` image thumbnail opens; a path link opens the file dialog.

Result: each line marked pass/fail with device and app version, kept in the
commit that closes this doc, not in the docs.

## Order

1. Items 6, 7, 8, 5 — one worker each or paired (6+7 web, 5+8), `balanced`;
   independent, small, all tested.
2. Item 4 — one worker, `balanced`; touches only Slack.
3. Items 1 and 2 — one worker, `balanced`; 2 is the largest and the only
   seam change (`AgentFactory.search`).
4. Item 3 — the lead, after 1–3 merge; the CHANGELOG line names what landed.
5. Item 9 — the lead writes the checklist into the milestone reply; the user
   runs it after the release that carries 1–8.

## Dropped

- The run-card thread for build leads and workers (10 §Not built): stays
  unbuilt, named once in 11 §Not built.
- A thread opened later for a design that waited without a home: unbuilt, in
  11 §Not built.
- Raising the `slack.ts` ceiling: the shared-message renderer has a file
  whose reason it is; nothing in the adapter argues for 458.
- A server-side bound above 1000 for `/api/fs/exists`: the bound is fine;
  the client's batching was the bug.

## Budgets

`core/` +~10 (item 1); root `src/*.ts` +~50 (the route, the verb, the
retained sync report); `channels/` net 0 (a move); `web/` +~10; `tasks/`
net ~0. No ceiling crossed; `slack.ts` returns under its own.
