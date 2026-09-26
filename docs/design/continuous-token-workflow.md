# Continuous conversation — token cost and workflow

Design for one build: what changes in the continuous conversation
([10](10-continuous-session.md)) so a day of use costs fewer tokens and fewer
round trips. The build folds every rule below into 10, `roles.ts` and the
`pier-tasks` skill, then deletes this file.

## Measured

The one head so far (2026-09-26, 12 user messages, transcript usage):

| | |
| --- | --- |
| model calls | 53 — 32 of them main's own tool calls (29 `bash`) |
| cache read / write / uncached / output | 1.67M / 48K / 150 / 13.7K tokens |
| context at the end | 50K; compaction (100K) never fired |
| prefix on open (system prompt + seed) | 6.7K, written once |

- Prompt caching already hits ~100%: the system prompt has no clock, menu or
  ledger in it; every input appends. Nothing to fix, invariants to keep (§Cache).
- A call costs its whole context as a cache read, so the day's cost is
  `calls × context`. Both factors are ours: 4.4 calls per user message, 60% of
  them main working instead of dispatching; a context that only grows until
  compaction.

## Changes

### 1. Rotate on size — `core/`

- `CHAIN_FULL_TOKENS = 60_000` beside `CHAIN_IDLE_MS` (`core/types.ts`);
  `ChainReason` gains `full`.
- `MainChain.current` checks it after idle: a head whose `contextUsage.tokens`
  is past the ceiling rotates before the message, reason `full`; `null`
  (right after a compaction) and a streaming head never rotate.
- The seed is the idle seed; `WHY.full` reads "the previous one reached 60K
  tokens"; the web divider (`DIVIDER`, `web/ui/main.ts`) and the origin
  validator (`agent/events.ts`) accept the reason.
- The head's compaction cap (100K) stays as the backstop: only a user message
  rotates, so a head fed by callbacks alone can still grow past 60K.

Why 60K: a turn at 60K costs ~6K uncached-equivalent; a rotation costs one
~7K cache write and pays back within three turns. Compaction would cost one
uncached 100K read plus a summary main did not write; rotation replaces it with
the memory main did write.

Risk: a discussion longer than three exchanges that main did not note is cut
at the rotation. The seed's last-exchange count stays 3; the dispatcher's
note rule (§2) is the carry.

### 2. Fewer main calls per message — `DISPATCHER`, `agent/roles.ts`

Three rules replace the current answer/dispatch line and "write a note when a
callback settles":

- Before the first tool call on a message, decide: answer from what is in
  context, or dispatch. One command may answer; a second command means a
  worker.
- A callback is the ledger's and the transcript's record already: it writes no
  note. A note records a decision, or a fact the ledger does not hold.
- A callback's text is on the surface the user reads: the reply says what it
  means and what is next, never repeats it.

### 3. Terse results — the run preamble, `tasks/agent.ts`

One sentence in the preamble every delegated run opens with, so the rule needs
no repeating in prompts: *Return the conclusion and the paths it rests on — no
process, no log of attempts; a deliverable longer than a screen goes to a file
the result names.* Callback truncation (8 000 chars) is unchanged.

### 4. Model by tier — `DISPATCHER`, the menu's notes

The operator's menu notes carry a tier word; the dispatcher picks by tier,
thinking follows the pin:

| Work | `--model` |
| --- | --- |
| lead; design, architecture, review of a hard change | `hardest` |
| coding a feature or a fix; integration | `balanced` |
| research, summaries, lookups, transcripts, bulk mechanical edits | `cheap` |

- The lead line becomes `--model hardest --thinking high`.
- Never `--model ?` per message: a word that matches no pin, or two, is a
  refusal that prints the menu — the dispatcher picks from that.
- One pin per tier word: `resolveModel` keeps refusing on several hits, so a
  second balanced pin needs a note of its own (`gpt reviewer`).
- Main runs on the instance default model; 10 §Roles says to pin it balanced.
- `pier-tasks` §Model choice names the three words.

### 5. Seed ledger, one line per run — `core/chain.ts`

`<runId> · <name> · <state> · session <id> · <cwd>` instead of a JSON object
per run: the same fields the dispatcher uses (`--run`, `--session`), a third
of the tokens.

### 6. Context shown against the compaction point — `core/types.ts`, `web/ui/session-header.ts`

`ContextUsage` gains `compactAt` (the window minus the session's reserve: 100K
for a head, 150K for a lead or worker, the instance's for any other session),
and the header prints `used/compactAt` instead of `used/window` — `50K/100K`
rather than `50K/1000K`, so the number shown is the distance to compaction (or,
for a head, past the `full` ceiling). `contextWindow` stays on the seam for
the percentage.

### Caps stay: home 100K, lead and worker 150K

A design session consuming 300–500K tokens is a *cumulative* figure; the cap
bounds what is *in the context at once*. A lead at 150K reaches 500K spent
long before it compacts, because every call re-reads its whole context.

- 1M-context models price input and cache reads 2× above 200K in the
  context; a turn at 300K costs ~4× a turn at 150K (double the tokens at
  double the rate), and quality degrades past 200K.
- The lead's state is its doc by contract, so compaction loses nothing the
  build needs; the summary plus the doc is what a lead resumes from anyway.
- Not split by role: a worker at 150K and a lead at 150K compact for the same
  reason (§`CHILD_COMPACTION_CAP`); a second constant needs a second reason.

Room to move without crossing the price tier: 150K → 180K for children, if
compaction proves too frequent in a week of use; measured, not assumed.

### 7. A lead stays in the rail for its life — `web/`

A lead whose turn ended is waiting on the user, not idle: today it is listed
only while `unread` (an attention flag, cleared by looking) or running, so the
design conversation vanishes from "In progress" the moment the user has seen
it — and the user falls back to relaying through main, the path 10 §Roles says
main is not in.

- `SessionInfo` gains `role?: "lead"` (`web/server.ts`, from
  `TaskStore.roleOf`); `inProgress` (`web/ui/sidebar.ts`) keeps every lead,
  live or not; its idle dot reads "lead — waiting for you".
- A lead leaves the rail when its session is deleted: a feature has no
  machine-readable end, so the operator closes it.

### 8. A lead reports milestones only — `tasks/`

A `--role lead` run's every turn end is a callback to main today, its first
proposal to the user included: a main turn spent on what the user reads in the
lead's session. Decided when the run finishes:

- the callback fires when the run was a milestone resume (`resumePrompt`
  headed by `MILESTONE`) or its result carries a `Design final:` line;
- otherwise the run settles with no callback owed, as `--callback none`
  does, the reason on the run's record ("a lead's turn, not a milestone") so
  the Console says why nothing reached main.

### 9. A cross-session follow-up is visible where it waits — `web/`, `tasks/`

`pier task run --run <id> --after` parks a `follow_up` task message in the
outbox until the target idles; nothing shows in the target's UI meanwhile.

- The session snapshot's `queue` (`web/server.ts`) merges the pending task
  messages for that session (`TaskStore`, state `pending`, kind `follow_up`),
  rendered as the composer's queued rows with the sender's run name; shown,
  not recalled from there (`pier task cancel` is the sender's).
- The sender's Background Run row shows `1 queued` while its message is
  pending.

### Cache — invariants, not changes

- The head's system prompt is the same bytes every turn: nothing per-turn goes
  before the transcript; the clock and the sender ride the user message, the
  ledger the seed.
- A head keeps its model and thinking for its life; a rotation carries them.
- Every system input appends; the head requests the 1h TTL, which is
  `CHAIN_IDLE_MS`.
- Accepted one-time misses: a rotation (~7K write), a settings change that
  edits the prompt (skills, the home's `AGENTS.md`), the user switching model.

## Acceptance

From the heads' transcript usage, over a week of daily use:

- main averages ≤ 2 model calls per user message;
- uncached input stays under 2% of input; no head compacts;
- every rotation shows its reason on the web divider; `full` rotations lose
  nothing the user has to repeat.

## Build

Three workers, then the fold into 10 and the skill at integration:

- rotation on size + the seed line: `core/types.ts`, `core/chain.ts`,
  `agent/events.ts`, `web/ui/main.ts`; `chain.test.ts` — rotates past the
  ceiling with reason `full`, not on `null`, not while streaming, seed carried;
- the prompts: `agent/roles.ts` (§2, §4), `tasks/agent.ts` (§3),
  `skills/pier-tasks/SKILL.md` (§4); preamble golden test;
- `compactAt` on the seam and in the header (§6): `agent/pi.ts`,
  `core/types.ts`, `core/session.testkit.ts`, `web/ui/session-header.ts`;
  header test — the small worker, or folded into the first;
- the lead's presence (§7, §8): `web/server.ts`, `web/ui/sidebar.ts`,
  `tasks/service.ts` or `tasks/callbacks.ts`; `lead.test.ts` — a plain turn
  end reaches nobody, a milestone resume and a `Design final:` do;
- the visible follow-up (§9): `web/server.ts`, `web/ui/composer.ts`, the run
  row; snapshot test with one pending task message.

## Parked

- Chat commands `/new`, `/status`, `/stop` — after a few days of use.
- IM Phase 3 (10 §IM).
- A rotation on a callback to a full head; a lead keeping the 1h TTL while
  its workers run (10 §Not built).
